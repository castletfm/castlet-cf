/**
 * Client-side artwork image checks (mvp-design.md sections 11.1 and 16).
 *
 * The pure predicate `checkArtworkDimensions` is unit-tested; the DOM decode
 * helper `readImageDimensions` runs only in the browser. The Worker re-checks
 * reported dimensions on completion, so these are convenience guards, not the
 * source of truth.
 */

/** Minimum square artwork edge in pixels (section 11.1). */
export const MIN_ARTWORK_DIMENSION = 1400;

/** Maximum square artwork edge in pixels (section 11.1). */
export const MAX_ARTWORK_DIMENSION = 3000;

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

/**
 * Decode an image file just far enough to read its pixel dimensions. Uses
 * `createImageBitmap` when available and falls back to an `<img>` element.
 * Browser-only; not exercised by unit tests.
 *
 * Untrusted-bytes safety contract (verify at the sole caller,
 * components/uploaders.tsx `ArtworkUploader.onSelect`): the caller runs a
 * content-type sniff and the MAX_ARTWORK_BYTES (10 MiB) size cap BEFORE calling
 * this — see uploaders.tsx:123-131 — so the blob handed here is already
 * bounded, and it wraps this call in try/catch (uploaders.tsx:132-143). Both
 * decode paths REJECT on bad bytes: `createImageBitmap` rejects on a
 * malformed/truncated/zero-byte blob, and the `<img>` fallback rejects via
 * `onerror`. A rejection therefore surfaces as the safe "Could not read the
 * selected image." banner, never an unhandled crash or hang — so accidental
 * corrupt/truncated input fails safe, which is the threat-model requirement.
 * The only remaining path is a deliberately crafted valid-but-huge-dimension
 * decompression bomb; that is a trusted operator feeding hostile bytes to their
 * OWN browser (an explicit Non-goal) and is bounded by the 10 MiB cap and the
 * off-thread async decoder. Falsifiable: if any caller invokes this without a
 * prior size cap or outside a try/catch, that caller is the defect, not this.
 */
export async function readImageDimensions(file: Blob): Promise<ImageDimensions> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  return await new Promise<ImageDimensions>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the selected image."));
    };
    img.src = url;
  });
}
