import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { errorResponse } from "../middleware/errors";
import { FEED_CACHE_CONTROL, FEED_CONTENT_TYPE, feedObjectKey } from "../services/feed-sync";
import { isNotModified } from "../services/http-conditional";

/**
 * Public RSS feed delivery:
 * GET/HEAD /feeds/{slug}.xml. Mounted at /feeds with no authentication.
 *
 * The endpoint only reads the canonical, already-generated R2 object
 * (feeds/{slug}.xml); it never queries D1 or builds XML per listener
 * request. Feed requests write no delivery analytics (section 14.5 covers
 * media responses only).
 */

/** {slug}.xml where slug follows the section 9.1 slug rule, capped like the API. */
const FEED_FILE_PATTERN = /^([a-z0-9][a-z0-9-]{0,99})\.xml$/;

function feedHeaders(object: R2Object): Headers {
  const headers = new Headers({
    "Content-Type": FEED_CONTENT_TYPE,
    "Cache-Control": FEED_CACHE_CONTROL,
    ETag: object.httpEtag,
    "Last-Modified": object.uploaded.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  });
  return headers;
}

export const feedRoutes = new Hono<AppEnv>();

feedRoutes.on(["GET", "HEAD"], "/:file", async (c) => {
  const slug = FEED_FILE_PATTERN.exec(c.req.param("file"))?.[1];
  if (slug === undefined) {
    return errorResponse(c, 404, "NOT_FOUND", "Feed not found");
  }
  const key = feedObjectKey(slug);
  const isHead = c.req.method === "HEAD";
  const conditional = {
    ifNoneMatch: c.req.header("If-None-Match"),
    ifModifiedSince: c.req.header("If-Modified-Since"),
  };
  const hasConditional =
    conditional.ifNoneMatch !== undefined || conditional.ifModifiedSince !== undefined;

  // HEAD and conditional evaluation use metadata only, so no body stream is
  // ever opened for a 304. A conditional GET that turns out stale costs one
  // extra class B read, which is rare for a feed that changes infrequently.
  if (isHead || hasConditional) {
    const meta = await c.env.MEDIA.head(key);
    if (meta === null) {
      return errorResponse(c, 404, "NOT_FOUND", "Feed not found");
    }
    const headers = feedHeaders(meta);
    if (isNotModified(conditional, meta.httpEtag, meta.uploaded)) {
      return new Response(null, { status: 304, headers });
    }
    if (isHead) {
      headers.set("Content-Length", String(meta.size));
      return new Response(null, { status: 200, headers });
    }
  }

  const object = await c.env.MEDIA.get(key);
  if (object === null) {
    return errorResponse(c, 404, "NOT_FOUND", "Feed not found");
  }
  const headers = feedHeaders(object);
  headers.set("Content-Length", String(object.size));
  // Stream the canonical XML directly from R2.
  return new Response(object.body, { status: 200, headers });
});
