/**
 * Application chrome: primary navigation and the logout control. The main
 * content region is a named landmark and receives focus targets from each
 * screen's <h2>.
 */

import type { ReactNode } from "react";

import { routeHref, type Route } from "../router";

interface NavItem {
  href: string;
  label: string;
  /** Route names that should render this item as current. */
  match: Route["name"][];
}

const NAV_ITEMS: NavItem[] = [
  { href: routeHref.dashboard(), label: "Dashboard", match: ["dashboard"] },
  { href: routeHref.shows(), label: "Shows", match: ["shows", "show", "episodes", "episode"] },
  { href: routeHref.analytics(), label: "Analytics", match: ["analytics"] },
  { href: routeHref.storage(), label: "Storage", match: ["storage"] },
];

export function Layout({
  route,
  sessionExpiresAt,
  onLogout,
  children,
}: {
  route: Route;
  sessionExpiresAt: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href={routeHref.dashboard()}>
          Castlet
        </a>
        <nav aria-label="Primary">
          <ul>
            {NAV_ITEMS.map((item) => {
              const current = item.match.includes(route.name);
              return (
                <li key={item.href}>
                  <a href={item.href} aria-current={current ? "page" : undefined}>
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="app-header-end">
          <span className="muted session-note">
            Session ends {new Date(sessionExpiresAt).toLocaleTimeString()}
          </span>
          <button type="button" className="btn-secondary" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>
      <main id="main" className="app-main">
        {children}
      </main>
    </div>
  );
}
