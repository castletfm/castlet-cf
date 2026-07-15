import { z } from "zod";

/**
 * Zod schemas shared by the Worker API and the admin SPA.
 * Validation rules come from mvp-design.md sections 9.1, 12.1, and 12.2.
 */

/**
 * Show slug rule (section 9.1): lowercase ASCII, begins with a letter or
 * digit, and contains only a-z, 0-9, and hyphens.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    SLUG_PATTERN,
    "Slug must be lowercase ASCII, start with a letter or digit, and contain only a-z, 0-9, and hyphens",
  );

/**
 * Apple Podcasts top-level categories (section 12.1 requires a primary Apple
 * category). Subcategories are out of scope for the MVP; feed generation
 * emits the top-level category only.
 */
export const APPLE_CATEGORIES = [
  "Arts",
  "Business",
  "Comedy",
  "Education",
  "Fiction",
  "Government",
  "Health & Fitness",
  "History",
  "Kids & Family",
  "Leisure",
  "Music",
  "News",
  "Religion & Spirituality",
  "Science",
  "Society & Culture",
  "Sports",
  "TV & Film",
  "Technology",
  "True Crime",
] as const;

export const appleCategorySchema = z.enum(APPLE_CATEGORIES);

/** RFC 5646-style language tag, e.g. "en", "ja", "en-US", "pt-BR". */
export const languageSchema = z
  .string()
  .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, "Expected a language tag such as en, ja, or en-US");

const emailSchema = z.email().max(254);
const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2000);

const titleSchema = z.string().trim().min(1).max(500);
const personNameSchema = z.string().trim().min(1).max(200);
const showDescriptionSchema = z.string().trim().min(1).max(4000);
const copyrightSchema = z.string().trim().min(1).max(500);

/** Optimistic-concurrency version observed by the client (section 9.1). */
const versionSchema = z.number().int().min(1);

export const showCreateSchema = z.strictObject({
  slug: slugSchema,
  title: titleSchema,
  authorName: personNameSchema,
  ownerName: personNameSchema,
  ownerEmail: emailSchema,
  description: showDescriptionSchema,
  language: languageSchema.default("en"),
  categoryPrimary: appleCategorySchema,
  categorySecondary: appleCategorySchema.nullish(),
  explicit: z.boolean().default(false),
  websiteUrl: httpUrlSchema.nullish(),
  copyrightText: copyrightSchema.nullish(),
});

export const showPatchSchema = z
  .strictObject({
    version: versionSchema,
    slug: slugSchema.optional(),
    title: titleSchema.optional(),
    authorName: personNameSchema.optional(),
    ownerName: personNameSchema.optional(),
    ownerEmail: emailSchema.optional(),
    description: showDescriptionSchema.optional(),
    language: languageSchema.optional(),
    categoryPrimary: appleCategorySchema.optional(),
    categorySecondary: appleCategorySchema.nullable().optional(),
    explicit: z.boolean().optional(),
    websiteUrl: httpUrlSchema.nullable().optional(),
    copyrightText: copyrightSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "version"), {
    message: "At least one updatable field is required",
  });

export const episodeStatusSchema = z.enum(["draft", "published", "unpublished", "archived"]);

export const episodeTypeSchema = z.enum(["full", "bonus", "trailer"]);

/**
 * Draft episodes may be created before all publish requirements are met
 * (section 12.2 applies at publish time), so description may be empty here.
 * GUID and duration are never client-supplied: the GUID is generated at
 * creation and immutable (section 9.1); duration is set by upload completion.
 */
export const episodeCreateSchema = z.strictObject({
  title: titleSchema,
  description: z.string().trim().max(4000).default(""),
  episodeType: episodeTypeSchema.default("full"),
  explicit: z.boolean().default(false),
  seasonNumber: z.number().int().min(1).nullish(),
  episodeNumber: z.number().int().min(1).nullish(),
});

export const episodePatchSchema = z
  .strictObject({
    version: versionSchema,
    title: titleSchema.optional(),
    description: z.string().trim().max(4000).optional(),
    episodeType: episodeTypeSchema.optional(),
    explicit: z.boolean().optional(),
    seasonNumber: z.number().int().min(1).nullable().optional(),
    episodeNumber: z.number().int().min(1).nullable().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "version"), {
    message: "At least one updatable field is required",
  });
