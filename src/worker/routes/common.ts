import type { Context } from "hono";
import type { z } from "zod";

import type { AppEnv } from "../app-env";
import { errorResponse } from "../middleware/errors";

/** Reads the JSON request body, or produces the standard 400 envelope. */
export async function readJsonBody(
  c: Context<AppEnv>,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: errorResponse(c, 400, "INVALID_REQUEST", "Expected a JSON request body"),
    };
  }
}

/** 422 envelope with safe, field-level Zod issue details. */
export function validationFailed(c: Context<AppEnv>, error: z.ZodError): Response {
  return errorResponse(c, 422, "VALIDATION_FAILED", "Request validation failed", {
    issues: error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}
