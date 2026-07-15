import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { errorResponse } from "../middleware/errors";

/**
 * Development/test-only upload shim.
 *
 * The production upload path is browser -> presigned PUT -> R2 S3 endpoint
 * (`https://{account}.r2.cloudflarestorage.com/...`). A local `wrangler dev`
 * has no reachable S3 endpoint for its local R2 bucket, so the Playwright e2e
 * cannot land bytes there with a real presigned PUT. This route lets the e2e
 * write the uploaded bytes straight into the Worker's own R2 binding (the same
 * local bucket the completion HEAD then reads). Playwright reroutes the
 * browser's PUT to this endpoint; nothing else calls it.
 *
 * It is inert unless the `E2E_UPLOAD_SHIM` var is exactly "1". That var is
 * absent from wrangler.jsonc `vars` and from .dev.vars.example, so a real
 * deployment never enables it and the endpoint always returns 404 there. The
 * route is registered unconditionally (the Hono app is built once at module
 * load, before any request env is available) but gated per request.
 */
export const e2eShimRoutes = new Hono<AppEnv>();

const SHIM_PREFIX = "/__e2e/r2/";

e2eShimRoutes.put("/r2/*", async (c) => {
  if (c.env.E2E_UPLOAD_SHIM !== "1") {
    return errorResponse(c, 404, "NOT_FOUND", "Not found");
  }

  // The object key is everything after the mount prefix, matching the key the
  // presigned PUT would have targeted (e.g. audio/{show}/{ep}/{obj}.mp3).
  const index = c.req.path.indexOf(SHIM_PREFIX);
  const objectKey = index === -1 ? "" : c.req.path.slice(index + SHIM_PREFIX.length);
  if (objectKey === "") {
    return errorResponse(c, 400, "INVALID_REQUEST", "Missing object key");
  }

  const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
  // Test fixtures are small; buffering here keeps the shim simple and lets R2
  // store an exact length. This is never the production upload path.
  const body = await c.req.arrayBuffer();
  await c.env.MEDIA.put(objectKey, body, { httpMetadata: { contentType } });

  return c.body(null, 200);
});
