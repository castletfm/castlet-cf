/**
 * Display formatters for the admin SPA.
 *
 * Byte sizes are shown in binary units (KiB/MiB/GiB) per mvp-design.md
 * section 16. These functions format for display only; the exact byte counts
 * returned by the API are always preserved unchanged in application state and
 * only run through these helpers at render time.
 */

const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Round to a fixed number of digits, then drop trailing zeros (1.50 -> 1.5). */
function trimFixed(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/**
 * Format a byte count in binary units. Values below 1 KiB are shown as whole
 * bytes; larger values use up to `fractionDigits` decimals with trailing
 * zeros removed. Non-finite input renders as an em dash.
 */
export function formatBytes(bytes: number, fractionDigits = 2): string {
  if (!Number.isFinite(bytes)) {
    return "—";
  }
  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BINARY_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const text = unitIndex === 0 ? String(Math.round(value)) : trimFixed(value, fractionDigits);
  return `${sign}${text} ${BINARY_UNITS[unitIndex]}`;
}

/** Group an integer with commas every three digits, e.g. 1572864 -> "1,572,864". */
function groupThousands(value: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(Math.trunc(value)));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += ",";
    }
    out += digits[i];
  }
  return `${negative ? "-" : ""}${out}`;
}

/** Exact byte count with thousands separators, e.g. "1,572,864 bytes". */
export function formatExactBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "—";
  }
  return `${groupThousands(bytes)} bytes`;
}

/** A ratio in [0, 1] as a whole-number percentage clamped to that range. */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) {
    return "—";
  }
  const clamped = Math.min(1, Math.max(0, ratio));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Format a whole-second duration as H:MM:SS (or M:SS when under an hour),
 * matching the itunes:duration style. Negative or non-finite input renders as
 * an em dash.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${two(mins)}:${two(secs)}` : `${mins}:${two(secs)}`;
}

/** Format an ISO-8601 timestamp for display; invalid input renders an em dash. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null || iso === "") {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString();
}
