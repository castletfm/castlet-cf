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
