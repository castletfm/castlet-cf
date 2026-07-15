/**
 * Episode editor (mvp-design.md section 16): metadata form (optimistic
 * version, 409 → refetch), audio upload with progress, client-side publish
 * gating that the server re-checks, and publish/unpublish/delete with
 * confirmation for the destructive actions.
 */

import { useEffect, useState, type FormEvent } from "react";

import type { EpisodePatchRequest, EpisodeResource } from "../../shared/contracts";
import {
  ApiError,
  deleteEpisode,
  getEpisode,
  patchEpisode,
  publishEpisode,
  unpublishEpisode,
} from "../api";
import { episodePublishGate } from "../lib/gates";
import { formatDuration, formatTimestamp } from "../lib/format";
import { navigate, routeHref } from "../router";
import { CheckboxField, NumberField, SelectField, TextArea, TextField } from "../components/fields";
import { AudioUploader } from "../components/uploaders";
import { Banner, ConfirmButton, Spinner, useAsync } from "../components/ui";

const TYPE_OPTIONS = [
  { value: "full", label: "Full" },
  { value: "bonus", label: "Bonus" },
  { value: "trailer", label: "Trailer" },
];

interface FormState {
  title: string;
  description: string;
  episodeType: string;
  explicit: boolean;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

function toForm(episode: EpisodeResource): FormState {
  return {
    title: episode.title,
    description: episode.description,
    episodeType: episode.episodeType,
    explicit: episode.explicit,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
  };
}

export function EpisodeEditorScreen({ episodeId }: { episodeId: string }) {
  const {
    data: episode,
    error,
    loading,
    reload,
    setData,
  } = useAsync(() => getEpisode(episodeId), [episodeId]);

  return (
    <section aria-labelledby="episode-heading">
      <div className="screen-head">
        <h2 id="episode-heading" tabIndex={-1}>
          Episode editor
        </h2>
        {episode !== null && (
          <a className="btn-secondary" href={routeHref.episodes(episode.showId)}>
            All episodes
          </a>
        )}
      </div>

      {error !== null && <Banner variant="error">{error}</Banner>}
      {loading && episode === null && <Spinner />}

      {episode !== null && (
        <div className="two-col">
          <MetadataForm episode={episode} onSaved={setData} onConflict={reload} />
          <div className="side-col">
            <PublishCard episode={episode} onChanged={setData} />
            <AudioCard episode={episode} onUploaded={() => reload()} />
            <details className="card">
              <summary>Identifiers</summary>
              <dl className="kv">
                <dt>GUID (immutable)</dt>
                <dd>
                  <code>{episode.guid}</code>
                </dd>
                <dt>Created</dt>
                <dd>{formatTimestamp(episode.createdAt)}</dd>
                <dt>Version</dt>
                <dd>{episode.version}</dd>
              </dl>
            </details>
          </div>
        </div>
      )}
    </section>
  );
}

function MetadataForm({
  episode,
  onSaved,
  onConflict,
}: {
  episode: EpisodeResource;
  onSaved: (episode: EpisodeResource) => void;
  onConflict: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(episode));
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    variant: "success" | "warning" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    setForm(toForm(episode));
  }, [episode.version, episode.id]);

  const editable = episode.status === "draft" || episode.status === "unpublished";

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const body: EpisodePatchRequest = {
      version: episode.version,
      title: form.title,
      description: form.description,
      episodeType: form.episodeType as EpisodePatchRequest["episodeType"],
      explicit: form.explicit,
      seasonNumber: form.seasonNumber,
      episodeNumber: form.episodeNumber,
    };
    setSubmitting(true);
    try {
      const updated = await patchEpisode(episode.id, body);
      onSaved(updated);
      setNotice({ variant: "success", text: "Saved." });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409 && err.code === "VERSION_CONFLICT") {
        onConflict();
        setNotice({
          variant: "warning",
          text: "Another change was saved first. This form was reloaded — reapply your edits and save again.",
        });
      } else {
        setNotice({
          variant: "error",
          text: err instanceof ApiError ? err.message : "Could not save changes.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <h3>Metadata</h3>
      {!editable && (
        <Banner variant="info">
          Only draft and unpublished episodes can be edited. Unpublish to make changes.
        </Banner>
      )}
      {notice !== null && <Banner variant={notice.variant}>{notice.text}</Banner>}
      <fieldset disabled={!editable || submitting} className="fieldset-plain">
        <TextField label="Title" required value={form.title} onChange={(v) => update("title", v)} />
        <TextArea
          label="Description"
          value={form.description}
          onChange={(v) => update("description", v)}
          hint="Required before publishing."
        />
        <SelectField
          label="Episode type"
          value={form.episodeType}
          onChange={(v) => update("episodeType", v)}
          options={TYPE_OPTIONS}
        />
        <CheckboxField
          label="Explicit content"
          checked={form.explicit}
          onChange={(v) => update("explicit", v)}
        />
        <NumberField
          label="Season number"
          value={form.seasonNumber}
          onChange={(v) => update("seasonNumber", v)}
          min={1}
        />
        <NumberField
          label="Episode number"
          value={form.episodeNumber}
          onChange={(v) => update("episodeNumber", v)}
          min={1}
        />
      </fieldset>
      {editable && (
        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? "Saving…" : "Save changes"}
          </button>
          <span className="muted">Version {episode.version}</span>
        </div>
      )}
    </form>
  );
}

function PublishCard({
  episode,
  onChanged,
}: {
  episode: EpisodeResource;
  onChanged: (episode: EpisodeResource) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    variant: "success" | "warning" | "error";
    text: string;
  } | null>(null);
  const gate = episodePublishGate(episode);

  async function publish() {
    setNotice(null);
    setBusy(true);
    try {
      const updated = await publishEpisode(episode.id);
      onChanged(updated);
      setNotice({ variant: "success", text: "Published and feed synchronized." });
    } catch (err: unknown) {
      setNotice({ variant: "error", text: publishErrorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    setNotice(null);
    try {
      const updated = await unpublishEpisode(episode.id);
      onChanged(updated);
      setNotice({ variant: "success", text: "Unpublished and removed from the feed." });
    } catch (err: unknown) {
      setNotice({
        variant: "error",
        text: err instanceof ApiError ? err.message : "Unpublish failed.",
      });
    }
  }

  async function remove() {
    try {
      await deleteEpisode(episode.id);
      navigate(routeHref.episodes(episode.showId));
    } catch (err: unknown) {
      setNotice({
        variant: "error",
        text: err instanceof ApiError ? err.message : "Delete failed.",
      });
    }
  }

  return (
    <section className="card" aria-labelledby="publish-heading">
      <h3 id="publish-heading">Publishing</h3>
      <p>
        Status: <span className={`status status-${episode.status}`}>{episode.status}</span>
        {episode.publishedAt !== null && (
          <span className="muted"> · published {formatTimestamp(episode.publishedAt)}</span>
        )}
      </p>
      <p className="muted">Duration {formatDuration(episode.durationSeconds)}</p>

      {notice !== null && <Banner variant={notice.variant}>{notice.text}</Banner>}

      {episode.status !== "published" && !gate.ok && (
        <Banner variant="info" title="Before you can publish">
          <ul className="plain-list">
            {gate.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </Banner>
      )}

      <div className="button-row">
        {episode.status !== "published" && (
          <button
            type="button"
            className="btn-primary"
            disabled={!gate.ok || busy}
            onClick={() => void publish()}
          >
            {busy ? "Publishing…" : "Publish now"}
          </button>
        )}
        {episode.status === "published" && (
          <ConfirmButton
            danger
            prompt="Unpublish this episode?"
            confirmLabel="Unpublish"
            onConfirm={unpublish}
          >
            Unpublish
          </ConfirmButton>
        )}
        {episode.status !== "published" && (
          <ConfirmButton
            danger
            prompt="Delete this episode record? Media is not purged."
            confirmLabel="Delete"
            onConfirm={remove}
          >
            Delete
          </ConfirmButton>
        )}
      </div>
    </section>
  );
}

function AudioCard({ episode, onUploaded }: { episode: EpisodeResource; onUploaded: () => void }) {
  return (
    <section className="card" aria-labelledby="audio-heading">
      <h3 id="audio-heading">Audio</h3>
      {episode.audioObjectId !== null ? (
        <p className="muted">Audio attached. Duration {formatDuration(episode.durationSeconds)}.</p>
      ) : (
        <p className="muted">No audio yet. Upload a .mp3 or .m4a file to enable publishing.</p>
      )}
      <AudioUploader episode={episode} onUploaded={() => onUploaded()} />
    </section>
  );
}

function publishErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return "Publish failed.";
  }
  if (err.code === "FEED_WRITE_FAILED") {
    return "The episode was saved, but the feed could not be written. Open the show settings and use Regenerate feed.";
  }
  if (err.code === "EPISODE_NOT_PUBLISHABLE" || err.code === "SHOW_NOT_FEED_READY") {
    return `${err.message} Fix the missing requirements and try again.`;
  }
  return err.message;
}
