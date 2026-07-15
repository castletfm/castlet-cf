import { createMiddleware } from "hono/factory";

export interface RequestIdVariables {
  requestId: string;
}

/**
 * Assigns a random request ID to every request and echoes it back in the
 * X-Request-Id response header. The ID is included in error envelopes and
 * structured logs so a client-reported failure can be correlated with logs.
 */
export function requestId() {
  return createMiddleware<{ Variables: RequestIdVariables }>(async (c, next) => {
    const id = crypto.randomUUID();
    c.set("requestId", id);
    await next();
    c.header("X-Request-Id", id);
  });
}
