import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Route } from "@playwright/test";

import { TEST_ADMIN_ACCESS_KEY } from "../auth-constants";

/**
 * Mandatory end-to-end happy path (mvp-design.md section 18.3), driven through
 * the real admin SPA against a local `wrangler dev` (see start-dev.mjs):
 *
 *   log in (Turnstile TEST key) -> create show -> upload artwork ->
 *   create episode -> upload MP3 -> publish -> fetch feed and assert the
 *   episode + enclosure -> HEAD + Range bytes=0-1023 on the enclosure ->
 *   unpublish -> assert the feed no longer contains the item.
 *
 * The one deviation from a production run is the upload transport. Production
 * uploads go browser -> presigned PUT -> R2 S3 endpoint. A local dev server has
 * no reachable S3 endpoint for its local R2 bucket, so we intercept the
 * browser's PUT to *.r2.cloudflarestorage.com and forward the fixture bytes to
 * the Worker's own R2 binding via the dev-only shim (PUT /__e2e/r2/*, gated by
 * E2E_UPLOAD_SHIM). Everything else — the SPA flow, quota reservation, the
 * completion HEAD + signature check, feed generation, and public delivery —
 * runs exactly as in production. Playwright cannot read the XHR upload body
 * (postDataBuffer is null for it), so the interceptor serves the known fixture
 * from disk keyed by the object-key extension; the declared size the SPA sent
 * is that same file's size, so the completion size check still holds.
 */

const PORT = process.env.E2E_PORT ?? "8788";
const BASE = `http://127.0.0.1:${PORT}`;

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const ARTWORK = `${FIXTURES}artwork.jpg`;
const AUDIO = `${FIXTURES}tiny.mp3`;

/** Match the enclosure URL, byte length, and MIME type in feed XML. */
const ENCLOSURE = /<enclosure[^>]*url="([^"]+)"[^>]*length="(\d+)"[^>]*type="([^"]+)"/;

test("operator publishes an episode and it appears in and leaves the feed", async ({
  page,
  context,
  request,
}) => {
  const slug = `e2e-${Math.random().toString(36).slice(2, 8)}`;

  // Reroute the credential-less R2 PUT to the local upload shim so the bytes
  // land in the same local R2 bucket the completion step then reads.
  await page.route(/r2\.cloudflarestorage\.com/, async (route: Route) => {
    const url = new URL(route.request().url());
    // Presigned path is /{bucket}/{objectKey}; drop the bucket segment.
    const objectKey = url.pathname.split("/").filter(Boolean).slice(1).join("/");
    const contentType = route.request().headers()["content-type"] ?? "application/octet-stream";
    const fixture = /\.jpe?g$/.test(objectKey) ? ARTWORK : AUDIO;
    const shim = await request.put(`${BASE}/__e2e/r2/${objectKey}`, {
      headers: { "content-type": contentType },
      data: readFileSync(fixture),
    });
    expect(shim.status(), "upload shim should accept the object").toBe(200);
    await route.fulfill({ status: 200, body: "" });
  });

  // --- log in through the real Turnstile-backed login form ---
  await page.goto("/");
  await page.getByLabel("Access key").fill(TEST_ADMIN_ACCESS_KEY);
  // The TEST sitekey auto-solves and writes the token into the response input.
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
    return el !== null && el.value.length > 0;
  });
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // --- create a show ---
  await page.goto("/#/shows");
  await page.getByRole("button", { name: "New show" }).click();
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Title").fill("E2E Show");
  await page.getByLabel("Author name").fill("E2E Author");
  await page.getByLabel("Owner name").fill("E2E Owner");
  await page.getByLabel("Owner email").fill("owner@example.com");
  await page.getByLabel("Description").fill("An end-to-end test show.");
  await page.getByRole("button", { name: "Create show" }).click();
  await expect(page.getByRole("heading", { name: "Show settings" })).toBeVisible();
  const showId = page.url().split("/shows/")[1] ?? "";
  expect(showId).not.toBe("");

  // --- upload square artwork (1400x1400) ---
  await page.getByLabel("Choose artwork file").setInputFiles(ARTWORK);
  await page.getByRole("button", { name: "Upload artwork" }).click();
  await expect(page.getByRole("img", { name: "Show artwork" })).toBeVisible();

  // --- create an episode draft ---
  await page.goto(`/#/shows/${showId}/episodes`);
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByLabel("Title").fill("E2E Episode");
  await page.getByLabel("Description").fill("An end-to-end test episode.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByRole("heading", { name: "Episode editor" })).toBeVisible();
  const episodeId = page.url().split("/episodes/")[1] ?? "";
  expect(episodeId).not.toBe("");

  // --- upload a small valid MP3 ---
  await page.getByLabel("Choose audio file").setInputFiles(AUDIO);
  await page.getByRole("button", { name: "Upload audio" }).click();
  await expect(page.getByText("Audio attached.")).toBeVisible();

  // --- publish ---
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByText("Published and feed synchronized.")).toBeVisible();

  // --- fetch the feed and assert the episode + enclosure ---
  const feedUrl = `${BASE}/feeds/${slug}.xml`;
  const feedRes = await request.get(feedUrl);
  expect(feedRes.status()).toBe(200);
  expect(feedRes.headers()["content-type"]).toContain("application/rss+xml");
  const feedXml = await feedRes.text();
  expect(feedXml).toContain("E2E Episode");
  const enclosure = ENCLOSURE.exec(feedXml);
  expect(enclosure, "feed should contain an enclosure").not.toBeNull();
  const mediaUrl = enclosure![1] as string;
  expect(enclosure![3]).toBe("audio/mpeg");

  // --- HEAD the enclosure ---
  const headRes = await request.head(mediaUrl);
  expect(headRes.status()).toBe(200);
  expect(headRes.headers()["accept-ranges"]).toBe("bytes");
  const total = Number(headRes.headers()["content-length"]);
  expect(total).toBeGreaterThan(1024);

  // --- Range: bytes=0-1023 -> 206 with exactly 1024 bytes ---
  const rangeRes = await request.get(mediaUrl, { headers: { Range: "bytes=0-1023" } });
  expect(rangeRes.status()).toBe(206);
  expect(rangeRes.headers()["content-range"]).toBe(`bytes 0-1023/${total}`);
  const rangeBody = await rangeRes.body();
  expect(rangeBody.byteLength).toBe(1024);

  // --- unpublish and assert the item leaves the feed ---
  await page.goto(`/#/episodes/${episodeId}`);
  await page.getByRole("button", { name: "Unpublish" }).click(); // arm the confirm
  await page.getByRole("button", { name: "Unpublish" }).click(); // confirm
  await expect(page.getByText("Unpublished and removed from the feed.")).toBeVisible();

  const feedAfter = await context.request.get(feedUrl);
  expect(feedAfter.status()).toBe(200);
  const feedAfterXml = await feedAfter.text();
  expect(feedAfterXml).not.toContain("E2E Episode");
  expect(feedAfterXml).not.toContain("<enclosure");
});
