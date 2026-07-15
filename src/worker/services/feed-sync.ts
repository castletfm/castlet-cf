import { z } from "zod";

import { FEED_CACHE_MAX_AGE_SECONDS, MAX_FEED_EPISODES } from "../../shared/constants";
import {
  acquireFeedSyncLock,
  getShowById,
  getStorageObjectById,
  listPublishedEpisodesForFeed,
  markShowFeedSynchronized,
  releaseFeedSyncLock,
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
 * to the revision the XML was built from and clears feed_error. A build
 * failure or an R2 write failure instead stores a concise feed_error and
 * reports a retryable failure, leaving the caller's committed D1 state and the
 * previous canonical feed object intact rather than throwing (so the route
 * returns a controlled 502, never an uncaught 500).
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

/** Concise feed_error value for a build failure (e.g. XML-invalid stored text). */
const FEED_BUILD_ERROR_MESSAGE = "Canonical feed generation failed";

/**
 * Per-show feed-sync advisory lock tuning (section 12.3). The lease is long
 * enough to cover a slow R2 PUT and short enough that a crashed holder is
 * reclaimed quickly. The bounded acquire wait (attempts * backoff) keeps a
 * contended request from blocking indefinitely; when it runs out it returns the
 * retryable FEED_WRITE_FAILED so the operator retries rather than a stale feed
 * being reported synchronized.
 */
const FEED_SYNC_LOCK_TTL_MS = 30_000;
const FEED_SYNC_LOCK_MAX_ACQUIRE_ATTEMPTS = 50;
const FEED_SYNC_LOCK_ACQUIRE_BACKOFF_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Rebuilds and stores the canonical feed for a show. The build+PUT+mark section
 * runs behind a per-show advisory lock (section 12.3): two concurrent same-show
 * syncs are serialized, so their R2 PUTs to feeds/{slug}.xml can no longer
 * reorder and leave R2 holding an older revision under a "synchronized" state.
 * Inside the lock the show is re-read so the XML is built from the current
 * feed_revision (callers bump the revision before synchronizing).
 */
export async function synchronizeFeed(deps: FeedSyncDeps, showId: string): Promise<FeedSyncResult> {
  const { db } = deps;

  // Cheap pre-lock validation so an unknown or not-feed-ready show returns the
  // right error (404 / 409) without ever contending for the lock. (Acquiring
  // the lock for a nonexistent id would match zero rows and only ever time out.)
  const show = await getShowById(db, showId);
  if (show === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  const readiness = await checkShowFeedReady(db, show);
  if (!readiness.ready) {
    return { ok: false, error: "SHOW_NOT_FEED_READY", missing: readiness.missing };
  }

  // Bounded wait to acquire the per-show lock. Serializing here is what closes
  // the R2-PUT reorder race; keep the CAS mark below as defense in depth.
  const nonce = crypto.randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < FEED_SYNC_LOCK_MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + FEED_SYNC_LOCK_TTL_MS).toISOString();
    if (await acquireFeedSyncLock(db, showId, nonce, nowIso, expiresAt)) {
      acquired = true;
      break;
    }
    if (attempt < FEED_SYNC_LOCK_MAX_ACQUIRE_ATTEMPTS - 1) {
      await sleep(FEED_SYNC_LOCK_ACQUIRE_BACKOFF_MS);
    }
  }
  if (!acquired) {
    // Could not serialize within the bounded wait. Return the retryable failure
    // (mapped to 502) rather than skipping this request's R2 write and falsely
    // reporting success — success is owed only after our own R2 write lands.
    return { ok: false, error: "FEED_WRITE_FAILED" };
  }

  try {
    return await synchronizeFeedLocked(deps, showId);
  } finally {
    await releaseFeedSyncLock(db, showId, nonce);
  }
}

/**
 * The build+PUT+mark critical section, run while the per-show lock is held.
 * Re-reads the show under the lock so the XML reflects the current
 * feed_revision and data rather than a stale pre-lock snapshot.
 */
async function synchronizeFeedLocked(deps: FeedSyncDeps, showId: string): Promise<FeedSyncResult> {
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
  const nowIso = new Date().toISOString();

  let xml: string;
  try {
    xml = buildRssFeed({
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
  } catch {
    // Defense in depth: a feed-visible field holding a character XML 1.0 cannot
    // represent (InvalidXmlCharacterError) — or any other build failure — would
    // otherwise throw uncaught here, after the caller has already committed the
    // publish and feed-revision bump to D1, yielding a 500 with no feed_error.
    // Validation normally rejects such input at write time (validation.ts); this
    // covers legacy rows and any edge path by routing the failure to the same
    // controlled, retryable feed_error path as an R2 write failure (section
    // 12.3), so the request returns FEED_WRITE_FAILED (mapped to 502), not 500.
    await setShowFeedError(db, show.id, FEED_BUILD_ERROR_MESSAGE, nowIso);
    return { ok: false, error: "FEED_WRITE_FAILED" };
  }

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

  // Compare-and-set mark (see markShowFeedSynchronized): advances the published
  // revision only while feed_revision still equals builtRevision. Under the
  // lock builtRevision is the current revision; the guard remains as defense in
  // depth against the narrow lock-expiry overlap window.
  await markShowFeedSynchronized(db, show.id, builtRevision, nowIso);
  return { ok: true, revision: builtRevision };
}
