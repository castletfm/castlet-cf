/**
 * HMAC-SHA256 signed session tokens (mvp-design.md section 10.2).
 *
 * Token format: `base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)`.
 * The payload carries `iat`, `exp` (Unix seconds), and the CSRF token that
 * state-changing requests must echo in the X-CSRF-Token header.
 *
 * Never log tokens or the signing key.
 */

export interface SessionPayload {
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Expiry, Unix seconds (exclusive: token is invalid at or after this time). */
  exp: number;
  /** Random CSRF token bound to this session. */
  csrf: string;
}

const encoder = new TextEncoder();

async function importSigningKey(signingKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Generates a random URL-safe CSRF token (32 random bytes). */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Creates a signed session token valid for `ttlSeconds` from `nowMs`.
 * Returns the token together with its decoded payload.
 */
export async function createSessionToken(
  signingKey: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): Promise<{ token: string; payload: SessionPayload }> {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = {
    iat,
    exp: iat + ttlSeconds,
    csrf: generateCsrfToken(),
  };

  const payloadPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importSigningKey(signingKey);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadPart));
  const signaturePart = toBase64Url(new Uint8Array(signature));

  return { token: `${payloadPart}.${signaturePart}`, payload };
}

/**
 * Verifies a session token. Returns the payload when the signature is valid
 * and the token has not expired; otherwise returns null.
 *
 * `crypto.subtle.verify` performs the constant-time signature comparison, so
 * tampered payloads and signatures are rejected without leaking timing.
 */
export async function verifySessionToken(
  signingKey: string,
  token: string,
  nowMs = Date.now(),
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return null;
  }
  const [payloadPart, signaturePart] = parts;

  const signature = fromBase64Url(signaturePart);
  if (signature === null) {
    return null;
  }

  const key = await importSigningKey(signingKey);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payloadPart));
  if (!valid) {
    return null;
  }

  const payloadBytes = fromBase64Url(payloadPart);
  if (payloadBytes === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!isSessionPayload(parsed)) {
    return null;
  }
  if (Math.floor(nowMs / 1000) >= parsed.exp) {
    return null;
  }
  return parsed;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.iat === "number" &&
    Number.isFinite(record.iat) &&
    typeof record.exp === "number" &&
    Number.isFinite(record.exp) &&
    typeof record.csrf === "string" &&
    record.csrf.length > 0
  );
}
