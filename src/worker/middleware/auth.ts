import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../app-env";
import { verifySessionToken } from "../services/sessions";
import { errorResponse } from "./errors";

/** Signed session cookie (HttpOnly; Secure; SameSite=Strict; Path=/). */
export const SESSION_COOKIE_NAME = "castlet_session";

/** Non-HttpOnly CSRF cookie the SPA reads to fill X-CSRF-Token. */
export const CSRF_COOKIE_NAME = "castlet_csrf";

/** API paths reachable without a session (mvp-design.md section 15). */
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set(["/api/health", "/api/auth/login"]);

/**
 * Session-cookie verification for all /api/* routes except PUBLIC_API_PATHS.
 * On success the decoded session payload is stored in the `session` context
 * variable; on failure the request is rejected with 401 using the standard
 * error envelope.
 */
export function sessionAuth() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (PUBLIC_API_PATHS.has(c.req.path)) {
      return next();
    }

    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token !== undefined) {
      const payload = await verifySessionToken(c.env.SESSION_SIGNING_KEY, token);
      if (payload !== null) {
        c.set("session", payload);
        return next();
      }
    }

    return errorResponse(c, 401, "UNAUTHORIZED", "Authentication required");
  });
}
