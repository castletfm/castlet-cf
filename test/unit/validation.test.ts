import { describe, expect, it } from "vitest";

import {
  episodeCreateSchema,
  episodePatchSchema,
  showCreateSchema,
  showPatchSchema,
  slugSchema,
} from "../../src/shared/validation";

/** SOH (U+0001): an XML-1.0-invalid control character, built to avoid a raw byte in source. */
const SOH = String.fromCharCode(1);

describe("slugSchema", () => {
  const accepted = [
    "a",
    "z9",
    "9z",
    "0",
    "my-show",
    "my-show-2",
    "a-b-c",
    "double--hyphen",
    "trailing-",
  ];
  it.each(accepted)("accepts %j", (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  const rejected = [
    "",
    "-starts-with-hyphen",
    "Uppercase",
    "MY-SHOW",
    "under_score",
    "with space",
    "dot.dot",
    "accént",
    "日本語",
    "slash/slash",
    "a".repeat(101),
  ];
  it.each(rejected)("rejects %j", (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(false);
  });
});

const validShow = {
  slug: "my-show",
  title: "My Show",
  authorName: "Author",
  ownerName: "Owner",
  ownerEmail: "owner@example.com",
  description: "A show about testing.",
  categoryPrimary: "Technology",
};

describe("showCreateSchema", () => {
  it("accepts a minimal show and applies defaults", () => {
    const parsed = showCreateSchema.parse(validShow);
    expect(parsed.language).toBe("en");
    expect(parsed.explicit).toBe(false);
  });

  it("accepts an HTTPS ASCII website URL", () => {
    expect(
      showCreateSchema.safeParse({ ...validShow, websiteUrl: "https://example.com/show" }).success,
    ).toBe(true);
  });

  it.each([
    ["bad email", { ownerEmail: "not-an-email" }],
    ["unknown category", { categoryPrimary: "Podcasting" }],
    ["bad language tag", { language: "english language" }],
    ["non-http URL", { websiteUrl: "ftp://example.com/feed" }],
    // Section 13.2: public URLs must be HTTPS and ASCII-only.
    ["http:// URL", { websiteUrl: "http://example.com/feed" }],
    ["non-ASCII URL", { websiteUrl: "https://example.com/café" }],
    ["malformed URL", { websiteUrl: "not a url" }],
    // Scheme-only spellings Zod's URL parser accepts but that lack the
    // https:// authority form; they would emit a malformed channel <link>.
    ["scheme-only https URL", { websiteUrl: "https:example.com" }],
    ["single-slash https URL", { websiteUrl: "https:/example.com" }],
    ["empty-host https URL", { websiteUrl: "https:///path" }],
    // Feed-visible text must not carry an XML-1.0-invalid control character
    // (U+0001, via SOH); such a value would make the RSS builder throw at publish.
    ["control char in title", { title: `bad${SOH}title` }],
    ["control char in description", { description: `bad${SOH}desc` }],
    ["control char in author name", { authorName: `bad${SOH}name` }],
    ["control char in owner name", { ownerName: `bad${SOH}owner` }],
    ["control char in copyright", { copyrightText: `bad${SOH}copy` }],
    ["empty title", { title: "   " }],
    ["bad slug", { slug: "Bad Slug" }],
  ])("rejects %s", (_name, overrides) => {
    expect(showCreateSchema.safeParse({ ...validShow, ...overrides }).success).toBe(false);
  });

  it("accepts a plain https:// URL with a host", () => {
    expect(
      showCreateSchema.safeParse({ ...validShow, websiteUrl: "https://example.com" }).success,
    ).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(showCreateSchema.safeParse({ ...validShow, feedRevision: 5 }).success).toBe(false);
  });
});

describe("showPatchSchema", () => {
  it("requires a version and at least one updatable field", () => {
    expect(showPatchSchema.safeParse({ title: "New" }).success).toBe(false);
    expect(showPatchSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(showPatchSchema.safeParse({ version: 1, title: "New" }).success).toBe(true);
  });

  it("rejects non-editable fields such as status and slugLockedAt", () => {
    expect(showPatchSchema.safeParse({ version: 1, status: "inactive" }).success).toBe(false);
    expect(showPatchSchema.safeParse({ version: 1, slugLockedAt: null }).success).toBe(false);
  });
});

describe("episode schemas", () => {
  it("accepts a minimal draft and applies defaults", () => {
    const parsed = episodeCreateSchema.parse({ title: "Episode 1" });
    expect(parsed.description).toBe("");
    expect(parsed.episodeType).toBe("full");
    expect(parsed.explicit).toBe(false);
  });

  it("never accepts a client-supplied guid", () => {
    expect(episodeCreateSchema.safeParse({ title: "Ep", guid: "custom" }).success).toBe(false);
    expect(episodePatchSchema.safeParse({ version: 1, guid: "custom" }).success).toBe(false);
  });

  it("rejects non-positive season and episode numbers", () => {
    expect(episodeCreateSchema.safeParse({ title: "Ep", seasonNumber: 0 }).success).toBe(false);
    expect(episodePatchSchema.safeParse({ version: 1, episodeNumber: -1 }).success).toBe(false);
  });

  it("rejects an XML-1.0-invalid control character in feed-visible episode text", () => {
    // U+0001 in title or description would make the RSS builder throw at
    // publish time, so it must be rejected at write time (F3).
    expect(episodeCreateSchema.safeParse({ title: `Ep${SOH}` }).success).toBe(false);
    expect(episodeCreateSchema.safeParse({ title: "Ep", description: `d${SOH}` }).success).toBe(
      false,
    );
    expect(episodePatchSchema.safeParse({ version: 1, title: `Ep${SOH}` }).success).toBe(false);
    expect(episodePatchSchema.safeParse({ version: 1, description: `d${SOH}` }).success).toBe(
      false,
    );
  });
});
