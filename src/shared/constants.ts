/**
 * Application-wide constants shared by the Worker and the admin SPA.
 */

/** Application version reported by GET /api/health. */
export const APP_VERSION = "0.1.0";

/** Total application storage ceiling: 8.5 GiB (section 17, item 1). */
export const MAX_TOTAL_STORAGE_BYTES = 9_126_805_504;

/** Maximum audio file size: 250 MiB (section 11.1). */
export const MAX_AUDIO_BYTES = 262_144_000;

/** Maximum artwork file size: 10 MiB (section 11.1). */
export const MAX_ARTWORK_BYTES = 10_485_760;

/** Presigned upload URL lifetime: 15 minutes (section 10.4). */
export const UPLOAD_URL_TTL_SECONDS = 900;

/** Operator session lifetime: 12 hours (section 10.2). */
export const SESSION_TTL_SECONDS = 43_200;

/** Maximum outstanding (initiated, unexpired) upload intents (section 17, item 5). */
export const MAX_OUTSTANDING_UPLOAD_INTENTS = 20;

/** Maximum completed uploads per UTC day (section 17, item 6). */
export const MAX_COMPLETED_UPLOADS_PER_UTC_DAY = 20;

/** Newest published episodes included in a generated feed (section 13.2). */
export const MAX_FEED_EPISODES = 300;

/** Cache-Control max-age for public RSS feeds, in seconds (section 13.1). */
export const FEED_CACHE_MAX_AGE_SECONDS = 300;

/** Cache-Control max-age for immutable public media, in seconds (section 14.2). */
export const MEDIA_CACHE_MAX_AGE_SECONDS = 31_536_000;

/** Recent episodes shown on the dashboard (section 15.2, GET /api/dashboard). */
export const DASHBOARD_RECENT_EPISODES_LIMIT = 10;

/** Per-run cap on expired intents handled by POST /api/maintenance/run (section 11.6). */
export const MAINTENANCE_SWEEP_LIMIT = 200;

/**
 * Analytics Engine data retention, used to clamp analytics query windows.
 * Cloudflare retains Analytics Engine data points for about three months;
 * querying beyond that returns nothing, so 90 days is the usable window.
 */
export const ANALYTICS_RETENTION_DAYS = 90;
