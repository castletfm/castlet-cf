#!/usr/bin/env node
/**
 * Deployment smoke test (mvp-design.md section 18.4).
 *
 * Exercises the public surface of a deployed (or locally running) Castlet
 * instance the way a podcast client would: liveness, the canonical feed, and
 * immutable media delivery including a single byte range. It is the scripted
 * form of the section 18.4 curls:
 *
 *   curl -fsS  "${BASE_URL}/api/health"
 *   curl -fsSI "${BASE_URL}/feeds/${SHOW_SLUG}.xml"
 *   curl -fsSI "${MEDIA_URL}"
 *   curl -fsS -D - -o /dev/null -H 'Range: bytes=0-1023' "${MEDIA_URL}"
 *
 * The range response must be 206, carry a correct Content-Range, and return
 * exactly 1024 bytes when the object is at least that large.
 *
 * Usage:
 *   node scripts/smoke-test.mjs <BASE_URL> [SHOW_SLUG] [MEDIA_URL]
 *   BASE_URL=... SHOW_SLUG=... MEDIA_URL=... node scripts/smoke-test.mjs
 *
 * Arguments override the matching environment variables. BASE_URL is required.
 * SHOW_SLUG enables the feed check; MEDIA_URL enables the media + range checks.
 * Checks whose inputs are missing are reported as SKIP, not failures.
 *
 * Exit code is 0 when every attempted check passes, non-zero otherwise.
 */

const [, , baseArg, slugArg, mediaArg] = process.argv;

const BASE_URL = (baseArg ?? process.env.BASE_URL ?? "").replace(/\/+$/, "");
const SHOW_SLUG = slugArg ?? process.env.SHOW_SLUG ?? "";
const MEDIA_URL = mediaArg ?? process.env.MEDIA_URL ?? "";

const RANGE_BYTES = 1024;

function usage() {
  process.stderr.write(
    [
      "Castlet deployment smoke test (mvp-design.md 18.4)",
      "",
      "Usage:",
      "  node scripts/smoke-test.mjs <BASE_URL> [SHOW_SLUG] [MEDIA_URL]",
      "  BASE_URL=... SHOW_SLUG=... MEDIA_URL=... node scripts/smoke-test.mjs",
      "",
      "  BASE_URL   Origin of the deployment, e.g. https://castlet.example.workers.dev (required)",
      "  SHOW_SLUG  A published show slug; enables GET/HEAD /feeds/<slug>.xml",
      "  MEDIA_URL  A full enclosure URL; enables the media HEAD + Range checks",
      "",
    ].join("\n"),
  );
}

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(name, detail) {
  passed += 1;
  process.stdout.write(`  PASS  ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function fail(name, detail) {
  failed += 1;
  process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function skip(name, detail) {
  skipped += 1;
  process.stdout.write(`  SKIP  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function checkHealth() {
  const url = `${BASE_URL}/api/health`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      fail("health", `GET ${url} returned ${res.status}`);
      return;
    }
    const body = await res.json().catch(() => null);
    if (body && body.status === "ok") {
      pass("health", `version ${body.version ?? "?"}`);
    } else {
      fail("health", `unexpected body from ${url}`);
    }
  } catch (err) {
    fail("health", `GET ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkFeedHead() {
  if (SHOW_SLUG === "") {
    skip("feed HEAD", "no SHOW_SLUG provided");
    return;
  }
  const url = `${BASE_URL}/feeds/${SHOW_SLUG}.xml`;
  try {
    const res = await fetch(url, { method: "HEAD" });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("application/rss+xml")) {
      pass("feed HEAD", `${res.status} ${type}`);
    } else {
      fail("feed HEAD", `HEAD ${url} returned ${res.status} (${type || "no content-type"})`);
    }
  } catch (err) {
    fail("feed HEAD", `HEAD ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkMediaHead() {
  if (MEDIA_URL === "") {
    skip("media HEAD", "no MEDIA_URL provided");
    return;
  }
  try {
    const res = await fetch(MEDIA_URL, { method: "HEAD" });
    const acceptRanges = res.headers.get("accept-ranges") ?? "";
    if (res.ok && acceptRanges === "bytes") {
      const len = res.headers.get("content-length") ?? "?";
      pass("media HEAD", `${res.status}, Accept-Ranges: bytes, Content-Length: ${len}`);
    } else {
      fail(
        "media HEAD",
        `HEAD ${MEDIA_URL} returned ${res.status}, Accept-Ranges: ${acceptRanges || "none"}`,
      );
    }
  } catch (err) {
    fail("media HEAD", `HEAD ${MEDIA_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkMediaRange() {
  if (MEDIA_URL === "") {
    skip("media Range", "no MEDIA_URL provided");
    return;
  }
  const wanted = `bytes=0-${RANGE_BYTES - 1}`;
  try {
    const res = await fetch(MEDIA_URL, { method: "GET", headers: { Range: wanted } });
    if (res.status !== 206) {
      fail("media Range", `expected 206, got ${res.status} for Range: ${wanted}`);
      return;
    }
    const contentRange = res.headers.get("content-range") ?? "";
    const match = /^bytes 0-(\d+)\/(\d+)$/.exec(contentRange);
    if (match === null) {
      fail("media Range", `malformed Content-Range: "${contentRange}"`);
      return;
    }
    const end = Number(match[1]);
    const total = Number(match[2]);
    if (total < RANGE_BYTES) {
      // Object smaller than the window: the server returns the whole object.
      skip("media Range", `object is ${total} bytes (< ${RANGE_BYTES}); cannot assert 1024`);
      return;
    }
    if (end !== RANGE_BYTES - 1) {
      fail(
        "media Range",
        `expected end ${RANGE_BYTES - 1}, got ${end} (Content-Range ${contentRange})`,
      );
      return;
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength !== RANGE_BYTES) {
      fail("media Range", `expected ${RANGE_BYTES} bytes, got ${body.byteLength}`);
      return;
    }
    pass("media Range", `206, Content-Range: ${contentRange}, ${body.byteLength} bytes`);
  } catch (err) {
    fail("media Range", `GET ${MEDIA_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  if (BASE_URL === "") {
    usage();
    process.stderr.write("Error: BASE_URL is required.\n");
    process.exit(2);
  }

  process.stdout.write(`Castlet smoke test against ${BASE_URL}\n`);
  await checkHealth();
  await checkFeedHead();
  await checkMediaHead();
  await checkMediaRange();

  process.stdout.write(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
