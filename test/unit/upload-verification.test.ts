import { describe, expect, it } from "vitest";

import {
  hasValidMediaSignature,
  isJpegSignature,
  isM4aSignature,
  isMp3Signature,
  isPngSignature,
} from "../../src/worker/services/upload-verification";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function m4aHeader(ftypOffset: number): Uint8Array {
  const buffer = new Uint8Array(64);
  buffer.set([0x66, 0x74, 0x79, 0x70], ftypOffset); // "ftyp"
  buffer.set([0x4d, 0x34, 0x41, 0x20], ftypOffset + 4); // "M4A "
  return buffer;
}

describe("isMp3Signature", () => {
  it("accepts an ID3v2 tag", () => {
    expect(isMp3Signature(bytes(0x49, 0x44, 0x33, 0x04, 0x00))).toBe(true);
  });

  it("accepts MPEG frame sync 0xFFEx and 0xFFFx", () => {
    expect(isMp3Signature(bytes(0xff, 0xe2, 0x00))).toBe(true);
    expect(isMp3Signature(bytes(0xff, 0xfb, 0x90))).toBe(true);
  });

  it("rejects non-MP3 leading bytes", () => {
    expect(isMp3Signature(bytes(0xff, 0x00))).toBe(false); // sync bits missing
    expect(isMp3Signature(bytes(0x49, 0x44, 0x00))).toBe(false); // "ID" only
    expect(isMp3Signature(bytes(0x00, 0x00, 0x00))).toBe(false);
    expect(isMp3Signature(bytes(0xff))).toBe(false); // too short
  });
});

describe("isM4aSignature", () => {
  it("accepts ftyp at the standard offset 4", () => {
    expect(isM4aSignature(m4aHeader(4))).toBe(true);
  });

  it("accepts ftyp slightly later, still near the start", () => {
    expect(isM4aSignature(m4aHeader(12))).toBe(true);
  });

  it("rejects ftyp far from the start", () => {
    expect(isM4aSignature(m4aHeader(40))).toBe(false);
  });

  it("rejects data without an ftyp box", () => {
    expect(isM4aSignature(new Uint8Array(64))).toBe(false);
    expect(isM4aSignature(bytes(0x00, 0x00))).toBe(false);
  });
});

describe("isJpegSignature", () => {
  it("accepts FF D8 FF", () => {
    expect(isJpegSignature(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isJpegSignature(bytes(0xff, 0xd8, 0x00))).toBe(false);
    expect(isJpegSignature(bytes(0xff, 0xd8))).toBe(false); // too short
  });
});

describe("isPngSignature", () => {
  it("accepts the eight-byte PNG signature", () => {
    expect(isPngSignature(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe(true);
  });

  it("rejects a corrupted signature", () => {
    expect(isPngSignature(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b))).toBe(false);
    expect(isPngSignature(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBe(false);
  });
});

describe("hasValidMediaSignature", () => {
  it("dispatches by canonical MIME type", () => {
    expect(hasValidMediaSignature("audio/mpeg", bytes(0x49, 0x44, 0x33))).toBe(true);
    expect(hasValidMediaSignature("audio/mp4", m4aHeader(4))).toBe(true);
    expect(hasValidMediaSignature("image/jpeg", bytes(0xff, 0xd8, 0xff))).toBe(true);
    expect(
      hasValidMediaSignature("image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe(true);
  });

  it("rejects a valid signature declared as a different type", () => {
    expect(hasValidMediaSignature("image/png", bytes(0xff, 0xd8, 0xff))).toBe(false);
    expect(hasValidMediaSignature("audio/mpeg", m4aHeader(4))).toBe(false);
  });

  it("rejects unknown content types", () => {
    expect(hasValidMediaSignature("application/pdf", bytes(0x25, 0x50, 0x44, 0x46))).toBe(false);
  });
});
