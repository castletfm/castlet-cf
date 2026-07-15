import { Hono } from "hono";
import type { Context } from "hono";

import { MEDIA_CACHE_MAX_AGE_SECONDS } from "../../shared/constants";
import type { AppEnv } from "../app-env";
import { errorResponse } from "../middleware/errors";
import { getActiveStorageObjectByPublicPath, type StorageObjectRow } from "../services/db";
import {
  ARTWORK_MARKER,
  classifyClientFamily,
  writeDeliveryEvent,
} from "../services/delivery-analytics";
import { isNotModified } from "../services/http-conditional";
import { parseRangeHeader } from "../services/range";

/**
 * Public immutable media delivery (mvp-design.md sections 14 and 4.2):
 *
 *   GET|HEAD /artwork/{showId}/{objectId}.{ext}
 *   GET|HEAD /media/{showId}/{episodeId}/{objectId}.{ext}
 *
 * Mounted at /artwork and /media with no authentication. Every path
 * segment is validated (UUID shape, expected extension) and the R2 key is
 * derived only from the validated components; a raw request path is never
 * passed to R2. The storage object must exist in D1, be ACTIVE, and match
 * the derived public path and owner IDs.
 *
 * If-Range is implemented for exact ETag matches only: when an If-Range
 * header is present and is not exactly the current quoted ETag (including
 * HTTP-date validators, which are not supported), the range is ignored and
 * the full 200 response is served — the safe fallback required by section
 * 14.4. HEAD ignores Range and returns full-entity headers (RFC 9110
 * permits this).
 */

const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SEGMENT}$`);
const FILE_PATTERN = new RegExp(`^(${UUID_SEGMENT})\\.([a-z0-9]{1,5})$`);

/** Expected public extensions per media kind (section 11.1 canonical names). */
const KIND_EXTENSIONS: Record<"artwork" | "audio", ReadonlySet<string>> = {
  artwork: new Set(["jpg", "jpeg", "png"]),
  audio: new Set(["mp3", "m4a"]),
};

const MEDIA_CACHE_CONTROL = `public, max-age=${MEDIA_CACHE_MAX_AGE_SECONDS}, immutable`;

interface MediaTarget {
  kind: "artwork" | "audio";
  showId: string;
  /** null for artwork. */
  episodeId: string | null;
  objectId: string;
  /** Public path rebuilt from validated segments only. */
  publicPath: string;
  /** R2 object key derived from validated segments only. */
  objectKey: string;
}

/** Validates path segments and derives the target; null means 404. */
function resolveTarget(
  kind: "artwork" | "audio",
  showId: string,
  episodeId: string | null,
  file: string,
): MediaTarget | null {
  if (!UUID_PATTERN.test(showId)) {
    return null;
  }
  if (kind === "audio" && (episodeId === null || !UUID_PATTERN.test(episodeId))) {
    return null;
  }
  const match = FILE_PATTERN.exec(file);
  const objectId = match?.[1];
  const extension = match?.[2];
  if (objectId === undefined || extension === undefined || !KIND_EXTENSIONS[kind].has(extension)) {
    return null;
  }
  if (kind === "artwork") {
    return {
      kind,
      showId,
      episodeId: null,
      objectId,
      publicPath: `/artwork/${showId}/${objectId}.${extension}`,
      objectKey: `artwork/${showId}/${objectId}.${extension}`,
    };
  }
  return {
    kind,
    showId,
    episodeId,
    objectId,
    publicPath: `/media/${showId}/${episodeId}/${objectId}.${extension}`,
    objectKey: `audio/${showId}/${episodeId}/${objectId}.${extension}`,
  };
}

/** True when the D1 row is exactly the object the validated path names. */
function rowMatchesTarget(row: StorageObjectRow, target: MediaTarget): boolean {
  const ownerMatches =
    target.kind === "artwork"
      ? row.owner_kind === "show" && row.owner_id === target.showId
      : row.owner_kind === "episode" && row.owner_id === target.episodeId;
  return (
    row.id === target.objectId &&
    row.kind === target.kind &&
    row.object_key === target.objectKey &&
    ownerMatches
  );
}

/** Complete-response header set (section 14.2), minus Content-Length. */
function mediaHeaders(contentType: string, object: R2Object): Headers {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    ETag: object.httpEtag,
    "Last-Modified": object.uploaded.toUTCString(),
    "Cache-Control": MEDIA_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
  });
}

interface DeliveryOutcome {
  status: number;
  ranged: boolean;
  responseBytes: number;
  rangeStart: number | null;
  rangeEnd: number | null;
}

async function serveMedia(c: Context<AppEnv>, target: MediaTarget): Promise<Response> {
  const totalForEvent = { value: 0 };

  // One event per response, after the response is determined (section 14.5).
  // Dimensions never include raw IPs or full user-agent strings.
  const record = (outcome: DeliveryOutcome): void => {
    const country = c.req.raw.cf?.country;
    const event = {
      showId: target.showId,
      episodeMarker: target.episodeId ?? ARTWORK_MARKER,
      objectId: target.objectId,
      method: c.req.method,
      status: outcome.status,
      country: typeof country === "string" ? country : "",
      clientFamily: classifyClientFamily(c.req.header("User-Agent")),
      ranged: outcome.ranged,
      responseBytes: outcome.responseBytes,
      rangeStart: outcome.rangeStart,
      rangeEnd: outcome.rangeEnd,
      totalBytes: totalForEvent.value,
    };
    c.executionCtx.waitUntil(
      Promise.resolve().then(() => {
        writeDeliveryEvent(c.env.DELIVERY_ANALYTICS, event);
      }),
    );
  };

  const notFound = (): Response => {
    record({ status: 404, ranged: false, responseBytes: 0, rangeStart: null, rangeEnd: null });
    return errorResponse(c, 404, "NOT_FOUND", "Media not found");
  };

  // Indexed lookup (public_path is UNIQUE); active objects only. Active
  // objects always carry a positive verified size and an ETag; anything
  // else is not publicly servable.
  const row = await getActiveStorageObjectByPublicPath(c.env.DB, target.publicPath);
  if (
    row === null ||
    !rowMatchesTarget(row, target) ||
    row.byte_length === null ||
    row.byte_length <= 0 ||
    row.etag === null
  ) {
    return notFound();
  }
  const size = row.byte_length;
  const quotedEtag = `"${row.etag}"`;
  totalForEvent.value = size;

  const conditional = {
    ifNoneMatch: c.req.header("If-None-Match"),
    ifModifiedSince: c.req.header("If-Modified-Since"),
  };
  const hasConditional =
    conditional.ifNoneMatch !== undefined || conditional.ifModifiedSince !== undefined;

  // HEAD ignores Range and returns full-entity headers, and conditional
  // requests are evaluated on metadata only, so a 304 never opens a body
  // stream. A conditional GET that proves stale costs one extra class B
  // read; with immutable objects a stale If-None-Match effectively never
  // happens.
  if (c.req.method === "HEAD" || hasConditional) {
    const meta = await c.env.MEDIA.head(target.objectKey);
    if (meta === null) {
      return notFound();
    }
    const headers = mediaHeaders(row.content_type, meta);
    if (isNotModified(conditional, meta.httpEtag, meta.uploaded)) {
      record({ status: 304, ranged: false, responseBytes: 0, rangeStart: null, rangeEnd: null });
      return new Response(null, { status: 304, headers });
    }
    if (c.req.method === "HEAD") {
      headers.set("Content-Length", String(size));
      record({ status: 200, ranged: false, responseBytes: 0, rangeStart: null, rangeEnd: null });
      return new Response(null, { status: 200, headers });
    }
  }

  let range = parseRangeHeader(c.req.header("Range"), size);
  if (range.kind === "invalid") {
    // Unsatisfiable or multiple range (section 14.2); no R2 read needed.
    record({ status: 416, ranged: false, responseBytes: 0, rangeStart: null, rangeEnd: null });
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (range.kind === "valid") {
    // If-Range: honor the range only on an exact quoted-ETag match; any
    // mismatch (or a date validator) downgrades to the full response.
    const ifRange = c.req.header("If-Range");
    if (ifRange !== undefined && ifRange !== quotedEtag) {
      range = { kind: "none" };
    }
  }

  if (range.kind === "valid") {
    const length = range.end - range.start + 1;
    // Ranged R2 read; the body is streamed, never buffered (section 14.3).
    const object = await c.env.MEDIA.get(target.objectKey, {
      range: { offset: range.start, length },
    });
    if (object === null) {
      return notFound();
    }
    const headers = mediaHeaders(row.content_type, object);
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(length));
    record({
      status: 206,
      ranged: true,
      responseBytes: length,
      rangeStart: range.start,
      rangeEnd: range.end,
    });
    return new Response(object.body, { status: 206, headers });
  }

  // Complete response; the body is streamed directly from R2.
  const object = await c.env.MEDIA.get(target.objectKey);
  if (object === null) {
    return notFound();
  }
  const headers = mediaHeaders(row.content_type, object);
  headers.set("Content-Length", String(size));
  record({ status: 200, ranged: false, responseBytes: size, rangeStart: null, rangeEnd: null });
  return new Response(object.body, { status: 200, headers });
}

export const artworkRoutes = new Hono<AppEnv>();

artworkRoutes.on(["GET", "HEAD"], "/:showId/:file", async (c) => {
  const target = resolveTarget("artwork", c.req.param("showId"), null, c.req.param("file"));
  if (target === null) {
    // Malformed path segments: no meaningful analytics dimensions exist.
    return errorResponse(c, 404, "NOT_FOUND", "Media not found");
  }
  return serveMedia(c, target);
});

export const mediaRoutes = new Hono<AppEnv>();

mediaRoutes.on(["GET", "HEAD"], "/:showId/:episodeId/:file", async (c) => {
  const target = resolveTarget(
    "audio",
    c.req.param("showId"),
    c.req.param("episodeId"),
    c.req.param("file"),
  );
  if (target === null) {
    return errorResponse(c, 404, "NOT_FOUND", "Media not found");
  }
  return serveMedia(c, target);
});
