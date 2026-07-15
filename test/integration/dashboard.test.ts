import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  DashboardResponse,
  EpisodeResource,
  ShowResource,
  UploadInitiateResponse,
} from "../../src/shared/contracts";
import {
  BASE,
  createAuthContext,
  readHeaders,
  uniqueSlug,
  writeHeaders,
  type AuthContext,
} from "./session-helper";

const PAST_ISO = "2000-01-01T00:00:00.000Z";

let auth: AuthContext;

beforeEach(async () => {
  auth = await createAuthContext();
});

async function createShow(): Promise<ShowResource> {
  const res = await SELF.fetch(`${BASE}/api/shows`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      slug: uniqueSlug("dash"),
      title: "Dashboard Show",
      authorName: "Author",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      description: "Show for dashboard tests.",
      categoryPrimary: "Technology",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ShowResource;
}

async function createEpisode(showId: string, title: string): Promise<EpisodeResource> {
  const res = await SELF.fetch(`${BASE}/api/shows/${showId}/episodes`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as EpisodeResource;
}

async function initiateArtwork(showId: string, size: number): Promise<UploadInitiateResponse> {
  const res = await SELF.fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      ownerKind: "show",
      ownerId: showId,
      kind: "artwork",
      filename: "cover.png",
      contentType: "image/png",
      size,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as UploadInitiateResponse;
}

async function getDashboard(): Promise<DashboardResponse> {
  const res = await SELF.fetch(`${BASE}/api/dashboard`, { headers: readHeaders(auth) });
  expect(res.status).toBe(200);
  return (await res.json()) as DashboardResponse;
}

async function usage(): Promise<{ active_bytes: number; reserved_bytes: number }> {
  const row = await env.DB.prepare(
    "SELECT active_bytes, reserved_bytes FROM account_usage WHERE singleton_id = 1",
  ).first<{ active_bytes: number; reserved_bytes: number }>();
  expect(row).not.toBeNull();
  return row as { active_bytes: number; reserved_bytes: number };
}

describe("GET /api/dashboard", () => {
  it("requires authentication", async () => {
    const res = await SELF.fetch(`${BASE}/api/dashboard`);
    expect(res.status).toBe(401);
  });

  it("reports storage counters including seeded reservations and the ceiling", async () => {
    const show = await createShow();
    const before = await usage();
    const initiated = await initiateArtwork(show.id, 5000);

    const dashboard = await getDashboard();
    expect(dashboard.storage.maxTotalBytes).toBe(Number(env.MAX_TOTAL_STORAGE_BYTES));
    expect(dashboard.storage.activeBytes).toBe(before.active_bytes);
    expect(dashboard.storage.reservedBytes).toBe(before.reserved_bytes + 5000);

    const abort = await SELF.fetch(`${BASE}/api/uploads/${initiated.uploadId}`, {
      method: "DELETE",
      headers: writeHeaders(auth),
    });
    expect(abort.status).toBe(204);
  });

  it("detects feed-dirty shows both ways and omits synchronized shows", async () => {
    const show = await createShow();

    // Fresh show: revision 0 published, no error -> not dirty.
    let dashboard = await getDashboard();
    expect(dashboard.feedDirtyShows.map((s) => s.id)).not.toContain(show.id);

    // Published revision lags -> dirty.
    await env.DB.prepare("UPDATE shows SET feed_revision = feed_revision + 1 WHERE id = ?")
      .bind(show.id)
      .run();
    dashboard = await getDashboard();
    expect(dashboard.feedDirtyShows.map((s) => s.id)).toContain(show.id);

    // Revisions equal but feed_error recorded -> still dirty.
    await env.DB.prepare(
      "UPDATE shows SET feed_published_revision = feed_revision, feed_error = 'R2 write failed' WHERE id = ?",
    )
      .bind(show.id)
      .run();
    dashboard = await getDashboard();
    const dirty = dashboard.feedDirtyShows.find((s) => s.id === show.id);
    expect(dirty?.feedError).toBe("R2 write failed");

    // Fully synchronized again -> not dirty.
    await env.DB.prepare("UPDATE shows SET feed_error = NULL WHERE id = ?").bind(show.id).run();
    dashboard = await getDashboard();
    expect(dashboard.feedDirtyShows.map((s) => s.id)).not.toContain(show.id);
  });

  it("caps recent episodes at 10, newest first", async () => {
    const show = await createShow();
    const created: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      created.push((await createEpisode(show.id, `Episode ${i}`)).id);
    }

    const dashboard = await getDashboard();
    expect(dashboard.recentEpisodes).toHaveLength(10);
    for (const episode of dashboard.recentEpisodes) {
      expect(created).toContain(episode.id);
    }
    // Newest first: created_at ordering is non-increasing.
    const stamps = dashboard.recentEpisodes.map((e) => e.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it("sweeps expired upload intents opportunistically", async () => {
    const show = await createShow();
    const before = await usage();
    const initiated = await initiateArtwork(show.id, 64);
    await env.DB.prepare("UPDATE upload_intents SET expires_at = ? WHERE id = ?")
      .bind(PAST_ISO, initiated.uploadId)
      .run();

    await getDashboard();

    const intent = await env.DB.prepare("SELECT status FROM upload_intents WHERE id = ?")
      .bind(initiated.uploadId)
      .first<{ status: string }>();
    expect(intent?.status).toBe("expired");
    const object = await env.DB.prepare("SELECT status FROM storage_objects WHERE id = ?")
      .bind(initiated.storageObjectId)
      .first<{ status: string }>();
    expect(object?.status).toBe("deleted");
    expect(await usage()).toEqual(before);
  });
});
