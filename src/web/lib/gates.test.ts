import { describe, expect, it } from "vitest";

import type { EpisodeResource, ShowResource } from "../../shared/contracts";
import { episodePublishGate, showFeedReadyGate } from "./gates";

function makeEpisode(overrides: Partial<EpisodeResource> = {}): EpisodeResource {
  return {
    id: "ep-1",
    showId: "show-1",
    guid: "guid-1",
    title: "Episode One",
    description: "A description.",
    status: "draft",
    episodeType: "full",
    explicit: false,
    seasonNumber: null,
    episodeNumber: null,
    durationSeconds: 1854,
    audioObjectId: "audio-1",
    publishedAt: null,
    version: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeShow(overrides: Partial<ShowResource> = {}): ShowResource {
  return {
    id: "show-1",
    slug: "example-show",
    title: "Example Show",
    authorName: "Author",
    ownerName: "Owner",
    ownerEmail: "owner@example.com",
    description: "About the show.",
    language: "en",
    categoryPrimary: "Technology",
    categorySecondary: null,
    explicit: false,
    websiteUrl: null,
    copyrightText: null,
    artworkObjectId: "art-1",
    status: "active",
    feedRevision: 2,
    feedPublishedRevision: 2,
    feedLastGeneratedAt: "2026-07-15T00:00:00.000Z",
    feedError: null,
    feedSynchronized: true,
    slugLockedAt: null,
    version: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("episodePublishGate", () => {
  it("passes a complete draft with attached audio", () => {
    const result = episodePublishGate(makeEpisode());
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks when the title is blank", () => {
    const result = episodePublishGate(makeEpisode({ title: "   " }));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Add an episode title.");
  });

  it("blocks when the description is empty", () => {
    const result = episodePublishGate(makeEpisode({ description: "" }));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Add an episode description.");
  });

  it("blocks when no audio is attached", () => {
    const result = episodePublishGate(makeEpisode({ audioObjectId: null }));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Upload an audio file.");
  });

  it("blocks an already-published episode", () => {
    const result = episodePublishGate(makeEpisode({ status: "published" }));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("The episode is already published.");
  });

  it("allows re-publishing an unpublished episode", () => {
    expect(episodePublishGate(makeEpisode({ status: "unpublished" })).ok).toBe(true);
  });

  it("collects every unmet reason at once", () => {
    const result = episodePublishGate(
      makeEpisode({ title: "", description: "", audioObjectId: null }),
    );
    expect(result.reasons).toHaveLength(3);
  });
});

describe("showFeedReadyGate", () => {
  it("passes a fully configured active show", () => {
    const result = showFeedReadyGate(makeShow());
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks a show without artwork", () => {
    const result = showFeedReadyGate(makeShow({ artworkObjectId: null }));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Upload show artwork.");
  });

  it("blocks an invalid owner email", () => {
    const result = showFeedReadyGate(makeShow({ ownerEmail: "not-an-email" }));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("Add a valid owner email.");
  });

  it("blocks an inactive show", () => {
    const result = showFeedReadyGate(makeShow({ status: "inactive" }));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("The show is inactive.");
  });
});
