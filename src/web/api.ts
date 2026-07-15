/**
 * Minimal API client for the admin SPA.
 *
 * The access key is only ever held in component state during login and sent
 * once to /api/auth/login; it is never written to localStorage,
 * sessionStorage, or IndexedDB. Auth state lives in the HttpOnly session
 * cookie; the non-HttpOnly castlet_csrf cookie supplies the X-CSRF-Token
 * header for state-changing requests.
 */

export const CSRF_COOKIE_NAME = "castlet_csrf";

export interface SessionInfo {
  authenticated: boolean;
  expiresAt: string;
  csrfCookiePresent: boolean;
  csrfCookieMatchesSession: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return null;
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = "UNKNOWN";
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as ErrorEnvelope;
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // Keep the generic message.
  }
  return new ApiError(res.status, code, message);
}

export async function getSession(): Promise<SessionInfo> {
  const res = await fetch("/api/auth/session");
  if (!res.ok) {
    throw await toApiError(res);
  }
  return (await res.json()) as SessionInfo;
}

export async function login(accessKey: string, turnstileToken: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey, turnstileToken }),
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
}

export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": readCookie(CSRF_COOKIE_NAME) ?? "",
    },
    body: "{}",
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
}
