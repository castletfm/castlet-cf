# Operations

Running Castlet in production: cost and free-tier assumptions, when to upgrade,
and backup and recovery.

## Cost assumptions and billing caveat

This project is designed to fit inside Cloudflare's free allocations as verified
against Cloudflare's published limits on 15 July 2026: Workers 100k dynamic
requests/day, D1 5M row reads/day, R2 10 GB-month storage, Analytics Engine 100k
data points/day, and free/unlimited static asset requests. Those limits are
platform-controlled and can change; re-verify before deploying or opening access
to more traffic.

**R2 is usage-based, not hard-capped.** Exceeding the free monthly allowance
(storage, Class A/B operations) creates real charges. The application enforces
its own 8.5 GiB storage ceiling (`MAX_TOTAL_STORAGE_BYTES` = `9,126,805,504`
bytes) and per-file/upload limits as a safeguard, and budget notifications are
not a spending cutoff. Keep the bucket on R2 Standard storage and keep the
`r2.dev` public URL disabled.

### Delivery analytics

Analytics Engine has no read binding, so `GET /api/analytics/episodes` queries
the Analytics Engine SQL REST API with a bearer token — this is why the optional
`ANALYTICS_API_TOKEN` secret exists (the account ID reuses `R2_ACCOUNT_ID`).
When the token is absent (tests, local dev), the endpoint returns
`{ "available": false, "episodes": [] }` with `200` instead of failing, so the
dashboard degrades gracefully rather than erroring.

## Upgrade triggers

Known limits and the likely response when the MVP outgrows them:

| Trigger                                           | Likely response                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Active storage approaches 8.5 GiB                 | Purge orphaned media, buy R2 storage, or move the archive while preserving URLs    |
| Worker traffic approaches ~70,000 requests/day    | Consider a custom domain with direct R2 delivery, paid Workers, or split delivery  |
| Need WAV/FLAC ingestion or loudness normalization | Add paid Containers with FFmpeg or a separate processing service                   |
| Need public creators (multi-tenant)               | Replace single-key auth with real identity, abuse controls, email, quotas, billing |
| Need scheduled publishing                         | Add a bounded Workflow/Cron design and re-verify plan requirements                 |
| Need long-term or certified analytics             | Build a retained log pipeline and an IAB-aligned measurement process               |
| Need private feeds                                | Add signed feed/media authorization and redesign cache behavior                    |
| Need guaranteed URL ownership                     | Attach a controlled custom domain and keep old feed URLs with permanent redirects  |
| Need more than 3 days of operational logs         | Add paid log export or an external log destination                                 |

## Backup and recovery

There is no automatic backup on the Free plan, but the procedure is
reproducible. Run it on a schedule you are comfortable with.

1. **Export D1 metadata to SQL:**

   ```bash
   wrangler d1 export castlet-db --remote --output castlet-db-backup.sql
   ```

   This is the source of truth for shows, episodes, immutable GUIDs, storage
   objects, and quota counters.

2. **Copy R2 media** (audio, artwork, and generated feeds) with any
   S3-compatible tool pointed at the R2 endpoint, for example:

   ```bash
   # endpoint: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
   aws s3 sync s3://castlet-media ./castlet-media-backup \
     --endpoint-url "https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com"
   ```

3. **Keep the identity mapping.** The D1 export already contains the durable
   mapping you need to restore identity: `episodes.guid` (never changes),
   `storage_objects.public_path`, and `storage_objects.object_key`. Preserving
   GUIDs and public paths is what keeps existing subscribers working after a
   restore. For a lightweight standalone copy:

   ```bash
   wrangler d1 execute castlet-db --remote --json \
     --command "SELECT e.guid, o.public_path, o.object_key
                FROM episodes e JOIN storage_objects o ON o.id = e.audio_object_id" \
     > castlet-guid-path-map.json
   ```

4. **Test the restore into a NON-production Worker name.** Never restore over
   production while verifying. Create a scratch Worker/D1/R2 (e.g.
   `castlet-restore-test`), load the SQL into its D1
   (`wrangler d1 execute <db> --remote --file castlet-db-backup.sql`), copy the
   R2 objects into its bucket, deploy, and run the smoke test against it.
