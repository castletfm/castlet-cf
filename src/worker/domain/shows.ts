import type { z } from "zod";

import type { ShowResource } from "../../shared/contracts";
import type { showCreateSchema, showPatchSchema } from "../../shared/validation";
import {
  deactivateShowRow,
  getShowById,
  getShowBySlug,
  insertShow,
  isUniqueConstraintError,
  updateShowMetadata,
  type ShowRow,
} from "../services/db";

/**
 * Show business rules (mvp-design.md sections 9.1, 12.1, 12.5).
 * Routes translate the returned error tags into HTTP status codes.
 */

export type ShowCreateInput = z.output<typeof showCreateSchema>;
export type ShowPatchInput = z.output<typeof showPatchSchema>;

export type ShowErrorCode = "NOT_FOUND" | "SLUG_TAKEN" | "SLUG_LOCKED" | "VERSION_CONFLICT";

export type ShowResult = { ok: true; show: ShowRow } | { ok: false; error: ShowErrorCode };

export function showRowToResource(row: ShowRow): ShowResource {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    authorName: row.author_name,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    description: row.description,
    language: row.language,
    categoryPrimary: row.category_primary,
    categorySecondary: row.category_secondary,
    explicit: row.explicit === 1,
    websiteUrl: row.website_url,
    copyrightText: row.copyright_text,
    artworkObjectId: row.artwork_object_id,
    status: row.status,
    feedRevision: row.feed_revision,
    feedPublishedRevision: row.feed_published_revision,
    feedLastGeneratedAt: row.feed_last_generated_at,
    feedError: row.feed_error,
    slugLockedAt: row.slug_locked_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createShow(db: D1Database, input: ShowCreateInput): Promise<ShowResult> {
  const now = new Date().toISOString();
  const row: ShowRow = {
    id: crypto.randomUUID(),
    slug: input.slug,
    title: input.title,
    author_name: input.authorName,
    owner_name: input.ownerName,
    owner_email: input.ownerEmail,
    description: input.description,
    language: input.language,
    category_primary: input.categoryPrimary,
    category_secondary: input.categorySecondary ?? null,
    explicit: input.explicit ? 1 : 0,
    website_url: input.websiteUrl ?? null,
    copyright_text: input.copyrightText ?? null,
    artwork_object_id: null,
    status: "active",
    feed_revision: 0,
    feed_published_revision: 0,
    feed_last_generated_at: null,
    feed_error: null,
    slug_locked_at: null,
    version: 1,
    created_at: now,
    updated_at: now,
  };

  try {
    await insertShow(db, row);
  } catch (err) {
    // The UNIQUE index is the authority; a pre-check would still race.
    if (isUniqueConstraintError(err, "shows.slug")) {
      return { ok: false, error: "SLUG_TAKEN" };
    }
    throw err;
  }
  return { ok: true, show: row };
}

export async function updateShow(
  db: D1Database,
  id: string,
  patch: ShowPatchInput,
): Promise<ShowResult> {
  const current = await getShowById(db, id);
  if (current === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (patch.version !== current.version) {
    return { ok: false, error: "VERSION_CONFLICT" };
  }

  if (patch.slug !== undefined && patch.slug !== current.slug) {
    // Slug is immutable once locked at first publish (section 9.1).
    if (current.slug_locked_at !== null) {
      return { ok: false, error: "SLUG_LOCKED" };
    }
    const taken = await getShowBySlug(db, patch.slug);
    if (taken !== null && taken.id !== id) {
      return { ok: false, error: "SLUG_TAKEN" };
    }
  }

  const now = new Date().toISOString();
  let updated: boolean;
  try {
    updated = await updateShowMetadata(db, {
      id,
      expectedVersion: patch.version,
      slug: patch.slug ?? current.slug,
      title: patch.title ?? current.title,
      author_name: patch.authorName ?? current.author_name,
      owner_name: patch.ownerName ?? current.owner_name,
      owner_email: patch.ownerEmail ?? current.owner_email,
      description: patch.description ?? current.description,
      language: patch.language ?? current.language,
      category_primary: patch.categoryPrimary ?? current.category_primary,
      category_secondary:
        patch.categorySecondary === undefined
          ? current.category_secondary
          : patch.categorySecondary,
      explicit: (patch.explicit === undefined ? current.explicit === 1 : patch.explicit) ? 1 : 0,
      website_url: patch.websiteUrl === undefined ? current.website_url : patch.websiteUrl,
      copyright_text:
        patch.copyrightText === undefined ? current.copyright_text : patch.copyrightText,
      updated_at: now,
    });
  } catch (err) {
    if (isUniqueConstraintError(err, "shows.slug")) {
      return { ok: false, error: "SLUG_TAKEN" };
    }
    throw err;
  }
  if (!updated) {
    // The version guard lost a race between our read and the UPDATE.
    return { ok: false, error: "VERSION_CONFLICT" };
  }

  const row = await getShowById(db, id);
  if (row === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  return { ok: true, show: row };
}

/** Idempotent soft-deactivation; repeat calls return the inactive show. */
export async function deactivateShow(db: D1Database, id: string): Promise<ShowResult> {
  const current = await getShowById(db, id);
  if (current === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (current.status === "active") {
    await deactivateShowRow(db, id, new Date().toISOString());
  }
  const row = await getShowById(db, id);
  if (row === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  return { ok: true, show: row };
}
