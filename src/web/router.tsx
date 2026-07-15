/**
 * Tiny dependency-free hash router.
 *
 * Hash routing keeps the SPA entirely client-side and avoids relying on the
 * Static Assets single-page-application fallback for deep links, so a shared
 * or refreshed URL always resolves in the browser. Real <a href="#/..."> links
 * remain keyboard- and screen-reader-navigable.
 */

import { useSyncExternalStore } from "react";

export type Route =
  | { name: "dashboard" }
  | { name: "shows" }
  | { name: "show"; showId: string }
  | { name: "episodes"; showId: string }
  | { name: "episode"; episodeId: string }
  | { name: "analytics" }
  | { name: "storage" }
  | { name: "notFound"; hash: string };

/** Parse a location hash (e.g. "#/shows/abc") into a Route. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const segments = path.split("/").filter((s) => s.length > 0);

  if (segments.length === 0) {
    return { name: "dashboard" };
  }
  if (segments[0] === "shows") {
    if (segments.length === 1) {
      return { name: "shows" };
    }
    const showId = segments[1] as string;
    if (segments.length === 2) {
      return { name: "show", showId };
    }
    if (segments.length === 3 && segments[2] === "episodes") {
      return { name: "episodes", showId };
    }
  }
  if (segments[0] === "episodes" && segments.length === 2) {
    return { name: "episode", episodeId: segments[1] as string };
  }
  if (segments[0] === "analytics" && segments.length === 1) {
    return { name: "analytics" };
  }
  if (segments[0] === "storage" && segments.length === 1) {
    return { name: "storage" };
  }
  return { name: "notFound", hash: path };
}

export const routeHref = {
  dashboard: () => "#/",
  shows: () => "#/shows",
  show: (showId: string) => `#/shows/${encodeURIComponent(showId)}`,
  episodes: (showId: string) => `#/shows/${encodeURIComponent(showId)}/episodes`,
  episode: (episodeId: string) => `#/episodes/${encodeURIComponent(episodeId)}`,
  analytics: () => "#/analytics",
  storage: () => "#/storage",
};

/** Programmatic navigation; `href` is a "#/..." hash string. */
export function navigate(href: string): void {
  if (window.location.hash === href) {
    // Force a re-read even when navigating to the current hash.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = href;
  }
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getSnapshot(): string {
  return window.location.hash;
}

/** Subscribe to the current route, re-rendering on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getSnapshot);
  return parseHash(hash);
}
