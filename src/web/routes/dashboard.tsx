/**
 * Dashboard: storage counters against the ceiling,
 * a prominent feed-dirty banner when D1 and R2 feed revisions differ, and the
 * most recent episodes.
 */

import { getDashboard } from "../api";
import { formatTimestamp } from "../lib/format";
import { routeHref } from "../router";
import { Banner, Spinner, StorageMeter, useAsync } from "../components/ui";

export function DashboardScreen() {
  const { data, error, loading, reload } = useAsync(() => getDashboard(), []);

  return (
    <section aria-labelledby="dashboard-heading">
      <div className="screen-head">
        <h2 id="dashboard-heading" tabIndex={-1}>
          Dashboard
        </h2>
        <button type="button" className="btn-secondary" onClick={reload}>
          Refresh
        </button>
      </div>

      {error !== null && <Banner variant="error">{error}</Banner>}
      {loading && data === null && <Spinner />}

      {data !== null && (
        <>
          {data.feedDirtyShows.length > 0 && (
            <Banner
              variant="warning"
              title={`${data.feedDirtyShows.length} show${
                data.feedDirtyShows.length === 1 ? "" : "s"
              } need feed attention`}
            >
              <p>
                The published feed revision differs from the current data, or feed generation
                failed. Open the show and regenerate its feed.
              </p>
              <ul className="plain-list">
                {data.feedDirtyShows.map((show) => (
                  <li key={show.id}>
                    <a href={routeHref.show(show.id)}>{show.title}</a>{" "}
                    <span className="muted">
                      (D1 rev {show.feedRevision}, published rev {show.feedPublishedRevision}
                      {show.feedError !== null ? `; error: ${show.feedError}` : ""})
                    </span>
                  </li>
                ))}
              </ul>
            </Banner>
          )}

          <section className="card" aria-labelledby="storage-heading">
            <h3 id="storage-heading">Storage</h3>
            <StorageMeter
              activeBytes={data.storage.activeBytes}
              reservedBytes={data.storage.reservedBytes}
              orphanedBytes={data.storage.orphanedBytes}
              maxTotalBytes={data.storage.maxTotalBytes}
            />
          </section>

          <section className="card" aria-labelledby="recent-heading">
            <h3 id="recent-heading">Recent episodes</h3>
            {data.recentEpisodes.length === 0 ? (
              <p className="muted">No episodes yet.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentEpisodes.map((episode) => (
                    <tr key={episode.id}>
                      <td>{episode.title}</td>
                      <td>
                        <span className={`status status-${episode.status}`}>{episode.status}</span>
                      </td>
                      <td>{formatTimestamp(episode.createdAt)}</td>
                      <td>
                        <a href={routeHref.episode(episode.id)}>Open</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </section>
  );
}
