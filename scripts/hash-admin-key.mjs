#!/usr/bin/env node
/**
 * Generate (or hash) the operator access key.
 *
 * Usage:
 *   node scripts/hash-admin-key.mjs             # generate a new random key
 *   node scripts/hash-admin-key.mjs <accessKey> # hash an existing key
 *
 * The lowercase SHA-256 hex digest (stdout) is the value for:
 *   wrangler secret put ADMIN_ACCESS_KEY_SHA256
 *
 * The access key itself is shown once on stderr when generated. Store it in a
 * password manager; it cannot be recovered from the digest.
 */
import { createHash, randomBytes } from "node:crypto";

const provided = process.argv[2];
const accessKey = provided ?? randomBytes(32).toString("base64url");
const digest = createHash("sha256").update(accessKey, "utf8").digest("hex");

if (provided === undefined) {
  console.error("Generated operator access key (shown once, store it securely):");
  console.error(accessKey);
  console.error("");
}
console.error("SHA-256 digest for `wrangler secret put ADMIN_ACCESS_KEY_SHA256`:");
console.log(digest);
