import { describe, expect, it } from "vitest";

import { createSessionToken, verifySessionToken } from "../../src/worker/services/sessions";

const KEY = "unit-test-signing-key";
const TTL = 3600;

function decodeBase64Url(part: string): string {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
}

function encodeBase64Url(raw: string): string {
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("session tokens", () => {
  it("round trips: sign then verify returns the payload", async () => {
    const now = Date.now();
    const { token, payload } = await createSessionToken(KEY, TTL, now);

    expect(payload.exp - payload.iat).toBe(TTL);
    expect(payload.csrf.length).toBeGreaterThanOrEqual(32);

    const verified = await verifySessionToken(KEY, token, now);
    expect(verified).toEqual(payload);
  });

  it("rejects an expired token", async () => {
    const now = Date.now();
    const { token } = await createSessionToken(KEY, TTL, now);

    const justBeforeExpiry = now + (TTL - 1) * 1000;
    expect(await verifySessionToken(KEY, token, justBeforeExpiry)).not.toBeNull();

    const atExpiry = now + TTL * 1000;
    expect(await verifySessionToken(KEY, token, atExpiry)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const now = Date.now();
    const { token } = await createSessionToken(KEY, TTL, now);
    const [payloadPart, signaturePart] = token.split(".") as [string, string];

    const decoded = JSON.parse(decodeBase64Url(payloadPart)) as { exp: number };
    decoded.exp += 86_400; // try to extend the session
    const forged = `${encodeBase64Url(JSON.stringify(decoded))}.${signaturePart}`;

    expect(await verifySessionToken(KEY, forged, now)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const now = Date.now();
    const { token } = await createSessionToken(KEY, TTL, now);
    const [payloadPart, signaturePart] = token.split(".") as [string, string];

    const flipped = signaturePart.startsWith("A")
      ? `B${signaturePart.slice(1)}`
      : `A${signaturePart.slice(1)}`;

    expect(await verifySessionToken(KEY, `${payloadPart}.${flipped}`, now)).toBeNull();
  });

  it("rejects a token signed with a different key", async () => {
    const now = Date.now();
    const { token } = await createSessionToken("some-other-key", TTL, now);
    expect(await verifySessionToken(KEY, token, now)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", ".", "a.b.c", "not-a-token", "onlyonepart", "!!.!!"]) {
      expect(await verifySessionToken(KEY, bad)).toBeNull();
    }
  });
});
