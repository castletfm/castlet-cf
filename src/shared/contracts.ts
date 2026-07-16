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
// Uploads
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

// ---------------------------------------------------------------------------
// Dashboard (GET /api/dashboard)
// ---------------------------------------------------------------------------

/** Storage counters from account_usage plus the configured ceiling. */
export interface StorageCounters {
  activeBytes: number;
  reservedBytes: number;
  /**
   * Bytes held by orphaned objects, a subset of activeBytes (orphaned objects
   * count against the quota until purged). This is how much an explicit purge
   * would reclaim; surfaced so the operator can decide when to purge.
   */
  orphanedBytes: number;
  /** MAX_TOTAL_STORAGE_BYTES for this deployment. */
  maxTotalBytes: number;
}

export interface DashboardResponse {
  storage: StorageCounters;
  /** Shows whose canonical feed is stale or failed to synchronize. */
  feedDirtyShows: ShowResource[];
  /** Most recently created episodes, newest first, capped. */
  recentEpisodes: EpisodeResource[];
}

// ---------------------------------------------------------------------------
// Analytics (GET /api/analytics/episodes)
// ---------------------------------------------------------------------------

/**
 * Aggregated delivery totals for one episode (or a show's artwork, marked by
 * episodeId === "artwork"). Request counts are non-certified totals, never
 * unique listeners or IAB downloads.
 */
export interface EpisodeAnalytics {
  showId: string;
  /** Episode ID, or "artwork" for show artwork deliveries. */
  episodeId: string;
  requests: number;
  bytes: number;
  rangedRequests: number;
}

export interface AnalyticsEpisodesResponse {
  /** False when no Analytics Engine API token is configured. */
  available: boolean;
  /** Effective (clamped) query window, ISO-8601 UTC. */
  from: string;
  to: string;
  episodes: EpisodeAnalytics[];
}

// ---------------------------------------------------------------------------
// Storage administration
// ---------------------------------------------------------------------------

/** One orphaned object in GET /api/storage/orphans. */
export interface OrphanedObjectResource {
  id: string;
  ownerKind: OwnerKind;
  ownerId: string;
  /** Owning show/episode title, or null when the owner no longer exists. */
  ownerTitle: string | null;
  kind: StorageKind;
  publicPath: string;
  originalFilename: string;
  contentType: string;
  byteLength: number | null;
  orphanedAt: string | null;
}

export interface OrphanListResponse {
  orphans: OrphanedObjectResource[];
}

// ---------------------------------------------------------------------------
// Maintenance (POST /api/maintenance/run)
// ---------------------------------------------------------------------------

/** Difference between recorded account_usage counters and D1-derived sums. */
export interface UsageDrift {
  recordedActiveBytes: number;
  /** SUM(byte_length) of active + orphaned storage objects. */
  computedActiveBytes: number;
  /** recorded - computed; 0 means no drift. */
  activeBytesDrift: number;
  recordedReservedBytes: number;
  /** SUM(expected_size) of intents still in status 'initiated'. */
  computedReservedBytes: number;
  reservedBytesDrift: number;
}

export interface MaintenanceRunResponse {
  /** Overdue initiated intents expired by this run. */
  expiredIntents: number;
  /** Reserved bytes released by expiring those intents. */
  releasedBytes: number;
  /** Pending R2 objects that existed and were deleted by this run. */
  deletedObjects: number;
  drift: UsageDrift;
  /** True when account_usage was rewritten to the computed values. */
  corrected: boolean;
  /** Human-readable caveats (e.g. checks that would need a full R2 listing). */
  notes: string[];
}
