# End-to-end test (Playwright)

One mandatory happy path (mvp-design.md section 18.3), driven through the real
admin SPA against a local `wrangler dev`:

log in → create show → upload artwork → create episode → upload MP3 → publish →
fetch the feed and assert the episode + enclosure → `HEAD` + `Range: bytes=0-1023`
on the enclosure → unpublish → assert the item left the feed.

## Run it

```bash
pnpm install
pnpm exec playwright install chromium   # one-time browser download
pnpm test:e2e
```

`pnpm test:e2e` starts its own server (`test/e2e/start-dev.mjs`): it builds the
SPA, applies the local D1 migrations, and runs `wrangler dev` in local mode on
`http://127.0.0.1:8788` with Cloudflare's Turnstile **TEST** keys and the same
test access key the Vitest suite uses. No real Cloudflare account, D1, or R2 is
touched. Local D1/R2 state lives under `.wrangler/state`.

## What is real, and the one deviation

Everything the operator does runs through the actual SPA and Worker: login
(Turnstile-backed), show/episode CRUD, quota reservation, the upload completion
HEAD + signature check, feed generation, and public feed/media delivery
(including the byte-range response).

The single deviation is the **upload transport**. In production the browser
`PUT`s bytes to a presigned R2 S3 URL (`*.r2.cloudflarestorage.com`). A local
`wrangler dev` has no reachable S3 endpoint for its local R2 bucket, so the test
intercepts that `PUT` and forwards the fixture bytes to the Worker's own R2
binding through a dev-only shim: `PUT /__e2e/r2/*`, in
`src/worker/routes/e2e-shim.ts`, gated by the `E2E_UPLOAD_SHIM` var. That var is
absent from `wrangler.jsonc` and `.dev.vars.example`, so the shim always returns
404 in a real deployment. (Playwright cannot read the XHR upload body, so the
interceptor serves the known fixture from disk keyed by the object-key
extension; the size the SPA declared is that same file's size, so the
completion size check still holds.)

Nothing in this flow is stubbed to force a pass — if a step cannot run, the test
fails rather than skipping.

## Requirements and CI

- **Network:** the login step calls Turnstile Siteverify
  (`challenges.cloudflare.com`). The TEST secret always passes, but the request
  needs outbound network. Fully offline runs will fail at login.
- **Not in CI.** This suite is intentionally excluded from `.github/workflows/ci.yml`
  (which runs typecheck, lint, format, `pnpm test`, and build). It needs a
  browser download and the Turnstile network call, so it is run manually /
  opt-in rather than gating every push. `pnpm test` stays fast and hermetic.

## Fixtures

- `fixtures/tiny.mp3` — a short silent MP3 (ID3 header + valid MPEG frames),
  large enough that `Range: bytes=0-1023` returns a full 1024 bytes.
- `fixtures/artwork.jpg` — a 1400×1400 baseline JPEG (square, within the
  1400–3000px artwork bounds).

Both were generated with `ffmpeg`; regenerate with:

```bash
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 2 -b:a 64k -acodec libmp3lame -write_xing 1 fixtures/tiny.mp3
ffmpeg -f lavfi -i color=c=0x1f3a5f:s=1400x1400 -frames:v 1 -pix_fmt yuvj420p fixtures/artwork.jpg
```
