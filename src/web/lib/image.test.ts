import { describe, expect, it } from "vitest";

import {
  checkArtworkDimensions,
  MAX_ARTWORK_DIMENSION,
  MIN_ARTWORK_DIMENSION,
  readImageDimensions,
} from "./image";

describe("checkArtworkDimensions", () => {
  it("accepts a square image inside the allowed range", () => {
    expect(checkArtworkDimensions(1400, 1400)).toEqual({ ok: true, reason: null });
    expect(checkArtworkDimensions(3000, 3000)).toEqual({ ok: true, reason: null });
    expect(checkArtworkDimensions(2000, 2000).ok).toBe(true);
  });

  it("rejects non-square images", () => {
    const result = checkArtworkDimensions(1400, 1500);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("square");
  });

  it("rejects images below the minimum edge", () => {
    const result = checkArtworkDimensions(MIN_ARTWORK_DIMENSION - 1, MIN_ARTWORK_DIMENSION - 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("at least");
  });

  it("rejects images above the maximum edge", () => {
    const result = checkArtworkDimensions(MAX_ARTWORK_DIMENSION + 1, MAX_ARTWORK_DIMENSION + 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("at most");
  });

  it("rejects zero, negative, or non-integer dimensions", () => {
    expect(checkArtworkDimensions(0, 0).ok).toBe(false);
    expect(checkArtworkDimensions(-1400, -1400).ok).toBe(false);
    expect(checkArtworkDimensions(1400.5, 1400.5).ok).toBe(false);
  });
});

/** Build a minimal PNG header (signature + IHDR) with the given dimensions. */
function pngHeader(width: number, height: number): Blob {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR chunk length (13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false); // width, big-endian
  view.setUint32(20, height, false); // height, big-endian
  return new Blob([bytes], { type: "image/png" });
}

/** Build a minimal JPEG header (SOI + APP0/JFIF + SOF0) with the given dimensions. */
function jpegHeader(width: number, height: number): Blob {
  const bytes = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10, // APP0, length 16
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00, // "JFIF\0"
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // JFIF payload remainder
    0xff,
    0xc0,
    0x00,
    0x11, // SOF0, length 17
    0x08, // sample precision
    (height >> 8) & 0xff,
    height & 0xff, // height, big-endian
    (width >> 8) & 0xff,
    width & 0xff, // width, big-endian
    0x03, // component count
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01, // component specs
  ]);
  return new Blob([bytes], { type: "image/jpeg" });
}

describe("readImageDimensions", () => {
  it("reads dimensions from a valid square PNG header within range", async () => {
    const dims = await readImageDimensions(pngHeader(1400, 1400));
    expect(dims).toEqual({ width: 1400, height: 1400 });
    expect(checkArtworkDimensions(dims.width, dims.height).ok).toBe(true);
  });

  it("reads dimensions from a valid JPEG header", async () => {
    const dims = await readImageDimensions(jpegHeader(2000, 2000));
    expect(dims).toEqual({ width: 2000, height: 2000 });
  });

  it("measures an oversized PNG from the header without decoding, so the caller rejects", async () => {
    // A tiny header advertising 30000×30000 (a decompression bomb) is read, not
    // decoded; checkArtworkDimensions then rejects it.
    const dims = await readImageDimensions(pngHeader(30000, 30000));
    expect(dims).toEqual({ width: 30000, height: 30000 });
    const check = checkArtworkDimensions(dims.width, dims.height);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("at most");
  });

  it("reads a non-square image so the caller can reject it", async () => {
    const dims = await readImageDimensions(pngHeader(1400, 1500));
    expect(dims).toEqual({ width: 1400, height: 1500 });
    expect(checkArtworkDimensions(dims.width, dims.height).ok).toBe(false);
  });

  it("rejects a zero-byte blob", async () => {
    await expect(readImageDimensions(new Blob([]))).rejects.toThrow();
  });

  it("rejects a truncated header", async () => {
    // PNG signature only, no IHDR.
    const truncated = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
    await expect(readImageDimensions(truncated)).rejects.toThrow();
  });

  it("rejects a malformed JPEG with no frame header", async () => {
    // SOI followed by a bogus marker with a length that runs off the end.
    const malformed = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])]);
    await expect(readImageDimensions(malformed)).rejects.toThrow();
  });

  it("rejects a non-image blob", async () => {
    await expect(readImageDimensions(new Blob(["not an image at all"]))).rejects.toThrow();
  });
});
