import { describe, expect, it } from "vitest";

import {
  type AnalyticsWindow,
  buildDeliveryTotalsSql,
  queryEpisodeDeliveryTotals,
  resolveAnalyticsWindow,
} from "../../src/worker/services/analytics-query";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const DAY_MS = 86_400_000;

describe("resolveAnalyticsWindow", () => {
  it("defaults to the full retention window ending now", () => {
    const result = resolveAnalyticsWindow(undefined, undefined, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.window.to.getTime()).toBe(NOW.getTime());
      expect(result.window.from.getTime()).toBe(NOW.getTime() - 90 * DAY_MS);
    }
  });

  it("accepts date-only and full ISO timestamps", () => {
    const result = resolveAnalyticsWindow("2026-07-01", "2026-07-10T06:30:00.000Z", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.window.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(result.window.to.toISOString()).toBe("2026-07-10T06:30:00.000Z");
    }
  });

  it("clamps from below the retention floor and to above now", () => {
    const result = resolveAnalyticsWindow("2020-01-01", "2030-01-01", NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.window.from.getTime()).toBe(NOW.getTime() - 90 * DAY_MS);
      expect(result.window.to.getTime()).toBe(NOW.getTime());
    }
  });

  it("rejects malformed and impossible dates", () => {
    expect(resolveAnalyticsWindow("notadate", undefined, NOW).ok).toBe(false);
    expect(resolveAnalyticsWindow("2026-13-40", undefined, NOW).ok).toBe(false);
    expect(resolveAnalyticsWindow(undefined, "07/01/2026", NOW).ok).toBe(false);
  });

  it("rejects an inverted window", () => {
    const result = resolveAnalyticsWindow("2026-07-10", "2026-07-01", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("from");
    }
  });
});

describe("buildDeliveryTotalsSql", () => {
  it("selects the write-side blob/double contract and bounds the window", () => {
    const sql = buildDeliveryTotalsSql({
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-07-10T06:30:15.250Z"),
    });
    expect(sql).toContain("blob1 AS showId");
    expect(sql).toContain("blob2 AS episodeId");
    expect(sql).toContain("blob8 AS ranged");
    expect(sql).toContain("SUM(_sample_interval) AS requests");
    expect(sql).toContain("SUM(double1 * _sample_interval) AS bytes");
    expect(sql).toContain("FROM podcast_delivery");
    expect(sql).toContain("timestamp >= toDateTime('2026-07-01 00:00:00')");
    expect(sql).toContain("timestamp <= toDateTime('2026-07-10 06:30:15')");
    expect(sql).toContain("GROUP BY blob1, blob2, blob8");
  });
});

describe("queryEpisodeDeliveryTotals", () => {
  const window: AnalyticsWindow = {
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-10T00:00:00.000Z"),
  };
  const withData = (data: unknown) => ({
    accountId: "acc",
    apiToken: "tok",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch,
  });

  it("folds valid rows into per-episode totals", async () => {
    const result = await queryEpisodeDeliveryTotals(
      withData([
        { showId: "s1", episodeId: "e1", ranged: "0", requests: 3, bytes: 100 },
        { showId: "s1", episodeId: "e1", ranged: "1", requests: 2, bytes: 50 },
      ]),
      window,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.episodes).toEqual([
        { showId: "s1", episodeId: "e1", requests: 5, bytes: 150, rangedRequests: 2 },
      ]);
    }
  });

  it("fails closed (never throws) on a null row from the provider", async () => {
    const result = await queryEpisodeDeliveryTotals(withData([null]), window);
    expect(result.ok).toBe(false);
  });

  it("fails closed on a row missing required fields", async () => {
    const result = await queryEpisodeDeliveryTotals(withData([{ showId: "s1" }]), window);
    expect(result.ok).toBe(false);
  });

  it("fails closed on a row whose aggregate is non-numeric", async () => {
    const result = await queryEpisodeDeliveryTotals(
      withData([{ showId: "s1", episodeId: "e1", ranged: "0", requests: "nope", bytes: 100 }]),
      window,
    );
    expect(result.ok).toBe(false);
  });
});
