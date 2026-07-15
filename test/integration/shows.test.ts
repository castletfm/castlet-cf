import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { ShowListResponse, ShowResource } from "../../src/shared/contracts";
import {
  BASE,
  createAuthContext,
  readHeaders,
  uniqueSlug,
  writeHeaders,
  type AuthContext,
} from "./session-helper";

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

const SHOW_INPUT = {
  title: "Test Show",
  authorName: "Author",
  ownerName: "Owner",
  ownerEmail: "owner@example.com",
  description: "A show used in integration tests.",
  categoryPrimary: "Technology",
};

let auth: AuthContext;

beforeEach(async () => {
  auth = await createAuthContext();
});

async function createShow(overrides: Record<string, unknown> = {}): Promise<ShowResource> {
  const res = await SELF.fetch(`${BASE}/api/shows`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({ ...SHOW_INPUT, slug: uniqueSlug(), ...overrides }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ShowResource;
}

async function getShow(id: string): Promise<ShowResource> {
  const res = await SELF.fetch(`${BASE}/api/shows/${id}`, { headers: readHeaders(auth) });
  expect(res.status).toBe(200);
  return (await res.json()) as ShowResource;
}

describe("POST /api/shows", () => {
  it("creates a show with defaults, version 1, and feed revision 0", async () => {
    const slug = uniqueSlug("created");
    const show = await createShow({ slug });

    expect(show.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(show.slug).toBe(slug);
    expect(show.status).toBe("active");
    expect(show.language).toBe("en");
    expect(show.explicit).toBe(false);
    expect(show.version).toBe(1);
    expect(show.feedRevision).toBe(0);
    expect(show.slugLockedAt).toBeNull();
  });

  it("rejects a duplicate slug with 409 SLUG_TAKEN", async () => {
    const slug = uniqueSlug("dup");
    await createShow({ slug });
    const res = await SELF.fetch(`${BASE}/api/shows`, {
      method: "POST",
      headers: writeHeaders(auth),
      body: JSON.stringify({ ...SHOW_INPUT, slug }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("SLUG_TAKEN");
  });

  it("rejects invalid input with 422 VALIDATION_FAILED", async () => {
    const res = await SELF.fetch(`${BASE}/api/shows`, {
      method: "POST",
      headers: writeHeaders(auth),
      body: JSON.stringify({ ...SHOW_INPUT, slug: "Bad Slug", ownerEmail: "nope" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody & { error: { details: { issues: unknown[] } } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });
});

describe("GET /api/shows and GET /api/shows/{id}", () => {
  it("lists created shows", async () => {
    const a = await createShow();
    const b = await createShow();

    const res = await SELF.fetch(`${BASE}/api/shows`, { headers: readHeaders(auth) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ShowListResponse;
    const ids = body.shows.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("returns 404 for an unknown show id", async () => {
    const res = await SELF.fetch(`${BASE}/api/shows/${crypto.randomUUID()}`, {
      headers: readHeaders(auth),
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/shows/{id}", () => {
  it("updates fields and increments version and feed revision", async () => {
    const show = await createShow();
    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, title: "Renamed", explicit: true }),
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as ShowResource;
    expect(updated.title).toBe("Renamed");
    expect(updated.explicit).toBe(true);
    expect(updated.version).toBe(2);
    expect(updated.feedRevision).toBe(1);
    // Untouched fields survive the update.
    expect(updated.slug).toBe(show.slug);
    expect(updated.ownerEmail).toBe(show.ownerEmail);
  });

  it("returns 409 VERSION_CONFLICT for a stale version and writes nothing", async () => {
    const show = await createShow();
    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 99, title: "Stale write" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VERSION_CONFLICT");

    const unchanged = await getShow(show.id);
    expect(unchanged.title).toBe(SHOW_INPUT.title);
    expect(unchanged.version).toBe(1);
    expect(unchanged.feedRevision).toBe(0);
  });

  it("allows a slug change while unlocked", async () => {
    const show = await createShow();
    const renamed = uniqueSlug("renamed");
    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, slug: renamed }),
    });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as ShowResource;
    expect(updated.slug).toBe(renamed);
  });

  it("refuses a slug change once slug_locked_at is set", async () => {
    const show = await createShow();
    await env.DB.prepare("UPDATE shows SET slug_locked_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), show.id)
      .run();

    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, slug: uniqueSlug("new") }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("SLUG_LOCKED");

    // Other metadata stays editable, including a no-op same-slug value.
    const titleRes = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, slug: show.slug, title: "Still editable" }),
    });
    expect(titleRes.status).toBe(200);
  });

  it("rejects changing the slug to one taken by another show", async () => {
    const takenSlug = uniqueSlug("taken");
    await createShow({ slug: takenSlug });
    const show = await createShow();

    const res = await SELF.fetch(`${BASE}/api/shows/${show.id}`, {
      method: "PATCH",
      headers: writeHeaders(auth),
      body: JSON.stringify({ version: 1, slug: takenSlug }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("SLUG_TAKEN");
  });
});

describe("POST /api/shows/{id}/deactivate", () => {
  it("soft-deactivates and is idempotent", async () => {
    const show = await createShow();

    const first = await SELF.fetch(`${BASE}/api/shows/${show.id}/deactivate`, {
      method: "POST",
      headers: writeHeaders(auth),
      body: "{}",
    });
    expect(first.status).toBe(200);
    const deactivated = (await first.json()) as ShowResource;
    expect(deactivated.status).toBe("inactive");
    const revisionAfterFirst = deactivated.feedRevision;

    const second = await SELF.fetch(`${BASE}/api/shows/${show.id}/deactivate`, {
      method: "POST",
      headers: writeHeaders(auth),
      body: "{}",
    });
    expect(second.status).toBe(200);
    const again = (await second.json()) as ShowResource;
    expect(again.status).toBe("inactive");
    expect(again.feedRevision).toBe(revisionAfterFirst);
  });
});

describe("route protection smoke tests", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await SELF.fetch(`${BASE}/api/shows`);
    expect(res.status).toBe(401);
  });

  it("rejects an authenticated write without a CSRF token with 403", async () => {
    const res = await SELF.fetch(`${BASE}/api/shows`, {
      method: "POST",
      headers: {
        Cookie: auth.cookieHeader,
        "Content-Type": "application/json",
        Origin: "http://example.com",
      },
      body: JSON.stringify(SHOW_INPUT),
    });
    expect(res.status).toBe(403);
  });
});
