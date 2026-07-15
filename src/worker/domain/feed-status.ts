import type { EpisodeStatus } from "../../shared/contracts";

/**
 * The single source of truth for which episode statuses are (or were just)
 * feed-visible, so a change to an episode in one of these states affects the
 * show's feed. Shared by the publish/edit path (episodes) and the audio-attach
 * path (storage) — keep it in one place so the two can never drift.
 */
export const FEED_AFFECTING_EPISODE_STATUSES: readonly EpisodeStatus[] = [
  "published",
  "unpublished",
];

/** Set form of {@link FEED_AFFECTING_EPISODE_STATUSES} for O(1) membership checks. */
export const FEED_AFFECTING_EPISODE_STATUS_SET: ReadonlySet<EpisodeStatus> = new Set(
  FEED_AFFECTING_EPISODE_STATUSES,
);
