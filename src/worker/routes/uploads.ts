import { Hono } from "hono";
import type { Context } from "hono";

import {
  MAX_COMPLETED_UPLOADS_PER_UTC_DAY,
  MAX_OUTSTANDING_UPLOAD_INTENTS,
} from "../../shared/constants";
import { uploadCompleteSchema, uploadInitiateSchema } from "../../shared/validation";
import type { AppEnv } from "../app-env";
import {
  abortUpload,
  completeUpload,
  initiateUpload,
  storageObjectRowToResource,
  sweepExpiredUploadIntents,
  type UploadDeps,
  type UploadErrorCode,
} from "../domain/storage";
import { errorResponse } from "../middleware/errors";
import { createPresignedPutUrl } from "../services/r2-signing";
import { readJsonBody, validationFailed } from "./common";

/**
 * Direct-upload routes (mvp-design.md sections 11.3, 11.5, and 15.2):
 * POST /api/uploads, POST /api/uploads/{id}/complete, DELETE /api/uploads/{id}.
 * Mounted at /api/uploads behind sessionAuth + csrfProtection.
 */

function uploadDeps(c: Context<AppEnv>): UploadDeps {
  const env = c.env;
  return {
    db: env.DB,
    media: env.MEDIA,
    config: {
      maxTotalStorageBytes: Number(env.MAX_TOTAL_STORAGE_BYTES),
      maxAudioBytes: Number(env.MAX_AUDIO_BYTES),
      maxArtworkBytes: Number(env.MAX_ARTWORK_BYTES),
      uploadUrlTtlSeconds: Number(env.UPLOAD_URL_TTL_SECONDS),
      maxOutstandingIntents: MAX_OUTSTANDING_UPLOAD_INTENTS,
      maxCompletedUploadsPerUtcDay: MAX_COMPLETED_UPLOADS_PER_UTC_DAY,
    },
    presign: (objectKey, contentType) =>
      createPresignedPutUrl({
        accountId: env.R2_ACCOUNT_ID,
        bucketName: env.R2_BUCKET_NAME,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        objectKey,
        contentType,
        expiresSeconds: Number(env.UPLOAD_URL_TTL_SECONDS),
      }),
  };
}

function uploadError(c: Context<AppEnv>, error: UploadErrorCode): Response {
  switch (error) {
    case "OWNER_NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Upload owner not found");
    case "NOT_FOUND":
      return errorResponse(c, 404, "NOT_FOUND", "Upload not found");
    case "SHOW_INACTIVE":
      return errorResponse(c, 409, "SHOW_INACTIVE", "Cannot upload media to an inactive show");
    case "UNSUPPORTED_MEDIA_TYPE":
      return errorResponse(
        c,
        422,
        "UNSUPPORTED_MEDIA_TYPE",
        "File extension, MIME type, and upload kind must agree (mp3/m4a audio, jpg/png artwork)",
      );
    case "FILE_TOO_LARGE":
      return errorResponse(c, 422, "FILE_TOO_LARGE", "File exceeds the maximum size for its kind");
    case "TOO_MANY_PENDING_UPLOADS":
      return errorResponse(
        c,
        429,
        "TOO_MANY_PENDING_UPLOADS",
        "Too many outstanding uploads; complete or abort existing uploads first",
      );
    case "DAILY_UPLOAD_LIMIT_REACHED":
      return errorResponse(
        c,
        429,
        "DAILY_UPLOAD_LIMIT_REACHED",
        "The daily completed-upload limit has been reached; try again tomorrow (UTC)",
      );
    case "QUOTA_EXCEEDED":
      return errorResponse(
        c,
        409,
        "QUOTA_EXCEEDED",
        "Not enough storage quota remains for this upload",
      );
    case "ALREADY_COMPLETED":
      return errorResponse(c, 409, "ALREADY_COMPLETED", "This upload was already completed");
    case "INTENT_NOT_ACTIVE":
      return errorResponse(
        c,
        409,
        "INTENT_NOT_ACTIVE",
        "This upload is no longer active (expired, aborted, or rejected)",
      );
    case "INTENT_EXPIRED":
      return errorResponse(
        c,
        409,
        "INTENT_EXPIRED",
        "This upload expired before completion; initiate a new upload",
      );
    case "OBJECT_NOT_UPLOADED":
      return errorResponse(
        c,
        409,
        "OBJECT_NOT_UPLOADED",
        "No uploaded object was found; finish the PUT before completing",
      );
    case "SIZE_MISMATCH":
      return errorResponse(
        c,
        422,
        "SIZE_MISMATCH",
        "Uploaded object is larger than the declared size; initiate a new upload with the correct size",
      );
    case "CONTENT_TYPE_MISMATCH":
      return errorResponse(
        c,
        422,
        "CONTENT_TYPE_MISMATCH",
        "Uploaded object content type does not match the declared content type",
      );
    case "MISSING_ETAG":
      return errorResponse(c, 422, "MISSING_ETAG", "Uploaded object has no ETag");
    case "INVALID_FILE_SIGNATURE":
      return errorResponse(
        c,
        422,
        "INVALID_FILE_SIGNATURE",
        "Uploaded object does not look like the declared media format",
      );
    case "INVALID_IMAGE_DIMENSIONS":
      return errorResponse(
        c,
        422,
        "INVALID_IMAGE_DIMENSIONS",
        "Artwork must be square and between 1400x1400 and 3000x3000 pixels",
      );
  }
}

export const uploadRoutes = new Hono<AppEnv>();

uploadRoutes.post("/", async (c) => {
  const read = await readJsonBody(c);
  if (!read.ok) {
    return read.response;
  }
  const parsed = uploadInitiateSchema.safeParse(read.body);
  if (!parsed.success) {
    return validationFailed(c, parsed.error);
  }

  const deps = uploadDeps(c);
  // Opportunistic, bounded cleanup of abandoned uploads (section 11.6).
  await sweepExpiredUploadIntents(deps);

  const result = await initiateUpload(deps, parsed.data);
  if (!result.ok) {
    return uploadError(c, result.error);
  }
  return c.json(result.response, 201);
});

uploadRoutes.post("/:id/complete", async (c) => {
  // The completion body is optional client metadata; accept an empty body.
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      return errorResponse(c, 400, "INVALID_REQUEST", "Expected a JSON request body");
    }
  }
  const parsed = uploadCompleteSchema.safeParse(body);
  if (!parsed.success) {
    return validationFailed(c, parsed.error);
  }

  const result = await completeUpload(uploadDeps(c), c.req.param("id"), parsed.data);
  if (!result.ok) {
    return uploadError(c, result.error);
  }
  return c.json(storageObjectRowToResource(result.object));
});

uploadRoutes.delete("/:id", async (c) => {
  const result = await abortUpload(uploadDeps(c), c.req.param("id"));
  if (!result.ok) {
    return uploadError(c, result.error);
  }
  return c.body(null, 204);
});
