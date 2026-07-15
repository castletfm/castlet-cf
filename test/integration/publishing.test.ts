import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { EpisodeResource, ShowResource } from "../../src/shared/contracts";
import { publishEpisode } from "../../src/worker/domain/episodes";
import { synchronizeFeed } from "../../src/worker/services/feed-sync";
import {
  BASE,
  createAuthContext,
  readHeaders,
  uniqueSlug,
  writeHeaders,
  type AuthContext,
} from "./session-helper";

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

interface ShowFeedStateRow {
  feed_revision: number;
  feed_published_revision: number;
  feed_error: string | null;
  feed_last_generated_at: string | null;
  slug_locked_at: string | null;
  version: number;
}

interface EpisodeStateRow {
  status: string;
  guid: string;
  published_at: string | null;
  version: number;
}

let auth: AuthContext;
let show: ShowResource;
let episode: EpisodeResource;

beforeEach(async () => {
  auth = await createAuthContext();
  const showRes = await SELF.fetch(`${BASE}/api/shows`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      slug: uniqueSlug("pub"),
      title: "Publishing Show",
      authorName: "Author",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      description: "Show hosting publish tests.",
      categoryPrimary: "Technology",
    }),
  });
  expect(showRes.status).toBe(201);
  show = (await showRes.json()) as ShowResource;

  episode = await createEpisode("Episode One");
});

async function createEpisode(title: string): Promise<EpisodeResource> {
  const res = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({ title, description: "An episode description." }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as EpisodeResource;
}

/** Inserts an ACTIVE storage object row directly (upload flow is Phase 3's tests). */
async function insertActiveObject(input: {
  ownerKind: "show" | "episode";
  ownerId: string;
  kind: "artwork" | "audio";
  objectKey: string;
  publicPath: string;
  contentType: string;
  byteLength: number | null;
  status?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO storage_objects (
       id, owner_kind, owner_id, kind, object_key, public_path,
       original_filename, content_type, byte_length, etag, status,
       created_at, activated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'orig.bin', ?, ?, 'etag-1', ?, ?, ?)`,
  )
    .bind(
      id,
      input.ownerKind,
      input.ownerId,
      input.kind,
      input.objectKey,
      input.publicPath,
      input.contentType,
      input.byteLength,
      input.status ?? "active",
      nowIso,
      nowIso,
    )
    .run();
  return id;
}

async function attachArtwork(showId: string): Promise<string> {
  const objectId = await insertActiveObject({
    ownerKind: "show",
    ownerId: showId,
    kind: "artwork",
    objectKey: `artwork/${showId}/${crypto.randomUUID()}.jpg`,
    publicPath: `/artwork/${showId}/${crypto.randomUUID()}.jpg`,
    contentType: "image/jpeg",
    byteLength: 4096,
  });
  await env.DB.prepare("UPDATE shows SET artwork_object_id = ? WHERE id = ?")
    .bind(objectId, showId)
    .run();
  return objectId;
}

async function attachAudio(
  episodeId: string,
  overrides: { contentType?: string; byteLength?: number | null } = {},
): Promise<string> {
  const objectId = await insertActiveObject({
    ownerKind: "episode",
    ownerId: episodeId,
    kind: "audio",
    objectKey: `audio/${show.id}/${episodeId}/${crypto.randomUUID()}.mp3`,
    publicPath: `/media/${show.id}/${episodeId}/${crypto.randomUUID()}.mp3`,
    contentType: overrides.contentType ?? "audio/mpeg",
    byteLength: overrides.byteLength === undefined ? 48_320_123 : overrides.byteLength,
  });
  await env.DB.prepare(
    "UPDATE episodes SET audio_object_id = ?, duration_seconds = 1854 WHERE id = ?",
  )
    .bind(objectId, episodeId)
    .run();
  return objectId;
}

async function makePublishable(episodeId: string): Promise<void> {
  await attachArtwork(show.id);
  await attachAudio(episodeId);
}

async function publish(episodeId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/episodes/${episodeId}/publish`, {
    method: "POST",
    headers: writeHeaders(auth),
  });
}

async function unpublish(episodeId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/episodes/${episodeId}/unpublish`, {
    method: "POST",
    headers: writeHeaders(auth),
  });
}

async function regenerateFeed(showId: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/shows/${showId}/regenerate-feed`, {
    method: "POST",
    headers: writeHeaders(auth),
  });
}

async function showFeedState(showId: string): Promise<ShowFeedStateRow> {
  const row = await env.DB.prepare(
    `SELECT feed_revision, feed_published_revision, feed_error,
            feed_last_generated_at, slug_locked_at, version
     FROM shows WHERE id = ?`,
  )
    .bind(showId)
    .first<ShowFeedStateRow>();
  expect(row).not.toBeNull();
  return row as ShowFeedStateRow;
}

async function episodeState(episodeId: string): Promise<EpisodeStateRow> {
  const row = await env.DB.prepare(
    "SELECT status, guid, published_at, version FROM episodes WHERE id = ?",
  )
    .bind(episodeId)
    .first<EpisodeStateRow>();
  expect(row).not.toBeNull();
  return row as EpisodeStateRow;
}

async function readFeed(slug: string): Promise<{ body: R2ObjectBody; text: string } | null> {
  const object = await env.MEDIA.get(`feeds/${slug}.xml`);
  if (object === null) {
    return null;
  }
  return { body: object, text: await object.text() };
}

// ---------------------------------------------------------------------------
// POST /api/episodes/{id}/publish
// ---------------------------------------------------------------------------

describe("POST /api/episodes/{id}/publish", () => {
  it("requires authentication", async () => {
    const res = await SELF.fetch(`${BASE}/api/episodes/${episode.id}/publish`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("publishes the episode and writes the canonical feed to R2", async () => {
    await makePublishable(episode.id);

    const res = await publish(episode.id);
    expect(res.status).toBe(200);
    const published = (await res.json()) as EpisodeResource;
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
    expect(published.guid).toBe(episode.guid);

    // Canonical feed exists in R2 with the design's HTTP metadata (13.4).
    const feed = await readFeed(show.slug);
    expect(feed).not.toBeNull();
    expect(feed?.body.httpMetadata?.contentType).toBe("application/rss+xml; charset=utf-8");
    expect(feed?.body.httpMetadata?.cacheControl).toBe("public, max-age=300");

    // Feed content: channel + the published item with its stable GUID and
    // enclosure metadata built from the active audio object.
    expect(feed?.text).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(feed?.text).toContain("<title>Publishing Show</title>");
    expect(feed?.text).toContain(`<guid isPermaLink="false">${episode.guid}</guid>`);
    expect(feed?.text).toContain(`length="48320123" type="audio/mpeg"`);
    expect(feed?.text).toContain("<itunes:duration>30:54</itunes:duration>");
    expect(feed?.text).toContain(
      `<atom:link href="http://example.com/feeds/${show.slug}.xml" rel="self" type="application/rss+xml" />`,
    );

    // Revisions match, no error, slug locked on first publication.
    const state = await showFeedState(show.id);
    expect(state.feed_revision).toBeGreaterThan(0);
    expect(state.feed_published_revision).toBe(state.feed_revision);
    expect(state.feed_error).toBeNull();
    expect(state.feed_last_generated_at).not.toBeNull();
    expect(state.slug_locked_at).not.toBeNull();

    // The show GET response surfaces the synchronized state.
    const showRes = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      headers: readHeaders(auth),
    });
    const showBody = (await showRes.json()) as ShowResource;
    expect(showBody.feedSynchronized).toBe(true);
    expect(showBody.feedError).toBeNull();
  });

  it("rejects republishing with 409", async () => {
    await makePublishable(episode.id);
    expect((await publish(episode.id)).status).toBe(200);

    const res = await publish(episode.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("EPISODE_ALREADY_PUBLISHED");
  });

  it("blocks publishing when the show has no active artwork", async () => {
    await attachAudio(episode.id); // audio only; no artwork

    const res = await publish(episode.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("SHOW_NOT_FEED_READY");
    expect(body.error.details).toEqual({ missing: ["artwork"] });

    // Nothing was mutated and no feed was written.
    expect((await episodeState(episode.id)).status).toBe("draft");
    expect(await readFeed(show.slug)).toBeNull();
    const state = await showFeedState(show.id);
    expect(state.slug_locked_at).toBeNull();
    expect(state.feed_revision).toBe(0);
  });

  it("blocks publishing when the episode has no audio", async () => {
    await attachArtwork(show.id); // artwork only; no audio

    const res = await publish(episode.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("EPISODE_NOT_PUBLISHABLE");
    expect(body.error.details).toEqual({ missing: ["audio"] });
    expect((await episodeState(episode.id)).status).toBe("draft");
  });

  it("blocks publishing when the audio object has no positive byte length", async () => {
    await attachArtwork(show.id);
    await attachAudio(episode.id, { byteLength: null });

    const res = await publish(episode.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("EPISODE_NOT_PUBLISHABLE");
    expect(body.error.details).toEqual({ missing: ["audioByteLength"] });
  });

  it("blocks publishing when the episode description is empty", async () => {
    await makePublishable(episode.id);
    await env.DB.prepare("UPDATE episodes SET description = '' WHERE id = ?")
      .bind(episode.id)
      .run();

    const res = await publish(episode.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("EPISODE_NOT_PUBLISHABLE");
    expect(body.error.details).toEqual({ missing: ["description"] });
  });

  it("preserves version discipline for concurrent edits", async () => {
    await makePublishable(episode.id);

    // A metadata PATCH lands before the publish (version 1 -> 2).
    const patchRes = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: episode.version, title: "Renamed before publish" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as EpisodeResource;
    expect(patched.version).toBe(episode.version + 1);

    const showVersionBefore = (await showFeedState(show.id)).version;

    const res = await publish(episode.id);
    expect(res.status).toBe(200);
    const published = (await res.json()) as EpisodeResource;

    // Publish incremented on top of the concurrent bump, not over it.
    expect(published.version).toBe(patched.version + 1);
    expect(published.title).toBe("Renamed before publish");

    // Publishing does not consume the operator's cached show version:
    // slug lock and feed bookkeeping leave shows.version untouched.
    expect((await showFeedState(show.id)).version).toBe(showVersionBefore);
    const showPatch = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: showVersionBefore, title: "Still editable" }),
    });
    expect(showPatch.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/episodes/{id}/unpublish
// ---------------------------------------------------------------------------

describe("POST /api/episodes/{id}/unpublish", () => {
  it("removes the item from the regenerated feed and retains the GUID", async () => {
    await makePublishable(episode.id);
    expect((await publish(episode.id)).status).toBe(200);
    expect((await readFeed(show.slug))?.text).toContain(episode.guid);

    const res = await unpublish(episode.id);
    expect(res.status).toBe(200);
    const unpublished = (await res.json()) as EpisodeResource;
    expect(unpublished.status).toBe("unpublished");
    expect(unpublished.guid).toBe(episode.guid);

    // The feed keeps publishing as a valid empty channel (12.1 note).
    const feed = await readFeed(show.slug);
    expect(feed).not.toBeNull();
    expect(feed?.text).not.toContain(episode.guid);
    expect(feed?.text).not.toContain("<item>");
    expect(feed?.text).toContain("<title>Publishing Show</title>");

    const state = await showFeedState(show.id);
    expect(state.feed_published_revision).toBe(state.feed_revision);
    expect(state.feed_error).toBeNull();

    // GUID and media survive in D1 (12.4).
    const row = await episodeState(episode.id);
    expect(row.guid).toBe(episode.guid);
  });

  it("rejects unpublishing a non-published episode with 409", async () => {
    const res = await unpublish(episode.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("EPISODE_NOT_PUBLISHED");
  });
});

// ---------------------------------------------------------------------------
// R2 write failure and POST /api/shows/{id}/regenerate-feed
// ---------------------------------------------------------------------------

describe("feed write failure and regenerate-feed", () => {
  it("returns 502 on R2 failure, keeps D1 publish state and the old feed, then a retry succeeds", async () => {
    // First a successful publish so a previous canonical feed exists.
    await makePublishable(episode.id);
    expect((await publish(episode.id)).status).toBe(200);
    const oldFeedText = (await readFeed(show.slug))?.text;
    expect(oldFeedText).toContain(episode.guid);

    const second = await createEpisode("Episode Two");
    await attachAudio(second.id);

    // Simulate an R2 outage: the test runner shares the worker's env, so
    // patching the binding's put() makes the worker's feed write fail.
    const originalPut = env.MEDIA.put;
    (env.MEDIA as { put: unknown }).put = () => Promise.reject(new Error("simulated R2 outage"));
    let res: Response;
    try {
      res = await publish(second.id);
    } finally {
      (env.MEDIA as { put: unknown }).put = originalPut;
    }

    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("FEED_WRITE_FAILED");
    expect(body.error.details).toEqual({ retryable: true });

    // D1 publish state retained; feed marked dirty with a concise error.
    expect((await episodeState(second.id)).status).toBe("published");
    const dirty = await showFeedState(show.id);
    expect(dirty.feed_error).not.toBeNull();
    expect(dirty.feed_published_revision).toBeLessThan(dirty.feed_revision);

    // The previous canonical feed is intact (no partial write).
    const feedDuringError = await readFeed(show.slug);
    expect(feedDuringError?.text).toBe(oldFeedText);
    expect(feedDuringError?.text).not.toContain(second.guid);

    // The show resource surfaces the failure for the dashboard.
    const showRes = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      headers: readHeaders(auth),
    });
    const showBody = (await showRes.json()) as ShowResource;
    expect(showBody.feedSynchronized).toBe(false);
    expect(showBody.feedError).not.toBeNull();

    // Retry via regenerate-feed: clears the error and catches the feed up.
    const retry = await regenerateFeed(show.id);
    expect(retry.status).toBe(200);
    const regenerated = (await retry.json()) as ShowResource;
    expect(regenerated.feedSynchronized).toBe(true);
    expect(regenerated.feedError).toBeNull();

    const feedAfterRetry = await readFeed(show.slug);
    expect(feedAfterRetry?.text).toContain(episode.guid);
    expect(feedAfterRetry?.text).toContain(second.guid);
    const state = await showFeedState(show.id);
    expect(state.feed_published_revision).toBe(state.feed_revision);
    expect(state.feed_error).toBeNull();
  });

  it("returns a controlled 502 (not a 500) when a stored value makes the feed build throw", async () => {
    // Validation rejects XML-1.0-invalid control characters at write time, so
    // simulate a legacy row by writing U+0001 into the episode description
    // directly. On publish the D1 state commits first, then buildRssFeed throws
    // InvalidXmlCharacterError; the defense-in-depth catch must route that to
    // the controlled feed_error / FEED_WRITE_FAILED (502) path (F3).
    await makePublishable(episode.id);
    const badDescription = `legacy${String.fromCharCode(1)}description`;
    await env.DB.prepare("UPDATE episodes SET description = ? WHERE id = ?")
      .bind(badDescription, episode.id)
      .run();

    const res = await publish(episode.id);
    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("FEED_WRITE_FAILED");
    expect(body.error.details).toEqual({ retryable: true });

    // The publish committed to D1, and the feed is marked dirty with a concise
    // error — the designed retryable state, not a silent 500 with no feed_error.
    expect((await episodeState(episode.id)).status).toBe("published");
    const dirty = await showFeedState(show.id);
    expect(dirty.feed_error).not.toBeNull();
    expect(dirty.feed_published_revision).toBeLessThan(dirty.feed_revision);

    // The build threw before any R2 write, so no feed object was created.
    expect(await readFeed(show.slug)).toBeNull();
  });

  it("allows an idempotent regenerate when revisions already match", async () => {
    await makePublishable(episode.id);
    expect((await publish(episode.id)).status).toBe(200);
    const before = await showFeedState(show.id);
    expect(before.feed_published_revision).toBe(before.feed_revision);

    const res = await regenerateFeed(show.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ShowResource).feedSynchronized).toBe(true);
    expect((await readFeed(show.slug))?.text).toContain(episode.guid);
  });

  it("rejects regenerating a feed for a show that is not feed-ready", async () => {
    const res = await regenerateFeed(show.id); // no artwork attached
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("SHOW_NOT_FEED_READY");
    expect(body.error.details).toEqual({ missing: ["artwork"] });
  });

  it("returns 404 for an unknown show", async () => {
    const res = await regenerateFeed(crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Concurrent same-show feed sync (per-show advisory lock)
// ---------------------------------------------------------------------------

describe("concurrent same-show feed sync", () => {
  it("serializes overlapping syncs so R2 ends at the newest revision and D1 matches", async () => {
    await makePublishable(episode.id);
    expect((await publish(episode.id)).status).toBe(200);

    const deps = {
      db: env.DB,
      media: env.MEDIA,
      publicBaseUrl: env.PUBLIC_BASE_URL as string,
    };

    // Two feed-affecting edits queued back to back: an older revision carrying
    // "Concurrent Title A" and a newer one carrying "Concurrent Title B".
    await env.DB.prepare(
      "UPDATE shows SET title = 'Concurrent Title A', feed_revision = feed_revision + 1 WHERE id = ?",
    )
      .bind(show.id)
      .run();
    const syncOlder = synchronizeFeed(deps, show.id);

    await env.DB.prepare(
      "UPDATE shows SET title = 'Concurrent Title B', feed_revision = feed_revision + 1 WHERE id = ?",
    )
      .bind(show.id)
      .run();
    const syncNewer = synchronizeFeed(deps, show.id);

    // Delay the FIRST R2 PUT so that, without serialization, the older sync's
    // write would land LAST and overwrite feeds/{slug}.xml with stale XML while
    // D1 still reported synchronized. The lock must prevent that reordering.
    const originalPut = env.MEDIA.put.bind(env.MEDIA);
    let putCount = 0;
    (env.MEDIA as { put: unknown }).put = (...args: unknown[]): Promise<unknown> => {
      putCount += 1;
      const delayMs = putCount === 1 ? 80 : 0;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          (originalPut as (...a: unknown[]) => Promise<unknown>)(...args).then(resolve, reject);
        }, delayMs);
      });
    };

    let older: Awaited<typeof syncOlder>;
    let newer: Awaited<typeof syncNewer>;
    try {
      [older, newer] = await Promise.all([syncOlder, syncNewer]);
    } finally {
      (env.MEDIA as { put: unknown }).put = originalPut;
    }

    // Both syncs succeed (neither is skipped-and-lied-to), and each reports its
    // mark as applied (serialized, so neither is superseded).
    expect(older.ok).toBe(true);
    expect(newer.ok).toBe(true);
    expect(older.ok && older.synchronized).toBe(true);
    expect(newer.ok && newer.synchronized).toBe(true);

    // R2 holds the newest content, never the older revision's stale XML: because
    // each sync re-reads under the lock, both build the current (newest) feed.
    const feed = await readFeed(show.slug);
    expect(feed?.text).toContain("<title>Concurrent Title B</title>");
    expect(feed?.text).not.toContain("<title>Concurrent Title A</title>");

    // D1 reports synchronized AND matches R2 (no stale-under-synchronized).
    const state = await showFeedState(show.id);
    expect(state.feed_published_revision).toBe(state.feed_revision);
    expect(state.feed_error).toBeNull();
  });

  it("warns and leaves the feed dirty when a concurrent bump supersedes it before the mark", async () => {
    await makePublishable(episode.id);
    expect((await publish(episode.id)).status).toBe(200);

    const deps = {
      db: env.DB,
      media: env.MEDIA,
      publicBaseUrl: env.PUBLIC_BASE_URL as string,
    };

    // A feed-affecting edit to sync.
    await env.DB.prepare(
      "UPDATE shows SET title = 'Superseded', feed_revision = feed_revision + 1 WHERE id = ?",
    )
      .bind(show.id)
      .run();

    // Bump feed_revision again DURING this sync's R2 write — after it captured
    // builtRevision under the lock but before the compare-and-set mark — so the
    // mark's guard (feed_revision = builtRevision) matches zero rows, exactly as
    // a concurrent feed-affecting PATCH landing mid-sync would.
    const originalPut = env.MEDIA.put.bind(env.MEDIA);
    let bumped = false;
    (env.MEDIA as { put: unknown }).put = async (...args: unknown[]): Promise<unknown> => {
      if (!bumped) {
        bumped = true;
        await env.DB.prepare("UPDATE shows SET feed_revision = feed_revision + 1 WHERE id = ?")
          .bind(show.id)
          .run();
      }
      return (originalPut as (...a: unknown[]) => Promise<unknown>)(...args);
    };

    let result: Awaited<ReturnType<typeof synchronizeFeed>>;
    try {
      result = await synchronizeFeed(deps, show.id);
    } finally {
      (env.MEDIA as { put: unknown }).put = originalPut;
    }

    // The R2 write landed, so the sync does not fail the publish, but it reports
    // the mark as superseded instead of silently swallowing it.
    expect(result.ok).toBe(true);
    expect(result.ok && result.synchronized).toBe(false);
    // The feed is left dirty for the next publish/regenerate to re-sync.
    const state = await showFeedState(show.id);
    expect(state.feed_published_revision).toBeLessThan(state.feed_revision);
  });
});

// ---------------------------------------------------------------------------
// Validate-then-write races (the publish/slug fences)
// ---------------------------------------------------------------------------

type PreparedStatement = ReturnType<D1Database["prepare"]>;

/**
 * Deterministically lands a concurrent mutation inside a read->write window:
 * the first time a prepared statement whose SQL contains `needle` runs its
 * terminal `.first()`, `mutate` is awaited before the read returns. Wrapping
 * `.bind()` too keeps the hook alive across `prepare().bind().first()`.
 */
function raceOnRead(needle: string, mutate: () => Promise<void>): () => void {
  const db = env.DB as unknown as { prepare: (sql: string) => PreparedStatement };
  const originalPrepare = db.prepare.bind(db);
  let fired = false;

  function wrap(stmt: PreparedStatement, sql: string): PreparedStatement {
    const s = stmt as unknown as {
      bind: (...a: unknown[]) => PreparedStatement;
      first: (...a: unknown[]) => Promise<unknown>;
    };
    const originalBind = s.bind.bind(s);
    const originalFirst = s.first.bind(s);
    s.bind = (...a: unknown[]): PreparedStatement => wrap(originalBind(...a), sql);
    s.first = async (...a: unknown[]): Promise<unknown> => {
      if (!fired && sql.includes(needle)) {
        fired = true;
        await mutate();
      }
      return originalFirst(...a);
    };
    return stmt;
  }

  db.prepare = (sql: string): PreparedStatement => wrap(originalPrepare(sql), sql);
  return () => {
    db.prepare = originalPrepare;
  };
}

/**
 * Like {@link raceOnRead} but lands `mutate` AFTER the terminal `.first()`
 * returns, so the caller still reads the pre-mutation row into memory. Use this
 * to test a write fenced in the DB (not a re-checked in-memory value): the flow
 * reads a still-valid row, then the mutation invalidates it before the fenced
 * write runs.
 */
function raceAfterRead(needle: string, mutate: () => Promise<void>): () => void {
  const db = env.DB as unknown as { prepare: (sql: string) => PreparedStatement };
  const originalPrepare = db.prepare.bind(db);
  let fired = false;

  function wrap(stmt: PreparedStatement, sql: string): PreparedStatement {
    const s = stmt as unknown as {
      bind: (...a: unknown[]) => PreparedStatement;
      first: (...a: unknown[]) => Promise<unknown>;
    };
    const originalBind = s.bind.bind(s);
    const originalFirst = s.first.bind(s);
    s.bind = (...a: unknown[]): PreparedStatement => wrap(originalBind(...a), sql);
    s.first = async (...a: unknown[]): Promise<unknown> => {
      const row = await originalFirst(...a);
      if (!fired && sql.includes(needle)) {
        fired = true;
        await mutate();
      }
      return row;
    };
    return stmt;
  }

  db.prepare = (sql: string): PreparedStatement => wrap(originalPrepare(sql), sql);
  return () => {
    db.prepare = originalPrepare;
  };
}

describe("validate-then-write races", () => {
  it("rejects a publish whose validated version a concurrent PATCH bumped, and writes no feed", async () => {
    await makePublishable(episode.id);

    // Blank the description AND bump the version the instant the publish flow
    // reads the show — i.e. AFTER missingPublishRequirements saw a good
    // description but BEFORE the fenced publish UPDATE. Without the version
    // fence, publish would commit an empty-description episode into the feed.
    const restore = raceOnRead("FROM shows WHERE id = ?", async () => {
      await env.DB.prepare(
        "UPDATE episodes SET description = '', version = version + 1 WHERE id = ?",
      )
        .bind(episode.id)
        .run();
    });

    let res: Response;
    try {
      res = await publish(episode.id);
    } finally {
      restore();
    }

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    // The reported reason reflects reality (blanked description), not a
    // misleading EPISODE_ALREADY_PUBLISHED.
    expect(body.error.code).toBe("EPISODE_NOT_PUBLISHABLE");
    expect(body.error.details).toEqual({ missing: ["description"] });

    // The episode stayed unpublished and no canonical feed was written.
    expect((await episodeState(episode.id)).status).toBe("draft");
    expect(await readFeed(show.slug)).toBeNull();
  });

  it("rejects a publish onto a show a concurrent deactivate flipped inactive, and writes no feed", async () => {
    await makePublishable(episode.id);

    // Deactivate the show the instant the publish flow reads it — i.e. AFTER the
    // upfront show.status check saw the in-memory show active but BEFORE the
    // fenced publish UPDATE. A deactivate bumps the show version, not the
    // episode version, so the episode-version guard alone would still publish
    // onto a just-deactivated show; the EXISTS(show active) fence changes zero
    // rows instead, and the lost-race re-read reports it truthfully.
    const restore = raceAfterRead("FROM shows WHERE id = ?", async () => {
      await env.DB.prepare(
        "UPDATE shows SET status = 'inactive', version = version + 1 WHERE id = ?",
      )
        .bind(show.id)
        .run();
    });

    let res: Response;
    try {
      res = await publish(episode.id);
    } finally {
      restore();
    }

    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("SHOW_INACTIVE");

    // The episode stayed unpublished and no canonical feed was written.
    expect((await episodeState(episode.id)).status).toBe("draft");
    expect(await readFeed(show.slug)).toBeNull();
  });

  it("rejects a slug change fenced on a concurrent first-publish's slug lock", async () => {
    await makePublishable(episode.id);
    const deps = {
      db: env.DB,
      media: env.MEDIA,
      publicBaseUrl: env.PUBLIC_BASE_URL as string,
    };

    // A first-publish locks the slug (without bumping shows.version) the instant
    // the slug-changing PATCH checks the new slug's availability — i.e. AFTER the
    // PATCH read an unlocked show but BEFORE its fenced UPDATE. Without the
    // slug_locked_at fence, the version guard alone (version unchanged) would let
    // a published show's slug change and break feeds/{slug}.xml.
    const restore = raceOnRead("FROM shows WHERE slug = ?", async () => {
      const published = await publishEpisode(deps, episode.id);
      expect(published.ok).toBe(true);
    });

    const newSlug = uniqueSlug("relocated");
    let res: Response;
    try {
      res = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
        method: "PATCH",
        headers: writeHeaders(auth),
        body: JSON.stringify({ version: show.version, slug: newSlug }),
      });
    } finally {
      restore();
    }

    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("SLUG_LOCKED");

    // The slug is locked and unchanged; the feed still lives at the old slug.
    const state = await showFeedState(show.id);
    expect(state.slug_locked_at).not.toBeNull();
    const showRow = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      headers: readHeaders(auth),
    });
    expect(((await showRow.json()) as ShowResource).slug).toBe(show.slug);
    expect(await readFeed(newSlug)).toBeNull();
  });
});
