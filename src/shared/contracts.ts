import type { z } from "zod";

import type {
  appleCategorySchema,
  episodeCreateSchema,
  episodePatchSchema,
  episodeStatusSchema,
  episodeTypeSchema,
  ownerKindSchema,
  showCreateSchema,
  showPatchSchema,
  storageKindSchema,
  uploadCompleteSchema,
  uploadInitiateSchema,
} from "./validation";

/**
 * API request/response contracts shared by the Worker and the admin SPA.
 * Request bodies are the inputs of the Zod schemas in validation.ts;
 * responses use the resource shapes below (camelCase JSON; booleans are real
 * booleans even though D1 stores 0/1).
 */

export type ShowStatus = "active" | "inactive";
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>;
export type EpisodeType = z.infer<typeof episodeTypeSchema>;
export type AppleCategory = z.infer<typeof appleCategorySchema>;

export type ShowCreateRequest = z.input<typeof showCreateSchema>;
export type ShowPatchRequest = z.input<typeof showPatchSchema>;
export type EpisodeCreateRequest = z.input<typeof episodeCreateSchema>;
export type EpisodePatchRequest = z.input<typeof episodePatchSchema>;

export interface ShowResource {
  id: string;
  slug: string;
  title: string;
  authorName: string;
  ownerName: string;
  ownerEmail: string;
  description: string;
  language: string;
  categoryPrimary: string;
  categorySecondary: string | null;
  explicit: boolean;
  websiteUrl: string | null;
  copyrightText: string | null;
  artworkObjectId: string | null;
  status: ShowStatus;
  feedRevision: number;
  feedPublishedRevision: number;
  feedLastGeneratedAt: string | null;
  feedError: string | null;
  /** True when feedPublishedRevision === feedRevision and feedError is null. */
  feedSynchronized: boolean;
  slugLockedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeResource {
  id: string;
  showId: string;
  guid: string;
  title: string;
  description: string;
  status: EpisodeStatus;
  episodeType: EpisodeType;
  explicit: boolean;
  seasonNumber: number | null;
  episodeNumber: number | null;
  durationSeconds: number | null;
  audioObjectId: string | null;
  publishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShowListResponse {
  shows: ShowResource[];
}

export interface EpisodeListResponse {
  episodes: EpisodeResource[];
}

// ---------------------------------------------------------------------------
// Uploads (mvp-design.md sections 11.3 and 11.5)
// ---------------------------------------------------------------------------

export type OwnerKind = z.infer<typeof ownerKindSchema>;
export type StorageKind = z.infer<typeof storageKindSchema>;
export type StorageObjectStatus = "pending" | "active" | "orphaned" | "deleted" | "rejected";
export type UploadIntentStatus = "initiated" | "completed" | "expired" | "aborted" | "rejected";

export type UploadInitiateRequest = z.input<typeof uploadInitiateSchema>;
export type UploadCompleteRequest = z.input<typeof uploadCompleteSchema>;

/** Response of POST /api/uploads (section 11.3). */
export interface UploadInitiateResponse {
  uploadId: string;
  storageObjectId: string;
  putUrl: string;
  /** Headers the browser must send verbatim on the presigned PUT. */
  headers: Record<string, string>;
  publicPath: string;
  expiresAt: string;
}

/** Storage-object metadata returned by POST /api/uploads/{id}/complete. */
export interface StorageObjectResource {
  id: string;
  ownerKind: OwnerKind;
  ownerId: string;
  kind: StorageKind;
  publicPath: string;
  originalFilename: string;
  contentType: string;
  byteLength: number | null;
  etag: string | null;
  status: StorageObjectStatus;
  createdAt: string;
  activatedAt: string | null;
}

export type UploadCompleteResponse = StorageObjectResource;
