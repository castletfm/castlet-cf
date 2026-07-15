-- Per-show feed-sync advisory lock (mvp-design.md sections 12.3, 13.1).
--
-- synchronizeFeed() builds the RSS document, PUTs it to feeds/{slug}.xml, then
-- marks the show synchronized. Two concurrent same-show syncs could physically
-- reorder their R2 PUTs, leaving R2 holding an older revision's XML while D1
-- reports the feed synchronized. These two nullable columns back a D1 advisory
-- lock (a compare-and-set on the single-writer SQLite row) so that
-- build+PUT+mark runs serialized per show and the PUTs can no longer reorder.
--
-- feed_sync_lock_holder    a per-attempt nonce; NULL when the lock is free.
-- feed_sync_lock_expires_at ISO-8601 UTC lease expiry (same format as every
--                          other timestamp column); recovers a crashed holder.
-- Both are INTERNAL coordination state and never appear in an API resource.
-- See acquireFeedSyncLock / releaseFeedSyncLock in src/worker/services/db.ts.

ALTER TABLE shows ADD COLUMN feed_sync_lock_holder TEXT;
ALTER TABLE shows ADD COLUMN feed_sync_lock_expires_at TEXT;
