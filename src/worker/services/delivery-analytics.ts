/**
 * Delivery analytics writes (mvp-design.md section 14.5).
 *
 * One Analytics Engine data point per public media/artwork response,
 * enqueued via ctx.waitUntil() after the response is determined. Feed
 * requests are deliberately not recorded: the design's contract is one
 * event per media response.
 *
 * Never store raw IP addresses or complete user-agent strings, and never
 * present these counts as unique listeners or IAB-certified downloads.
 */

/** Marker used in place of an episode ID for artwork deliveries. */
export const ARTWORK_MARKER = "artwork";

/** Small normalized client taxonomy; never the raw user-agent string. */
export type ClientFamily =
  "apple-podcasts" | "spotify" | "overcast" | "pocketcasts" | "browser" | "bot" | "other";

/**
 * Maps a raw User-Agent header onto the small client-family enum. App
 * checks run before the generic browser check because most podcast apps
 * embed a Mozilla token.
 */
export function classifyClientFamily(userAgent: string | null | undefined): ClientFamily {
  if (userAgent === null || userAgent === undefined || userAgent === "") {
    return "other";
  }
  const ua = userAgent.toLowerCase();
  if (ua.includes("spotify")) {
    return "spotify";
  }
  if (ua.includes("overcast")) {
    return "overcast";
  }
  if (ua.includes("pocket casts") || ua.includes("pocketcasts")) {
    return "pocketcasts";
  }
  if (ua.includes("applecoremedia") || ua.includes("itunes") || ua.includes("itms")) {
    return "apple-podcasts";
  }
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) {
    return "bot";
  }
  if (ua.includes("mozilla/")) {
    return "browser";
  }
  return "other";
}

export interface DeliveryEvent {
  showId: string;
  /** Episode ID for audio deliveries, or ARTWORK_MARKER for artwork. */
  episodeMarker: string;
  objectId: string;
  method: string;
  status: number;
  /** ISO country from request.cf, or "" when unavailable. */
  country: string;
  clientFamily: ClientFamily;
  /** True when the response was a 206 partial response. */
  ranged: boolean;
  /** Bytes in the response body (0 for HEAD, 304, 404, 416). */
  responseBytes: number;
  /** Served range bounds; null when the response was not ranged. */
  rangeStart: number | null;
  rangeEnd: number | null;
  /** Complete object size in bytes. */
  totalBytes: number;
}

/**
 * Builds the Analytics Engine data point for one delivery. Blob order and
 * double order are the query-side contract; -1 marks an absent range bound.
 */
export function deliveryDataPoint(event: DeliveryEvent): AnalyticsEngineDataPoint {
  return {
    indexes: [event.showId],
    blobs: [
      event.showId,
      event.episodeMarker,
      event.objectId,
      event.method,
      String(event.status),
      event.country,
      event.clientFamily,
      event.ranged ? "1" : "0",
    ],
    doubles: [event.responseBytes, event.rangeStart ?? -1, event.rangeEnd ?? -1, event.totalBytes],
  };
}

/**
 * Writes one delivery event, swallowing failures: analytics must never
 * break public delivery.
 */
export function writeDeliveryEvent(
  dataset: AnalyticsEngineDataset | undefined,
  event: DeliveryEvent,
): void {
  try {
    dataset?.writeDataPoint(deliveryDataPoint(event));
  } catch {
    // Intentionally ignored (section 14.5: non-blocking best-effort write).
  }
}
