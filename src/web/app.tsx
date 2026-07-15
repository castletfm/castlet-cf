import { useCallback, useEffect, useState } from "react";

import { ApiError, getSession, logout, type SessionInfo } from "./api";
import { Login } from "./login";

type AuthState =
  { phase: "checking" } | { phase: "loggedOut" } | { phase: "loggedIn"; session: SessionInfo };

/**
 * Minimal authentication shell. Real dashboard screens (shows, episodes,
 * uploads, analytics) arrive in later phases.
 */
export function App() {
  const [state, setState] = useState<AuthState>({ phase: "checking" });
  const [notice, setNotice] = useState<string | null>(null);

  const refreshSession = useCallback(() => {
    setState({ phase: "checking" });
    getSession()
      .then((session) => setState({ phase: "loggedIn", session }))
      .catch((err: unknown) => {
        // 401 means "not logged in"; anything else is shown as a notice.
        if (!(err instanceof ApiError && err.status === 401)) {
          setNotice(err instanceof Error ? err.message : "Session check failed.");
        }
        setState({ phase: "loggedOut" });
      });
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  async function handleLogout() {
    setNotice(null);
    try {
      await logout();
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : "Logout failed.");
    }
    // Even on failure, re-check: an expired session also lands on login.
    refreshSession();
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem" }}>
      <h1>Castlet</h1>
      <p>Serverless podcast hosting.</p>
      {notice !== null && <p role="alert">{notice}</p>}
      {state.phase === "checking" && <p>Checking session…</p>}
      {state.phase === "loggedOut" && (
        <Login
          onLoggedIn={() => {
            setNotice(null);
            refreshSession();
          }}
        />
      )}
      {state.phase === "loggedIn" && (
        <section>
          <p>Logged in. Session expires {new Date(state.session.expiresAt).toLocaleString()}.</p>
          <p>Dashboard screens arrive in later phases.</p>
          <button type="button" onClick={() => void handleLogout()}>
            Log out
          </button>
        </section>
      )}
    </main>
  );
}
