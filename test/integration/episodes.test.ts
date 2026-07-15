import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  EpisodeListResponse,
  EpisodeResource,
  ShowResource,
} from "../../src/shared/contracts";
import {
  BASE,
  createAuthContext,
  readHeaders,
  uniqueSlug,
  writeHeaders,
  type AuthContext,
} from "./session-helper";

interface ErrorBody {
  error: { code: string; message: string };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let auth: AuthContext;
let show: ShowResource;

beforeEach(async () => {
  auth = await createAuthContext();
  const res = await SELF.fetch(`${BASE}/api/shows`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      slug: uniqueSlug("episode-host"),
      title: "Episode Host Show",
      authorName: "Author",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      description: "Show hosting episode tests.",
      categoryPrimary: "Technology",
    }),
  });
  expect(res.status).toBe(201);
  show = (await res.json()) as ShowResource;
});

async function createEpisode(overrides: Record<string, unknown> = {}): Promise<EpisodeResource> {
  const res = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({ title: "Episode", ...overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as EpisodeResource;
}

async function getEpisode(id: string): Promise<EpisodeResource> {
  const res = await SELF.fetch(`${BASE}/api/episodes/${id}`, { headers: readHeaders(auth) });
  expect(res.status).toBe(200);
  return (await res.json()) as EpisodeResource;
}

async function getShowResource(id: string): Promise<ShowResource> {
  const res = await SELF.fetch(`${BASE}/api/shows/${id}`, { headers: readHeaders(auth) });
  expect(res.status).toBe(200);
  return (await res.json()) as ShowResource;
}

/** Simulate a Phase 4 status transition directly in D1. */
async function setEpisodeStatus(id: string, status: string): Promise<void> {
  await env.DB.prepare("UPDATE episodes SET status = ?, published_at = ? WHERE id = ?")
    .bind(status, status === "draft" ? null : new Date().toISOString(), id)
    .run();
}

describe("POST /api/shows/{id}/episodes", () => {
  it("creates a draft with a server-generated GUID", async () => {
    const episode = await createEpisode({ title: "Pilot" });

    expect(episode.showId).toBe(show.id);
    expect(episode.guid).toMatch(UUID_PATTERN);
    expect(episode.status).toBe("draft");
    expect(episode.episodeType).toBe("full");
    expect(episode.version).toBe(1);
    expect(episode.publishedAt).toBeNull();
    expect(episode.audioObjectId).toBeNull();
  });

  it("returns 404 for an unknown show", async () => {
    const res = await SELF.fetch(`${BASE}/api/shows/${crypto.randomUUID()}/episodes`, {
      method: "POST",
      headers: writeHeaders(auth),
      body: JSON.stringify({ title: "Orphan" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 SHOW_INACTIVE for a deactivated show", async () => {
    await SELF.fetch(`${BASE}/api/shows/${show.id}/deactivate`, {
      method: "POST",
      headers: writeHeaders(auth),
      body: "{}",
    });

    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes`, {
      method: "POST",
      headers: writeHeaders(auth),
      body: JSON.stringify({ title: "Too late" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("SHOW_INACTIVE");
  });
});

describe("GUID immutability", () => {
  it("rejects a PATCH that tries to set guid and keeps the original", async () => {
    const episode = await createEpisode();

    const res = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, guid: "attacker-chosen-guid" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VALIDATION_FAILED");

    expect((await getEpisode(episode.id)).guid).toBe(episode.guid);
  });

  it("keeps the GUID across normal metadata updates", async () => {
    const episode = await createEpisode();
    const res = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, title: "Renamed", description: "New notes" }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as EpisodeResource;
    expect(updated.guid).toBe(episode.guid);
    expect(updated.title).toBe("Renamed");
    expect(updated.version).toBe(2);
  });
});

describe("PATCH /api/episodes/{id}", () => {
  it("returns 409 VERSION_CONFLICT for a stale version and writes nothing", async () => {
    const episode = await createEpisode();
    const res = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 42, title: "Stale" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VERSION_CONFLICT");

    const unchanged = await getEpisode(episode.id);
    expect(unchanged.title).toBe("Episode");
    expect(unchanged.version).toBe(1);
  });

  it("returns 409 EPISODE_NOT_EDITABLE for a published episode", async () => {
    const episode = await createEpisode();
    await setEpisodeStatus(episode.id, "published");

    const res = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, title: "Not allowed" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("EPISODE_NOT_EDITABLE");
  });

  it("edits an unpublished episode and increments the show feed revision", async () => {
    const episode = await createEpisode();
    await setEpisodeStatus(episode.id, "unpublished");
    const revisionBefore = (await getShowResource(show.id)).feedRevision;

    const res = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, title: "Post-unpublish edit" }),
    });
    expect(res.status).toBe(200);

    expect((await getShowResource(show.id)).feedRevision).toBe(revisionBefore + 1);
  });

  it("does not touch the show feed revision for draft edits", async () => {
    const episode = await createEpisode();
    const revisionBefore = (await getShowResource(show.id)).feedRevision;

    const res = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, title: "Draft edit" }),
    });
    expect(res.status).toBe(200);

    expect((await getShowResource(show.id)).feedRevision).toBe(revisionBefore);
  });
});

describe("GET /api/shows/{id}/episodes", () => {
  it("lists episodes and filters by status", async () => {
    const draft = await createEpisode({ title: "Draft episode" });
    const published = await createEpisode({ title: "Published episode" });
    await setEpisodeStatus(published.id, "published");

    const allRes = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes`, {
      headers: readHeaders(auth),
    });
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as EpisodeListResponse;
    expect(all.episodes).toHaveLength(2);

    const draftRes = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes?status=draft`, {
      headers: readHeaders(auth),
    });
    const drafts = (await draftRes.json()) as EpisodeListResponse;
    expect(drafts.episodes.map((e) => e.id)).toEqual([draft.id]);

    const pubRes = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes?status=published`, {
      headers: readHeaders(auth),
    });
    const pubs = (await pubRes.json()) as EpisodeListResponse;
    expect(pubs.episodes.map((e) => e.id)).toEqual([published.id]);
  });

  it("rejects an unknown status filter with 422", async () => {
    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes?status=bogus`, {
      headers: readHeaders(auth),
    });
    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/episodes/{id}", () => {
  function deleteEpisode(id: string): Promise<Response> {
    return SELF.fetch(`${BASE}/api/episodes/${id}`, {
      method: "DELETE",
      headers: writeHeaders(auth),
    });
  }

  it("deletes a draft", async () => {
    const episode = await createEpisode();
    const res = await deleteEpisode(episode.id);
    expect(res.status).toBe(204);

    const gone = await SELF.fetch(`${BASE}/api/episodes/${episode.id}`, {
      headers: readHeaders(auth),
    });
    expect(gone.status).toBe(404);
  });

  it("rejects deleting a published episode with 409", async () => {
    const episode = await createEpisode();
    await setEpisodeStatus(episode.id, "published");

    const res = await deleteEpisode(episode.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("EPISODE_PUBLISHED");

    expect((await getEpisode(episode.id)).id).toBe(episode.id);
  });

  it("deletes an unpublished episode and increments the show feed revision", async () => {
    const episode = await createEpisode();
    await setEpisodeStatus(episode.id, "unpublished");
    const revisionBefore = (await getShowResource(show.id)).feedRevision;

    const res = await deleteEpisode(episode.id);
    expect(res.status).toBe(204);

    expect((await getShowResource(show.id)).feedRevision).toBe(revisionBefore + 1);
  });
});

describe("route protection smoke tests", () => {
  it("rejects unauthenticated episode reads with 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/episodes/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("rejects an episode write without a CSRF token with 403", async () => {
    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}/episodes`, {
      method: "POST",
      headers: {
        Cookie: auth.cookieHeader,
        "Content-Type": "application/json",
        Origin: "http://example.com",
      },
      body: JSON.stringify({ title: "No CSRF" }),
    });
    expect(res.status).toBe(403);
  });
});
