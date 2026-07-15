/**
 * Analytics: per-show/episode request and byte
 * totals over a date range within the Analytics Engine retention window.
 * Degrades gracefully when no analytics token is configured (available:false).
 *
 * These are non-certified delivery totals — never unique listeners or IAB
 * downloads.
 */

import { useMemo, useState } from "react";

import { ANALYTICS_RETENTION_DAYS } from "../../shared/constants";
import { getAnalytics } from "../api";
import { formatExactBytes, formatTimestamp } from "../lib/format";
import { Banner, ByteSize, Spinner, useAsync } from "../components/ui";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function AnalyticsScreen() {
  const today = useMemo(() => new Date(), []);
  const retentionStart = useMemo(() => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - ANALYTICS_RETENTION_DAYS);
    return d;
  }, [today]);
  const defaultFrom = useMemo(() => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - 29);
    return d;
  }, [today]);

  const [fromDate, setFromDate] = useState(isoDate(defaultFrom));
  const [toDate, setToDate] = useState(isoDate(today));
  // The applied window drives the query; editing the inputs does not refetch
  // until "Apply" is pressed.
  const [applied, setApplied] = useState({ from: fromDate, to: toDate });

  const fromIso = `${applied.from}T00:00:00.000Z`;
  const toIso = `${applied.to}T23:59:59.999Z`;

  const analytics = useAsync(() => getAnalytics(fromIso, toIso), [fromIso, toIso]);

  const rows = useMemo(() => {
    if (analytics.data === null) return [];
    return [...analytics.data.episodes].sort((a, b) => b.requests - a.requests);
  }, [analytics.data]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => ({ requests: acc.requests + row.requests, bytes: acc.bytes + row.bytes }),
      { requests: 0, bytes: 0 },
    );
  }, [rows]);

  return (
    <section aria-labelledby="analytics-heading">
      <div className="screen-head">
        <h2 id="analytics-heading" tabIndex={-1}>
          Analytics
        </h2>
      </div>

      <p className="muted">
        Non-certified delivery totals for the last {ANALYTICS_RETENTION_DAYS} days of retained data.
        Request counts are not unique listeners or IAB downloads.
      </p>

      <form
        className="card inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ from: fromDate, to: toDate });
        }}
      >
        <div className="field">
          <label htmlFor="from-date">From</label>
          <input
            id="from-date"
            type="date"
            value={fromDate}
            min={isoDate(retentionStart)}
            max={toDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="to-date">To</label>
          <input
            id="to-date"
            type="date"
            value={toDate}
            min={fromDate}
            max={isoDate(today)}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
        <button type="submit" className="btn-primary">
          Apply
        </button>
      </form>

      {analytics.error !== null && <Banner variant="error">{analytics.error}</Banner>}
      {analytics.loading && analytics.data === null && <Spinner />}

      {analytics.data !== null && !analytics.data.available && (
        <Banner variant="info" title="Analytics not configured">
          No Analytics Engine API token is set for this deployment, so delivery totals are
          unavailable. Delivery is still recorded and will appear once a token is configured.
        </Banner>
      )}

      {analytics.data !== null && analytics.data.available && (
        <>
          <p className="muted">
            Window {formatTimestamp(analytics.data.from)} – {formatTimestamp(analytics.data.to)}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Show</th>
                <th scope="col">Episode</th>
                <th scope="col" className="num">
                  Requests
                </th>
                <th scope="col" className="num">
                  Ranged
                </th>
                <th scope="col" className="num">
                  Bytes
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No delivery recorded in this window.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={`${row.showId}:${row.episodeId}`}>
                  <td>
                    <code>{row.showId.slice(0, 8)}…</code>
                  </td>
                  <td>
                    {row.episodeId === "artwork" ? (
                      <em>artwork</em>
                    ) : (
                      <code>{row.episodeId.slice(0, 8)}…</code>
                    )}
                  </td>
                  <td className="num">{row.requests.toLocaleString()}</td>
                  <td className="num">{row.rangedRequests.toLocaleString()}</td>
                  <td className="num">
                    <ByteSize bytes={row.bytes} />
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    Total
                  </th>
                  <td className="num">{totals.requests.toLocaleString()}</td>
                  <td className="num" />
                  <td className="num" title={formatExactBytes(totals.bytes)}>
                    <ByteSize bytes={totals.bytes} />
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </>
      )}
    </section>
  );
}
