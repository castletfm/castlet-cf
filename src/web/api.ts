/**
 * API client for the admin SPA.
 *
 * The access key is only ever held in component state during login and sent
 * once to /api/auth/login; it is never written to localStorage,
 * sessionStorage, or IndexedDB. Auth state lives in the HttpOnly session
 * cookie; the non-HttpOnly castlet_csrf cookie supplies the X-CSRF-Token
 * header for state-changing requests.
 *
 * Every response shape here is imported from src/shared/contracts.ts — the SPA
 * never redefines the API's JSON shapes.
 */

import type {
  AnalyticsEpisodesResponse,
  DashboardResponse,
  EpisodeCreateRequest,
  EpisodeListResponse,
  EpisodePatchRequest,
  EpisodeResource,
  EpisodeStatus,
  MaintenanceRunResponse,
  OrphanListResponse,
  ShowCreateRequest,
  ShowListResponse,
  ShowPatchRequest,
  ShowResource,
  StorageObjectResource,
  UploadCompleteRequest,
  UploadInitiateRequest,
  UploadInitiateResponse,
} from "../shared/contracts";

export const CSRF_COOKIE_NAME = "castlet_csrf";

export interface AuthConfig {
  turnstileSiteKey: string;
}

export interface SessionInfo {
  authenticated: boolean;
  expiresAt: string;
  csrfCookiePresent: boolean;
  csrfCookieMatchesSession: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
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
  let details: unknown;
  try {
    const body = (await res.json()) as ErrorEnvelope;
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    details = body.error?.details;
  } catch {
    // Keep the generic message.
  }
  return new ApiError(res.status, code, message, details);
}

export async function getConfig(): Promise<AuthConfig> {
  const res = await fetch("/api/auth/config");
  if (!res.ok) {
    throw await toApiError(res);
  }
  return (await res.json()) as AuthConfig;
}

// A 401 anywhere means the session expired; the app shell registers a handler
// that returns the operator to the login screen.
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function csrfHeader(): Record<string, string> {
  return { "X-CSRF-Token": readCookie(CSRF_COOKIE_NAME) ?? "" };
}

interface RequestOptions {
  method?: string;
  /** JSON-serializable body; sets Content-Type and the CSRF header. */
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const init: RequestInit = { method };
  if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json", ...csrfHeader() };
    init.body = JSON.stringify(options.body);
  } else if (method !== "GET" && method !== "HEAD") {
    init.headers = csrfHeader();
  }

  const res = await fetch(path, init);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw await toApiError(res);
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function getSession(): Promise<SessionInfo> {
  return await request<SessionInfo>("/api/auth/session");
}

export async function login(accessKey: string, turnstileToken: string): Promise<void> {
  // Login is the one request that must NOT trip the unauthorized handler: a
  // bad key returns 401 and should surface as a form error, not a redirect
  // loop. It also predates any session/CSRF cookie, so it calls fetch directly.
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
  await request<void>("/api/auth/logout", { method: "POST", body: {} });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getDashboard(): Promise<DashboardResponse> {
  return await request<DashboardResponse>("/api/dashboard");
}

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------

export async function listShows(): Promise<ShowListResponse> {
  return await request<ShowListResponse>("/api/shows");
}

export async function getShow(id: string): Promise<ShowResource> {
  return await request<ShowResource>(`/api/shows/${encodeURIComponent(id)}`);
}

export async function createShow(body: ShowCreateRequest): Promise<ShowResource> {
  return await request<ShowResource>("/api/shows", { method: "POST", body });
}

export async function patchShow(id: string, body: ShowPatchRequest): Promise<ShowResource> {
  return await request<ShowResource>(`/api/shows/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export async function regenerateFeed(id: string): Promise<ShowResource> {
  return await request<ShowResource>(`/api/shows/${encodeURIComponent(id)}/regenerate-feed`, {
    method: "POST",
    body: {},
  });
}

export async function deactivateShow(id: string): Promise<ShowResource> {
  return await request<ShowResource>(`/api/shows/${encodeURIComponent(id)}/deactivate`, {
    method: "POST",
    body: {},
  });
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export async function listEpisodes(
  showId: string,
  status?: EpisodeStatus,
): Promise<EpisodeListResponse> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return await request<EpisodeListResponse>(
    `/api/shows/${encodeURIComponent(showId)}/episodes${query}`,
  );
}

export async function createEpisode(
  showId: string,
  body: EpisodeCreateRequest,
): Promise<EpisodeResource> {
  return await request<EpisodeResource>(`/api/shows/${encodeURIComponent(showId)}/episodes`, {
    method: "POST",
    body,
  });
}

export async function getEpisode(id: string): Promise<EpisodeResource> {
  return await request<EpisodeResource>(`/api/episodes/${encodeURIComponent(id)}`);
}

export async function patchEpisode(
  id: string,
  body: EpisodePatchRequest,
): Promise<EpisodeResource> {
  return await request<EpisodeResource>(`/api/episodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export async function publishEpisode(id: string): Promise<EpisodeResource> {
  return await request<EpisodeResource>(`/api/episodes/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    body: {},
  });
}

export async function unpublishEpisode(id: string): Promise<EpisodeResource> {
  return await request<EpisodeResource>(`/api/episodes/${encodeURIComponent(id)}/unpublish`, {
    method: "POST",
    body: {},
  });
}

export async function deleteEpisode(id: string): Promise<void> {
  await request<void>(`/api/episodes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export async function initiateUpload(body: UploadInitiateRequest): Promise<UploadInitiateResponse> {
  return await request<UploadInitiateResponse>("/api/uploads", { method: "POST", body });
}

export async function completeUpload(
  uploadId: string,
  body: UploadCompleteRequest,
): Promise<StorageObjectResource> {
  return await request<StorageObjectResource>(
    `/api/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: "POST", body },
  );
}

export async function abortUpload(uploadId: string): Promise<void> {
  await request<void>(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Analytics, storage, maintenance
// ---------------------------------------------------------------------------

export async function getAnalytics(from?: string, to?: string): Promise<AnalyticsEpisodesResponse> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();
  return await request<AnalyticsEpisodesResponse>(
    `/api/analytics/episodes${query ? `?${query}` : ""}`,
  );
}

export async function listOrphans(cursor?: string): Promise<OrphanListResponse> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return await request<OrphanListResponse>(`/api/storage/orphans${query}`);
}

export async function purgeStorageObject(id: string): Promise<void> {
  await request<void>(`/api/storage/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function runMaintenance(): Promise<MaintenanceRunResponse> {
  return await request<MaintenanceRunResponse>("/api/maintenance/run", {
    method: "POST",
    body: {},
  });
}
