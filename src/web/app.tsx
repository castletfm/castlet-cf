import { useCallback, useEffect, useState } from "react";

import { ApiError, getSession, logout, setUnauthorizedHandler, type SessionInfo } from "./api";
import { Layout } from "./components/layout";
import { Banner } from "./components/ui";
import { Login } from "./login";
import { routeHref, useRoute, type Route } from "./router";
import { AnalyticsScreen } from "./routes/analytics";
import { DashboardScreen } from "./routes/dashboard";
import { EpisodeEditorScreen } from "./routes/episode-editor";
import { EpisodesScreen } from "./routes/episodes";
import { ShowSettingsScreen } from "./routes/show-settings";
import { ShowsScreen } from "./routes/shows";
import { StorageScreen } from "./routes/storage";

type AuthState =
  { phase: "checking" } | { phase: "loggedOut" } | { phase: "loggedIn"; session: SessionInfo };

/** Map the current route to its screen. */
function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case "dashboard":
      return <DashboardScreen />;
    case "shows":
      return <ShowsScreen />;
    case "show":
      return <ShowSettingsScreen key={route.showId} showId={route.showId} />;
    case "episodes":
      return <EpisodesScreen key={route.showId} showId={route.showId} />;
    case "episode":
      return <EpisodeEditorScreen key={route.episodeId} episodeId={route.episodeId} />;
    case "analytics":
      return <AnalyticsScreen />;
    case "storage":
      return <StorageScreen />;
    case "notFound":
      return (
        <section>
          <h2 tabIndex={-1}>Page not found</h2>
          <p className="muted">No screen matches “{route.hash}”.</p>
          <p>
            <a href={routeHref.dashboard()}>Back to dashboard</a>
          </p>
        </section>
      );
  }
}

export function App() {
  const [state, setState] = useState<AuthState>({ phase: "checking" });
  const [notice, setNotice] = useState<string | null>(null);
  const route = useRoute();

  const refreshSession = useCallback(() => {
    setState({ phase: "checking" });
    getSession()
      .then((session) => setState({ phase: "loggedIn", session }))
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 401)) {
          setNotice(err instanceof Error ? err.message : "Session check failed.");
        }
        setState({ phase: "loggedOut" });
      });
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  // A 401 from any API call means the session expired: return to login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setNotice("Your session expired. Please log in again.");
      setState({ phase: "loggedOut" });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  async function handleLogout() {
    setNotice(null);
    try {
      await logout();
    } catch {
      // Even on failure, re-check: an expired session also lands on login.
    }
    setState({ phase: "loggedOut" });
  }

  if (state.phase === "checking") {
    return (
      <main className="centered">
        <p role="status">Checking session…</p>
      </main>
    );
  }

  if (state.phase === "loggedOut") {
    return (
      <main className="centered">
        <div className="login-card">
          <h1>Castlet</h1>
          <p className="muted">Serverless podcast hosting.</p>
          {notice !== null && <Banner variant="info">{notice}</Banner>}
          <Login
            onLoggedIn={() => {
              setNotice(null);
              refreshSession();
            }}
          />
        </div>
      </main>
    );
  }

  return (
    <Layout
      route={route}
      sessionExpiresAt={state.session.expiresAt}
      onLogout={() => void handleLogout()}
    >
      {notice !== null && <Banner variant="info">{notice}</Banner>}
      <RouteView route={route} />
    </Layout>
  );
}
