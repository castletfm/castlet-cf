/**
 * Shows screen: list all shows, create a show, and
 * deactivate one with confirmation.
 */

import { useState, type FormEvent } from "react";

import { APPLE_CATEGORIES, SLUG_PATTERN } from "../../shared/validation";
import type { ShowCreateRequest } from "../../shared/contracts";
import { ApiError, createShow, deactivateShow, listShows } from "../api";
import { navigate, routeHref } from "../router";
import { CheckboxField, SelectField, TextArea, TextField } from "../components/fields";
import { Banner, ConfirmButton, Spinner, useAsync } from "../components/ui";

const CATEGORY_OPTIONS = APPLE_CATEGORIES.map((c) => ({ value: c, label: c }));
const OPTIONAL_CATEGORY_OPTIONS = [{ value: "", label: "— none —" }, ...CATEGORY_OPTIONS];

export function ShowsScreen() {
  const shows = useAsync(() => listShows(), []);
  const [showForm, setShowForm] = useState(false);

  return (
    <section aria-labelledby="shows-heading">
      <div className="screen-head">
        <h2 id="shows-heading" tabIndex={-1}>
          Shows
        </h2>
        <button type="button" className="btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close" : "New show"}
        </button>
      </div>

      {showForm && (
        <CreateShowForm
          onCreated={(id) => {
            setShowForm(false);
            navigate(routeHref.show(id));
          }}
        />
      )}

      {shows.error !== null && <Banner variant="error">{shows.error}</Banner>}
      {shows.loading && shows.data === null && <Spinner />}

      {shows.data !== null && (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Slug</th>
              <th scope="col">Status</th>
              <th scope="col">Feed</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shows.data.shows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No shows yet. Create one to get started.
                </td>
              </tr>
            )}
            {shows.data.shows.map((show) => (
              <tr key={show.id}>
                <td>
                  <a href={routeHref.show(show.id)}>{show.title}</a>
                </td>
                <td>
                  <code>{show.slug}</code>
                </td>
                <td>
                  <span className={`status status-${show.status}`}>{show.status}</span>
                </td>
                <td>
                  {show.feedSynchronized ? (
                    <span className="status status-ok">synchronized</span>
                  ) : (
                    <span className="status status-warn">needs attention</span>
                  )}
                </td>
                <td className="row-actions">
                  <a href={routeHref.episodes(show.id)}>Episodes</a>
                  {show.status === "active" && (
                    <ConfirmButton
                      danger
                      prompt="Deactivate this show?"
                      confirmLabel="Deactivate"
                      onConfirm={async () => {
                        try {
                          await deactivateShow(show.id);
                          shows.reload();
                        } catch (err: unknown) {
                          shows.reload();
                          if (err instanceof ApiError) window.alert(err.message);
                        }
                      }}
                    >
                      Deactivate
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CreateShowForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("en");
  const [categoryPrimary, setCategoryPrimary] = useState<string>(APPLE_CATEGORIES[0]);
  const [categorySecondary, setCategorySecondary] = useState<string>("");
  const [explicit, setExplicit] = useState(false);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [copyrightText, setCopyrightText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSlugError(null);
    if (!SLUG_PATTERN.test(slug)) {
      setSlugError(
        "Lowercase letters, digits, and hyphens only; must start with a letter or digit.",
      );
      return;
    }
    const body: ShowCreateRequest = {
      slug,
      title,
      authorName,
      ownerName,
      ownerEmail,
      description,
      language,
      categoryPrimary: categoryPrimary as ShowCreateRequest["categoryPrimary"],
      categorySecondary:
        categorySecondary === ""
          ? null
          : (categorySecondary as ShowCreateRequest["categoryPrimary"]),
      explicit,
      websiteUrl: websiteUrl.trim() === "" ? null : websiteUrl.trim(),
      copyrightText: copyrightText.trim() === "" ? null : copyrightText.trim(),
    };
    setSubmitting(true);
    try {
      const show = await createShow(body);
      onCreated(show.id);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : "Could not create the show.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <h3>New show</h3>
      {error !== null && <Banner variant="error">{error}</Banner>}
      <TextField
        label="Slug"
        required
        value={slug}
        onChange={setSlug}
        error={slugError}
        hint="Used in the public feed URL; cannot change after the first publish."
        placeholder="my-show"
      />
      <TextField label="Title" required value={title} onChange={setTitle} />
      <TextField label="Author name" required value={authorName} onChange={setAuthorName} />
      <TextField label="Owner name" required value={ownerName} onChange={setOwnerName} />
      <TextField
        label="Owner email"
        required
        type="email"
        value={ownerEmail}
        onChange={setOwnerEmail}
      />
      <TextArea label="Description" required value={description} onChange={setDescription} />
      <TextField
        label="Language"
        required
        value={language}
        onChange={setLanguage}
        hint="A language tag such as en, ja, or en-US."
      />
      <SelectField
        label="Primary category"
        required
        value={categoryPrimary}
        onChange={setCategoryPrimary}
        options={CATEGORY_OPTIONS}
      />
      <SelectField
        label="Secondary category"
        value={categorySecondary}
        onChange={setCategorySecondary}
        options={OPTIONAL_CATEGORY_OPTIONS}
      />
      <CheckboxField label="Explicit content" checked={explicit} onChange={setExplicit} />
      <TextField label="Website URL" type="url" value={websiteUrl} onChange={setWebsiteUrl} />
      <TextField label="Copyright text" value={copyrightText} onChange={setCopyrightText} />
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create show"}
        </button>
      </div>
    </form>
  );
}
