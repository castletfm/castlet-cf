import type { z } from "zod";

import { MAX_OUTSTANDING_UPLOAD_INTENTS } from "../../shared/constants";
import type {
  EpisodeStatus,
  StorageObjectResource,
  UploadInitiateResponse,
} from "../../shared/contracts";
import type { uploadCompleteSchema, uploadInitiateSchema } from "../../shared/validation";
import {
  activateStorageObjectStatement,
  attachEpisodeAudioStatement,
  attachShowArtworkStatement,
  bumpShowFeedRevisionOnArtworkAttachStatement,
  bumpShowFeedRevisionOnEpisodeAudioAttachStatement,
  claimCompletedUploadIntent,
  claimStorageObjectPurge,
  claimUploadIntent,
  countCompletedUploadsSince,
  countOutstandingUploadIntents,
  getEpisodeById,
  getShowById,
  getStorageObjectById,
  getUploadIntentById,
  getUploadIntentByStorageObjectId,
  insertStorageObjectStatement,
  insertUploadIntentStatement,
  listExpiredInitiatedIntents,
  markStorageObjectDeleted,
  markStorageObjectRejected,
  orphanStorageObjectStatement,
  type StorageObjectRow,
  type UploadIntentRow,
} from "../services/db";
import {
  commitReservedBytes,
  releaseActiveBytes,
  releaseReservedBytes,
  reserveBytes,
} from "../services/quota";
import { SIGNATURE_RANGE_BYTES, hasValidMediaSignature } from "../services/upload-verification";

/**
 * Direct-upload business rules (mvp-design.md sections 10.4, 11, and 17).
 *
 * Lifecycle: initiate (reserve quota, pending object, initiated intent,
 * presigned PUT) -> browser PUT to R2 -> complete (verify, activate, attach)
 * or abort/expire (release quota, delete object). Routes translate the
 * returned error tags into HTTP responses.
 */

export type UploadInitiateInput = z.output<typeof uploadInitiateSchema>;
export type UploadCompleteInput = z.output<typeof uploadCompleteSchema>;

export interface UploadConfig {
  maxTotalStorageBytes: number;
  maxAudioBytes: number;
  maxArtworkBytes: number;
  uploadUrlTtlSeconds: number;
  maxOutstandingIntents: number;
  maxCompletedUploadsPerUtcDay: number;
}

export interface UploadDeps {
  db: D1Database;
  media: R2Bucket;
  config: UploadConfig;
  /** Presigned-PUT factory; injected so tests can stub the signer. */
  presign: (objectKey: string, contentType: string) => Promise<string>;
}

export type UploadErrorCode =
  // initiate
  | "OWNER_NOT_FOUND"
  | "SHOW_INACTIVE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_PENDING_UPLOADS"
  | "DAILY_UPLOAD_LIMIT_REACHED"
  | "QUOTA_EXCEEDED"
  // complete / abort
  | "NOT_FOUND"
  | "ALREADY_COMPLETED"
  | "OBJECT_PURGED"
  | "OWNER_DELETED"
  | "ATTACH_CONFLICT"
  | "INTENT_NOT_ACTIVE"
  | "INTENT_EXPIRED"
  | "OBJECT_NOT_UPLOADED"
  | "SIZE_MISMATCH"
  | "CONTENT_TYPE_MISMATCH"
  | "MISSING_ETAG"
  | "INVALID_FILE_SIGNATURE"
  | "INVALID_IMAGE_DIMENSIONS";

export type UploadFailure = { ok: false; error: UploadErrorCode };

/** Canonical file extension per accepted MIME type (section 11.1). */
const CANONICAL_EXTENSION: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Accepted filename extensions and the MIME type each must declare. */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** MIME types acceptable for each storage kind. */
const KIND_CONTENT_TYPES: Record<"artwork" | "audio", ReadonlySet<string>> = {
  audio: new Set(["audio/mpeg", "audio/mp4"]),
  artwork: new Set(["image/jpeg", "image/png"]),
};

/** Artwork pixel bounds (section 11.1); enforced when the client reports dimensions. */
const MIN_ARTWORK_PIXELS = 1400;
const MAX_ARTWORK_PIXELS = 3000;

/** Statuses whose episodes are (or were just) feed-visible (section 9.1). */
const FEED_AFFECTING_EPISODE_STATUSES: readonly EpisodeStatus[] = ["published", "unpublished"];

/**
 * Upper bound on compare-and-set attach retries during completion. The
 * outstanding-upload cap admits that many in-flight uploads for one owner, and
 * the compare-and-set has exactly one winner per round, so the last legitimate
 * completion can need as many attempts as there are contenders. The bound is
 * therefore derived from the outstanding-upload cap (plus one for margin) so
 * every in-cap completion can still attach; the two stay in sync if the cap
 * changes. Exhausting it means more contention than the caps permit -- a
 * genuine anomaly, not normal in-cap contention (see `completeUpload`).
 */
const MAX_ATTACH_ATTEMPTS = MAX_OUTSTANDING_UPLOAD_INTENTS + 1;

/** Owner state observed while retrying the completion attach. */
type OwnerAttachment = { exists: false } | { exists: true; attachment: string | null };

export function storageObjectRowToResource(row: StorageObjectRow): StorageObjectResource {
  return {
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    kind: row.kind,
    publicPath: row.public_path,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    byteLength: row.byte_length,
    etag: row.etag,
    status: row.status,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}

// ---------------------------------------------------------------------------
// Initiate (section 11.3)
// ---------------------------------------------------------------------------

export async function initiateUpload(
  deps: UploadDeps,
  input: UploadInitiateInput,
): Promise<{ ok: true; response: UploadInitiateResponse } | UploadFailure> {
  const { db, config } = deps;

  // Extension and MIME agreement, and MIME/kind agreement (section 11.1).
  const dotIndex = input.filename.lastIndexOf(".");
  const extension = dotIndex === -1 ? "" : input.filename.slice(dotIndex + 1).toLowerCase();
  if (
    EXTENSION_CONTENT_TYPES[extension] !== input.contentType ||
    !KIND_CONTENT_TYPES[input.kind].has(input.contentType)
  ) {
    return { ok: false, error: "UNSUPPORTED_MEDIA_TYPE" };
  }

  const maxBytes = input.kind === "audio" ? config.maxAudioBytes : config.maxArtworkBytes;
  if (input.size > maxBytes) {
    return { ok: false, error: "FILE_TOO_LARGE" };
  }

  // Owner must exist, and the owning show must be active (zod already
  // guarantees artwork<->show and audio<->episode pairing).
  let showId: string;
  let episodeId: string | null = null;
  if (input.ownerKind === "show") {
    const show = await getShowById(db, input.ownerId);
    if (show === null) {
      return { ok: false, error: "OWNER_NOT_FOUND" };
    }
    if (show.status !== "active") {
      return { ok: false, error: "SHOW_INACTIVE" };
    }
    showId = show.id;
  } else {
    const episode = await getEpisodeById(db, input.ownerId);
    if (episode === null) {
      return { ok: false, error: "OWNER_NOT_FOUND" };
    }
    const show = await getShowById(db, episode.show_id);
    if (show === null) {
      return { ok: false, error: "OWNER_NOT_FOUND" };
    }
    if (show.status !== "active") {
      return { ok: false, error: "SHOW_INACTIVE" };
    }
    showId = show.id;
    episodeId = episode.id;
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // Abuse limits (section 17, items 5 and 6). These pre-checks are fast
  // rejects only; the outstanding cap's source of truth is the guarded insert
  // below, and the daily cap's is the guarded completion claim (see
  // completeUpload), so a concurrent request cannot slip past.
  const outstanding = await countOutstandingUploadIntents(db, nowIso);
  if (outstanding >= config.maxOutstandingIntents) {
    return { ok: false, error: "TOO_MANY_PENDING_UPLOADS" };
  }
  const utcDayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const completedToday = await countCompletedUploadsSince(db, utcDayStart);
  if (completedToday >= config.maxCompletedUploadsPerUtcDay) {
    return { ok: false, error: "DAILY_UPLOAD_LIMIT_REACHED" };
  }

  // Atomic reservation against the quota ceiling (section 17, items 2 and 3).
  const reserved = await reserveBytes(db, input.size, config.maxTotalStorageBytes);
  if (!reserved) {
    return { ok: false, error: "QUOTA_EXCEEDED" };
  }

  const objectId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const canonicalExt = CANONICAL_EXTENSION[input.contentType] ?? extension;
  const objectKey =
    input.kind === "artwork"
      ? `artwork/${showId}/${objectId}.${canonicalExt}`
      : `audio/${showId}/${episodeId}/${objectId}.${canonicalExt}`;
  const publicPath =
    input.kind === "artwork"
      ? `/artwork/${showId}/${objectId}.${canonicalExt}`
      : `/media/${showId}/${episodeId}/${objectId}.${canonicalExt}`;
  const expiresAt = new Date(now.getTime() + config.uploadUrlTtlSeconds * 1000).toISOString();

  const objectRow: StorageObjectRow = {
    id: objectId,
    owner_kind: input.ownerKind,
    owner_id: input.ownerId,
    kind: input.kind,
    object_key: objectKey,
    public_path: publicPath,
    original_filename: input.filename,
    content_type: input.contentType,
    byte_length: null,
    etag: null,
    status: "pending",
    created_at: nowIso,
    activated_at: null,
    orphaned_at: null,
    deleted_at: null,
  };
  const intentRow: UploadIntentRow = {
    id: uploadId,
    storage_object_id: objectId,
    expected_content_type: input.contentType,
    expected_size: input.size,
    status: "initiated",
    expires_at: expiresAt,
    created_at: nowIso,
    completed_at: null,
  };

  // Both inserts carry the outstanding-intent cap condition, so within the
  // batch's implicit transaction they either both apply or both change zero
  // rows. Zero changes means the cap filled between the pre-check and the
  // write: undo the reservation and reject, with no orphan object left behind.
  const guard = { nowIso, maxOutstandingIntents: config.maxOutstandingIntents };
  let batchResults: D1Result[];
  try {
    batchResults = await db.batch([
      insertStorageObjectStatement(db, objectRow, guard),
      insertUploadIntentStatement(db, intentRow, guard),
    ]);
  } catch (err) {
    await releaseReservedBytes(db, input.size);
    throw err;
  }
  if ((batchResults[1]?.meta.changes ?? 0) === 0) {
    await releaseReservedBytes(db, input.size);
    return { ok: false, error: "TOO_MANY_PENDING_UPLOADS" };
  }

  const putUrl = await deps.presign(objectKey, input.contentType);

  return {
    ok: true,
    response: {
      uploadId,
      storageObjectId: objectId,
      putUrl,
      headers: { "Content-Type": input.contentType },
      publicPath,
      expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Complete (section 11.5)
// ---------------------------------------------------------------------------

export async function completeUpload(
  deps: UploadDeps,
  uploadId: string,
  input: UploadCompleteInput,
): Promise<{ ok: true; object: StorageObjectRow } | UploadFailure> {
  const { db, media, config } = deps;

  const intent = await getUploadIntentById(db, uploadId);
  if (intent === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  const object = await getStorageObjectById(db, intent.storage_object_id);
  if (object === null) {
    return { ok: false, error: "NOT_FOUND" };
  }

  // Duplicate completion is a deliberate 409, not idempotent success: the
  // object may since have been replaced and orphaned, so replaying the
  // original response could report stale ownership.
  if (intent.status === "completed") {
    return { ok: false, error: "ALREADY_COMPLETED" };
  }
  if (intent.status !== "initiated") {
    return { ok: false, error: "INTENT_NOT_ACTIVE" };
  }

  const nowIso = new Date().toISOString();
  if (intent.expires_at <= nowIso) {
    await expireIntent(deps, intent, object.object_key);
    return { ok: false, error: "INTENT_EXPIRED" };
  }

  // One R2 HEAD (section 17, item 11) to verify existence, size, type, ETag.
  const head = await media.head(object.object_key);
  if (head === null) {
    // The PUT may still be in flight; leave the intent alive for a retry.
    return { ok: false, error: "OBJECT_NOT_UPLOADED" };
  }
  if (head.size > intent.expected_size) {
    return rejectUpload(deps, intent, object, "SIZE_MISMATCH");
  }
  if ((head.httpMetadata?.contentType ?? "") !== intent.expected_content_type) {
    return rejectUpload(deps, intent, object, "CONTENT_TYPE_MISMATCH");
  }
  if (head.etag === "") {
    return rejectUpload(deps, intent, object, "MISSING_ETAG");
  }

  // Client-reported artwork dimensions: reject obvious mismatches (11.1).
  if (object.kind === "artwork") {
    const { imageWidth, imageHeight } = input;
    const dimensions = [imageWidth, imageHeight].filter(
      (value): value is number => typeof value === "number",
    );
    const outOfRange = dimensions.some(
      (value) => value < MIN_ARTWORK_PIXELS || value > MAX_ARTWORK_PIXELS,
    );
    const notSquare =
      typeof imageWidth === "number" &&
      typeof imageHeight === "number" &&
      imageWidth !== imageHeight;
    if (outOfRange || notSquare) {
      return rejectUpload(deps, intent, object, "INVALID_IMAGE_DIMENSIONS");
    }
  }

  // One small ranged GET for the file signature (sections 10.4 and 17).
  if (head.size === 0) {
    return rejectUpload(deps, intent, object, "INVALID_FILE_SIGNATURE");
  }
  const rangeLength = Math.min(SIGNATURE_RANGE_BYTES, head.size);
  const ranged = await media.get(object.object_key, { range: { offset: 0, length: rangeLength } });
  if (ranged === null) {
    return { ok: false, error: "OBJECT_NOT_UPLOADED" };
  }
  const leadingBytes = new Uint8Array(await ranged.arrayBuffer());
  if (!hasValidMediaSignature(intent.expected_content_type, leadingBytes)) {
    return rejectUpload(deps, intent, object, "INVALID_FILE_SIGNATURE");
  }

  // Read the owner before claiming so the previous attachment can be
  // orphaned; the owner was validated at initiation and cannot be hard
  // deleted out from under a pending audio upload in normal operation.
  // `buildAttach` produces a compare-and-set attach against the owner's
  // currently-observed attachment, and `readCurrentAttachment` re-reads it so
  // a lost race can retry against the truly-current value (see below).
  let previousObjectId: string | null;
  // Builds the guarded feed-revision bump for this owner, batched with the
  // winning attach so the feed-affecting decision reflects the owner's state AT
  // ATTACH TIME (see the batch loop below and the statement docs in db.ts).
  let buildFeedBump: () => D1PreparedStatement;
  let buildAttach: (expectedPreviousObjectId: string | null) => D1PreparedStatement;
  // Re-reads the owner during a lost-attach retry. The result distinguishes a
  // deleted owner (`exists: false`) from an owner that still exists but points
  // at no attachment (`attachment: null`); the two must not collapse to the
  // same value, or a mid-attach owner deletion would spin the CAS loop forever.
  let readOwnerAttachment: () => Promise<OwnerAttachment>;
  if (object.owner_kind === "show") {
    const show = await getShowById(db, object.owner_id);
    if (show === null) {
      return rejectUpload(deps, intent, object, "OWNER_NOT_FOUND");
    }
    previousObjectId = show.artwork_object_id;
    // Show artwork is always part of the feed; the guard bumps once the attach
    // has landed within the same batch.
    buildFeedBump = () =>
      bumpShowFeedRevisionOnArtworkAttachStatement(db, show.id, object.id, nowIso);
    buildAttach = (expectedPreviousObjectId) =>
      attachShowArtworkStatement(db, show.id, object.id, nowIso, expectedPreviousObjectId);
    readOwnerAttachment = async () => {
      const current = await getShowById(db, object.owner_id);
      return current === null
        ? { exists: false }
        : { exists: true, attachment: current.artwork_object_id };
    };
  } else {
    const episode = await getEpisodeById(db, object.owner_id);
    if (episode === null) {
      return rejectUpload(deps, intent, object, "OWNER_NOT_FOUND");
    }
    previousObjectId = episode.audio_object_id;
    // The audio replacement is feed-affecting only if the episode is feed-
    // visible AT ATTACH TIME. Deciding it here from the pre-attach read would be
    // stale: a concurrent publish can flip the episode to published (and
    // synchronize the feed against the OLD audio) between this read and the
    // attach. The guarded bump re-checks the current status inside the winning
    // attach batch, so a just-swapped enclosure never leaves the show reported
    // synchronized against the old one (section 9.1).
    buildFeedBump = () =>
      bumpShowFeedRevisionOnEpisodeAudioAttachStatement(
        db,
        episode.show_id,
        episode.id,
        object.id,
        FEED_AFFECTING_EPISODE_STATUSES,
        nowIso,
      );
    buildAttach = (expectedPreviousObjectId) =>
      attachEpisodeAudioStatement(
        db,
        episode.id,
        object.id,
        input.durationSeconds ?? null,
        nowIso,
        expectedPreviousObjectId,
      );
    readOwnerAttachment = async () => {
      const current = await getEpisodeById(db, object.owner_id);
      return current === null
        ? { exists: false }
        : { exists: true, attachment: current.audio_object_id };
    };
  }

  // Race-safe claim that also enforces the daily completed-upload cap in the
  // same statement (section 17, item 6): exactly one completion wins the
  // idempotency gate, and the claim is refused once the day's cap is full.
  const utcDayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const claimed = await claimCompletedUploadIntent(
    db,
    uploadId,
    nowIso,
    utcDayStart,
    config.maxCompletedUploadsPerUtcDay,
  );
  if (!claimed) {
    // Zero changes is either a lost race or the daily cap. Re-read to tell
    // them apart: an intent still `initiated` was blocked by the cap guard,
    // so clean up like a rejection (release the reservation, delete the
    // uploaded object) rather than activating it.
    const current = await getUploadIntentById(db, uploadId);
    if (current !== null && current.status === "initiated") {
      return rejectUpload(deps, intent, object, "DAILY_UPLOAD_LIMIT_REACHED");
    }
    return { ok: false, error: "ALREADY_COMPLETED" };
  }

  // Activate the object with a status-guarded compare-and-set BEFORE committing
  // bytes or attaching. Activation requires status='pending', so it is the
  // chokepoint the object's lifecycle races on: SQLite lets exactly one of
  // activation or a concurrent purge win the object's `pending` transition. A
  // purge can reach this object precisely because our completed-intent claim
  // above flipped the intent off 'initiated', which makes a concurrent
  // purgeStorageObject fall through to its pending else-branch and claim
  // pending->deleted (deleting the R2 bytes). If that purge won, this activation
  // changes zero rows: the object is gone and its bytes were already removed
  // from R2, so DO NOT commit bytes or attach a dead object. Release the
  // reservation (reserved drops by exactly the reservation; active untouched)
  // and report the conflict. Once activation wins, the object is 'active' and
  // purge (which requires 'pending') can no longer touch it, so the rest is safe.
  const activation = await activateStorageObjectStatement(
    db,
    object.id,
    head.size,
    head.etag,
    nowIso,
  ).run();
  if (activation.meta.changes === 0) {
    await releaseReservedBytes(db, intent.expected_size);
    return { ok: false, error: "OBJECT_PURGED" };
  }

  // Move the declared reservation to active storage using verified bytes.
  await commitReservedBytes(db, intent.expected_size, head.size);

  // Swap the now-active object onto its owner with a compare-and-set, so two
  // concurrent completions for the same owner can never leave a just-attached
  // object active-but-unreferenced (invariant 9.1). The attach applies only
  // while the owner still points at the attachment we observed; the displaced
  // object is orphaned in the same batch, keeping the winning path atomic. A
  // lost attach (zero changed rows) means either another completion attached
  // first or the owner was deleted mid-flight. Re-read the owner to tell those
  // apart:
  //   - owner deleted: stop; the object is active but references nobody, so
  //     orphan it (its bytes stay in active_bytes until purge reclaims them)
  //     and report OWNER_DELETED. Retrying could never succeed.
  //   - owner present: another completion won the attach; retry the CAS
  //     against the now-current attachment, orphaning whatever we displace.
  // Because the orphan guard is `status = 'active'`, orphaning a value we lost
  // the race for is an idempotent no-op rather than a double-orphan. The retry
  // count is bounded by MAX_ATTACH_ATTEMPTS, which is at least the
  // outstanding-upload cap, so every in-cap completion can still attach; a lost
  // attach that persists past that bound with the owner still present means more
  // contention than the caps permit -- a genuine anomaly, not normal in-cap
  // contention. After the cap we orphan the object and report ATTACH_CONFLICT
  // rather than spin. The end state after any interleaving: exactly one object
  // attached+active, every other completed object orphaned.
  let displaced = previousObjectId;
  let attached = false;
  for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt += 1) {
    // buildAttach is always the first statement, so results[0] is the attach.
    const statements: D1PreparedStatement[] = [buildAttach(displaced)];
    if (displaced !== null && displaced !== object.id) {
      statements.push(orphanStorageObjectStatement(db, displaced, nowIso));
    }
    // Bump the show's feed_revision in the SAME batch as the attach, guarded on
    // the owner's post-attach state (see buildFeedBump). On a lost attach the
    // guard changes zero rows, so only the winning batch bumps -- no new
    // read-then-write window between the attach and the revision bump.
    statements.push(buildFeedBump());
    const results = await db.batch(statements);
    if ((results[0]?.meta.changes ?? 0) > 0) {
      attached = true; // won the attach; the displaced object (if any) is now orphaned
      break;
    }
    // Lost the attach. Re-read the owner to distinguish a deleted owner from a
    // lost race against a concurrent completion.
    const owner = await readOwnerAttachment();
    if (!owner.exists) {
      // The owner was deleted after we claimed the intent. The object is
      // active but references nobody: orphan it so purge reclaims the bytes,
      // then report the owner-missing failure.
      await orphanStorageObjectStatement(db, object.id, nowIso).run();
      return { ok: false, error: "OWNER_DELETED" };
    }
    if (owner.attachment === object.id) {
      attached = true; // our object is already the attachment; nothing left to displace
      break;
    }
    displaced = owner.attachment;
  }
  if (!attached) {
    // Retry cap reached with the owner still present: the CAS kept losing to a
    // moving target beyond any plausible contention. Orphan the now-active
    // object (invariant 9.1: never leave it active-but-unreferenced) and
    // surface a conflict instead of looping forever.
    await orphanStorageObjectStatement(db, object.id, nowIso).run();
    return { ok: false, error: "ATTACH_CONFLICT" };
  }

  const activated = await getStorageObjectById(db, object.id);
  if (activated === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  return { ok: true, object: activated };
}

/**
 * Verification failed: claim the intent as rejected (race-safe), release the
 * reservation, delete the uploaded object, and mark the record rejected
 * (section 11.5, step 6).
 */
async function rejectUpload(
  deps: UploadDeps,
  intent: UploadIntentRow,
  object: StorageObjectRow,
  error: UploadErrorCode,
): Promise<UploadFailure> {
  const claimed = await claimUploadIntent(deps.db, intent.id, "rejected", null);
  if (!claimed) {
    return { ok: false, error: "ALREADY_COMPLETED" };
  }
  await releaseReservedBytes(deps.db, intent.expected_size);
  await deps.media.delete(object.object_key);
  await markStorageObjectRejected(deps.db, object.id);
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Abort (DELETE /api/uploads/{id})
// ---------------------------------------------------------------------------

export async function abortUpload(
  deps: UploadDeps,
  uploadId: string,
): Promise<{ ok: true } | UploadFailure> {
  const { db, media } = deps;

  const intent = await getUploadIntentById(db, uploadId);
  if (intent === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (intent.status === "aborted") {
    return { ok: true }; // DELETE is idempotent
  }
  if (intent.status !== "initiated") {
    return { ok: false, error: "INTENT_NOT_ACTIVE" };
  }

  const claimed = await claimUploadIntent(db, uploadId, "aborted", null);
  if (!claimed) {
    return { ok: false, error: "INTENT_NOT_ACTIVE" };
  }

  await releaseReservedBytes(db, intent.expected_size);
  const object = await getStorageObjectById(db, intent.storage_object_id);
  if (object !== null) {
    await media.delete(object.object_key);
    await markStorageObjectDeleted(db, object.id, new Date().toISOString());
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Expiration sweep (section 11.6)
// ---------------------------------------------------------------------------

/** Default per-request cap on swept intents. */
export const EXPIRATION_SWEEP_LIMIT = 20;

/** What one bounded expiration sweep accomplished. */
export interface SweepReport {
  /** Overdue initiated intents transitioned to 'expired'. */
  expiredIntents: number;
  /** Reserved bytes released by those expirations. */
  releasedBytes: number;
  /** Uploaded R2 objects that existed and were deleted. */
  deletedObjects: number;
}

/**
 * Expires overdue initiated intents: marks them expired, releases their
 * reservations, deletes any uploaded R2 object, and marks the pending
 * storage object deleted. Bounded by `limit`; called opportunistically at
 * the start of POST /api/uploads and on dashboard load, and with a larger
 * cap by POST /api/maintenance/run.
 */
export async function sweepExpiredUploadIntents(
  deps: UploadDeps,
  limit: number = EXPIRATION_SWEEP_LIMIT,
): Promise<SweepReport> {
  const nowIso = new Date().toISOString();
  const overdue = await listExpiredInitiatedIntents(deps.db, nowIso, limit);

  const report: SweepReport = { expiredIntents: 0, releasedBytes: 0, deletedObjects: 0 };
  for (const row of overdue) {
    const done = await expireIntent(deps, row, row.object_key);
    if (done.expired) {
      report.expiredIntents += 1;
      report.releasedBytes += row.expected_size;
      if (done.objectDeleted) {
        report.deletedObjects += 1;
      }
    }
  }
  return report;
}

/**
 * Expires one initiated intent; `expired` is false if another caller won the
 * claim. The R2 HEAD before DELETE tells the maintenance report whether an
 * uploaded object was actually removed (delete alone gives no signal).
 */
async function expireIntent(
  deps: Pick<UploadDeps, "db" | "media">,
  intent: UploadIntentRow,
  objectKey: string,
): Promise<{ expired: boolean; objectDeleted: boolean }> {
  const claimed = await claimUploadIntent(deps.db, intent.id, "expired", null);
  if (!claimed) {
    return { expired: false, objectDeleted: false };
  }
  await releaseReservedBytes(deps.db, intent.expected_size);
  const uploaded = await deps.media.head(objectKey);
  if (uploaded !== null) {
    await deps.media.delete(objectKey);
  }
  await markStorageObjectDeleted(deps.db, intent.storage_object_id, new Date().toISOString());
  return { expired: true, objectDeleted: uploaded !== null };
}

// ---------------------------------------------------------------------------
// Purge (section 15.2, DELETE /api/storage/{id})
// ---------------------------------------------------------------------------

export type PurgeErrorCode = "NOT_FOUND" | "OBJECT_ACTIVE" | "UPLOAD_IN_FLIGHT" | "ALREADY_PURGED";

export type PurgeFailure = { ok: false; error: PurgeErrorCode };

/**
 * Purges an eligible object: deletes it from R2, decrements active storage
 * exactly once (status-guarded claim; a repeat purge gets 409 and never a
 * second decrement), and marks the record deleted.
 *
 * Eligible statuses:
 * - orphaned: R2 delete + active_bytes decrement (section 9.1: orphaned
 *   bytes count until purged);
 * - rejected: R2 delete only (its reservation was already released and
 *   active_bytes never included it);
 * - pending with an expired intent: same cleanup as the expiration sweep;
 *   pending with a live intent is refused (the upload may still complete).
 *
 * Never purges an active object.
 *
 * Order matters for orphans: R2 delete happens before the claim/decrement,
 * so an interrupted purge can be retried and the quota can never drop while
 * the object still exists in R2.
 */
export async function purgeStorageObject(
  deps: Pick<UploadDeps, "db" | "media">,
  id: string,
): Promise<{ ok: true } | PurgeFailure> {
  const { db, media } = deps;
  const object = await getStorageObjectById(db, id);
  if (object === null) {
    return { ok: false, error: "NOT_FOUND" };
  }
  const nowIso = new Date().toISOString();

  switch (object.status) {
    case "active":
      return { ok: false, error: "OBJECT_ACTIVE" };
    case "deleted":
      return { ok: false, error: "ALREADY_PURGED" };
    case "orphaned": {
      await media.delete(object.object_key);
      const claimed = await claimStorageObjectPurge(db, id, "orphaned", nowIso);
      if (!claimed) {
        return { ok: false, error: "ALREADY_PURGED" };
      }
      const bytes = object.byte_length ?? 0;
      if (bytes > 0) {
        // False return = pre-existing quota drift; maintenance reconciles it.
        await releaseActiveBytes(db, bytes);
      }
      return { ok: true };
    }
    case "rejected": {
      await media.delete(object.object_key);
      const claimed = await claimStorageObjectPurge(db, id, "rejected", nowIso);
      if (!claimed) {
        return { ok: false, error: "ALREADY_PURGED" };
      }
      return { ok: true };
    }
    case "pending": {
      const intent = await getUploadIntentByStorageObjectId(db, object.id);
      if (intent !== null && intent.status === "initiated") {
        if (intent.expires_at > nowIso) {
          return { ok: false, error: "UPLOAD_IN_FLIGHT" };
        }
        // Stale pending: identical cleanup to the expiration sweep.
        const done = await expireIntent(deps, intent, object.object_key);
        if (!done.expired) {
          return { ok: false, error: "ALREADY_PURGED" };
        }
        return { ok: true };
      }
      // Pending object whose intent already left 'initiated' (its reservation
      // was released then). Claim the row terminally 'deleted' BEFORE touching
      // R2: activation requires status='pending' (activateStorageObjectStatement),
      // so if a concurrent completeUpload activates this object in the window,
      // the guarded claim changes zero rows and we return WITHOUT deleting a now
      // -live object's bytes. Deleting R2 first would irreversibly destroy the
      // media of an object completion is about to make active.
      const claimed = await claimStorageObjectPurge(db, id, "pending", nowIso);
      if (!claimed) {
        return { ok: false, error: "ALREADY_PURGED" };
      }
      await media.delete(object.object_key);
      return { ok: true };
    }
  }
}
