import { describe, expect, it } from "vitest";

import { checkArtworkDimensions, MAX_ARTWORK_DIMENSION, MIN_ARTWORK_DIMENSION } from "./image";

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
