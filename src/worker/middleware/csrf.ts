import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../app-env";
import { CSRF_COOKIE_NAME } from "./auth";
import { errorResponse } from "./errors";

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF and origin checks for authenticated state-changing requests
 * (mvp-design.md section 10.3):
 *
 * - `Origin` must match PUBLIC_BASE_URL exactly;
 * - `Content-Type` must be application/json;
 * - `X-CSRF-Token` must equal both the CSRF cookie and the CSRF token
 *   embedded in the signed session.
 *
 * Runs after sessionAuth(): requests without a session variable are public
 * paths (login is protected by Turnstile instead) — everything else was
 * already rejected with 401.
 */
export function csrfProtection() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      return next();
    }

    const session = c.get("session");
    if (session === undefined) {
      return next();
    }

    const expectedOrigin = new URL(c.env.PUBLIC_BASE_URL).origin;
    if (c.req.header("Origin") !== expectedOrigin) {
      return errorResponse(c, 403, "ORIGIN_MISMATCH", "Origin check failed");
    }

    const contentType = c.req.header("Content-Type") ?? "";
    const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return errorResponse(
        c,
        403,
        "UNSUPPORTED_CONTENT_TYPE",
        "Content-Type must be application/json",
      );
    }

    const headerToken = c.req.header("X-CSRF-Token");
    const cookieToken = getCookie(c, CSRF_COOKIE_NAME);
    if (
      headerToken === undefined ||
      headerToken.length === 0 ||
      headerToken !== cookieToken ||
      headerToken !== session.csrf
    ) {
      return errorResponse(c, 403, "CSRF_MISMATCH", "CSRF validation failed");
    }

    return next();
  });
}
