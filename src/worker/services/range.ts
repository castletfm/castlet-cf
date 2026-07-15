/**
 * Single byte-range parser for public media delivery (mvp-design.md
 * section 14.3).
 *
 * Exactly three forms are accepted:
 *
 *   bytes=S-E   first-byte..last-byte (E clamped to size-1)
 *   bytes=S-    open-ended from S
 *   bytes=-N    suffix: the final N bytes (N clamped to size)
 *
 * Everything else is rejected: non-`bytes` units, empty range specs,
 * comma-separated multiple ranges, start greater than end, start at or
 * beyond the object size, and zero-length suffixes.
 */

export type RangeParseResult =
  /** No Range header was present: serve the complete object. */
  | { kind: "none" }
  /** One satisfiable range; `start`/`end` are inclusive byte offsets. */
  | { kind: "valid"; start: number; end: number }
  /** Present but malformed or unsatisfiable: respond 416. */
  | { kind: "invalid" };

const BOUNDED_RANGE = /^(\d+)-(\d+)$/;
const OPEN_ENDED_RANGE = /^(\d+)-$/;
const SUFFIX_RANGE = /^-(\d+)$/;

/**
 * Parses a Range request header against an object of `size` bytes.
 * `header` is the raw header value, or null/undefined when absent.
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): RangeParseResult {
  if (header === null || header === undefined) {
    return { kind: "none" };
  }
  // Non-`bytes` units (including bad casing/whitespace) are rejected.
  if (!header.startsWith("bytes=")) {
    return { kind: "invalid" };
  }
  const spec = header.slice("bytes=".length);
  // Empty specs and comma-separated multiple ranges are rejected.
  if (spec === "" || spec.includes(",")) {
    return { kind: "invalid" };
  }
  // A zero-byte object satisfies no range at all.
  if (size <= 0) {
    return { kind: "invalid" };
  }

  const bounded = BOUNDED_RANGE.exec(spec);
  if (bounded !== null) {
    const start = Number(bounded[1]);
    const end = Number(bounded[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { kind: "invalid" };
    }
    if (start > end || start >= size) {
      return { kind: "invalid" };
    }
    return { kind: "valid", start, end: Math.min(end, size - 1) };
  }

  const openEnded = OPEN_ENDED_RANGE.exec(spec);
  if (openEnded !== null) {
    const start = Number(openEnded[1]);
    if (!Number.isSafeInteger(start) || start >= size) {
      return { kind: "invalid" };
    }
    return { kind: "valid", start, end: size - 1 };
  }

  const suffix = SUFFIX_RANGE.exec(spec);
  if (suffix !== null) {
    const length = Number(suffix[1]);
    // Zero-length suffixes are rejected; oversized suffixes clamp to the
    // whole object.
    if (!Number.isSafeInteger(length) || length === 0) {
      return { kind: "invalid" };
    }
    return { kind: "valid", start: Math.max(size - length, 0), end: size - 1 };
  }

  return { kind: "invalid" };
}
