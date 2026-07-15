import { Hono } from "hono";

import { APP_VERSION } from "../shared/constants";
import type { AppEnv } from "./app-env";
import { sessionAuth } from "./middleware/auth";
import { csrfProtection } from "./middleware/csrf";
import { notFound, onError } from "./middleware/errors";
import { requestId } from "./middleware/request-id";
import { authRoutes } from "./routes/auth";
import { episodeRoutes, showEpisodeRoutes } from "./routes/episodes";
import { showRoutes } from "./routes/shows";
import { uploadRoutes } from "./routes/uploads";

const app = new Hono<AppEnv>();

app.use("*", requestId());

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

// Later phases add /feeds/*, /media/*, /artwork/*, analytics, and
// maintenance routes here.

app.notFound(notFound);
app.onError(onError);

export default app;
