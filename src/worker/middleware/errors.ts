import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppEnv } from "../app-env";

/**
 * Error envelope shared by all API error responses.
 * Never include stack traces, SQL text,
 * secrets, signed URLs, or raw provider error bodies.
 */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    requestId: string;
  };
}

type ErrorContext = Context<AppEnv>;

export function errorResponse(
  c: ErrorContext,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      details,
      requestId: c.get("requestId") ?? "",
    },
  };
  return c.json(body, status);
}

/** Hono not-found handler producing the standard error envelope. */
export function notFound(c: ErrorContext): Response {
  return errorResponse(c, 404, "NOT_FOUND", "Resource not found");
}

/** Hono error handler producing the standard error envelope. */
export function onError(err: Error, c: ErrorContext): Response {
  if (err instanceof HTTPException) {
    return errorResponse(c, err.status as ContentfulStatusCode, "HTTP_ERROR", err.message);
  }

  // Structured log without sensitive material (no cookies, keys, or URLs).
  console.error(
    JSON.stringify({
      level: "error",
      requestId: c.get("requestId") ?? "",
      name: err.name,
      message: err.message,
    }),
  );
  return errorResponse(c, 500, "INTERNAL_ERROR", "Internal server error");
}
