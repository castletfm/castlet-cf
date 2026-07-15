import { Hono } from "hono";

import type { AnalyticsEpisodesResponse } from "../../shared/contracts";
import type { AppEnv } from "../app-env";
import { errorResponse } from "../middleware/errors";
import { queryEpisodeDeliveryTotals, resolveAnalyticsWindow } from "../services/analytics-query";

/**
 * GET /api/analytics/episodes (mvp-design.md section 15.2): aggregated
 * request and byte metrics from the Analytics Engine SQL API. Degrades
 * gracefully: without a configured token (tests, local dev) it reports
 * `available: false` with 200; an unreachable or failing SQL API is a 502
 * with a safe message, never a raw provider body.
 */
export const analyticsRoutes = new Hono<AppEnv>();

analyticsRoutes.get("/episodes", async (c) => {
  const windowResult = resolveAnalyticsWindow(c.req.query("from"), c.req.query("to"));
  if (!windowResult.ok) {
    return errorResponse(c, 422, "VALIDATION_FAILED", windowResult.message);
  }
  const { window } = windowResult;
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();

  const apiToken = c.env.ANALYTICS_API_TOKEN;
  if (apiToken === undefined || apiToken === "") {
    const body: AnalyticsEpisodesResponse = {
      available: false,
      from: fromIso,
      to: toIso,
      episodes: [],
    };
    return c.json(body);
  }

  const result = await queryEpisodeDeliveryTotals(
    { accountId: c.env.R2_ACCOUNT_ID, apiToken },
    window,
  );
  if (!result.ok) {
    return errorResponse(
      c,
      502,
      "ANALYTICS_UNAVAILABLE",
      "Analytics backend is unavailable; try again later",
    );
  }

  const body: AnalyticsEpisodesResponse = {
    available: true,
    from: fromIso,
    to: toIso,
    episodes: result.episodes,
  };
  return c.json(body);
});
