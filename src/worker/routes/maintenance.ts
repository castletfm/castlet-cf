import { Hono } from "hono";

import type { AppEnv } from "../app-env";
import { runMaintenance } from "../domain/maintenance";
import { uploadDeps } from "./uploads";

/**
 * POST /api/maintenance/run: expire
 * overdue upload intents and report quota consistency. State-changing, so it
 * sits behind the CSRF/origin middleware like every other write.
 */
export const maintenanceRoutes = new Hono<AppEnv>();

maintenanceRoutes.post("/run", async (c) => {
  const report = await runMaintenance(uploadDeps(c));
  return c.json(report);
});
