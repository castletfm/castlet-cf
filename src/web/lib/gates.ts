/**
 * Client-side validation gates that mirror the server's publish and feed
 * requirements (mvp-design.md sections 12.1 and 12.2).
 *
 * These gates only decide whether to *enable* an action in the UI so the
 * operator gets immediate feedback. The Worker repeats every check on publish
 * and feed generation, so a stale or bypassed client gate can never publish an
 * invalid episode.
 */

import type { EpisodeResource, ShowResource } from "../../shared/contracts";

export interface GateResult {
  /** True when every client-known requirement is satisfied. */
  ok: boolean;
  /** Human-readable list of unmet requirements, empty when ok. */
  reasons: string[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether an episode can be published from the client's point of view
 * (section 12.2). `audioObjectId` is only set once an active audio object is
 * attached at upload completion, so its presence stands in for "active audio".
 * Already-published and archived episodes are not re-publishable here.
 */
export function episodePublishGate(episode: EpisodeResource): GateResult {
  const reasons: string[] = [];
  if (!isNonEmpty(episode.title)) {
    reasons.push("Add an episode title.");
  }
  if (!isNonEmpty(episode.description)) {
    reasons.push("Add an episode description.");
  }
  if (episode.audioObjectId === null) {
    reasons.push("Upload an audio file.");
  }
  if (episode.status === "published") {
    reasons.push("The episode is already published.");
  }
  if (episode.status === "archived") {
    reasons.push("Archived episodes cannot be published.");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Whether a show meets the client-known feed requirements (section 12.1).
 * "At least one published episode" is a directory-submission concern, not a
 * feed-generation blocker, so it is intentionally not gated here.
 */
export function showFeedReadyGate(show: ShowResource): GateResult {
  const reasons: string[] = [];
  if (!isNonEmpty(show.title)) {
    reasons.push("Add a show title.");
  }
  if (!isNonEmpty(show.authorName)) {
    reasons.push("Add an author name.");
  }
  if (!isNonEmpty(show.ownerName)) {
    reasons.push("Add an owner name.");
  }
  if (!isNonEmpty(show.ownerEmail) || !EMAIL_PATTERN.test(show.ownerEmail.trim())) {
    reasons.push("Add a valid owner email.");
  }
  if (!isNonEmpty(show.description)) {
    reasons.push("Add a show description.");
  }
  if (!isNonEmpty(show.language)) {
    reasons.push("Set a language code.");
  }
  if (!isNonEmpty(show.categoryPrimary)) {
    reasons.push("Choose a primary category.");
  }
  if (show.artworkObjectId === null) {
    reasons.push("Upload show artwork.");
  }
  if (show.status !== "active") {
    reasons.push("The show is inactive.");
  }
  return { ok: reasons.length === 0, reasons };
}
