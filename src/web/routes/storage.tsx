/**
 * Storage maintenance: review orphaned objects and
 * purge them with confirmation, and run the maintenance action showing its
 * report.
 */

import { useEffect, useRef, useState } from "react";

import type { MaintenanceRunResponse, OrphanedObjectResource } from "../../shared/contracts";
import { ApiError, listOrphans, purgeStorageObject, runMaintenance } from "../api";
import { formatExactBytes, formatTimestamp } from "../lib/format";
import { Banner, ByteSize, ConfirmButton, Spinner, useAsync } from "../components/ui";

export function StorageScreen() {
  const orphans = useAsync(() => listOrphans(), []);
  const [purgeError, setPurgeError] = useState<string | null>(null);

  // Pages beyond the first are fetched on demand and appended. When the first
  // page (re)loads — including after a purge or maintenance run — reset the
  // appended pages and seed the cursor from it.
  const [appended, setAppended] = useState<OrphanedObjectResource[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped whenever the first page is replaced (initial load, purge, or
  // maintenance reload). A load-more in flight captures the current value and
  // discards its response if the generation changed meanwhile, so a reload that
  // resolves before an older load-more can never let that stale page append a
  // row the refreshed first page already shows (a duplicate key).
  const generation = useRef(0);
  useEffect(() => {
    if (orphans.data !== null) {
      generation.current += 1;
      setAppended([]);
      setNextCursor(orphans.data.nextCursor);
    }
  }, [orphans.data]);
  const allOrphans = [...(orphans.data?.orphans ?? []), ...appended];

  async function loadMore() {
    if (nextCursor === null) return;
    const gen = generation.current;
    setPurgeError(null);
    setLoadingMore(true);
    try {
      const page = await listOrphans(nextCursor);
      if (generation.current !== gen) return; // first page was replaced mid-flight; discard
      setAppended((prev) => [...prev, ...page.orphans]);
      setNextCursor(page.nextCursor);
    } catch (err: unknown) {
      if (generation.current === gen) {
        setPurgeError(err instanceof ApiError ? err.message : "Could not load more orphans.");
      }
    } finally {
      setLoadingMore(false);
    }
  }

  const [report, setReport] = useState<MaintenanceRunResponse | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function purge(id: string) {
    setPurgeError(null);
    try {
      await purgeStorageObject(id);
      orphans.reload();
    } catch (err: unknown) {
      setPurgeError(err instanceof ApiError ? err.message : "Purge failed.");
      orphans.reload();
    }
  }

  async function maintenance() {
    setMaintenanceError(null);
    setRunning(true);
    try {
      const result = await runMaintenance();
      setReport(result);
      orphans.reload();
    } catch (err: unknown) {
      setMaintenanceError(err instanceof ApiError ? err.message : "Maintenance run failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="storage-heading">
      <div className="screen-head">
        <h2 id="storage-heading" tabIndex={-1}>
          Storage maintenance
        </h2>
        <button
          type="button"
          className="btn-secondary"
          disabled={running}
          onClick={() => void maintenance()}
        >
          {running ? "Running…" : "Run maintenance"}
        </button>
      </div>

      {maintenanceError !== null && <Banner variant="error">{maintenanceError}</Banner>}
      {report !== null && <MaintenanceReport report={report} />}

      <section className="card" aria-labelledby="orphans-heading">
        <h3 id="orphans-heading">Orphaned objects</h3>
        <p className="muted">
          Orphaned objects are replaced media that still counts against active storage until purged.
          Purging deletes the object from R2 and frees its bytes. This cannot be undone.
        </p>

        {purgeError !== null && <Banner variant="error">{purgeError}</Banner>}
        {orphans.error !== null && <Banner variant="error">{orphans.error}</Banner>}
        {orphans.loading && orphans.data === null && <Spinner />}

        {orphans.data !== null && (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Owner</th>
                <th scope="col">Filename</th>
                <th scope="col" className="num">
                  Size
                </th>
                <th scope="col">Orphaned</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {allOrphans.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No orphaned objects. Storage is clean.
                  </td>
                </tr>
              )}
              {allOrphans.map((orphan) => (
                <tr key={orphan.id}>
                  <td>{orphan.kind}</td>
                  <td>{orphan.ownerTitle ?? <span className="muted">(owner removed)</span>}</td>
                  <td>{orphan.originalFilename}</td>
                  <td className="num">
                    <ByteSize bytes={orphan.byteLength} />
                  </td>
                  <td>{formatTimestamp(orphan.orphanedAt)}</td>
                  <td>
                    <ConfirmButton
                      danger
                      prompt="Purge this object from R2?"
                      confirmLabel="Purge"
                      onConfirm={() => purge(orphan.id)}
                    >
                      Purge
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {nextCursor !== null && (
          <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </section>
  );
}

function MaintenanceReport({ report }: { report: MaintenanceRunResponse }) {
  const drift = report.drift;
  const hasDrift = drift.activeBytesDrift !== 0 || drift.reservedBytesDrift !== 0;
  return (
    <section className="card" aria-labelledby="report-heading">
      <h3 id="report-heading">Maintenance report</h3>
      <dl className="kv">
        <dt>Expired intents</dt>
        <dd>{report.expiredIntents}</dd>
        <dt>Reserved bytes released</dt>
        <dd title={formatExactBytes(report.releasedBytes)}>
          <ByteSize bytes={report.releasedBytes} />
        </dd>
        <dt>Pending objects deleted</dt>
        <dd>{report.deletedObjects}</dd>
        <dt>Usage counters</dt>
        <dd>
          {report.corrected
            ? "Corrected to computed values."
            : hasDrift
              ? "Drift detected (not auto-corrected)."
              : "No drift."}
        </dd>
      </dl>
      {hasDrift && (
        <Banner variant="warning" title="Usage drift">
          Active drift {formatExactBytes(drift.activeBytesDrift)}; reserved drift{" "}
          {formatExactBytes(drift.reservedBytesDrift)}.
        </Banner>
      )}
      {report.notes.length > 0 && (
        <ul className="plain-list">
          {report.notes.map((note) => (
            <li key={note} className="muted">
              {note}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
