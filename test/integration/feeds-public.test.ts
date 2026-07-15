import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BASE, uniqueSlug } from "./session-helper";

/**
 * Public feed delivery (mvp-design.md section 13.1): GET/HEAD
 * /feeds/{slug}.xml served from the canonical R2 object, never rebuilt per
 * request. Publishing-side generation of the canonical object is covered by
 * publishing.test.ts; these tests seed the R2 object directly.
 */

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Feed Delivery Test</title></channel></rss>
`;

interface ErrorBody {
  error: { code: string; message: string };
}

async function putFeed(slug: string): Promise<R2Object> {
  const object = await env.MEDIA.put(`feeds/${slug}.xml`, FEED_XML, {
    httpMetadata: {
      contentType: "application/rss+xml; charset=utf-8",
      cacheControl: "public, max-age=300",
    },
  });
  expect(object).not.toBeNull();
  return object as R2Object;
}

let slug: string;
let feedUrl: string;
let points: AnalyticsEngineDataPoint[];
let originalWrite: typeof env.DELIVERY_ANALYTICS.writeDataPoint;

beforeEach(async () => {
  slug = uniqueSlug("feedpub");
  feedUrl = `${BASE}/feeds/${slug}.xml`;
  await putFeed(slug);

  points = [];
  originalWrite = env.DELIVERY_ANALYTICS.writeDataPoint;
  env.DELIVERY_ANALYTICS.writeDataPoint = (point) => {
    if (point !== undefined) {
      points.push(point);
    }
  };
});

afterEach(() => {
  env.DELIVERY_ANALYTICS.writeDataPoint = originalWrite;
});

describe("GET /feeds/{slug}.xml", () => {
  it("serves the canonical R2 object with the section 13.1 headers", async () => {
    const res = await SELF.fetch(feedUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Length")).toBe(String(new Blob([FEED_XML]).size));

    // Quoted ETag from the R2 httpEtag representation.
    const etag = res.headers.get("ETag");
    expect(etag).toMatch(/^".+"$/);

    // Valid HTTP date.
    const lastModified = res.headers.get("Last-Modified");
    expect(lastModified).not.toBeNull();
    expect(Number.isNaN(Date.parse(lastModified as string))).toBe(false);

    expect(await res.text()).toBe(FEED_XML);
  });

  it("returns 304 for a matching If-None-Match", async () => {
    const first = await SELF.fetch(feedUrl);
    const etag = first.headers.get("ETag") as string;

    const res = await SELF.fetch(feedUrl, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("returns 304 for If-Modified-Since at the Last-Modified time", async () => {
    const first = await SELF.fetch(feedUrl);
    const lastModified = first.headers.get("Last-Modified") as string;

    const res = await SELF.fetch(feedUrl, { headers: { "If-Modified-Since": lastModified } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  it("returns 200 for a stale If-Modified-Since", async () => {
    const res = await SELF.fetch(feedUrl, {
      headers: { "If-Modified-Since": new Date(0).toUTCString() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FEED_XML);
  });

  it("returns the 404 envelope for an unknown slug", async () => {
    const res = await SELF.fetch(`${BASE}/feeds/${uniqueSlug("missing")}.xml`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it.each([
    ["uppercase slug", "Bad.xml"],
    ["wrong extension", "some-slug.json"],
    ["no extension", "some-slug"],
    ["leading hyphen", "-slug.xml"],
    ["encoded traversal", "..%2fsecrets.xml"],
  ])("rejects %s with 404", async (_name, file) => {
    const res = await SELF.fetch(`${BASE}/feeds/${file}`);
    expect(res.status).toBe(404);
  });

  it("writes no delivery analytics for feed requests", async () => {
    const res = await SELF.fetch(feedUrl);
    expect(res.status).toBe(200);
    await res.text();
    // Media responses write their event through waitUntil; give any stray
    // write a moment to land before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(points).toHaveLength(0);
  });
});

describe("HEAD /feeds/{slug}.xml", () => {
  it("returns the same headers as GET with no body", async () => {
    const getRes = await SELF.fetch(feedUrl);
    const res = await SELF.fetch(feedUrl, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    for (const name of [
      "Content-Type",
      "Cache-Control",
      "ETag",
      "Last-Modified",
      "X-Content-Type-Options",
      "Content-Length",
    ]) {
      expect(res.headers.get(name)).toBe(getRes.headers.get(name));
    }
  });

  it("supports If-None-Match on HEAD", async () => {
    const getRes = await SELF.fetch(feedUrl);
    const etag = getRes.headers.get("ETag") as string;
    const res = await SELF.fetch(feedUrl, {
      method: "HEAD",
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
  });

  it("returns 404 for an unknown slug", async () => {
    const res = await SELF.fetch(`${BASE}/feeds/${uniqueSlug("missing")}.xml`, {
      method: "HEAD",
    });
    expect(res.status).toBe(404);
  });
});
