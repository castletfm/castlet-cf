import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  EpisodeResource,
  OrphanListResponse,
  ShowResource,
  UploadInitiateResponse,
} from "../../src/shared/contracts";
import {
  BASE,
  createAuthContext,
  readHeaders,
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
  status: string;
  byte_length: number | null;
  deleted_at: string | null;
}

function mp3Bytes(size: number): Uint8Array {
  const buffer = new Uint8Array(size);
  buffer.set([0x49, 0x44, 0x33]); // "ID3"
  return buffer;
}

let auth: AuthContext;
let show: ShowResource;
let episode: EpisodeResource;

beforeEach(async () => {
  auth = await createAuthContext();
  const showRes = await SELF.fetch(`${BASE}/api/shows`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      slug: uniqueSlug("storage"),
      title: "Storage Admin Show",
      authorName: "Author",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      description: "Show for storage admin tests.",
      categoryPrimary: "Technology",
    }),
  });
  expect(showRes.status).toBe(201);
  show = (await showRes.json()) as ShowResource;

  const episodeRes = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({ title: "Storage Episode" }),
  });
  expect(episodeRes.status).toBe(201);
  episode = (await episodeRes.json()) as EpisodeResource;
});

async function objectRow(id: string): Promise<StorageObjectDbRow> {
  const row = await env.DB.prepare(
    "SELECT id, object_key, status, byte_length, deleted_at FROM storage_objects WHERE id = ?",
  )
    .bind(id)
    .first<StorageObjectDbRow>();
  expect(row).not.toBeNull();
  return row as StorageObjectDbRow;
}

async function usage(): Promise<{ active_bytes: number; reserved_bytes: number }> {
  const row = await env.DB.prepare(
    "SELECT active_bytes, reserved_bytes FROM account_usage WHERE singleton_id = 1",
  ).first<{ active_bytes: number; reserved_bytes: number }>();
  expect(row).not.toBeNull();
  return row as { active_bytes: number; reserved_bytes: number };
}

/** Initiates an audio upload; optionally PUTs bytes and completes it. */
async function initiateAudio(size: number): Promise<UploadInitiateResponse> {
  const res = await SELF.fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      ownerKind: "episode",
      ownerId: episode.id,
      kind: "audio",
      filename: "episode.mp3",
      contentType: "audio/mpeg",
      size,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as UploadInitiateResponse;
}

async function uploadAudio(size: number): Promise<string> {
  const initiated = await initiateAudio(size);
  const row = await objectRow(initiated.storageObjectId);
  await env.MEDIA.put(row.object_key, mp3Bytes(size), {
    httpMetadata: { contentType: "audio/mpeg" },
  });
  const res = await SELF.fetch(`${BASE}/api/uploads/${initiated.uploadId}/complete`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  return initiated.storageObjectId;
}

async function listOrphans(): Promise<OrphanListResponse> {
  const res = await SELF.fetch(`${BASE}/api/storage/orphans`, { headers: readHeaders(auth) });
  expect(res.status).toBe(200);
  return (await res.json()) as OrphanListResponse;
}

async function purge(id: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/storage/${id}`, {
    method: "DELETE",
    headers: writeHeaders(auth),
  });
}

describe("GET /api/storage/orphans", () => {
  it("requires authentication", async () => {
    const res = await SELF.fetch(`${BASE}/api/storage/orphans`);
    expect(res.status).toBe(401);
  });

  it("lists only orphaned objects, with owner info and byte length", async () => {
    const firstId = await uploadAudio(64);
    const secondId = await uploadAudio(80); // replaces the first -> orphaned

    const { orphans } = await listOrphans();
    const ids = orphans.map((o) => o.id);
    expect(ids).toContain(firstId);
    expect(ids).not.toContain(secondId); // active objects are never listed

    const orphan = orphans.find((o) => o.id === firstId);
    expect(orphan).toMatchObject({
      ownerKind: "episode",
      ownerId: episode.id,
      ownerTitle: "Storage Episode",
      kind: "audio",
      contentType: "audio/mpeg",
      byteLength: 64,
    });
    expect(orphan?.orphanedAt).toBeTruthy();
    expect(orphan?.publicPath).toMatch(/^\/media\//);
  });
});

describe("DELETE /api/storage/{id}", () => {
  it("purges an orphaned object: deletes from R2, decrements exactly its bytes", async () => {
    const firstId = await uploadAudio(64);
    await uploadAudio(80);
    const orphanKey = (await objectRow(firstId)).object_key;
    expect(await env.MEDIA.head(orphanKey)).not.toBeNull();
    const before = await usage();

    const res = await purge(firstId);
    expect(res.status).toBe(204);

    expect(await env.MEDIA.head(orphanKey)).toBeNull();
    const row = await objectRow(firstId);
    expect(row.status).toBe("deleted");
    expect(row.deleted_at).toBeTruthy();

    const after = await usage();
    expect(before.active_bytes - after.active_bytes).toBe(64);
    expect(after.reserved_bytes).toBe(before.reserved_bytes);
  });

  it("refuses a second purge with 409 and never decrements twice", async () => {
    const firstId = await uploadAudio(64);
    await uploadAudio(80);
    expect((await purge(firstId)).status).toBe(204);
    const after = await usage();

    const res = await purge(firstId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("ALREADY_PURGED");
    expect(await usage()).toEqual(after);
  });

  it("refuses to purge an active object with 409", async () => {
    const activeId = await uploadAudio(64);
    const key = (await objectRow(activeId)).object_key;
    const before = await usage();

    const res = await purge(activeId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("STORAGE_OBJECT_ACTIVE");

    expect((await objectRow(activeId)).status).toBe("active");
    expect(await env.MEDIA.head(key)).not.toBeNull();
    expect(await usage()).toEqual(before);
  });

  it("refuses to purge a pending object with a live upload intent", async () => {
    const initiated = await initiateAudio(64);
    const res = await purge(initiated.storageObjectId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("UPLOAD_IN_FLIGHT");
    expect((await objectRow(initiated.storageObjectId)).status).toBe("pending");

    const abort = await SELF.fetch(`${BASE}/api/uploads/${initiated.uploadId}`, {
      method: "DELETE",
      headers: writeHeaders(auth),
    });
    expect(abort.status).toBe(204);
  });

  it("purges a stale pending object like the expiration sweep", async () => {
    const before = await usage();
    const initiated = await initiateAudio(64);
    const key = (await objectRow(initiated.storageObjectId)).object_key;
    await env.MEDIA.put(key, mp3Bytes(64), { httpMetadata: { contentType: "audio/mpeg" } });
    await env.DB.prepare("UPDATE upload_intents SET expires_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", initiated.uploadId)
      .run();

    const res = await purge(initiated.storageObjectId);
    expect(res.status).toBe(204);

    expect((await objectRow(initiated.storageObjectId)).status).toBe("deleted");
    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await usage()).toEqual(before); // reservation released, active untouched
  });

  it("returns 404 for an unknown object id", async () => {
    const res = await purge(crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});
