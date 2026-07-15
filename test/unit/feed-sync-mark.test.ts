import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  getShowById,
  insertShow,
  markShowFeedSynchronized,
  type ShowRow,
} from "../../src/worker/services/db";

const NOW = "2026-07-15T12:00:00.000Z";
const LATER = "2026-07-15T12:05:00.000Z";

function showRow(overrides: Partial<ShowRow> = {}): ShowRow {
  const id = crypto.randomUUID();
  return {
    id,
    slug: `mark-${id.slice(0, 8)}`,
    title: "Show",
    author_name: "Author",
    owner_name: "Owner",
    owner_email: "owner@example.com",
    description: "Description",
    language: "en",
    category_primary: "Technology",
    category_secondary: null,
    explicit: 0,
    website_url: null,
    copyright_text: null,
    artwork_object_id: null,
    status: "active",
    feed_revision: 5,
    feed_published_revision: 0,
    feed_last_generated_at: null,
    feed_error: "prior error",
    slug_locked_at: null,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("markShowFeedSynchronized compare-and-set (F1)", () => {
  it("does not advance when this sync built a now-superseded revision", async () => {
    // feed_revision is 5 (a newer mutation happened after an older sync began).
    const row = showRow();
    await insertShow(env.DB, row);

    // A stale sync that built revision 3 tries to mark: the guard requires
    // feed_revision to still equal 3, but it is 5, so the mark must not apply.
    const applied = await markShowFeedSynchronized(env.DB, row.id, 3, LATER);
    expect(applied).toBe(false);

    const after = await getShowById(env.DB, row.id);
    // Published revision is not advanced, the error is not cleared, and the
    // generation timestamp is untouched — the row is left for the newer sync.
    expect(after?.feed_published_revision).toBe(0);
    expect(after?.feed_error).toBe("prior error");
    expect(after?.feed_last_generated_at).toBeNull();
  });

  it("advances when this sync built the current latest revision", async () => {
    const row = showRow();
    await insertShow(env.DB, row);

    // The sync that built revision 5 (== feed_revision) marks synchronized.
    const applied = await markShowFeedSynchronized(env.DB, row.id, 5, LATER);
    expect(applied).toBe(true);

    const after = await getShowById(env.DB, row.id);
    expect(after?.feed_published_revision).toBe(5);
    expect(after?.feed_error).toBeNull();
    expect(after?.feed_last_generated_at).toBe(LATER);
  });
});
