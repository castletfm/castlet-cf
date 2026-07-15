import type { Env } from "./env";
import type { RequestIdVariables } from "./middleware/request-id";
import type { SessionPayload } from "./services/sessions";

/**
 * Per-request context variables shared across middleware and routes.
 * `session` is set by the auth middleware for authenticated requests and
 * stays undefined on public routes (/api/health, /api/auth/login).
 */
export interface AppVariables extends RequestIdVariables {
  session?: SessionPayload;
}

/** Hono environment used by the whole worker app. */
export type AppEnv = { Bindings: Env; Variables: AppVariables };
