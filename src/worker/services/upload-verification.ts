/**
 * File-signature verification for completed uploads. Checks operate on a
 * small initial byte range — never a complete object.
 */

/** Bytes to fetch with the single ranged GET at completion time. */
export const SIGNATURE_RANGE_BYTES = 32;

/** Farthest offset at which an M4A `ftyp` box may start ("near the beginning"). */
const MAX_FTYP_OFFSET = 28;

/** MP3: an ID3v2 tag or an MPEG frame sync (0xFF followed by 0xEx/0xFx). */
export function isMp3Signature(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true; // "ID3"
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return true; // MPEG frame sync: 11 set bits
  }
  return false;
}

/**
 * M4A: an ISO Base Media File Format `ftyp` box near the start. The box type
 * normally sits at offset 4 (after the 32-bit box size), but a small scan
 * tolerates unusual leading box sizes.
 */
export function isM4aSignature(bytes: Uint8Array): boolean {
  // "ftyp"
  const marker = [0x66, 0x74, 0x79, 0x70];
  for (let offset = 4; offset <= MAX_FTYP_OFFSET && offset + 4 <= bytes.length; offset += 1) {
    if (marker.every((byte, index) => bytes[offset + index] === byte)) {
      return true;
    }
  }
  return false;
}

/** JPEG: FF D8 FF. */
export function isJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** PNG: the standard eight-byte signature. */
export function isPngSignature(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= 8 && signature.every((byte, index) => bytes[index] === byte);
}

/** Dispatches to the signature check for the declared canonical MIME type. */
export function hasValidMediaSignature(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case "audio/mpeg":
      return isMp3Signature(bytes);
    case "audio/mp4":
      return isM4aSignature(bytes);
    case "image/jpeg":
      return isJpegSignature(bytes);
    case "image/png":
      return isPngSignature(bytes);
    default:
      return false;
  }
}
