#!/usr/bin/env node
/**
 * Local dev server for the Playwright e2e.
 *
 * Started by playwright.config.ts as its `webServer`. It builds the SPA,
 * applies the local D1 migrations, then runs `wrangler dev` in local mode so
 * the whole app (Worker + Static Assets + local D1/R2) runs offline against a
 * single origin.
 *
 * Every secret and var is passed on the command line with `--var`, which wins
 * over any developer `.dev.vars`, so the run is hermetic. The values are
 * Cloudflare's Turnstile TEST keys (always pass) plus the same test access key
 * and signing key the Vitest suite uses (test/auth-constants.ts). Real R2
 * credentials are not needed: the presigned PUT never leaves the machine — the
 * e2e reroutes it to the E2E_UPLOAD_SHIM endpoint (routes/e2e-shim.ts).
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = process.env.E2E_PORT ?? "8788";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Repository root (this file is at <root>/test/e2e/start-dev.mjs).
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Local binary path, e.g. node_modules/.bin/wrangler. */
function bin(name) {
  const path = `${ROOT}node_modules/.bin/${name}`;
  return existsSync(path) ? path : name;
}

/** Run a command to completion; exit this process on failure. */
function run(label, cmd, args) {
  process.stdout.write(`[e2e] ${label}\n`);
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(`[e2e] ${label} failed (exit ${result.status ?? "signal"})\n`);
    process.exit(result.status ?? 1);
  }
}

// Must equal test/auth-constants.ts TEST_ADMIN_ACCESS_KEY. The e2e spec logs in
// with this plaintext; the Worker stores only its SHA-256 digest.
const ACCESS_KEY = "castlet-test-access-key";
const ADMIN_ACCESS_KEY_SHA256 = createHash("sha256").update(ACCESS_KEY, "utf8").digest("hex");

// 1. Build the SPA so `wrangler dev` can serve it from dist/.
run("building SPA (vite build)", bin("vite"), ["build"]);

// 2. Apply migrations to the local D1 database the dev server uses.
run("applying local D1 migrations", bin("wrangler"), [
  "d1",
  "migrations",
  "apply",
  "castlet-db",
  "--local",
]);

// 3. Start wrangler dev with test vars/secrets and the upload shim enabled.
const vars = {
  PUBLIC_BASE_URL: BASE_URL,
  E2E_UPLOAD_SHIM: "1",
  ADMIN_ACCESS_KEY_SHA256,
  SESSION_SIGNING_KEY: "castlet-test-session-signing-key-32b",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA", // Turnstile "always passes" test sitekey
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA", // matching test secret
  R2_ACCOUNT_ID: "e2e-local-account",
  R2_BUCKET_NAME: "castlet-media",
  R2_ACCESS_KEY_ID: "e2e-local-access-key-id",
  R2_SECRET_ACCESS_KEY: "e2e-local-secret-access-key",
};

const varArgs = Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
const devArgs = ["dev", "--port", PORT, "--local", ...varArgs];

process.stdout.write(`[e2e] starting wrangler dev on ${BASE_URL}\n`);
const child = spawn(bin("wrangler"), devArgs, { cwd: ROOT, stdio: "inherit" });

// Propagate termination so Playwright's teardown stops wrangler cleanly.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
