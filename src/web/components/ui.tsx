/**
 * Shared presentational primitives and a small data-loading hook used across
 * the admin screens. Kept intentionally lightweight — no component framework.
 */

import { useCallback, useEffect, useState, type DependencyList, type ReactNode } from "react";

import { formatBytes, formatExactBytes, formatPercent } from "../lib/format";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the loader. */
  reload: () => void;
  /** Replace the loaded data locally (e.g. after a mutation returns a resource). */
  setData: (value: T) => void;
}

/**
 * Load async data with loading/error state and a manual reload. The loader is
 * re-run whenever a dependency changes or reload() is called. Results from a
 * superseded run are discarded.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Request failed.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, nonce]);

  return { data, error, loading, reload, setData };
}

export type BannerVariant = "error" | "warning" | "success" | "info";

export function Banner({
  variant,
  title,
  children,
}: {
  variant: BannerVariant;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`banner banner-${variant}`} role={variant === "error" ? "alert" : "status"}>
      {title !== undefined && <strong className="banner-title">{title}</strong>}
      {children !== undefined && <div className="banner-body">{children}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="muted" role="status">
      {label}
    </p>
  );
}

/** Copy a value to the clipboard with transient confirmation. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button type="button" className="btn-secondary" onClick={() => void copy()}>
      {copied ? "Copied ✓" : label}
    </button>
  );
}

/**
 * A button that arms an inline confirmation before running its action. Used
 * for the destructive/irreversible operations the design requires operators to
 * confirm: unpublish, delete, and purge (section 16). `onConfirm` should
 * handle its own errors; this component only manages the confirm/busy state.
 */
export function ConfirmButton({
  children,
  onConfirm,
  prompt = "Are you sure?",
  confirmLabel = "Confirm",
  disabled = false,
  danger = false,
}: {
  children: ReactNode;
  onConfirm: () => void | Promise<void>;
  prompt?: string;
  confirmLabel?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        className={danger ? "btn-danger" : "btn-secondary"}
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {children}
      </button>
    );
  }

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <span className="confirm" role="group" aria-label={prompt}>
      <span className="confirm-prompt">{prompt}</span>
      <button
        type="button"
        className={danger ? "btn-danger" : "btn-primary"}
        disabled={busy}
        onClick={() => void confirm()}
      >
        {busy ? "Working…" : confirmLabel}
      </button>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() => setArmed(false)}
      >
        Cancel
      </button>
    </span>
  );
}

/** Storage usage meter showing active/reserved against the ceiling. */
export function StorageMeter({
  activeBytes,
  reservedBytes,
  maxTotalBytes,
}: {
  activeBytes: number;
  reservedBytes: number;
  maxTotalBytes: number;
}) {
  const used = activeBytes + reservedBytes;
  const ratio = maxTotalBytes > 0 ? used / maxTotalBytes : 0;
  const activePct = maxTotalBytes > 0 ? (activeBytes / maxTotalBytes) * 100 : 0;
  const reservedPct = maxTotalBytes > 0 ? (reservedBytes / maxTotalBytes) * 100 : 0;
  const near = ratio >= 0.9;

  return (
    <div className="meter-block">
      <div
        className="meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={maxTotalBytes}
        aria-valuenow={used}
        aria-label="Storage used"
      >
        <span
          className="meter-fill meter-active"
          style={{ width: `${Math.min(100, activePct)}%` }}
        />
        <span
          className="meter-fill meter-reserved"
          style={{ width: `${Math.min(100, reservedPct)}%` }}
        />
      </div>
      <dl className="meter-legend">
        <div>
          <dt>Active</dt>
          <dd title={formatExactBytes(activeBytes)}>{formatBytes(activeBytes)}</dd>
        </div>
        <div>
          <dt>Reserved</dt>
          <dd title={formatExactBytes(reservedBytes)}>{formatBytes(reservedBytes)}</dd>
        </div>
        <div>
          <dt>Ceiling</dt>
          <dd title={formatExactBytes(maxTotalBytes)}>{formatBytes(maxTotalBytes)}</dd>
        </div>
        <div>
          <dt>Used</dt>
          <dd className={near ? "warn-text" : undefined}>{formatPercent(ratio)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Format a byte count with an exact-byte tooltip; preserves the raw value. */
export function ByteSize({ bytes }: { bytes: number | null }) {
  if (bytes === null) {
    return <span>—</span>;
  }
  return <span title={formatExactBytes(bytes)}>{formatBytes(bytes)}</span>;
}
