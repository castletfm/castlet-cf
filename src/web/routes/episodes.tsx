/**
 * Episodes screen: list a show's episodes filtered
 * by status and create a draft.
 */

import { useState, type FormEvent } from "react";

import type { EpisodeCreateRequest, EpisodeStatus } from "../../shared/contracts";
import { ApiError, createEpisode, getShow, listEpisodes } from "../api";
import { formatDuration, formatTimestamp } from "../lib/format";
import { navigate, routeHref } from "../router";
import { CheckboxField, NumberField, SelectField, TextArea, TextField } from "../components/fields";
import { Banner, Spinner, useAsync } from "../components/ui";

type Filter = "all" | EpisodeStatus;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "published", label: "Published" },
  { value: "unpublished", label: "Unpublished" },
];

const TYPE_OPTIONS = [
  { value: "full", label: "Full" },
  { value: "bonus", label: "Bonus" },
  { value: "trailer", label: "Trailer" },
];

export function EpisodesScreen({ showId }: { showId: string }) {
  const show = useAsync(() => getShow(showId), [showId]);
  const [filter, setFilter] = useState<Filter>("all");
  const episodes = useAsync(
    () => listEpisodes(showId, filter === "all" ? undefined : filter),
    [showId, filter],
  );
  const [showForm, setShowForm] = useState(false);

  return (
    <section aria-labelledby="episodes-heading">
      <div className="screen-head">
        <h2 id="episodes-heading" tabIndex={-1}>
          Episodes{show.data !== null ? ` — ${show.data.title}` : ""}
        </h2>
        <div className="screen-head-actions">
          <a className="btn-secondary" href={routeHref.show(showId)}>
            Show settings
          </a>
          <button type="button" className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Close" : "New draft"}
          </button>
        </div>
      </div>

      {showForm && (
        <CreateEpisodeForm
          showId={showId}
          onCreated={(id) => {
            setShowForm(false);
            navigate(routeHref.episode(id));
          }}
        />
      )}

      <div className="tabs" role="tablist" aria-label="Filter episodes by status">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            className={filter === f.value ? "tab tab-active" : "tab"}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {episodes.error !== null && <Banner variant="error">{episodes.error}</Banner>}
      {episodes.loading && episodes.data === null && <Spinner />}

      {episodes.data !== null && (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Duration</th>
              <th scope="col">Published</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {episodes.data.episodes.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No episodes match this filter.
                </td>
              </tr>
            )}
            {episodes.data.episodes.map((episode) => (
              <tr key={episode.id}>
                <td>
                  <a href={routeHref.episode(episode.id)}>{episode.title}</a>
                </td>
                <td>
                  <span className={`status status-${episode.status}`}>{episode.status}</span>
                </td>
                <td>{formatDuration(episode.durationSeconds)}</td>
                <td>{formatTimestamp(episode.publishedAt)}</td>
                <td>
                  <a href={routeHref.episode(episode.id)}>Edit</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CreateEpisodeForm({
  showId,
  onCreated,
}: {
  showId: string;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [episodeType, setEpisodeType] = useState("full");
  const [explicit, setExplicit] = useState(false);
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const [episodeNumber, setEpisodeNumber] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body: EpisodeCreateRequest = {
      title,
      description,
      episodeType: episodeType as EpisodeCreateRequest["episodeType"],
      explicit,
      seasonNumber,
      episodeNumber,
    };
    setSubmitting(true);
    try {
      const episode = await createEpisode(showId, body);
      onCreated(episode.id);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Could not create the draft.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <h3>New episode draft</h3>
      {error !== null && <Banner variant="error">{error}</Banner>}
      <TextField label="Title" required value={title} onChange={setTitle} />
      <TextArea
        label="Description"
        value={description}
        onChange={setDescription}
        hint="Required before publishing; can be left empty on a draft."
      />
      <SelectField
        label="Episode type"
        value={episodeType}
        onChange={setEpisodeType}
        options={TYPE_OPTIONS}
      />
      <CheckboxField label="Explicit content" checked={explicit} onChange={setExplicit} />
      <NumberField label="Season number" value={seasonNumber} onChange={setSeasonNumber} min={1} />
      <NumberField
        label="Episode number"
        value={episodeNumber}
        onChange={setEpisodeNumber}
        min={1}
      />
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create draft"}
        </button>
      </div>
    </form>
  );
}
