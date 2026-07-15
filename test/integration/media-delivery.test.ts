import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BASE } from "./session-helper";

/**
 * Public media delivery: GET/HEAD
 * /media/{showId}/{episodeId}/{objectId}.{ext} and
 * /artwork/{showId}/{objectId}.{ext} with byte ranges, conditional
 * requests, immutable caching, and one analytics event per response.
 *
 * The routes read only storage_objects and R2, so tests seed those
 * directly; the owning show/episode rows are not consulted on the public
 * delivery path (immutable media URLs must keep working regardless).
 */

const AUDIO_SIZE = 4096;

function makeBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
}

interface SeededMedia {
  showId: string;
  episodeId: string | null;
  objectId: string;
  url: string;
  etag: string;
  bytes: Uint8Array;
}

async function insertStorageObject(row: {
  id: string;
  ownerKind: "show" | "episode";
  ownerId: string;
  kind: "artwork" | "audio";
  objectKey: string;
  publicPath: string;
  contentType: string;
  byteLength: number;
  etag: string;
  status: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO storage_objects (
       id, owner_kind, owner_id, kind, object_key, public_path,
       original_filename, content_type, byte_length, etag, status,
       created_at, activated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'orig.bin', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.ownerKind,
      row.ownerId,
      row.kind,
      row.objectKey,
      row.publicPath,
      row.contentType,
      row.byteLength,
      row.etag,
      row.status,
      nowIso,
      nowIso,
    )
    .run();
}

/** Seeds an ACTIVE audio object with real bytes in the test R2 bucket. */
async function seedAudio(
  options: { status?: string; skipRow?: boolean } = {},
): Promise<SeededMedia> {
  const showId = crypto.randomUUID();
  const episodeId = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  const objectKey = `audio/${showId}/${episodeId}/${objectId}.mp3`;
  const publicPath = `/media/${showId}/${episodeId}/${objectId}.mp3`;
  const bytes = makeBytes(AUDIO_SIZE);

  const put = await env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType: "audio/mpeg" },
  });
  if (options.skipRow !== true) {
    await insertStorageObject({
      id: objectId,
      ownerKind: "episode",
      ownerId: episodeId,
      kind: "audio",
      objectKey,
      publicPath,
      contentType: "audio/mpeg",
      byteLength: AUDIO_SIZE,
      etag: put.etag,
      status: options.status ?? "active",
    });
  }
  return { showId, episodeId, objectId, url: `${BASE}${publicPath}`, etag: put.etag, bytes };
}

/** Seeds an ACTIVE artwork object with real bytes in the test R2 bucket. */
async function seedArtwork(): Promise<SeededMedia> {
  const showId = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  const objectKey = `artwork/${showId}/${objectId}.jpg`;
  const publicPath = `/artwork/${showId}/${objectId}.jpg`;
  const bytes = makeBytes(2048);

  const put = await env.MEDIA.put(objectKey, bytes, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  await insertStorageObject({
    id: objectId,
    ownerKind: "show",
    ownerId: showId,
    kind: "artwork",
    objectKey,
    publicPath,
    contentType: "image/jpeg",
    byteLength: bytes.length,
    etag: put.etag,
    status: "active",
  });
  return { showId, episodeId: null, objectId, url: `${BASE}${publicPath}`, etag: put.etag, bytes };
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/** Indexed access that fails the test instead of returning undefined. */
function itemAt<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return item;
}

let points: AnalyticsEngineDataPoint[];
let originalWrite: typeof env.DELIVERY_ANALYTICS.writeDataPoint;

beforeEach(() => {
  points = [];
  originalWrite = env.DELIVERY_ANALYTICS.writeDataPoint;
  env.DELIVERY_ANALYTICS.writeDataPoint = (point) => {
    if (point !== undefined) {
      points.push(point);
    }
  };
});

afterEach(() => {
  env.DELIVERY_ANALYTICS.writeDataPoint = originalWrite;
});

async function waitForPoints(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(points).toHaveLength(count);
  });
}

// ---------------------------------------------------------------------------
// Full responses (section 14.2)
// ---------------------------------------------------------------------------

describe("GET /media/... full response", () => {
  it("returns 200 with the complete section 14.2 header set and exact bytes", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url);

    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Content-Length")).toBe(String(AUDIO_SIZE));
    expect(res.headers.get("ETag")).toBe(`"${media.etag}"`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const lastModified = res.headers.get("Last-Modified");
    expect(lastModified).not.toBeNull();
    expect(Number.isNaN(Date.parse(lastModified as string))).toBe(false);

    expect(await bodyBytes(res)).toEqual(media.bytes);
  });

  it("serves artwork with its stored content type", async () => {
    const artwork = await seedArtwork();
    const res = await SELF.fetch(artwork.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await bodyBytes(res)).toEqual(artwork.bytes);
  });
});

describe("HEAD /media/...", () => {
  it("returns identical headers to GET with no body", async () => {
    const media = await seedAudio();
    const getRes = await SELF.fetch(media.url);
    const res = await SELF.fetch(media.url, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    for (const name of [
      "Accept-Ranges",
      "Content-Type",
      "Content-Length",
      "ETag",
      "Last-Modified",
      "Cache-Control",
      "X-Content-Type-Options",
    ]) {
      expect(res.headers.get(name)).toBe(getRes.headers.get(name));
    }
  });

  it("ignores Range and returns full-entity headers", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, {
      method: "HEAD",
      headers: { Range: "bytes=0-1023" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(AUDIO_SIZE));
    expect(res.headers.get("Content-Range")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Byte ranges (sections 14.2 and 14.3)
// ---------------------------------------------------------------------------

describe("ranged GET /media/...", () => {
  it("serves bytes=0-1023 as 206 with exactly 1024 bytes", async () => {
    const media = await seedAudio();

    // Spot-check streaming: the worker must ask R2 for exactly the range
    // and pass the body through (no whole-object read).
    const realGet = env.MEDIA.get;
    const calls: Array<{ key: string; options: R2GetOptions | undefined }> = [];
    (env.MEDIA as { get: unknown }).get = function spy(
      this: R2Bucket,
      key: string,
      options?: R2GetOptions,
    ) {
      calls.push({ key, options });
      return (realGet as (k: string, o?: R2GetOptions) => Promise<R2ObjectBody | null>).call(
        this,
        key,
        options,
      );
    };

    let res: Response;
    try {
      res = await SELF.fetch(media.url, { headers: { Range: "bytes=0-1023" } });
    } finally {
      (env.MEDIA as { get: unknown }).get = realGet;
    }

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-1023/${AUDIO_SIZE}`);
    expect(res.headers.get("Content-Length")).toBe("1024");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");

    const body = await bodyBytes(res);
    expect(body.length).toBe(1024);
    expect(body).toEqual(media.bytes.slice(0, 1024));

    expect(calls).toHaveLength(1);
    expect(itemAt(calls, 0).options).toEqual({ range: { offset: 0, length: 1024 } });
  });

  it("serves a suffix range bytes=-100", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, { headers: { Range: "bytes=-100" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(
      `bytes ${AUDIO_SIZE - 100}-${AUDIO_SIZE - 1}/${AUDIO_SIZE}`,
    );
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(await bodyBytes(res)).toEqual(media.bytes.slice(AUDIO_SIZE - 100));
  });

  it("serves an open-ended range bytes=1024-", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, { headers: { Range: "bytes=1024-" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 1024-${AUDIO_SIZE - 1}/${AUDIO_SIZE}`);
    expect(res.headers.get("Content-Length")).toBe(String(AUDIO_SIZE - 1024));
    expect(await bodyBytes(res)).toEqual(media.bytes.slice(1024));
  });

  it("returns 416 with Content-Range bytes */TOTAL when the start is beyond the object", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, {
      headers: { Range: `bytes=${AUDIO_SIZE}-` },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${AUDIO_SIZE}`);
    expect(await res.text()).toBe("");
  });

  it("returns 416 for multiple ranges", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, {
      headers: { Range: "bytes=0-1,2-3" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${AUDIO_SIZE}`);
  });
});

// ---------------------------------------------------------------------------
// Conditional requests (section 14.4)
// ---------------------------------------------------------------------------

describe("conditional requests", () => {
  it("returns 304 for a matching If-None-Match", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, {
      headers: { "If-None-Match": `"${media.etag}"` },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("ETag")).toBe(`"${media.etag}"`);
  });

  it("returns 304 for If-Modified-Since at the Last-Modified time", async () => {
    const media = await seedAudio();
    const first = await SELF.fetch(media.url);
    const lastModified = first.headers.get("Last-Modified") as string;

    const res = await SELF.fetch(media.url, {
      headers: { "If-Modified-Since": lastModified },
    });
    expect(res.status).toBe(304);
  });

  it("returns 200 for a non-matching If-None-Match", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, {
      headers: { "If-None-Match": '"different-etag"' },
    });
    expect(res.status).toBe(200);
    expect(await bodyBytes(res)).toEqual(media.bytes);
  });

  it("falls back to the full 200 response when If-Range does not match", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, {
      headers: { Range: "bytes=0-1023", "If-Range": '"stale-etag"' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe(String(AUDIO_SIZE));
    expect(await bodyBytes(res)).toEqual(media.bytes);
  });

  it("honors the range when If-Range matches the current ETag", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, {
      headers: { Range: "bytes=0-1023", "If-Range": `"${media.etag}"` },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-1023/${AUDIO_SIZE}`);
  });
});

// ---------------------------------------------------------------------------
// Validation and 404s (section 14.1)
// ---------------------------------------------------------------------------

describe("path validation and object state", () => {
  interface ErrorBody {
    error: { code: string };
  }

  it("returns the 404 envelope for an orphaned object", async () => {
    const media = await seedAudio({ status: "orphaned" });
    const res = await SELF.fetch(media.url);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when no storage object row exists", async () => {
    const media = await seedAudio({ skipRow: true }); // bytes in R2, no D1 row
    const res = await SELF.fetch(media.url);
    expect(res.status).toBe(404);
  });

  it.each([
    [
      "malformed show UUID",
      (m: SeededMedia) => `${BASE}/media/not-a-uuid/${m.episodeId as string}/${m.objectId}.mp3`,
    ],
    [
      "malformed episode UUID",
      (m: SeededMedia) => `${BASE}/media/${m.showId}/xyz/${m.objectId}.mp3`,
    ],
    [
      "uppercase UUID",
      (m: SeededMedia) =>
        `${BASE}/media/${m.showId.toUpperCase()}/${m.episodeId as string}/${m.objectId}.mp3`,
    ],
    [
      "encoded traversal in file segment",
      (m: SeededMedia) =>
        `${BASE}/media/${m.showId}/${m.episodeId as string}/..%2f..%2ffeeds%2fx.mp3`,
    ],
    [
      "encoded traversal in id segment",
      (m: SeededMedia) => `${BASE}/media/${m.showId}/..%2f${m.objectId}.mp3/${m.objectId}.mp3`,
    ],
    [
      "wrong extension",
      (m: SeededMedia) => `${BASE}/media/${m.showId}/${m.episodeId as string}/${m.objectId}.m4a`,
    ],
    [
      "unexpected extension",
      (m: SeededMedia) => `${BASE}/media/${m.showId}/${m.episodeId as string}/${m.objectId}.exe`,
    ],
    [
      "artwork extension on the media route",
      (m: SeededMedia) => `${BASE}/media/${m.showId}/${m.episodeId as string}/${m.objectId}.jpg`,
    ],
    [
      "wrong show id",
      (m: SeededMedia) =>
        `${BASE}/media/${crypto.randomUUID()}/${m.episodeId as string}/${m.objectId}.mp3`,
    ],
    [
      "wrong episode id",
      (m: SeededMedia) => `${BASE}/media/${m.showId}/${crypto.randomUUID()}/${m.objectId}.mp3`,
    ],
  ])("rejects %s with 404", async (_name, buildUrl) => {
    const media = await seedAudio();
    const res = await SELF.fetch(buildUrl(media));
    expect(res.status).toBe(404);
  });

  it("rejects audio extensions on the artwork route", async () => {
    const artwork = await seedArtwork();
    const res = await SELF.fetch(`${BASE}/artwork/${artwork.showId}/${artwork.objectId}.mp3`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Delivery analytics (section 14.5)
// ---------------------------------------------------------------------------

describe("delivery analytics", () => {
  const UA = "Overcast/2026.1 (+http://overcast.fm/; iOS podcast app)";

  it("writes one event for a full GET with the documented shape", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, { headers: { "User-Agent": UA } });
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    await waitForPoints(1);
    const point = itemAt(points, 0);
    expect(point.indexes).toEqual([media.showId]);
    expect(point.blobs).toEqual([
      media.showId,
      media.episodeId,
      media.objectId,
      "GET",
      "200",
      expect.any(String) as unknown as string, // country; unavailable locally
      "overcast",
      "0",
    ]);
    expect(point.doubles).toEqual([AUDIO_SIZE, -1, -1, AUDIO_SIZE]);

    // Never the raw user-agent, never anything that looks like an IP.
    for (const blob of point.blobs ?? []) {
      expect(blob).not.toContain(UA);
      expect(blob).not.toContain("Overcast/");
      expect(String(blob)).not.toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    }
  });

  it("records range bounds and served bytes for a 206", async () => {
    const media = await seedAudio();
    const res = await SELF.fetch(media.url, { headers: { Range: "bytes=0-1023" } });
    expect(res.status).toBe(206);
    await res.arrayBuffer();

    await waitForPoints(1);
    const point = itemAt(points, 0);
    expect(point.blobs?.[4]).toBe("206");
    expect(point.blobs?.[7]).toBe("1"); // ranged
    expect(point.doubles).toEqual([1024, 0, 1023, AUDIO_SIZE]);
  });

  it("uses the artwork marker for artwork deliveries", async () => {
    const artwork = await seedArtwork();
    const res = await SELF.fetch(artwork.url);
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    await waitForPoints(1);
    expect(itemAt(points, 0).blobs?.[1]).toBe("artwork");
  });

  it("records HEAD and 416 responses with zero response bytes", async () => {
    const media = await seedAudio();

    const head = await SELF.fetch(media.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    await waitForPoints(1);
    expect(itemAt(points, 0).blobs?.[3]).toBe("HEAD");
    expect(itemAt(points, 0).doubles?.[0]).toBe(0);

    const unsatisfiable = await SELF.fetch(media.url, {
      headers: { Range: "bytes=999999-" },
    });
    expect(unsatisfiable.status).toBe(416);
    await waitForPoints(2);
    expect(itemAt(points, 1).blobs?.[4]).toBe("416");
    expect(itemAt(points, 1).doubles?.[0]).toBe(0);
  });

  it("records a 404 for a well-formed path whose object is inactive", async () => {
    const media = await seedAudio({ status: "orphaned" });
    const res = await SELF.fetch(media.url);
    expect(res.status).toBe(404);
    await waitForPoints(1);
    expect(itemAt(points, 0).blobs?.[4]).toBe("404");
  });

  it("writes nothing for malformed paths", async () => {
    const res = await SELF.fetch(`${BASE}/media/not-a-uuid/also-bad/nope.mp3`);
    expect(res.status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(points).toHaveLength(0);
  });
});
