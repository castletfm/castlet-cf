import { Hono } from "hono";

import { APP_VERSION } from "../shared/constants";
import type { Env } from "./env";
import { notFound, onError } from "./middleware/errors";
import { requestId, type RequestIdVariables } from "./middleware/request-id";

const app = new Hono<{ Bindings: Env; Variables: RequestIdVariables }>();

app.use("*", requestId());

// Liveness only. No dependency checks and no sensitive detail (section 15.2).
app.get("/api/health", (c) => c.json({ status: "ok", version: APP_VERSION }));

// Later phases add /api/auth, /api/shows, /api/episodes, /api/uploads,
// /feeds/*, /media/*, /artwork/*, analytics, and maintenance routes here.

app.notFound(notFound);
app.onError(onError);

export default app;
