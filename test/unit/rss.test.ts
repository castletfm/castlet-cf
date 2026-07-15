import { describe, expect, it } from "vitest";

import { MAX_FEED_EPISODES } from "../../src/shared/constants";
import {
  buildRssFeed,
  formatItunesDuration,
  formatRfc2822Date,
  type FeedEpisodeInput,
  type FeedShowInput,
} from "../../src/worker/services/rss";

const BASE_URL = "https://host.example";

function showInput(overrides: Partial<FeedShowInput> = {}): FeedShowInput {
  return {
    slug: "example-show",
    title: "Example Show",
    authorName: "Example Author",
    ownerName: "Example Owner",
    ownerEmail: "podcast@example.com",
    description: "Example description.",
    language: "en",
    categoryPrimary: "Technology",
    categorySecondary: null,
    explicit: false,
    websiteUrl: null,
    copyrightText: null,
    artworkPublicPath: "/artwork/SHOW/OBJECT.jpg",
    ...overrides,
  };
}

function episodeInput(overrides: Partial<FeedEpisodeInput> = {}): FeedEpisodeInput {
  return {
    guid: "EPISODE-GUID",
    title: "Episode title",
    description: "Episode description.",
    status: "published",
    publishedAt: "2026-07-15T12:00:00.000Z",
    episodeType: "full",
    explicit: false,
    seasonNumber: null,
    episodeNumber: null,
    durationSeconds: 1854,
    audioPublicPath: "/media/SHOW/EPISODE/OBJECT.mp3",
    audioByteLength: 48_320_123,
    audioContentType: "audio/mpeg",
    ...overrides,
  };
}

function countItems(xml: string): number {
  return xml.split("<item>").length - 1;
}

describe("formatItunesDuration", () => {
  it("formats zero seconds", () => {
    expect(formatItunesDuration(0)).toBe("0:00");
  });

  it("formats durations below one hour as M:SS", () => {
    expect(formatItunesDuration(59)).toBe("0:59");
    expect(formatItunesDuration(65)).toBe("1:05");
    expect(formatItunesDuration(1854)).toBe("30:54");
    expect(formatItunesDuration(3599)).toBe("59:59");
  });

  it("formats durations of an hour or more as H:MM:SS", () => {
    expect(formatItunesDuration(3600)).toBe("1:00:00");
    expect(formatItunesDuration(3661)).toBe("1:01:01");
    expect(formatItunesDuration(45_296)).toBe("12:34:56");
  });
});

describe("formatRfc2822Date", () => {
  it("produces RFC 2822-compatible UTC output via toUTCString", () => {
    expect(formatRfc2822Date("2026-07-15T12:00:00.000Z")).toBe("Wed, 15 Jul 2026 12:00:00 GMT");
    expect(formatRfc2822Date("2026-01-01T00:00:00.000Z")).toBe("Thu, 01 Jan 2026 00:00:00 GMT");
  });
});

describe("buildRssFeed", () => {
  it("builds a valid empty channel with zero episodes", () => {
    const xml = buildRssFeed({
      show: showInput(),
      episodes: [],
      publicBaseUrl: BASE_URL,
      generatedAt: new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`)).toBe(true);
    expect(xml).toContain(`<rss version="2.0"`);
    expect(xml).toContain(`xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"`);
    expect(xml).toContain(`xmlns:content="http://purl.org/rss/1.0/modules/content/"`);
    expect(xml).toContain(`xmlns:atom="http://www.w3.org/2005/Atom"`);
    expect(xml).toContain("<title>Example Show</title>");
    // No website URL: the channel link falls back to the public base URL.
    expect(xml).toContain(`<link>${BASE_URL}/</link>`);
    expect(xml).toContain("<language>en</language>");
    expect(xml).toContain("<description>Example description.</description>");
    expect(xml).toContain(
      `<atom:link href="${BASE_URL}/feeds/example-show.xml" rel="self" type="application/rss+xml" />`,
    );
    expect(xml).toContain("<itunes:author>Example Author</itunes:author>");
    expect(xml).toContain("<itunes:name>Example Owner</itunes:name>");
    expect(xml).toContain("<itunes:email>podcast@example.com</itunes:email>");
    expect(xml).toContain(`<itunes:image href="${BASE_URL}/artwork/SHOW/OBJECT.jpg" />`);
    expect(xml).toContain(`<itunes:category text="Technology" />`);
    expect(xml).toContain("<itunes:explicit>false</itunes:explicit>");
    expect(xml).toContain("<lastBuildDate>Wed, 15 Jul 2026 12:00:00 GMT</lastBuildDate>");
    expect(countItems(xml)).toBe(0);
    expect(xml.trimEnd().endsWith("</rss>")).toBe(true);
  });

  it("renders one episode with the full item shape", () => {
    const xml = buildRssFeed({
      show: showInput({ websiteUrl: "https://example.invalid/" }),
      episodes: [episodeInput({ seasonNumber: 2, episodeNumber: 7 })],
      publicBaseUrl: BASE_URL,
    });

    expect(xml).toContain("<link>https://example.invalid/</link>");
    expect(countItems(xml)).toBe(1);
    expect(xml).toContain("<title>Episode title</title>");
    expect(xml).toContain("<description>Episode description.</description>");
    expect(xml).toContain("<content:encoded><![CDATA[Episode description.]]></content:encoded>");
    expect(xml).toContain(`<guid isPermaLink="false">EPISODE-GUID</guid>`);
    expect(xml).toContain("<pubDate>Wed, 15 Jul 2026 12:00:00 GMT</pubDate>");
    expect(xml).toContain(
      `<enclosure url="${BASE_URL}/media/SHOW/EPISODE/OBJECT.mp3" length="48320123" type="audio/mpeg" />`,
    );
    expect(xml).toContain("<itunes:duration>30:54</itunes:duration>");
    expect(xml).toContain("<itunes:episodeType>full</itunes:episodeType>");
    expect(xml).toContain("<itunes:season>2</itunes:season>");
    expect(xml).toContain("<itunes:episode>7</itunes:episode>");
  });

  it("escapes user text and emits a secondary category when present", () => {
    const xml = buildRssFeed({
      show: showInput({
        title: "News & <Reviews>",
        categorySecondary: "Health & Fitness",
      }),
      episodes: [episodeInput({ title: `Q&A "special" <live>`, description: "before]]>after" })],
      publicBaseUrl: BASE_URL,
    });

    expect(xml).toContain("<title>News &amp; &lt;Reviews&gt;</title>");
    expect(xml).toContain(`<itunes:category text="Health &amp; Fitness" />`);
    expect(xml).toContain(`<title>Q&amp;A "special" &lt;live&gt;</title>`);
    // CDATA split keeps the raw content safe.
    expect(xml).toContain(
      "<content:encoded><![CDATA[before]]]]><![CDATA[>after]]></content:encoded>",
    );
  });

  it("omits itunes:duration, season, and episode when unset", () => {
    const xml = buildRssFeed({
      show: showInput(),
      episodes: [episodeInput({ durationSeconds: null })],
      publicBaseUrl: BASE_URL,
    });
    expect(xml).not.toContain("<itunes:duration>");
    expect(xml).not.toContain("<itunes:season>");
    expect(xml).not.toContain("<itunes:episode>");
  });

  it("excludes draft and unpublished episodes", () => {
    const xml = buildRssFeed({
      show: showInput(),
      episodes: [
        episodeInput({ guid: "PUBLISHED" }),
        episodeInput({ guid: "DRAFT", status: "draft" }),
        episodeInput({ guid: "UNPUBLISHED", status: "unpublished" }),
        episodeInput({ guid: "ARCHIVED", status: "archived" }),
      ],
      publicBaseUrl: BASE_URL,
    });
    expect(countItems(xml)).toBe(1);
    expect(xml).toContain(">PUBLISHED</guid>");
    expect(xml).not.toContain("DRAFT");
    expect(xml).not.toContain("UNPUBLISHED");
    expect(xml).not.toContain("ARCHIVED");
  });

  it("caps the feed at the newest 300 episodes, newest first", () => {
    const episodes: FeedEpisodeInput[] = [];
    for (let i = 0; i < MAX_FEED_EPISODES + 1; i += 1) {
      const minutes = String(Math.floor(i / 60)).padStart(2, "0");
      const seconds = String(i % 60).padStart(2, "0");
      episodes.push(
        episodeInput({
          guid: `guid-${String(i).padStart(4, "0")}`,
          publishedAt: `2026-07-15T10:${minutes}:${seconds}.000Z`,
        }),
      );
    }
    // Shuffle the input order to prove the builder sorts by publishedAt.
    episodes.reverse();

    const xml = buildRssFeed({ show: showInput(), episodes, publicBaseUrl: BASE_URL });

    expect(countItems(xml)).toBe(MAX_FEED_EPISODES);
    // The newest episode (index 300) is first; the oldest (index 0) is cut.
    expect(xml).toContain(">guid-0300</guid>");
    expect(xml).not.toContain(">guid-0000</guid>");
    const first = xml.indexOf(">guid-0300</guid>");
    const second = xml.indexOf(">guid-0299</guid>");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  it("rejects a non-ASCII public URL", () => {
    expect(() =>
      buildRssFeed({
        show: showInput({ artworkPublicPath: "/artwork/SHOW/øbject.jpg" }),
        episodes: [],
        publicBaseUrl: BASE_URL,
      }),
    ).toThrow(/ASCII/);
  });
});
