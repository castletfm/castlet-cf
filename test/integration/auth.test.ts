import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_ACCESS_KEY } from "../auth-constants";

const BASE = "http://example.com";
const ORIGIN = "http://example.com"; // must equal PUBLIC_BASE_URL's origin

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface ParsedCookie {
  value: string;
  raw: string;
}

// SELF.fetch() dispatches to the worker inside this test isolate, so the
// worker's outbound `fetch` to Turnstile Siteverify resolves to the global
// we stub here. (`fetchMock` from "cloudflare:test" no longer exists in
// @cloudflare/vitest-pool-workers 0.18 / Vitest 4.)
const siteverifyQueue: boolean[] = [];

beforeEach(() => {
  siteverifyQueue.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== SITEVERIFY_URL) {
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }
    const success = siteverifyQueue.shift();
    if (success === undefined) {
      throw new Error("unexpected Siteverify call: no mocked response queued");
    }
    return Response.json({ success });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(siteverifyQueue).toEqual([]);
});

/** Queue one mocked Turnstile Siteverify response. */
function mockSiteverify(success: boolean): void {
  siteverifyQueue.push(success);
}

function parseSetCookies(res: Response): Map<string, ParsedCookie> {
  const cookies = new Map<string, ParsedCookie>();
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";", 1) as [string];
    const eq = pair.indexOf("=");
    cookies.set(pair.slice(0, eq), { value: pair.slice(eq + 1), raw });
  }
  return cookies;
}

async function login(): Promise<{
  res: Response;
  sessionToken: string;
  csrfToken: string;
  cookieHeader: string;
}> {
  mockSiteverify(true);
  const res = await SELF.fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      accessKey: TEST_ADMIN_ACCESS_KEY,
      turnstileToken: "test-turnstile-token",
    }),
  });
  const cookies = parseSetCookies(res);
  const sessionToken = cookies.get("castlet_session")?.value ?? "";
  const csrfToken = cookies.get("castlet_csrf")?.value ?? "";
  return {
    res,
    sessionToken,
    csrfToken,
    cookieHeader: `castlet_session=${sessionToken}; castlet_csrf=${csrfToken}`,
  };
}

describe("login", () => {
  it("happy path sets session and CSRF cookies without echoing the key", async () => {
    const { res, sessionToken, csrfToken } = await login();

    expect(res.status).toBe(200);
    expect(sessionToken).not.toBe("");
    expect(csrfToken).not.toBe("");

    const cookies = parseSetCookies(res);
    const sessionRaw = cookies.get("castlet_session")?.raw ?? "";
    expect(sessionRaw).toContain("HttpOnly");
    expect(sessionRaw).toContain("Secure");
    expect(sessionRaw).toContain("SameSite=Strict");
    expect(sessionRaw).toContain("Path=/");

    const csrfRaw = cookies.get("castlet_csrf")?.raw ?? "";
    expect(csrfRaw).not.toContain("HttpOnly");
    expect(csrfRaw).toContain("Secure");
    expect(csrfRaw).toContain("SameSite=Strict");
    expect(csrfRaw).toContain("Path=/");

    const bodyText = await res.text();
    expect(bodyText).not.toContain(TEST_ADMIN_ACCESS_KEY);
    const body = JSON.parse(bodyText) as { authenticated: boolean; expiresAt: string };
    expect(body.authenticated).toBe(true);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a failed Turnstile challenge with 403 and no cookies", async () => {
    mockSiteverify(false);
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ accessKey: TEST_ADMIN_ACCESS_KEY, turnstileToken: "bad" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TURNSTILE_FAILED");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a wrong access key with 401 and no cookies", async () => {
    mockSiteverify(true);
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ accessKey: "wrong-key", turnstileToken: "tok" }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_ACCESS_KEY");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ accessKey: TEST_ADMIN_ACCESS_KEY }),
    });
    expect(res.status).toBe(400);
  });
});

describe("route protection", () => {
  it("keeps /api/health open", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
  });

  it("returns 401 for unauthenticated /api/* requests", async () => {
    for (const path of ["/api/auth/session", "/api/shows", "/api/anything/nested"]) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("returns 401 for a tampered session cookie", async () => {
    const { sessionToken, csrfToken } = await login();
    const tampered = sessionToken.slice(0, -2) + (sessionToken.endsWith("aa") ? "bb" : "aa");
    const res = await SELF.fetch(`${BASE}/api/auth/session`, {
      headers: { Cookie: `castlet_session=${tampered}; castlet_csrf=${csrfToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("reports session and CSRF status for an authenticated request", async () => {
    const { cookieHeader } = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/session`, {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authenticated: boolean;
      csrfCookiePresent: boolean;
      csrfCookieMatchesSession: boolean;
    };
    expect(body.authenticated).toBe(true);
    expect(body.csrfCookiePresent).toBe(true);
    expect(body.csrfCookieMatchesSession).toBe(true);
  });
});

describe("CSRF and origin checks on state-changing requests", () => {
  it("rejects a missing X-CSRF-Token header with 403", async () => {
    const { cookieHeader } = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "Content-Type": "application/json", Origin: ORIGIN },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_MISMATCH");
  });

  it("rejects a mismatched X-CSRF-Token with 403", async () => {
    const { cookieHeader } = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-CSRF-Token": "not-the-right-token",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a CSRF value that matches the cookie but not the session", async () => {
    const { sessionToken } = await login();
    // Attacker-style double submit: cookie and header agree, but neither
    // matches the token inside the signed session.
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: `castlet_session=${sessionToken}; castlet_csrf=forged-token`,
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-CSRF-Token": "forged-token",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a wrong Origin with 403", async () => {
    const { cookieHeader, csrfToken } = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: "http://evil.example",
        "X-CSRF-Token": csrfToken,
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ORIGIN_MISMATCH");
  });

  it("rejects a missing Origin with 403", async () => {
    const { cookieHeader, csrfToken } = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a wrong Content-Type with 403", async () => {
    const { cookieHeader, csrfToken } = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "text/plain",
        Origin: ORIGIN,
        "X-CSRF-Token": csrfToken,
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_CONTENT_TYPE");
  });
});

describe("logout", () => {
  it("clears both cookies when session, CSRF, and origin are valid", async () => {
    const { cookieHeader, csrfToken } = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-CSRF-Token": csrfToken,
      },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const cookies = parseSetCookies(res);
    const session = cookies.get("castlet_session");
    const csrf = cookies.get("castlet_csrf");
    expect(session?.value).toBe("");
    expect(session?.raw).toContain("Max-Age=0");
    expect(csrf?.value).toBe("");
    expect(csrf?.raw).toContain("Max-Age=0");
  });
});
