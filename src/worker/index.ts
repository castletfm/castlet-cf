import { Hono } from "hono";

import { APP_VERSION } from "../shared/constants";
import type { AppEnv } from "./app-env";
import { sessionAuth } from "./middleware/auth";
import { csrfProtection } from "./middleware/csrf";
import { notFound, onError } from "./middleware/errors";
import { requestId } from "./middleware/request-id";
import { analyticsRoutes } from "./routes/analytics";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { episodeRoutes, showEpisodeRoutes } from "./routes/episodes";
import { feedRoutes } from "./routes/feeds";
import { maintenanceRoutes } from "./routes/maintenance";
import { artworkRoutes, mediaRoutes } from "./routes/media";
import { showRoutes } from "./routes/shows";
import { storageRoutes } from "./routes/storage";
import { uploadRoutes } from "./routes/uploads";

const app = new Hono<AppEnv>();

app.use("*", requestId());

// Public delivery routes (sections 13.1 and 14): no authentication. They
// live outside /api and are registered before the API middleware; the
// wrangler.jsonc run_worker_first patterns already route them to the worker.
app.route("/feeds", feedRoutes);
app.route("/artwork", artworkRoutes);
app.route("/media", mediaRoutes);

// Every /api/* route is protected by default: sessionAuth() rejects requests
// without a valid session cookie (401) except for the public paths listed in
// PUBLIC_API_PATHS, and csrfProtection() enforces origin/content-type/CSRF
// checks on authenticated state-changing requests (403). Register these
// before any /api route so future routes inherit the protection.
app.use("/api/*", sessionAuth());
app.use("/api/*", csrfProtection());

// Liveness only. No dependency checks and no sensitive detail (section 15.2).
app.get("/api/health", (c) => c.json({ status: "ok", version: APP_VERSION }));

app.route("/api/auth", authRoutes);
app.route("/api/shows", showRoutes);
app.route("/api/shows", showEpisodeRoutes);
app.route("/api/episodes", episodeRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/storage", storageRoutes);
app.route("/api/maintenance", maintenanceRoutes);

app.notFound(notFound);
app.onError(onError);

export default app;
