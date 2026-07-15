import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_OUTSTANDING_UPLOAD_INTENTS } from "../../src/shared/constants";
import type {
  EpisodeResource,
  ShowResource,
  StorageObjectResource,
  UploadInitiateResponse,
} from "../../src/shared/contracts";
import { publishEpisode } from "../../src/worker/domain/episodes";
import {
  completeUpload,
  sweepExpiredUploadIntents,
  type UploadDeps,
} from "../../src/worker/domain/storage";
import {
  BASE,
  createAuthContext,
  uniqueSlug,
  writeHeaders,
  type AuthContext,
} from "./session-helper";

interface ErrorBody {
  error: { code: string; message: string };
}

interface StorageObjectDbRow {
  id: string;
  object_key: string;
  public_path: string;
  status: string;
  byte_length: number | null;
  etag: string | null;
}

interface UploadIntentDbRow {
  id: string;
  status: string;
  expires_at: string;
  completed_at: string | null;
}

interface UsageRow {
  active_bytes: number;
  reserved_bytes: number;
}

const PAST_ISO = "2000-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures: small byte arrays with valid (or deliberately broken) signatures.
// ---------------------------------------------------------------------------

function mp3Bytes(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0x49, 0x44, 0x33]); // "ID3"
  return buffer;
}

function pngBytes(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer;
}

function jpegBytes(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
}

function junkBytes(size: number): Uint8Array {
  return new Uint8Array(size); // all zeros: matches no accepted signature
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let auth: AuthContext;
let show: ShowResource;
let episode: EpisodeResource;

beforeEach(async () => {
  auth = await createAuthContext();
  const showRes = await SELF.fetch(`${BASE}/api/shows`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      slug: uniqueSlug("upload-host"),
      title: "Upload Host Show",
      authorName: "Author",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      description: "Show hosting upload tests.",
      categoryPrimary: "Technology",
    }),
  });
  expect(showRes.status).toBe(201);
  show = (await showRes.json()) as ShowResource;

  const episodeRes = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({ title: "Episode" }),
  });
  expect(episodeRes.status).toBe(201);
  episode = (await episodeRes.json()) as EpisodeResource;
});

function audioInitiateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerKind: "episode",
    ownerId: episode.id,
    kind: "audio",
    filename: "episode-001.mp3",
    contentType: "audio/mpeg",
    size: 64,
    ...overrides,
  };
}

function artworkInitiateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerKind: "show",
    ownerId: show.id,
    kind: "artwork",
    filename: "cover.png",
    contentType: "image/png",
    size: 64,
    ...overrides,
  };
}

async function initiate(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify(body),
  });
}

async function initiateOk(body: Record<string, unknown>): Promise<UploadInitiateResponse> {
  const res = await initiate(body);
  expect(res.status).toBe(201);
  return (await res.json()) as UploadInitiateResponse;
}

async function complete(uploadId: string, body: Record<string, unknown> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/api/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify(body),
  });
}

async function abort(uploadId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/uploads/${uploadId}`, {
    method: "DELETE",
    headers: writeHeaders(auth),
  });
}

async function putObject(
  objectId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const row = await objectRow(objectId);
  await env.MEDIA.put(row.object_key, bytes, { httpMetadata: { contentType } });
  return row.object_key;
}

async function objectRow(id: string): Promise<StorageObjectDbRow> {
  const row = await env.DB.prepare("SELECT * FROM storage_objects WHERE id = ?")
    .bind(id)
    .first<StorageObjectDbRow>();
  expect(row).not.toBeNull();
  return row as StorageObjectDbRow;
}

async function intentRow(id: string): Promise<UploadIntentDbRow> {
  const row = await env.DB.prepare("SELECT * FROM upload_intents WHERE id = ?")
    .bind(id)
    .first<UploadIntentDbRow>();
  expect(row).not.toBeNull();
  return row as UploadIntentDbRow;
}

async function usage(): Promise<UsageRow> {
  const row = await env.DB.prepare(
    "SELECT active_bytes, reserved_bytes FROM account_usage WHERE singleton_id = 1",
  ).first<UsageRow>();
  expect(row).not.toBeNull();
  return row as UsageRow;
}

async function getEpisodeRow(id: string): Promise<{
  audio_object_id: string | null;
  duration_seconds: number | null;
}> {
  const row = await env.DB.prepare(
    "SELECT audio_object_id, duration_seconds FROM episodes WHERE id = ?",
  )
    .bind(id)
    .first<{ audio_object_id: string | null; duration_seconds: number | null }>();
  expect(row).not.toBeNull();
  return row as { audio_object_id: string | null; duration_seconds: number | null };
}

async function getShowRow(id: string): Promise<{
  artwork_object_id: string | null;
  feed_revision: number;
}> {
  const row = await env.DB.prepare(
    "SELECT artwork_object_id, feed_revision FROM shows WHERE id = ?",
  )
    .bind(id)
    .first<{ artwork_object_id: string | null; feed_revision: number }>();
  expect(row).not.toBeNull();
  return row as { artwork_object_id: string | null; feed_revision: number };
}

/** Full valid upload cycle; returns the storage object id and upload id. */
async function uploadAudio(
  bytes: Uint8Array,
  completeBody: Record<string, unknown> = {},
): Promise<{ uploadId: string; objectId: string; resource: StorageObjectResource }> {
  const initiated = await initiateOk(audioInitiateBody({ size: bytes.length }));
  await putObject(initiated.storageObjectId, bytes, "audio/mpeg");
  const res = await complete(initiated.uploadId, completeBody);
  expect(res.status).toBe(200);
  const resource = (await res.json()) as StorageObjectResource;
  return { uploadId: initiated.uploadId, objectId: initiated.storageObjectId, resource };
}

/** Seeds synthetic intent rows for limit tests; returns a cleanup function. */
async function seedIntents(
  count: number,
  status: "initiated" | "completed",
): Promise<() => Promise<void>> {
  const statements: D1PreparedStatement[] = [];
  const nowIso = new Date().toISOString();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  for (let i = 0; i < count; i += 1) {
    const objectId = `seed-obj-${crypto.randomUUID()}`;
    const intentId = `seed-int-${crypto.randomUUID()}`;
    statements.push(
      env.DB.prepare(
        `INSERT INTO storage_objects (
           id, owner_kind, owner_id, kind, object_key, public_path,
           original_filename, content_type, status, created_at
         ) VALUES (?, 'show', 'seed-owner', 'artwork', ?, ?, 'seed.png', 'image/png', ?, ?)`,
      ).bind(
        objectId,
        `seed/${objectId}.png`,
        `/seed/${objectId}.png`,
        status === "initiated" ? "pending" : "active",
        nowIso,
      ),
      env.DB.prepare(
        `INSERT INTO upload_intents (
           id, storage_object_id, expected_content_type, expected_size,
           status, expires_at, created_at, completed_at
         ) VALUES (?, ?, 'image/png', 1, ?, ?, ?, ?)`,
      ).bind(intentId, objectId, status, future, nowIso, status === "completed" ? nowIso : null),
    );
  }
  await env.DB.batch(statements);
  return async () => {
    await env.DB.prepare("DELETE FROM upload_intents WHERE id LIKE 'seed-int-%'").run();
    await env.DB.prepare("DELETE FROM storage_objects WHERE id LIKE 'seed-obj-%'").run();
  };
}

function testDeps(): UploadDeps {
  return {
    db: env.DB,
    media: env.MEDIA,
    config: {
      maxTotalStorageBytes: Number(env.MAX_TOTAL_STORAGE_BYTES),
      maxAudioBytes: Number(env.MAX_AUDIO_BYTES),
      maxArtworkBytes: Number(env.MAX_ARTWORK_BYTES),
      uploadUrlTtlSeconds: Number(env.UPLOAD_URL_TTL_SECONDS),
      maxOutstandingIntents: 20,
      maxCompletedUploadsPerUtcDay: 20,
    },
    presign: () => Promise.resolve("https://presign.invalid/unused"),
  };
}

// ---------------------------------------------------------------------------
// POST /api/uploads
// ---------------------------------------------------------------------------

describe("POST /api/uploads", () => {
  it("requires authentication", async () => {
    const res = await SELF.fetch(`${BASE}/api/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(audioInitiateBody()),
    });
    expect(res.status).toBe(401);
  });

  it("reserves quota and creates pending records with a presigned PUT", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 48_320 }));

    expect(initiated.uploadId).toBeTruthy();
    expect(initiated.headers).toEqual({ "Content-Type": "audio/mpeg" });
    expect(initiated.publicPath).toMatch(
      new RegExp(`^/media/${show.id}/${episode.id}/[0-9a-f-]{36}\\.mp3$`),
    );
    const expiresInMs = new Date(initiated.expiresAt).getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan(0);
    expect(expiresInMs).toBeLessThanOrEqual(900_000);

    const object = await objectRow(initiated.storageObjectId);
    expect(object.status).toBe("pending");
    // Section 11.2: object key mirrors the public path (audio/... vs /media/...).
    expect(`/${object.object_key}`).toBe(initiated.publicPath.replace("/media/", "/audio/"));

    const putUrl = new URL(initiated.putUrl);
    expect(putUrl.pathname).toBe(`/${env.R2_BUCKET_NAME}/${object.object_key}`);
    expect(putUrl.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(putUrl.searchParams.get("X-Amz-SignedHeaders") ?? "").toContain("content-type");

    const intent = await intentRow(initiated.uploadId);
    expect(intent.status).toBe("initiated");

    const after = await usage();
    expect(after.reserved_bytes - before.reserved_bytes).toBe(48_320);
    expect(after.active_bytes).toBe(before.active_bytes);

    expect((await abort(initiated.uploadId)).status).toBe(204);
  });

  it("rejects an unknown MIME type", async () => {
    const res = await initiate(audioInitiateBody({ contentType: "application/pdf" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a filename extension that disagrees with the MIME type", async () => {
    const res = await initiate(audioInitiateBody({ filename: "episode.wav" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects a kind/owner pairing mismatch", async () => {
    const res = await initiate(
      audioInitiateBody({ kind: "artwork", filename: "cover.png", contentType: "image/png" }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects audio above the configured maximum size", async () => {
    const res = await initiate(audioInitiateBody({ size: Number(env.MAX_AUDIO_BYTES) + 1 }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects artwork above the configured maximum size", async () => {
    const res = await initiate(artworkInitiateBody({ size: Number(env.MAX_ARTWORK_BYTES) + 1 }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects a missing owner", async () => {
    const res = await initiate(audioInitiateBody({ ownerId: crypto.randomUUID() }));
    expect(res.status).toBe(404);
  });

  it("rejects uploads to an inactive show", async () => {
    await env.DB.prepare("UPDATE shows SET status = 'inactive' WHERE id = ?").bind(show.id).run();
    const res = await initiate(artworkInitiateBody());
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("SHOW_INACTIVE");
  });

  it("enforces the outstanding-intent limit", async () => {
    const cleanup = await seedIntents(20, "initiated");
    try {
      const res = await initiate(audioInitiateBody());
      expect(res.status).toBe(429);
      expect(((await res.json()) as ErrorBody).error.code).toBe("TOO_MANY_PENDING_UPLOADS");
    } finally {
      await cleanup();
    }
  });

  it("enforces the daily completed-upload limit", async () => {
    const cleanup = await seedIntents(20, "completed");
    try {
      const res = await initiate(audioInitiateBody());
      expect(res.status).toBe(429);
      expect(((await res.json()) as ErrorBody).error.code).toBe("DAILY_UPLOAD_LIMIT_REACHED");
    } finally {
      await cleanup();
    }
  });

  it("never exceeds the outstanding-intent limit under concurrent initiation", async () => {
    // With 19 intents already outstanding, two near-simultaneous initiations
    // both pass the pre-count read (both see 19). The old check-then-insert
    // would let both write, reaching 21; the guarded insert admits only one.
    const before = await usage();
    const cleanup = await seedIntents(19, "initiated");
    try {
      const [a, b] = await Promise.all([
        initiate(audioInitiateBody()),
        initiate(audioInitiateBody()),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 429]);

      const loser = a.status === 429 ? a : b;
      expect(((await loser.json()) as ErrorBody).error.code).toBe("TOO_MANY_PENDING_UPLOADS");

      const outstanding = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM upload_intents WHERE status = 'initiated' AND expires_at > ?",
      )
        .bind(new Date().toISOString())
        .first<{ n: number }>();
      expect(outstanding?.n).toBe(20);

      // The refused request left no orphan pending object behind (19 seeded +
      // 1 winner), and released the bytes it had reserved.
      const pending = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM storage_objects WHERE status = 'pending'",
      ).first<{ n: number }>();
      expect(pending?.n).toBe(20);
      expect((await usage()).reserved_bytes - before.reserved_bytes).toBe(64);
    } finally {
      // Abort the winner so its reservation is released before cleanup.
      const winnerIntent = await env.DB.prepare(
        "SELECT id FROM upload_intents WHERE status = 'initiated' AND id NOT LIKE 'seed-int-%'",
      ).first<{ id: string }>();
      if (winnerIntent !== null) {
        await abort(winnerIntent.id);
      }
      await cleanup();
    }
  });

  it("rejects a reservation that would exceed the storage quota", async () => {
    const before = await usage();
    const max = Number(env.MAX_TOTAL_STORAGE_BYTES);
    await env.DB.prepare("UPDATE account_usage SET active_bytes = ? WHERE singleton_id = 1")
      .bind(max - before.reserved_bytes - 10)
      .run();
    try {
      const res = await initiate(audioInitiateBody({ size: 64 }));
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe("QUOTA_EXCEEDED");
    } finally {
      await env.DB.prepare("UPDATE account_usage SET active_bytes = ? WHERE singleton_id = 1")
        .bind(before.active_bytes)
        .run();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/uploads/{id}/complete
// ---------------------------------------------------------------------------

describe("POST /api/uploads/{id}/complete", () => {
  it("activates a verified audio object and attaches it to the episode", async () => {
    const before = await usage();
    const bytes = mp3Bytes(64);
    const { objectId, resource } = await uploadAudio(bytes, { durationSeconds: 1854 });

    expect(resource.status).toBe("active");
    expect(resource.byteLength).toBe(64);
    expect(resource.etag).toBeTruthy();
    expect(resource.activatedAt).toBeTruthy();

    const object = await objectRow(objectId);
    expect(object.status).toBe("active");
    expect(object.byte_length).toBe(64);

    const episodeAfter = await getEpisodeRow(episode.id);
    expect(episodeAfter.audio_object_id).toBe(objectId);
    expect(episodeAfter.duration_seconds).toBe(1854);

    // Draft episode audio is not feed-affecting.
    expect((await getShowRow(show.id)).feed_revision).toBe(show.feedRevision);

    const after = await usage();
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
    expect(after.active_bytes - before.active_bytes).toBe(64);
  });

  it("orphans replaced audio and bumps the feed revision for a published episode", async () => {
    await env.DB.prepare("UPDATE episodes SET status = 'published', published_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), episode.id)
      .run();

    const first = await uploadAudio(mp3Bytes(64));
    const revisionAfterFirst = (await getShowRow(show.id)).feed_revision;
    expect(revisionAfterFirst).toBe(show.feedRevision + 1);

    const second = await uploadAudio(mp3Bytes(80));
    expect((await objectRow(first.objectId)).status).toBe("orphaned");
    expect((await objectRow(second.objectId)).status).toBe("active");
    expect((await getEpisodeRow(episode.id)).audio_object_id).toBe(second.objectId);
    expect((await getShowRow(show.id)).feed_revision).toBe(revisionAfterFirst + 1);
  });

  it("activates artwork, attaches it to the show, and bumps the feed revision", async () => {
    const before = await usage();
    const bytes = pngBytes(64);
    const initiated = await initiateOk(artworkInitiateBody({ size: bytes.length }));
    await putObject(initiated.storageObjectId, bytes, "image/png");
    const res = await complete(initiated.uploadId, { imageWidth: 1400, imageHeight: 1400 });
    expect(res.status).toBe(200);

    const showAfter = await getShowRow(show.id);
    expect(showAfter.artwork_object_id).toBe(initiated.storageObjectId);
    expect(showAfter.feed_revision).toBe(show.feedRevision + 1);

    // Replace with a JPEG: previous artwork becomes orphaned.
    const jpeg = jpegBytes(48);
    const replacement = await initiateOk(
      artworkInitiateBody({ filename: "cover.jpg", contentType: "image/jpeg", size: jpeg.length }),
    );
    await putObject(replacement.storageObjectId, jpeg, "image/jpeg");
    expect((await complete(replacement.uploadId)).status).toBe(200);

    expect((await objectRow(initiated.storageObjectId)).status).toBe("orphaned");
    const showFinal = await getShowRow(show.id);
    expect(showFinal.artwork_object_id).toBe(replacement.storageObjectId);
    expect(showFinal.feed_revision).toBe(show.feedRevision + 2);

    const after = await usage();
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
    expect(after.active_bytes - before.active_bytes).toBe(64 + 48);
  });

  it("rejects artwork with out-of-range client-reported dimensions", async () => {
    const before = await usage();
    const bytes = pngBytes(64);
    const initiated = await initiateOk(artworkInitiateBody({ size: bytes.length }));
    const objectKey = await putObject(initiated.storageObjectId, bytes, "image/png");

    const res = await complete(initiated.uploadId, { imageWidth: 1000, imageHeight: 1000 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INVALID_IMAGE_DIMENSIONS");

    expect(await env.MEDIA.head(objectKey)).toBeNull();
    expect((await objectRow(initiated.storageObjectId)).status).toBe("rejected");
    expect((await intentRow(initiated.uploadId)).status).toBe("rejected");
    expect(await usage()).toEqual(before);
  });

  it("rejects an object larger than the declared size, deleting it and releasing quota", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 32 }));
    const objectKey = await putObject(initiated.storageObjectId, mp3Bytes(40), "audio/mpeg");

    const res = await complete(initiated.uploadId);
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("SIZE_MISMATCH");

    expect(await env.MEDIA.head(objectKey)).toBeNull();
    expect((await objectRow(initiated.storageObjectId)).status).toBe("rejected");
    expect((await intentRow(initiated.uploadId)).status).toBe("rejected");
    expect(await usage()).toEqual(before);
  });

  it("accepts an object smaller than declared and activates the actual byte count", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 100 }));
    await putObject(initiated.storageObjectId, mp3Bytes(64), "audio/mpeg");

    const res = await complete(initiated.uploadId);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StorageObjectResource).byteLength).toBe(64);

    const after = await usage();
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
    expect(after.active_bytes - before.active_bytes).toBe(64);
  });

  it("rejects a stored content type that differs from the declared one", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 64 }));
    const objectKey = await putObject(initiated.storageObjectId, mp3Bytes(64), "audio/mp4");

    const res = await complete(initiated.uploadId);
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("CONTENT_TYPE_MISMATCH");
    expect(await env.MEDIA.head(objectKey)).toBeNull();
    expect(await usage()).toEqual(before);
  });

  it("rejects an invalid file signature, deleting the object and releasing quota", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 64 }));
    const objectKey = await putObject(initiated.storageObjectId, junkBytes(64), "audio/mpeg");

    const res = await complete(initiated.uploadId);
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INVALID_FILE_SIGNATURE");

    expect(await env.MEDIA.head(objectKey)).toBeNull();
    expect((await objectRow(initiated.storageObjectId)).status).toBe("rejected");
    expect((await intentRow(initiated.uploadId)).status).toBe("rejected");
    expect(await usage()).toEqual(before);
  });

  it("rejects completion of an expired intent and cleans up", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 64 }));
    const objectKey = await putObject(initiated.storageObjectId, mp3Bytes(64), "audio/mpeg");
    await env.DB.prepare("UPDATE upload_intents SET expires_at = ? WHERE id = ?")
      .bind(PAST_ISO, initiated.uploadId)
      .run();

    const res = await complete(initiated.uploadId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INTENT_EXPIRED");

    expect((await intentRow(initiated.uploadId)).status).toBe("expired");
    expect((await objectRow(initiated.storageObjectId)).status).toBe("deleted");
    expect(await env.MEDIA.head(objectKey)).toBeNull();
    expect(await usage()).toEqual(before);
  });

  it("returns 409 before the object has been uploaded", async () => {
    const initiated = await initiateOk(audioInitiateBody({ size: 64 }));
    const res = await complete(initiated.uploadId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("OBJECT_NOT_UPLOADED");
    // The intent stays alive so the client can retry after the PUT lands.
    expect((await intentRow(initiated.uploadId)).status).toBe("initiated");
    expect((await abort(initiated.uploadId)).status).toBe(204);
  });

  it("returns a deliberate 409 for a duplicate completion", async () => {
    const before = await usage();
    const { uploadId } = await uploadAudio(mp3Bytes(64));

    const res = await complete(uploadId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("ALREADY_COMPLETED");

    // Quota moved exactly once.
    const after = await usage();
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
    expect(after.active_bytes - before.active_bytes).toBe(64);
  });

  it("never exceeds the daily completed-upload limit under concurrent completion", async () => {
    // 19 uploads already completed today. Two more are initiated (both pass
    // the initiation pre-check, since neither is completed yet) and then
    // completed near-simultaneously. The old unguarded claim would let both
    // complete, reaching 21; the guarded claim admits only the 20th.
    const before = await usage();
    // Earlier tests in this suite share the DB and leave real completed
    // intents; clear them so exactly 19 completed rows exist for the boundary.
    await env.DB.prepare("DELETE FROM upload_intents WHERE status = 'completed'").run();
    const cleanup = await seedIntents(19, "completed");
    try {
      const first = await initiateOk(audioInitiateBody({ size: 64 }));
      const second = await initiateOk(audioInitiateBody({ size: 64 }));
      const firstKey = await putObject(first.storageObjectId, mp3Bytes(64), "audio/mpeg");
      const secondKey = await putObject(second.storageObjectId, mp3Bytes(64), "audio/mpeg");

      const [a, b] = await Promise.all([complete(first.uploadId), complete(second.uploadId)]);
      expect([a.status, b.status].sort()).toEqual([200, 429]);

      const loserRes = a.status === 429 ? a : b;
      expect(((await loserRes.json()) as ErrorBody).error.code).toBe("DAILY_UPLOAD_LIMIT_REACHED");

      const completedToday = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM upload_intents WHERE status = 'completed' AND completed_at >= ?",
      )
        .bind(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
        .first<{ n: number }>();
      expect(completedToday?.n).toBe(20);

      // Winner activated; loser cleaned up like a rejection (intent rejected,
      // object deleted from R2, reservation released).
      const winner = a.status === 429 ? second : first;
      const loser = a.status === 429 ? first : second;
      const loserKey = a.status === 429 ? firstKey : secondKey;
      expect((await objectRow(winner.storageObjectId)).status).toBe("active");
      expect((await intentRow(loser.uploadId)).status).toBe("rejected");
      expect((await objectRow(loser.storageObjectId)).status).toBe("rejected");
      expect(await env.MEDIA.head(loserKey)).toBeNull();
      // Exactly one upload's 64 bytes moved to active; the loser's reservation
      // was released, leaving reserved_bytes unchanged from the start.
      const after = await usage();
      expect(after.reserved_bytes).toBe(before.reserved_bytes);
      expect(after.active_bytes - before.active_bytes).toBe(64);
    } finally {
      await cleanup();
    }
  });

  it("keeps exactly one audio object attached under concurrent completion for one episode", async () => {
    // Two uploads for the SAME episode are initiated and PUT, then completed
    // simultaneously via Promise.all. Both completions read the episode's
    // current (null) audio attachment before either attaches. An unconditional
    // attach lets the second overwrite the first, leaving the first object
    // active but referenced by nobody and never orphaned -- an invariant-9.1
    // storage leak. The compare-and-set attach forces the losing completion to
    // re-read and displace the now-current object, so exactly one object stays
    // attached+active and the other is orphaned.
    //
    // Driven through the domain function directly (not the HTTP route) because
    // the workers test pool serializes back-to-back SELF.fetch handlers, which
    // would hide the race; two concurrent completeUpload calls interleave at
    // their D1/R2 awaits and both capture the same pre-attach owner state.
    const before = await usage();

    const first = await initiateOk(audioInitiateBody({ size: 64 }));
    const second = await initiateOk(audioInitiateBody({ size: 80 }));
    await putObject(first.storageObjectId, mp3Bytes(64), "audio/mpeg");
    await putObject(second.storageObjectId, mp3Bytes(80), "audio/mpeg");

    const deps = testDeps();
    const [a, b] = await Promise.all([
      completeUpload(deps, first.uploadId, {}),
      completeUpload(deps, second.uploadId, {}),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // The episode references exactly one of the two objects.
    const attachedId = (await getEpisodeRow(episode.id)).audio_object_id ?? "";
    expect([first.storageObjectId, second.storageObjectId]).toContain(attachedId);
    const orphanedId =
      attachedId === first.storageObjectId ? second.storageObjectId : first.storageObjectId;

    // The attached object is active; the displaced one is orphaned -- never a
    // second active-but-unreferenced object.
    expect((await objectRow(attachedId)).status).toBe("active");
    expect((await objectRow(orphanedId)).status).toBe("orphaned");

    // Both objects' bytes count as active storage: the winner's stay active,
    // and the orphan's remain active until a later purge (orphan accounting).
    // Reservations are fully committed.
    const after = await usage();
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
    expect(after.active_bytes - before.active_bytes).toBe(64 + 80);
  });

  it("attaches every in-cap concurrent completion for one episode without spurious ATTACH_CONFLICT", async () => {
    // The outstanding-upload cap admits up to MAX_OUTSTANDING_UPLOAD_INTENTS
    // in-flight uploads for one episode. If that many complete at once, the
    // compare-and-set attach has exactly one winner per round, so the last
    // legitimate completion needs an attempt count equal to the number of
    // contenders. When the attach-retry cap was a fixed 16 -- below the
    // outstanding cap of 20 -- the 17th..20th legitimate completion exhausted
    // the loop and was spuriously orphaned with ATTACH_CONFLICT even though it
    // was within the allowed cap. The bound must be at least the outstanding
    // cap so only a genuine anomaly (more contention than the caps permit) ever
    // surfaces ATTACH_CONFLICT.
    //
    // Driven through the domain function directly (not the HTTP route) for the
    // same reason as the two-completion test above: the workers test pool
    // serializes back-to-back SELF.fetch handlers, hiding the race, whereas
    // concurrent completeUpload calls interleave at their D1/R2 awaits so all
    // contenders capture the same pre-attach owner state.
    const contenders = MAX_OUTSTANDING_UPLOAD_INTENTS; // worst-case in-cap contention
    const before = await usage();
    // Clear completed intents so these completions stay within the daily cap.
    await env.DB.prepare("DELETE FROM upload_intents WHERE status = 'completed'").run();

    const initiated: UploadInitiateResponse[] = [];
    for (let i = 0; i < contenders; i += 1) {
      const one = await initiateOk(audioInitiateBody({ size: 64 }));
      await putObject(one.storageObjectId, mp3Bytes(64), "audio/mpeg");
      initiated.push(one);
    }

    const deps = testDeps();
    try {
      const results = await Promise.all(
        initiated.map((one) => completeUpload(deps, one.uploadId, {})),
      );

      // Every legitimate, in-cap completion succeeded -- none was dropped.
      for (const result of results) {
        expect(result.ok).toBe(true);
      }

      // Exactly one object ends attached+active; the other contenders are orphaned.
      const attachedId = (await getEpisodeRow(episode.id)).audio_object_id ?? "";
      const objectIds = initiated.map((one) => one.storageObjectId);
      expect(objectIds).toContain(attachedId);
      expect((await objectRow(attachedId)).status).toBe("active");

      let orphanedCount = 0;
      for (const objectId of objectIds) {
        if (objectId === attachedId) {
          continue;
        }
        expect((await objectRow(objectId)).status).toBe("orphaned");
        orphanedCount += 1;
      }
      expect(orphanedCount).toBe(contenders - 1);

      // Accounting: every contender's bytes count as active (winner active, the
      // rest orphaned-but-still-active until purge); reservations fully committed.
      const after = await usage();
      expect(after.reserved_bytes).toBe(before.reserved_bytes);
      expect(after.active_bytes - before.active_bytes).toBe(64 * contenders);
    } finally {
      // These completions fill the day's completed-upload cap; clear them so
      // later tests in the shared DB start from a clean daily count.
      await env.DB.prepare("DELETE FROM upload_intents WHERE status = 'completed'").run();
    }
  });

  it("does not spin forever when the owner is deleted mid-attach; orphans the object and reports OWNER_DELETED", async () => {
    // Regression for an infinite-loop hazard in the compare-and-set attach
    // loop: the intent is claimed completed and the object activated, then the
    // owner (episode) is deleted before the attach lands. The attach matches
    // zero rows every iteration and re-reading the owner yields null, so the
    // pre-fix loop (which collapsed "owner missing" to "no attachment") never
    // terminated. We reproduce the mechanism deterministically by deleting the
    // episode exactly when the first attach batch runs, via a db proxy that
    // also caps batch calls so the buggy loop fails fast instead of hanging.
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 64 }));
    const objectKey = await putObject(initiated.storageObjectId, mp3Bytes(64), "audio/mpeg");

    const MAX_BATCH_CALLS = 5; // fix converges in 1 batch; buggy loop exceeds this
    let batchCalls = 0;
    const realBatch = env.DB.batch.bind(env.DB);
    const racingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            if (batchCalls === 1) {
              // Delete the owner right as the attach batch first runs, so the
              // attach compare-and-set matches zero rows this iteration onward.
              await env.DB.prepare("DELETE FROM episodes WHERE id = ?").bind(episode.id).run();
            }
            if (batchCalls > MAX_BATCH_CALLS) {
              throw new Error("attach retry loop did not terminate");
            }
            return realBatch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const deps: UploadDeps = { ...testDeps(), db: racingDb };
    const result = await completeUpload(deps, initiated.uploadId, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("OWNER_DELETED");
    }
    // The loop stopped promptly: a single attach batch, not a spin.
    expect(batchCalls).toBe(1);

    // The activated-but-unreferenced object is orphaned so purge reclaims it.
    expect((await objectRow(initiated.storageObjectId)).status).toBe("orphaned");
    // The R2 object is left in place for the purge step (design 11.5/11.6).
    expect(await env.MEDIA.head(objectKey)).not.toBeNull();

    // Accounting stays correct: the reservation was committed to active bytes,
    // and the orphan's bytes keep counting as active until a later purge.
    const after = await usage();
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
    expect(after.active_bytes - before.active_bytes).toBe(64);
  });

  it("marks the feed dirty when a concurrent publish makes the episode feed-visible before a replacement attach lands", async () => {
    // Silent feed-corruption race (section 9.1, same class the per-show feed-sync
    // lock defends). A replacement audio upload completes while the episode is
    // still draft, so the pre-attach read decides feedAffected=false. A
    // concurrent publish then flips the episode to published and synchronizes
    // feeds/{slug}.xml against the OLD audio A -- fully, marking the show
    // synchronized -- before the attach batch runs. The attach swaps the
    // enclosure to B and orphans A. The stale draft decision skipped the
    // feed_revision bump, so the show stayed reported synchronized while its
    // published episode's active enclosure (B) differs from what the feed serves
    // (A, soon a 404 once A is purged): no dirty banner, no operator signal.
    //
    // With the fix the bump is guarded on the episode's status AT ATTACH TIME
    // inside the same batch, so the just-swapped enclosure bumps feed_revision
    // and the show is left dirty (feed_published_revision < feed_revision), which
    // the section-16 banner surfaces and regenerate-feed self-corrects.
    //
    // Reproduced deterministically by wrapping env.DB so the concurrent publish
    // (against the real DB) runs to completion the instant the attach batch is
    // first issued -- the read->attach window the domain function exposes.
    await env.DB.prepare("DELETE FROM upload_intents WHERE status = 'completed'").run();

    // Make the episode publishable while still draft, with an active audio A
    // attached and the show artwork present.
    const nowIso = new Date().toISOString();
    const audioA = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO storage_objects (
         id, owner_kind, owner_id, kind, object_key, public_path,
         original_filename, content_type, byte_length, etag, status,
         created_at, activated_at
       ) VALUES (?, 'episode', ?, 'audio', ?, ?, 'a.mp3', 'audio/mpeg', 4096, 'etag-a', 'active', ?, ?)`,
    )
      .bind(
        audioA,
        episode.id,
        `audio/${show.id}/${episode.id}/${audioA}.mp3`,
        `/media/${show.id}/${episode.id}/${audioA}.mp3`,
        nowIso,
        nowIso,
      )
      .run();
    const artwork = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO storage_objects (
         id, owner_kind, owner_id, kind, object_key, public_path,
         original_filename, content_type, byte_length, etag, status,
         created_at, activated_at
       ) VALUES (?, 'show', ?, 'artwork', ?, ?, 'cover.jpg', 'image/jpeg', 4096, 'etag-art', 'active', ?, ?)`,
    )
      .bind(
        artwork,
        show.id,
        `artwork/${show.id}/${artwork}.jpg`,
        `/artwork/${show.id}/${artwork}.jpg`,
        nowIso,
        nowIso,
      )
      .run();
    await env.DB.prepare(
      "UPDATE episodes SET audio_object_id = ?, duration_seconds = 100, description = 'Ready to publish.' WHERE id = ?",
    )
      .bind(audioA, episode.id)
      .run();
    await env.DB.prepare("UPDATE shows SET artwork_object_id = ? WHERE id = ?")
      .bind(artwork, show.id)
      .run();

    // Replacement audio B: an initiated intent for the same episode, PUT to R2.
    const replacement = await initiateOk(audioInitiateBody({ size: 64 }));
    await putObject(replacement.storageObjectId, mp3Bytes(64), "audio/mpeg");

    const feedDeps = {
      db: env.DB,
      media: env.MEDIA,
      publicBaseUrl: env.PUBLIC_BASE_URL as string,
    };

    let batchCalls = 0;
    const realBatch = env.DB.batch.bind(env.DB);
    const racingDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            if (batchCalls === 1) {
              // Right as the attach batch is first issued, publish concurrently:
              // this flips the episode to published, bumps the revision, and
              // synchronizes feeds/{slug}.xml against the OLD audio A, leaving the
              // show synchronized -- all before the attach swaps the enclosure.
              const published = await publishEpisode(feedDeps, episode.id);
              expect(published.ok).toBe(true);
            }
            return realBatch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const deps: UploadDeps = { ...testDeps(), db: racingDb };
    const result = await completeUpload(deps, replacement.uploadId, {});

    expect(result.ok).toBe(true);

    // The published episode now points at the replacement B; A was orphaned.
    const episodeRow = await getEpisodeRow(episode.id);
    expect(episodeRow.audio_object_id).toBe(replacement.storageObjectId);
    expect((await objectRow(audioA)).status).toBe("orphaned");

    // The show must NOT be left synchronized against the stale enclosure: the
    // attach bumped feed_revision past the published revision, so the feed reads
    // dirty and the operator gets a signal. Without the fix these are equal and
    // the corruption is silent.
    const feedRow = await env.DB.prepare(
      "SELECT feed_revision, feed_published_revision FROM shows WHERE id = ?",
    )
      .bind(show.id)
      .first<{ feed_revision: number; feed_published_revision: number }>();
    expect(feedRow).not.toBeNull();
    expect(feedRow?.feed_revision).toBeGreaterThan(feedRow?.feed_published_revision ?? 0);
  });

  it("returns 404 for an unknown upload id", async () => {
    const res = await complete(crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/uploads/{id}
// ---------------------------------------------------------------------------

describe("DELETE /api/uploads/{id}", () => {
  it("aborts an initiated upload: releases quota and deletes the object", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 64 }));
    const objectKey = await putObject(initiated.storageObjectId, mp3Bytes(64), "audio/mpeg");

    expect((await abort(initiated.uploadId)).status).toBe(204);

    expect((await intentRow(initiated.uploadId)).status).toBe("aborted");
    expect((await objectRow(initiated.storageObjectId)).status).toBe("deleted");
    expect(await env.MEDIA.head(objectKey)).toBeNull();
    expect(await usage()).toEqual(before);

    // DELETE is idempotent.
    expect((await abort(initiated.uploadId)).status).toBe(204);
    expect(await usage()).toEqual(before);
  });

  it("returns 409 for a completed upload", async () => {
    const { uploadId } = await uploadAudio(mp3Bytes(64));
    const res = await abort(uploadId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("INTENT_NOT_ACTIVE");
  });

  it("returns 404 for an unknown upload id", async () => {
    expect((await abort(crypto.randomUUID())).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Expiration sweep
// ---------------------------------------------------------------------------

describe("expiration sweep", () => {
  it("expires overdue intents, releasing quota and deleting objects", async () => {
    const before = await usage();
    const initiated = await initiateOk(audioInitiateBody({ size: 64 }));
    const objectKey = await putObject(initiated.storageObjectId, mp3Bytes(64), "audio/mpeg");
    await env.DB.prepare("UPDATE upload_intents SET expires_at = ? WHERE id = ?")
      .bind(PAST_ISO, initiated.uploadId)
      .run();

    const expired = await sweepExpiredUploadIntents(testDeps());
    expect(expired).toBeGreaterThanOrEqual(1);

    expect((await intentRow(initiated.uploadId)).status).toBe("expired");
    expect((await objectRow(initiated.storageObjectId)).status).toBe("deleted");
    expect(await env.MEDIA.head(objectKey)).toBeNull();
    expect(await usage()).toEqual(before);
  });

  it("runs opportunistically when a new upload is initiated", async () => {
    const stale = await initiateOk(audioInitiateBody({ size: 64 }));
    await env.DB.prepare("UPDATE upload_intents SET expires_at = ? WHERE id = ?")
      .bind(PAST_ISO, stale.uploadId)
      .run();

    const fresh = await initiateOk(audioInitiateBody({ size: 32 }));
    expect((await intentRow(stale.uploadId)).status).toBe("expired");
    expect((await abort(fresh.uploadId)).status).toBe(204);
  });
});
