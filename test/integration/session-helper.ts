import { createSessionToken } from "../../src/worker/services/sessions";
import { TEST_SESSION_SIGNING_KEY } from "../auth-constants";

/**
 * Authenticated-request helpers for integration tests.
 *
 * Instead of driving the full login flow (which needs a Turnstile Siteverify
 * stub, covered by auth.test.ts), tests mint a signed session token directly
 * with the same signing key the worker uses in vitest.config.ts.
 */

export const BASE = "http://example.com";
export const ORIGIN = "http://example.com"; // must equal PUBLIC_BASE_URL's origin

export interface AuthContext {
  cookieHeader: string;
  csrfToken: string;
}

/**
 * D1 storage persists across tests within a file (the Vitest 4 workers pool
 * has no per-test isolated storage), so unique-constrained values like show
 * slugs must be unique per test.
 */
export function uniqueSlug(prefix = "show"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createAuthContext(): Promise<AuthContext> {
  const { token, payload } = await createSessionToken(TEST_SESSION_SIGNING_KEY, 3600);
  return {
    cookieHeader: `castlet_session=${token}; castlet_csrf=${payload.csrf}`,
    csrfToken: payload.csrf,
  };
}

/** Headers for GET requests. */
export function readHeaders(auth: AuthContext): Record<string, string> {
  return { Cookie: auth.cookieHeader };
}

/** Headers for state-changing requests (origin + CSRF checks apply). */
export function writeHeaders(auth: AuthContext): Record<string, string> {
  return {
    Cookie: auth.cookieHeader,
    "Content-Type": "application/json",
    Origin: ORIGIN,
    "X-CSRF-Token": auth.csrfToken,
  };
}
