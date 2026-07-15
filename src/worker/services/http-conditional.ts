/**
 * Conditional-request evaluation for the public feed and media routes
 * (mvp-design.md section 14.4): If-None-Match against the quoted R2
 * httpEtag, and If-Modified-Since against the R2 upload timestamp.
 */

export interface ConditionalHeaders {
  ifNoneMatch: string | null | undefined;
  ifModifiedSince: string | null | undefined;
}

/** Strips a weak-validator prefix so comparisons are weak (RFC 9110 8.8.3.2). */
function opaqueTag(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

/** True when an If-None-Match header value matches the current quoted ETag. */
export function etagMatches(headerValue: string, quotedEtag: string): boolean {
  if (headerValue.trim() === "*") {
    return true;
  }
  return headerValue
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => opaqueTag(candidate) === opaqueTag(quotedEtag));
}

/**
 * True when the request's conditional headers show the client already holds
 * the current representation, so a 304 should be returned. If-None-Match
 * takes precedence over If-Modified-Since (RFC 9110 13.1.3).
 */
export function isNotModified(
  headers: ConditionalHeaders,
  quotedEtag: string,
  lastModified: Date,
): boolean {
  if (headers.ifNoneMatch !== null && headers.ifNoneMatch !== undefined) {
    return etagMatches(headers.ifNoneMatch, quotedEtag);
  }
  if (headers.ifModifiedSince !== null && headers.ifModifiedSince !== undefined) {
    const since = Date.parse(headers.ifModifiedSince);
    if (Number.isNaN(since)) {
      return false;
    }
    // HTTP dates carry second precision; truncate the stored timestamp so an
    // exact Last-Modified echo compares as "not modified".
    return Math.floor(lastModified.getTime() / 1000) * 1000 <= since;
  }
  return false;
}
