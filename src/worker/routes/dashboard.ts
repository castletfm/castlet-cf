import { Hono } from "hono";

import { DASHBOARD_RECENT_EPISODES_LIMIT } from "../../shared/constants";
import type { DashboardResponse } from "../../shared/contracts";
import type { AppEnv } from "../app-env";
import { episodeRowToResource } from "../domain/episodes";
import { showRowToResource } from "../domain/shows";
import { sweepExpiredUploadIntents } from "../domain/storage";
import { listFeedDirtyShows, listRecentEpisodes } from "../services/db";
import { getAccountUsage } from "../services/quota";
import { uploadDeps } from "./uploads";

/**
 * GET /api/dashboard: storage counters,
 * feed-dirty shows, and recent episodes. Also runs the capped expiration
 * sweep opportunistically (section 11.6: lightweight cleanup on dashboard
 * load, bounded per request).
 */
export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", async (c) => {
  await sweepExpiredUploadIntents(uploadDeps(c));

  const db = c.env.DB;
  const usage = await getAccountUsage(db);
  const dirtyShows = await listFeedDirtyShows(db);
  const recentEpisodes = await listRecentEpisodes(db, DASHBOARD_RECENT_EPISODES_LIMIT);

  const body: DashboardResponse = {
    storage: {
      activeBytes: usage.activeBytes,
      reservedBytes: usage.reservedBytes,
      maxTotalBytes: Number(c.env.MAX_TOTAL_STORAGE_BYTES),
    },
    feedDirtyShows: dirtyShows.map(showRowToResource),
    recentEpisodes: recentEpisodes.map(episodeRowToResource),
  };
  return c.json(body);
});
