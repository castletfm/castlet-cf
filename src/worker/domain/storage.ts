import type { z } from "zod";

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
  claimUploadIntent,
  countCompletedUploadsSince,
  countOutstandingUploadIntents,
  getEpisodeById,
  getShowById,
  getStorageObjectById,
  getUploadIntentById,
  incrementShowFeedRevisionStatement,
  insertStorageObjectStatement,
  insertUploadIntentStatement,
  listExpiredInitiatedIntents,
  markStorageObjectDeleted,
  markStorageObjectRejected,
  orphanStorageObjectStatement,
  type StorageObjectRow,
  type UploadIntentRow,
} from "../services/db";
import { commitReservedBytes, releaseReservedBytes, reserveBytes } from "../services/quota";
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
const FEED_AFFECTING_EPISODE_STATUSES: ReadonlySet<EpisodeStatus> = new Set([
  "published",
  "unpublished",
]);

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

  // Abuse limits (section 17, items 5 and 6).
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

  try {
    await db.batch([
      insertStorageObjectStatement(db, objectRow),
      insertUploadIntentStatement(db, intentRow),
    ]);
  } catch (err) {
    await releaseReservedBytes(db, input.size);
    throw err;
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
  const { db, media } = deps;

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
  let previousObjectId: string | null;
  let feedAffected: boolean;
  let attachOwner: D1PreparedStatement;
  let feedShowId: string;
  if (object.owner_kind === "show") {
    const show = await getShowById(db, object.owner_id);
    if (show === null) {
      return rejectUpload(deps, intent, object, "OWNER_NOT_FOUND");
    }
    previousObjectId = show.artwork_object_id;
    feedAffected = true; // show artwork is always part of the feed
    feedShowId = show.id;
    attachOwner = attachShowArtworkStatement(db, show.id, object.id, nowIso);
  } else {
    const episode = await getEpisodeById(db, object.owner_id);
    if (episode === null) {
      return rejectUpload(deps, intent, object, "OWNER_NOT_FOUND");
    }
    previousObjectId = episode.audio_object_id;
    feedAffected = FEED_AFFECTING_EPISODE_STATUSES.has(episode.status);
    feedShowId = episode.show_id;
    attachOwner = attachEpisodeAudioStatement(
      db,
      episode.id,
      object.id,
      input.durationSeconds ?? null,
      nowIso,
    );
  }

  // Race-safe claim: exactly one completion wins (idempotency gate).
  const claimed = await claimUploadIntent(db, uploadId, "completed", nowIso);
  if (!claimed) {
    return { ok: false, error: "ALREADY_COMPLETED" };
  }

  // Move the declared reservation to active storage using verified bytes.
  await commitReservedBytes(db, intent.expected_size, head.size);

  const statements: D1PreparedStatement[] = [
    activateStorageObjectStatement(db, object.id, head.size, head.etag, nowIso),
    attachOwner,
  ];
  if (previousObjectId !== null && previousObjectId !== object.id) {
    statements.push(orphanStorageObjectStatement(db, previousObjectId, nowIso));
  }
  if (feedAffected) {
    statements.push(incrementShowFeedRevisionStatement(db, feedShowId, nowIso));
  }
  await db.batch(statements);

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

/**
 * Expires overdue initiated intents: marks them expired, releases their
 * reservations, deletes any uploaded R2 object, and marks the pending
 * storage object deleted. Bounded by `limit`; called opportunistically at
 * the start of POST /api/uploads and reusable by the maintenance endpoint.
 * Returns the number of intents expired.
 */
export async function sweepExpiredUploadIntents(
  deps: UploadDeps,
  limit: number = EXPIRATION_SWEEP_LIMIT,
): Promise<number> {
  const nowIso = new Date().toISOString();
  const overdue = await listExpiredInitiatedIntents(deps.db, nowIso, limit);

  let expired = 0;
  for (const row of overdue) {
    const done = await expireIntent(deps, row, row.object_key);
    if (done) {
      expired += 1;
    }
  }
  return expired;
}

/** Expires one initiated intent; returns false if another caller won the claim. */
async function expireIntent(
  deps: UploadDeps,
  intent: UploadIntentRow,
  objectKey: string,
): Promise<boolean> {
  const claimed = await claimUploadIntent(deps.db, intent.id, "expired", null);
  if (!claimed) {
    return false;
  }
  await releaseReservedBytes(deps.db, intent.expected_size);
  await deps.media.delete(objectKey);
  await markStorageObjectDeleted(deps.db, intent.storage_object_id, new Date().toISOString());
  return true;
}
