import { describe, expect, it } from "vitest";

import { parseRangeHeader, type RangeParseResult } from "../../src/worker/services/range";

const SIZE = 10_000;

describe("parseRangeHeader", () => {
  const cases: Array<{
    name: string;
    header: string | null | undefined;
    size?: number;
    expected: RangeParseResult;
  }> = [
    // Absent header
    { name: "null header", header: null, expected: { kind: "none" } },
    { name: "undefined header", header: undefined, expected: { kind: "none" } },

    // Accepted forms (section 14.3)
    {
      name: "bounded range",
      header: "bytes=0-1023",
      expected: { kind: "valid", start: 0, end: 1023 },
    },
    {
      name: "single-byte range",
      header: "bytes=0-0",
      expected: { kind: "valid", start: 0, end: 0 },
    },
    {
      name: "bounded range ending at last byte",
      header: `bytes=9000-${SIZE - 1}`,
      expected: { kind: "valid", start: 9000, end: SIZE - 1 },
    },
    {
      name: "bounded end clamped to size-1",
      header: "bytes=0-99999",
      expected: { kind: "valid", start: 0, end: SIZE - 1 },
    },
    {
      name: "open-ended range",
      header: "bytes=1024-",
      expected: { kind: "valid", start: 1024, end: SIZE - 1 },
    },
    {
      name: "open-ended from last byte",
      header: `bytes=${SIZE - 1}-`,
      expected: { kind: "valid", start: SIZE - 1, end: SIZE - 1 },
    },
    {
      name: "suffix range",
      header: "bytes=-1024",
      expected: { kind: "valid", start: SIZE - 1024, end: SIZE - 1 },
    },
    {
      name: "suffix larger than the object serves the whole object",
      header: "bytes=-999999",
      expected: { kind: "valid", start: 0, end: SIZE - 1 },
    },

    // Rejected forms (section 14.3)
    { name: "non-bytes unit", header: "items=0-100", expected: { kind: "invalid" } },
    { name: "missing unit", header: "0-1023", expected: { kind: "invalid" } },
    { name: "uppercase unit", header: "BYTES=0-1023", expected: { kind: "invalid" } },
    { name: "empty spec", header: "bytes=", expected: { kind: "invalid" } },
    { name: "bare dash", header: "bytes=-", expected: { kind: "invalid" } },
    {
      name: "multiple ranges",
      header: "bytes=0-499,500-999",
      expected: { kind: "invalid" },
    },
    {
      name: "multiple ranges with space",
      header: "bytes=0-1, 2-3",
      expected: { kind: "invalid" },
    },
    { name: "start greater than end", header: "bytes=500-499", expected: { kind: "invalid" } },
    {
      name: "start at object size",
      header: `bytes=${SIZE}-`,
      expected: { kind: "invalid" },
    },
    {
      name: "bounded start beyond object size",
      header: "bytes=99999-100000",
      expected: { kind: "invalid" },
    },
    { name: "zero-length suffix", header: "bytes=-0", expected: { kind: "invalid" } },
    {
      name: "negative start (not suffix notation)",
      header: "bytes=-5-10",
      expected: { kind: "invalid" },
    },
    { name: "non-numeric bounds", header: "bytes=abc-def", expected: { kind: "invalid" } },
    { name: "internal whitespace", header: "bytes=0 - 100", expected: { kind: "invalid" } },
    { name: "whitespace after unit", header: "bytes= 0-100", expected: { kind: "invalid" } },
    {
      name: "any range against a zero-byte object",
      header: "bytes=-5",
      size: 0,
      expected: { kind: "invalid" },
    },
    {
      name: "open-ended against a zero-byte object",
      header: "bytes=0-",
      size: 0,
      expected: { kind: "invalid" },
    },
  ];

  it.each(cases)("$name", ({ header, size, expected }) => {
    expect(parseRangeHeader(header, size ?? SIZE)).toEqual(expected);
  });

  it("returns none for an absent header even on a zero-byte object", () => {
    expect(parseRangeHeader(undefined, 0)).toEqual({ kind: "none" });
  });
});
