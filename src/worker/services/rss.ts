import { MAX_FEED_EPISODES } from "../../shared/constants";
import type { EpisodeStatus, EpisodeType } from "../../shared/contracts";
import { cdataSection, escapeXmlAttribute, escapeXmlText } from "./xml";

/**
 * RSS 2.0 document builder (mvp-design.md section 13).
 *
 * Builds the canonical feed XML from plain inputs; reading show/episode rows
 * and writing the result to R2 is feed-sync.ts's job. Only published
 * episodes are emitted, newest first, capped at MAX_FEED_EPISODES. A feed
 * with zero items is valid (an empty channel keeps publishing after the last
 * episode is unpublished).
 */

export interface FeedShowInput {
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
  /** Public path of the ACTIVE artwork object, e.g. "/artwork/{showId}/{objectId}.jpg". */
  artworkPublicPath: string;
}

export interface FeedEpisodeInput {
  guid: string;
  title: string;
  description: string;
  status: EpisodeStatus;
  /** ISO-8601 UTC publish timestamp. */
  publishedAt: string;
  episodeType: EpisodeType;
  explicit: boolean;
  seasonNumber: number | null;
  episodeNumber: number | null;
  durationSeconds: number | null;
  /** Public path of the ACTIVE audio object, e.g. "/media/{showId}/{episodeId}/{objectId}.mp3". */
  audioPublicPath: string;
  audioByteLength: number;
  audioContentType: string;
}

export interface BuildFeedInput {
  show: FeedShowInput;
  episodes: FeedEpisodeInput[];
  /** Absolute origin public URLs are built from, e.g. "https://host.example". */
  publicBaseUrl: string;
  /** Feed generation time (lastBuildDate); defaults to now. */
  generatedAt?: Date;
}

/** Printable-ASCII check for public URLs (section 13.2: ASCII-only). */
const ASCII_URL = /^[\x21-\x7e]+$/;

/**
 * Formats seconds as itunes:duration — "H:MM:SS" at an hour or more,
 * "M:SS" below (e.g. 0 -> "0:00", 1854 -> "30:54", 3661 -> "1:01:01").
 */
export function formatItunesDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** RFC 2822-compatible UTC date (section 13.2), via Date#toUTCString(). */
export function formatRfc2822Date(iso: string): string {
  return new Date(iso).toUTCString();
}

function boolText(value: boolean): string {
  return value ? "true" : "false";
}

export function buildRssFeed(input: BuildFeedInput): string {
  const { show } = input;
  const base = input.publicBaseUrl.replace(/\/+$/, "");

  const absoluteUrl = (publicPath: string): string => {
    const url = `${base}${publicPath}`;
    if (!ASCII_URL.test(url)) {
      throw new Error("Public feed URLs must be ASCII-only");
    }
    return url;
  };

  // Channel <link> is the one public URL sourced from operator free-text
  // (show.websiteUrl) rather than the controlled base origin. Section 13.2
  // requires public URLs to be absolute HTTPS and ASCII-only. Unlike the
  // base-derived URLs above, a stored websiteUrl may predate or violate that
  // rule, so fall back to the base origin (the default <link>, section 13.3)
  // whenever the value is absent, not HTTPS, not ASCII, or unparseable —
  // keeping the feed publishable and compliant rather than throwing.
  const channelLink = (websiteUrl: string | null): string => {
    const fallback = `${base}/`;
    if (websiteUrl === null || !ASCII_URL.test(websiteUrl)) {
      return fallback;
    }
    try {
      const parsed = new URL(websiteUrl);
      // Emit the canonical, normalized form (new URL(...).href) rather than the
      // raw string, so a stored scheme-only spelling such as "https:example.com"
      // becomes "https://example.com/" instead of a malformed <link>. Re-check
      // HTTPS and ASCII on the normalized value and fall back otherwise.
      const normalized = parsed.href;
      if (parsed.protocol !== "https:" || !ASCII_URL.test(normalized)) {
        return fallback;
      }
      return normalized;
    } catch {
      return fallback;
    }
  };

  const items = input.episodes
    .filter((episode) => episode.status === "published")
    .sort((a, b) => {
      if (a.publishedAt !== b.publishedAt) {
        return a.publishedAt < b.publishedAt ? 1 : -1;
      }
      return a.guid < b.guid ? 1 : a.guid > b.guid ? -1 : 0;
    })
    .slice(0, MAX_FEED_EPISODES);

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0"`,
    `  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"`,
    `  xmlns:content="http://purl.org/rss/1.0/modules/content/"`,
    `  xmlns:atom="http://www.w3.org/2005/Atom">`,
    `  <channel>`,
    `    <title>${escapeXmlText(show.title)}</title>`,
    `    <link>${escapeXmlText(channelLink(show.websiteUrl))}</link>`,
    `    <language>${escapeXmlText(show.language)}</language>`,
    `    <description>${escapeXmlText(show.description)}</description>`,
    `    <atom:link href="${escapeXmlAttribute(absoluteUrl(`/feeds/${show.slug}.xml`))}" rel="self" type="application/rss+xml" />`,
    `    <itunes:author>${escapeXmlText(show.authorName)}</itunes:author>`,
    `    <itunes:owner>`,
    `      <itunes:name>${escapeXmlText(show.ownerName)}</itunes:name>`,
    `      <itunes:email>${escapeXmlText(show.ownerEmail)}</itunes:email>`,
    `    </itunes:owner>`,
    `    <itunes:image href="${escapeXmlAttribute(absoluteUrl(show.artworkPublicPath))}" />`,
    `    <itunes:category text="${escapeXmlAttribute(show.categoryPrimary)}" />`,
  ];
  if (show.categorySecondary !== null) {
    lines.push(`    <itunes:category text="${escapeXmlAttribute(show.categorySecondary)}" />`);
  }
  lines.push(`    <itunes:explicit>${boolText(show.explicit)}</itunes:explicit>`);
  if (show.copyrightText !== null) {
    lines.push(`    <copyright>${escapeXmlText(show.copyrightText)}</copyright>`);
  }
  lines.push(
    `    <lastBuildDate>${(input.generatedAt ?? new Date()).toUTCString()}</lastBuildDate>`,
  );

  for (const episode of items) {
    lines.push(
      ``,
      `    <item>`,
      `      <title>${escapeXmlText(episode.title)}</title>`,
      `      <description>${escapeXmlText(episode.description)}</description>`,
      `      <content:encoded>${cdataSection(episode.description)}</content:encoded>`,
      `      <guid isPermaLink="false">${escapeXmlText(episode.guid)}</guid>`,
      `      <pubDate>${formatRfc2822Date(episode.publishedAt)}</pubDate>`,
      `      <enclosure url="${escapeXmlAttribute(absoluteUrl(episode.audioPublicPath))}" length="${episode.audioByteLength}" type="${escapeXmlAttribute(episode.audioContentType)}" />`,
    );
    if (episode.durationSeconds !== null) {
      lines.push(
        `      <itunes:duration>${formatItunesDuration(episode.durationSeconds)}</itunes:duration>`,
      );
    }
    lines.push(
      `      <itunes:episodeType>${escapeXmlText(episode.episodeType)}</itunes:episodeType>`,
      `      <itunes:explicit>${boolText(episode.explicit)}</itunes:explicit>`,
    );
    if (episode.seasonNumber !== null) {
      lines.push(`      <itunes:season>${episode.seasonNumber}</itunes:season>`);
    }
    if (episode.episodeNumber !== null) {
      lines.push(`      <itunes:episode>${episode.episodeNumber}</itunes:episode>`);
    }
    lines.push(`    </item>`);
  }

  lines.push(`  </channel>`, `</rss>`, ``);
  return lines.join("\n");
}
