import { z } from "zod";

import { FEED_CACHE_MAX_AGE_SECONDS, MAX_FEED_EPISODES } from "../../shared/constants";
import {
  getShowById,
  getStorageObjectById,
  listPublishedEpisodesForFeed,
  markShowFeedSynchronized,
  setShowFeedError,
  type ShowRow,
  type StorageObjectRow,
} from "./db";
import { buildRssFeed } from "./rss";

/**
 * Canonical feed synchronization (mvp-design.md sections 12.1, 12.3, 13.1).
 *
 * synchronizeFeed() builds the RSS document from current D1 state and writes
 * it to R2 under feeds/{slug}.xml. Success advances feed_published_revision
 * to the revision the XML was built from and clears feed_error; an R2 write
 * failure stores a concise feed_error and reports a retryable failure while
 * the previous canonical feed object stays intact.
 */

export interface FeedSyncDeps {
  db: D1Database;
  media: R2Bucket;
  publicBaseUrl: string;
}

/** Canonical R2 object key for a show's feed (section 13.1). */
export function feedObjectKey(slug: string): string {
  return `feeds/${slug}.xml`;
}

/** R2 HTTP metadata stored with the canonical feed (sections 13.1 and 13.4). */
export const FEED_CONTENT_TYPE = "application/rss+xml; charset=utf-8";
export const FEED_CACHE_CONTROL = `public, max-age=${FEED_CACHE_MAX_AGE_SECONDS}`;

/** Concise feed_error value; never a raw provider error body (section 15.1). */
const FEED_WRITE_ERROR_MESSAGE = "Canonical feed write to R2 failed";

const feedEmailSchema = z.email().max(254);

export type FeedReadiness =
  { ready: true; artwork: StorageObjectRow } | { ready: false; missing: string[] };

/**
 * Feed readiness (section 12.1): the show fields the channel needs plus an
 * ACTIVE artwork object. The at-least-one-published-episode rule applies to
 * directory submission only — an empty feed is valid, so it is deliberately
 * not checked here. The explicit flag is a NOT NULL 0/1 column and is always
 * present.
 */
export async function checkShowFeedReady(db: D1Database, show: ShowRow): Promise<FeedReadiness> {
  const missing: string[] = [];
  if (show.title.trim() === "") {
    missing.push("title");
  }
  if (show.author_name.trim() === "") {
    missing.push("authorName");
  }
  if (show.owner_name.trim() === "") {
    missing.push("ownerName");
  }
  if (!feedEmailSchema.safeParse(show.owner_email).success) {
    missing.push("ownerEmail");
  }
  if (show.description.trim() === "") {
    missing.push("description");
  }
  if (show.language.trim() === "") {
    missing.push("language");
  }
  if (show.category_primary.trim() === "") {
    missing.push("categoryPrimary");
  }

  let artwork: StorageObjectRow | null = null;
  if (show.artwork_object_id !== null) {
    artwork = await getStorageObjectById(db, show.artwork_object_id);
  }
  if (artwork === null || artwork.status !== "active" || artwork.kind !== "artwork") {
    missing.push("artwork");
    return { ready: false, missing };
  }

  if (missing.length > 0) {
    return { ready: false, missing };
  }
  return { ready: true, artwork };
}

export type FeedSyncResult =
  | { ok: true; revision: number }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "SHOW_NOT_FEED_READY"; missing: string[] }
  | { ok: false; error: "FEED_WRITE_FAILED" };

/**
 * Rebuilds and stores the canonical feed for a show. Re-reads the show so
 * the XML is built from the latest feed_revision (callers bump the revision
 * before synchronizing).
 */
export async function synchronizeFeed(deps: FeedSyncDeps, showId: string): Promise<FeedSyncResult> {
  const { db, media } = deps;

  const show = await getShowById(db, showId);
  if (show === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  const readiness = await checkShowFeedReady(db, show);
  if (!readiness.ready) {
    return { ok: false, error: "SHOW_NOT_FEED_READY", missing: readiness.missing };
  }

  const builtRevision = show.feed_revision;
  const episodes = await listPublishedEpisodesForFeed(db, show.id, MAX_FEED_EPISODES);
  const xml = buildRssFeed({
    show: {
      slug: show.slug,
      title: show.title,
      authorName: show.author_name,
      ownerName: show.owner_name,
      ownerEmail: show.owner_email,
      description: show.description,
      language: show.language,
      categoryPrimary: show.category_primary,
      categorySecondary: show.category_secondary,
      explicit: show.explicit === 1,
      websiteUrl: show.website_url,
      copyrightText: show.copyright_text,
      artworkPublicPath: readiness.artwork.public_path,
    },
    episodes: episodes.map((row) => ({
      guid: row.guid,
      title: row.title,
      description: row.description,
      status: row.status,
      // The join only returns published rows, which always carry a timestamp.
      publishedAt: row.published_at ?? row.updated_at,
      episodeType: row.episode_type,
      explicit: row.explicit === 1,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      durationSeconds: row.duration_seconds,
      audioPublicPath: row.audio_public_path,
      audioByteLength: row.audio_byte_length,
      audioContentType: row.audio_content_type,
    })),
    publicBaseUrl: deps.publicBaseUrl,
  });

  const nowIso = new Date().toISOString();
  try {
    await media.put(feedObjectKey(show.slug), xml, {
      httpMetadata: {
        contentType: FEED_CONTENT_TYPE,
        cacheControl: FEED_CACHE_CONTROL,
      },
    });
  } catch {
    // Keep the D1 mutation and the previous canonical feed; record a concise,
    // retryable error (section 12.3).
    await setShowFeedError(db, show.id, FEED_WRITE_ERROR_MESSAGE, nowIso);
    return { ok: false, error: "FEED_WRITE_FAILED" };
  }

  await markShowFeedSynchronized(db, show.id, builtRevision, nowIso);
  return { ok: true, revision: builtRevision };
}
