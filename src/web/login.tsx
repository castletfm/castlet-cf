import { useEffect, useRef, useState, type FormEvent } from "react";

import { ApiError, login } from "./api";

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Site key comes from the build environment; the fallback is Cloudflare's
// visible "always passes" Turnstile test sitekey, which pairs with the test
// secret in .dev.vars.example for local development.
const TURNSTILE_SITE_KEY: string =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? "1x00000000000000000000AA";

let turnstileScriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile !== undefined) {
    return Promise.resolve();
  }
  turnstileScriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error("Turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

interface LoginProps {
  onLoggedIn: () => void;
}

/**
 * Minimal login form: access key + Turnstile widget. The access key lives
 * only in component state and the login request body — never in any browser
 * storage.
 */
export function Login({ onLoggedIn }: LoginProps) {
  const [accessKey, setAccessKey] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [widgetFailed, setWidgetFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || containerRef.current === null || window.turnstile === undefined) {
          return;
        }
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token) => setTurnstileToken(token),
          "expired-callback": () => setTurnstileToken(null),
          "error-callback": () => setWidgetFailed(true),
        });
      })
      .catch(() => {
        if (!cancelled) setWidgetFailed(true);
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null && window.turnstile !== undefined) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (accessKey === "") {
      setError("Enter the operator access key.");
      return;
    }
    if (turnstileToken === null) {
      setError("Complete the Turnstile challenge first.");
      return;
    }

    setSubmitting(true);
    try {
      await login(accessKey, turnstileToken);
      onLoggedIn();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(
          err.code === "TURNSTILE_FAILED"
            ? "Turnstile verification failed. Try the challenge again."
            : err.code === "INVALID_ACCESS_KEY"
              ? "Invalid access key."
              : err.message,
        );
      } else {
        setError("Login request failed. Check your connection and try again.");
      }
      // Turnstile tokens are single-use; get a fresh one for the next try.
      setTurnstileToken(null);
      if (widgetIdRef.current !== null && window.turnstile !== undefined) {
        window.turnstile.reset(widgetIdRef.current);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <h2>Operator login</h2>
      <p>
        <label>
          Access key{" "}
          <input
            type="password"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </label>
      </p>
      <div ref={containerRef} />
      {widgetFailed && <p role="alert">Turnstile failed to load. Reload the page to try again.</p>}
      {error !== null && <p role="alert">{error}</p>}
      <p>
        <button type="submit" disabled={submitting}>
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </p>
    </form>
  );
}
