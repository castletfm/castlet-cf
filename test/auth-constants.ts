/**
 * Auth values shared between vitest.config.ts (miniflare bindings) and the
 * tests themselves. Test-only values; never used in a real deployment.
 */

/** Plaintext operator access key used by tests. */
export const TEST_ADMIN_ACCESS_KEY = "castlet-test-access-key";

/** Lowercase SHA-256 hex digest of TEST_ADMIN_ACCESS_KEY. */
export const TEST_ADMIN_ACCESS_KEY_SHA256 =
  "07338ad7d0fededa5cad2d8547a571a8f36121f03e9e13f65eedacf620f1ed1b";

/** HMAC signing key for session tokens in tests. */
export const TEST_SESSION_SIGNING_KEY = "castlet-test-session-signing-key-32b";

/** Cloudflare's dummy "always passes" Turnstile secret (Siteverify is mocked in tests). */
export const TEST_TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
