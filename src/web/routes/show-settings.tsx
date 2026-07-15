/**
 * Show settings (mvp-design.md section 16): edit metadata with optimistic
 * concurrency (409 → refetch + notify), upload artwork, copy the public feed
 * URL, and view/repair feed synchronization state.
 */

import { useEffect, useState, type FormEvent } from "react";

import { APPLE_CATEGORIES } from "../../shared/validation";
import type { ShowPatchRequest, ShowResource } from "../../shared/contracts";
import { ApiError, getShow, patchShow, regenerateFeed } from "../api";
import { showFeedReadyGate } from "../lib/gates";
import { formatTimestamp } from "../lib/format";
import { routeHref } from "../router";
import { CheckboxField, SelectField, TextArea, TextField } from "../components/fields";
import { ArtworkPreview, ArtworkUploader } from "../components/uploaders";
import { Banner, CopyButton, Spinner, useAsync } from "../components/ui";

const CATEGORY_OPTIONS = APPLE_CATEGORIES.map((c) => ({ value: c, label: c }));
const OPTIONAL_CATEGORY_OPTIONS = [{ value: "", label: "— none —" }, ...CATEGORY_OPTIONS];

interface FormState {
  slug: string;
  title: string;
  authorName: string;
  ownerName: string;
  ownerEmail: string;
  description: string;
  language: string;
  categoryPrimary: string;
  categorySecondary: string;
  explicit: boolean;
  websiteUrl: string;
  copyrightText: string;
}

function toForm(show: ShowResource): FormState {
  return {
    slug: show.slug,
    title: show.title,
    authorName: show.authorName,
    ownerName: show.ownerName,
    ownerEmail: show.ownerEmail,
    description: show.description,
    language: show.language,
    categoryPrimary: show.categoryPrimary,
    categorySecondary: show.categorySecondary ?? "",
    explicit: show.explicit,
    websiteUrl: show.websiteUrl ?? "",
    copyrightText: show.copyrightText ?? "",
  };
}

export function ShowSettingsScreen({ showId }: { showId: string }) {
  const { data: show, error, loading, reload, setData } = useAsync(() => getShow(showId), [showId]);

  return (
    <section aria-labelledby="show-heading">
      <div className="screen-head">
        <h2 id="show-heading" tabIndex={-1}>
          Show settings
        </h2>
        <a className="btn-secondary" href={routeHref.shows()}>
          All shows
        </a>
      </div>

      {error !== null && <Banner variant="error">{error}</Banner>}
      {loading && show === null && <Spinner />}

      {show !== null && (
        <>
          {show.status === "inactive" && (
            <Banner variant="warning" title="This show is inactive">
              Inactive shows cannot publish episodes.
            </Banner>
          )}
          <div className="two-col">
            <MetadataForm show={show} onSaved={setData} onConflict={reload} />
            <div className="side-col">
              <ArtworkCard show={show} onUploaded={() => reload()} />
              <FeedCard show={show} onUpdated={setData} />
            </div>
          </div>
          <p className="muted">
            <a href={routeHref.episodes(show.id)}>Manage episodes →</a>
          </p>
        </>
      )}
    </section>
  );
}

function MetadataForm({
  show,
  onSaved,
  onConflict,
}: {
  show: ShowResource;
  onSaved: (show: ShowResource) => void;
  onConflict: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(show));
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    variant: "success" | "warning" | "error";
    text: string;
  } | null>(null);

  // Re-hydrate when the loaded show changes (initial load, conflict refetch,
  // successful save). Server version only changes on save, so in-progress
  // edits are never clobbered mid-typing.
  useEffect(() => {
    setForm(toForm(show));
  }, [show.version, show.id]);

  const slugLocked = show.slugLockedAt !== null;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const body: ShowPatchRequest = {
      version: show.version,
      title: form.title,
      authorName: form.authorName,
      ownerName: form.ownerName,
      ownerEmail: form.ownerEmail,
      description: form.description,
      language: form.language,
      categoryPrimary: form.categoryPrimary as ShowPatchRequest["categoryPrimary"],
      categorySecondary:
        form.categorySecondary === ""
          ? null
          : (form.categorySecondary as ShowPatchRequest["categoryPrimary"]),
      explicit: form.explicit,
      websiteUrl: form.websiteUrl.trim() === "" ? null : form.websiteUrl.trim(),
      copyrightText: form.copyrightText.trim() === "" ? null : form.copyrightText.trim(),
    };
    if (!slugLocked && form.slug !== show.slug) {
      body.slug = form.slug;
    }
    setSubmitting(true);
    try {
      const updated = await patchShow(show.id, body);
      onSaved(updated);
      setNotice({ variant: "success", text: "Saved." });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409 && err.code === "VERSION_CONFLICT") {
        onConflict();
        setNotice({
          variant: "warning",
          text: "Another change was saved first. This form was reloaded with the latest values — reapply your edits and save again.",
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
      {notice !== null && <Banner variant={notice.variant}>{notice.text}</Banner>}
      <TextField
        label="Slug"
        value={form.slug}
        onChange={(v) => update("slug", v)}
        hint={
          slugLocked
            ? "Locked: an episode has been published, so the slug can no longer change."
            : "Lowercase letters, digits, and hyphens; locks after the first publish."
        }
        error={slugLocked && form.slug !== show.slug ? "Slug is locked." : null}
      />
      <TextField label="Title" required value={form.title} onChange={(v) => update("title", v)} />
      <TextField
        label="Author name"
        required
        value={form.authorName}
        onChange={(v) => update("authorName", v)}
      />
      <TextField
        label="Owner name"
        required
        value={form.ownerName}
        onChange={(v) => update("ownerName", v)}
      />
      <TextField
        label="Owner email"
        required
        type="email"
        value={form.ownerEmail}
        onChange={(v) => update("ownerEmail", v)}
      />
      <TextArea
        label="Description"
        required
        value={form.description}
        onChange={(v) => update("description", v)}
      />
      <TextField
        label="Language"
        required
        value={form.language}
        onChange={(v) => update("language", v)}
      />
      <SelectField
        label="Primary category"
        required
        value={form.categoryPrimary}
        onChange={(v) => update("categoryPrimary", v)}
        options={CATEGORY_OPTIONS}
      />
      <SelectField
        label="Secondary category"
        value={form.categorySecondary}
        onChange={(v) => update("categorySecondary", v)}
        options={OPTIONAL_CATEGORY_OPTIONS}
      />
      <CheckboxField
        label="Explicit content"
        checked={form.explicit}
        onChange={(v) => update("explicit", v)}
      />
      <TextField
        label="Website URL"
        type="url"
        value={form.websiteUrl}
        onChange={(v) => update("websiteUrl", v)}
      />
      <TextField
        label="Copyright text"
        value={form.copyrightText}
        onChange={(v) => update("copyrightText", v)}
      />
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <span className="muted">Version {show.version}</span>
      </div>
    </form>
  );
}

function ArtworkCard({ show, onUploaded }: { show: ShowResource; onUploaded: () => void }) {
  return (
    <section className="card" aria-labelledby="artwork-heading">
      <h3 id="artwork-heading">Artwork</h3>
      {show.artworkObjectId !== null ? (
        <ArtworkPreview showId={show.id} objectId={show.artworkObjectId} />
      ) : (
        <p className="muted">
          No artwork yet. A show needs square artwork (1400–3000px) to publish.
        </p>
      )}
      <p className="field-hint">Uploading new artwork replaces the current image with a new URL.</p>
      <ArtworkUploader showId={show.id} onUploaded={onUploaded} />
    </section>
  );
}

function FeedCard({
  show,
  onUpdated,
}: {
  show: ShowResource;
  onUpdated: (show: ShowResource) => void;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedUrl = `${window.location.origin}/feeds/${show.slug}.xml`;
  const gate = showFeedReadyGate(show);

  async function regenerate() {
    setError(null);
    setRegenerating(true);
    try {
      const updated = await regenerateFeed(show.id);
      onUpdated(updated);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Feed regeneration failed.");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <section className="card" aria-labelledby="feed-heading">
      <h3 id="feed-heading">Feed</h3>

      <div className="feed-url">
        <label htmlFor="feed-url-input">Public feed URL</label>
        <div className="copy-row">
          <input id="feed-url-input" type="text" readOnly value={feedUrl} />
          <CopyButton value={feedUrl} label="Copy" />
        </div>
        <p className="field-hint">
          <a href={feedUrl} target="_blank" rel="noreferrer">
            Open feed
          </a>
        </p>
      </div>

      {show.feedSynchronized ? (
        <Banner variant="success">
          Feed synchronized (revision {show.feedRevision}). Last generated{" "}
          {formatTimestamp(show.feedLastGeneratedAt)}.
        </Banner>
      ) : (
        <Banner variant="warning" title="Feed needs regeneration">
          <p>
            Data revision {show.feedRevision} differs from published revision{" "}
            {show.feedPublishedRevision}
            {show.feedError !== null ? `; last error: ${show.feedError}` : ""}.
          </p>
          {!gate.ok && (
            <ul className="plain-list">
              {gate.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      {error !== null && <Banner variant="error">{error}</Banner>}

      <button
        type="button"
        className="btn-secondary"
        disabled={regenerating}
        onClick={() => void regenerate()}
      >
        {regenerating ? "Regenerating…" : "Regenerate feed"}
      </button>
    </section>
  );
}
