import { useEffect, useState } from "react";

interface HealthResponse {
  status: string;
  version: string;
}

type HealthState =
  | { phase: "loading" }
  | { phase: "ok"; health: HealthResponse }
  | { phase: "error"; message: string };

/**
 * Placeholder dashboard shell. Real screens (login, shows, episodes,
 * uploads, analytics) arrive in later phases.
 */
export function App() {
  const [state, setState] = useState<HealthState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`unexpected status ${res.status}`);
        }
        return (await res.json()) as HealthResponse;
      })
      .then((health) => {
        if (!cancelled) setState({ phase: "ok", health });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message: err instanceof Error ? err.message : "request failed",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem" }}>
      <h1>Castlet</h1>
      <p>Serverless podcast hosting (scaffold).</p>
      {state.phase === "loading" && <p>Checking API health…</p>}
      {state.phase === "ok" && (
        <p>
          API status: <strong>{state.health.status}</strong> (version {state.health.version})
        </p>
      )}
      {state.phase === "error" && <p>API unreachable: {state.message}</p>}
    </main>
  );
}
