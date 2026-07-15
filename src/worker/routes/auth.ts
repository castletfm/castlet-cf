import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import { SESSION_TTL_SECONDS } from "../../shared/constants";
import type { AppEnv } from "../app-env";
import type { Env } from "../env";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../middleware/auth";
import { errorResponse } from "../middleware/errors";
import { verifyAccessKey } from "../services/access-key";
import { createSessionToken } from "../services/sessions";
import { verifyTurnstileToken } from "../services/turnstile";

const loginSchema = z.object({
  accessKey: z.string().min(1),
  turnstileToken: z.string().min(1),
});

function sessionTtlSeconds(env: Env): number {
  const parsed = Number.parseInt(env.SESSION_TTL_SECONDS, 10);
  // 12-hour default (mvp-design.md section 10.2) when the var is missing/bad.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SESSION_TTL_SECONDS;
}

interface CookieAttributes {
  path: "/";
  secure: true;
  sameSite: "Strict";
  maxAge: number;
}

function cookieAttributes(maxAge: number): CookieAttributes {
  return { path: "/", secure: true, sameSite: "Strict", maxAge };
}

export const authRoutes = new Hono<AppEnv>();

// Public: the SPA fetches the Turnstile site key (public by nature) at
// runtime so the deployed wrangler var is the single source of truth.
authRoutes.get("/config", (c) => {
  return c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY });
});

// Public: protected by Turnstile + access key rather than a session.
authRoutes.post("/login", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, 400, "INVALID_REQUEST", "Expected a JSON request body");
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(c, 400, "INVALID_REQUEST", "Expected accessKey and turnstileToken");
  }

  const turnstileOk = await verifyTurnstileToken(
    c.env.TURNSTILE_SECRET_KEY,
    parsed.data.turnstileToken,
    c.req.header("CF-Connecting-IP"),
  );
  if (!turnstileOk) {
    return errorResponse(c, 403, "TURNSTILE_FAILED", "Turnstile verification failed");
  }

  const accessKeyOk = await verifyAccessKey(parsed.data.accessKey, c.env.ADMIN_ACCESS_KEY_SHA256);
  if (!accessKeyOk) {
    return errorResponse(c, 401, "INVALID_ACCESS_KEY", "Invalid access key");
  }

  const ttl = sessionTtlSeconds(c.env);
  const { token, payload } = await createSessionToken(c.env.SESSION_SIGNING_KEY, ttl);

  setCookie(c, SESSION_COOKIE_NAME, token, { ...cookieAttributes(ttl), httpOnly: true });
  setCookie(c, CSRF_COOKIE_NAME, payload.csrf, cookieAttributes(ttl));

  // Never echo the access key (or anything derived from it) back.
  return c.json({
    authenticated: true,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  });
});

// Requires a session; sessionAuth + csrfProtection run before this handler.
authRoutes.post("/logout", (c) => {
  setCookie(c, SESSION_COOKIE_NAME, "", { ...cookieAttributes(0), httpOnly: true });
  setCookie(c, CSRF_COOKIE_NAME, "", cookieAttributes(0));
  return c.json({ authenticated: false });
});

// Requires a session; reports session and CSRF-cookie status for the SPA.
authRoutes.get("/session", (c) => {
  const session = c.get("session");
  if (session === undefined) {
    // Defensive: sessionAuth() already rejects unauthenticated requests.
    return errorResponse(c, 401, "UNAUTHORIZED", "Authentication required");
  }

  const csrfCookie = getCookie(c, CSRF_COOKIE_NAME);
  return c.json({
    authenticated: true,
    expiresAt: new Date(session.exp * 1000).toISOString(),
    csrfCookiePresent: csrfCookie !== undefined,
    csrfCookieMatchesSession: csrfCookie === session.csrf,
  });
});
