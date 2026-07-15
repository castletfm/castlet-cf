import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDuration,
  formatExactBytes,
  formatPercent,
  formatTimestamp,
} from "./format";

describe("formatBytes", () => {
  it("shows whole bytes below 1 KiB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("uses binary (1024) unit steps", () => {
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1 MiB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GiB");
  });

  it("drops trailing zeros and respects the ceiling of 8.5 GiB", () => {
    // 8.5 GiB = 9,126,805,504 bytes (the storage ceiling).
    expect(formatBytes(9_126_805_504)).toBe("8.5 GiB");
  });

  it("rounds to two decimals by default and honors a custom precision", () => {
    expect(formatBytes(1_572_864)).toBe("1.5 MiB");
    expect(formatBytes(1_600_000)).toBe("1.53 MiB");
    expect(formatBytes(1_600_000, 1)).toBe("1.5 MiB");
  });

  it("handles negatives and non-finite input", () => {
    expect(formatBytes(-2048)).toBe("-2 KiB");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatExactBytes", () => {
  it("preserves exact bytes with thousands separators", () => {
    expect(formatExactBytes(0)).toBe("0 bytes");
    expect(formatExactBytes(1_572_864)).toBe("1,572,864 bytes");
    expect(formatExactBytes(9_126_805_504)).toBe("9,126,805,504 bytes");
    expect(formatExactBytes(-1000)).toBe("-1,000 bytes");
  });
});

describe("formatPercent", () => {
  it("clamps to 0..100 and rounds", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(0.126)).toBe("13%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(1.4)).toBe("100%");
    expect(formatPercent(-0.2)).toBe("0%");
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds under an hour", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(1854)).toBe("30:54");
  });

  it("formats hours when needed", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("renders an em dash for null, negative, or non-finite input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatTimestamp", () => {
  it("renders an em dash for null, empty, or invalid input", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("")).toBe("—");
    expect(formatTimestamp("not-a-date")).toBe("—");
  });

  it("renders a non-empty string for a valid ISO timestamp", () => {
    expect(formatTimestamp("2026-07-15T12:00:00.000Z")).not.toBe("—");
  });
});
