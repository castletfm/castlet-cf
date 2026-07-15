/**
 * Client-side artwork image checks.
 *
 * `checkArtworkDimensions` is a pure predicate. `readImageDimensions` reads the
 * pixel dimensions from a bounded prefix of the file's PNG/JPEG header without
 * decoding the full bitmap. Both are unit-tested. The Worker re-checks reported
 * dimensions on completion, so these are convenience guards, not the source of
 * truth.
 */

/** Minimum square artwork edge in pixels (section 11.1). */
export const MIN_ARTWORK_DIMENSION = 1400;

/** Maximum square artwork edge in pixels (section 11.1). */
export const MAX_ARTWORK_DIMENSION = 3000;

/**
 * Bytes read from the head of the file to locate the PNG/JPEG dimension fields.
 * The PNG IHDR sits in the first 24 bytes; a JPEG SOF frame header follows a
 * handful of segments whose lengths we walk, so 64 KiB comfortably covers real
 * headers (including a full 64 KiB EXIF/APP segment) while keeping the read
 * small and bounded — we never buffer or decode the whole image.
 */
const HEADER_READ_BYTES = 65536;

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface DimensionCheck {
  ok: boolean;
  /** Reason the image is unacceptable, or null when ok. */
  reason: string | null;
}

/**
 * Check that artwork is square and within the allowed pixel range. Returns the
 * first failing reason so the UI can show a single, specific message.
 */
export function checkArtworkDimensions(width: number, height: number): DimensionCheck {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return { ok: false, reason: "Could not read valid image dimensions." };
  }
  if (width !== height) {
    return { ok: false, reason: `Artwork must be square; got ${width}×${height}.` };
  }
  if (width < MIN_ARTWORK_DIMENSION) {
    return {
      ok: false,
      reason: `Artwork must be at least ${MIN_ARTWORK_DIMENSION}×${MIN_ARTWORK_DIMENSION}; got ${width}×${height}.`,
    };
  }
  if (width > MAX_ARTWORK_DIMENSION) {
    return {
      ok: false,
      reason: `Artwork must be at most ${MAX_ARTWORK_DIMENSION}×${MAX_ARTWORK_DIMENSION}; got ${width}×${height}.`,
    };
  }
  return { ok: true, reason: null };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Extract dimensions from a PNG header. The IHDR chunk is mandatory and first,
 * so width/height live at fixed big-endian offsets 16 and 20. Returns null if
 * the signature or IHDR type is wrong, or the slice is too short.
 */
function parsePngDimensions(view: DataView): ImageDimensions | null {
  if (view.byteLength < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (view.getUint8(i) !== PNG_SIGNATURE[i]) return null;
  }
  // IHDR chunk type "IHDR" at bytes 12..15 (after the 4-byte length at 8..11).
  if (
    view.getUint8(12) !== 0x49 ||
    view.getUint8(13) !== 0x48 ||
    view.getUint8(14) !== 0x44 ||
    view.getUint8(15) !== 0x52
  ) {
    return null;
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/**
 * A Start-Of-Frame marker carries the frame's width/height. SOFn is 0xC0..0xCF
 * excluding the non-frame markers DHT (0xC4), JPGn extension (0xC8), and DAC
 * (0xCC).
 */
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Extract dimensions from a JPEG header by walking segment markers to the SOF
 * frame header, reading only the bounded slice. Returns null if the SOI is
 * missing, the marker stream is malformed, or no SOF appears before the slice
 * ends (fail safe: the caller rejects).
 */
function parseJpegDimensions(view: DataView): ImageDimensions | null {
  const length = view.byteLength;
  if (length < 4 || view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < length) {
    if (view.getUint8(offset) !== 0xff) return null; // marker stream misaligned
    let marker = view.getUint8(offset + 1);
    // Skip fill bytes: any number of 0xFF may pad before a marker.
    while (marker === 0xff && offset + 2 < length) {
      offset += 1;
      marker = view.getUint8(offset + 1);
    }
    // Standalone markers (RSTn 0xD0..0xD7, TEM 0x01) carry no length payload.
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    // End-of-image or start-of-scan: pixel data begins, no frame header found.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 4 > length) return null;
    const segLength = view.getUint16(offset + 2, false);
    if (segLength < 2) return null; // malformed segment length
    if (isSofMarker(marker)) {
      // SOF payload: precision(1), height(2), width(2) after the length field.
      if (offset + 9 > length) return null;
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      if (width < 1 || height < 1) return null;
      return { width, height };
    }
    offset += 2 + segLength;
  }
  return null;
}

/**
 * Read the pixel dimensions of an image from its file header, decoding NO
 * bitmap.
 *
 * Untrusted-bytes safety contract: this reads only a bounded prefix
 * (`HEADER_READ_BYTES`) of the file via `file.slice(...).arrayBuffer()` and
 * parses the PNG IHDR chunk or the JPEG SOF frame header for width/height. It
 * NEVER calls `createImageBitmap` and NEVER sets `<img>.src`, so a small
 * compressed file that advertises enormous pixel dimensions (a decompression
 * bomb — e.g. a few-KB PNG claiming 30000×30000) is measured, not decoded: the
 * sole caller (components/uploaders.tsx `ArtworkUploader.onSelect`) then runs
 * `checkArtworkDimensions` on the returned dimensions and rejects an oversized
 * or non-square image before any full-bitmap decode could OOM or hang the tab.
 *
 * Zero-byte, truncated, malformed, or non-PNG/non-JPEG input yields no readable
 * header and REJECTS by throwing, which the caller's try/catch turns into the
 * safe "Could not read the selected image." banner. Every bad or hostile input
 * therefore fails safe, satisfying the threat-model requirement that client
 * parsing never crash or hang on a malformed/oversized file.
 */
export async function readImageDimensions(file: Blob): Promise<ImageDimensions> {
  const buffer = await file.slice(0, HEADER_READ_BYTES).arrayBuffer();
  const view = new DataView(buffer);
  const dims = parsePngDimensions(view) ?? parseJpegDimensions(view);
  if (dims === null) {
    throw new Error("Could not read image dimensions from the file header.");
  }
  return dims;
}
