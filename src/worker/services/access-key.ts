/**
 * Operator access-key verification.
 *
 * The submitted key is hashed with SHA-256 via Web Crypto and compared
 * against the stored lowercase hex digest (ADMIN_ACCESS_KEY_SHA256) as
 * fixed-length byte arrays in constant time.
 *
 * Never log the submitted key, the digest, or the comparison result detail.
 */

const SHA256_BYTE_LENGTH = 32;

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length !== SHA256_BYTE_LENGTH * 2 || !/^[0-9a-f]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(SHA256_BYTE_LENGTH);
  for (let i = 0; i < SHA256_BYTE_LENGTH; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Returns true when SHA-256(submittedKey) equals `expectedSha256Hex`.
 * The digests are compared with `crypto.subtle.timingSafeEqual`, which
 * requires (and here always receives) equal-length inputs.
 */
export async function verifyAccessKey(
  submittedKey: string,
  expectedSha256Hex: string,
): Promise<boolean> {
  const digestBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(submittedKey),
  );
  const submittedDigest = new Uint8Array(digestBuffer);

  const expectedDigest = hexToBytes(expectedSha256Hex.toLowerCase());
  if (expectedDigest === null) {
    // Misconfigured secret: fail closed without comparing.
    return false;
  }

  return crypto.subtle.timingSafeEqual(submittedDigest, expectedDigest);
}
