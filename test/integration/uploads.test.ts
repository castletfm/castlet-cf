import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  EpisodeResource,
  ShowResource,
  StorageObjectResource,
  UploadInitiateResponse,
} from "../../src/shared/contracts";
import { sweepExpiredUploadIntents, type UploadDeps } from "../../src/worker/domain/storage";
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
