import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsEpisodesResponse } from "../../src/shared/contracts";
import app from "../../src/worker/index";
import { BASE, createAuthContext, readHeaders } from "./session-helper";

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

const PATH = "/api/analytics/episodes";

/**
 * vitest.config.ts deliberately leaves ANALYTICS_API_TOKEN unset, so
 * SELF-based requests exercise the graceful no-token path. Token-configured
 * behavior is tested by invoking the app directly with an env override and a
 * stubbed global fetch standing in for the Analytics Engine SQL API (the
 * worker under test runs in this isolate, so vi.stubGlobal applies).
 */
async function requestWithToken(query = ""): Promise<Response> {
  const auth = await createAuthContext();
  return app.request(
    `${BASE}${PATH}${query}`,
    { headers: readHeaders(auth) },
    { ...env, ANALYTICS_API_TOKEN: "test-analytics-token" },
  );
}

function stubSqlApi(response: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(response());
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/analytics/episodes", () => {
  it("requires authentication", async () => {
    const res = await SELF.fetch(`${BASE}${PATH}`);
    expect(res.status).toBe(401);
  });

  it("degrades gracefully to available:false when no token is configured", async () => {
    const auth = await createAuthContext();
    const res = await SELF.fetch(`${BASE}${PATH}`, { headers: readHeaders(auth) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AnalyticsEpisodesResponse;
    expect(body.available).toBe(false);
    expect(body.episodes).toEqual([]);
    // The default window is the full retention period ending now.
    const spanDays = (Date.parse(body.to) - Date.parse(body.from)) / 86_400_000;
    expect(spanDays).toBeCloseTo(90, 1);
  });

  it("rejects malformed from/to parameters with 422", async () => {
    const auth = await createAuthContext();
    const bad = await SELF.fetch(`${BASE}${PATH}?from=notadate`, { headers: readHeaders(auth) });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as ErrorBody).error.code).toBe("VALIDATION_FAILED");

    const inverted = await SELF.fetch(`${BASE}${PATH}?from=2026-07-10&to=2026-07-01`, {
      headers: readHeaders(auth),
    });
    expect(inverted.status).toBe(422);
  });

  it("queries the SQL API and maps grouped rows to per-episode totals", async () => {
    const fetchStub = stubSqlApi(
      () =>
        new Response(
          JSON.stringify({
            data: [
              // Ranged and unranged rows for the same episode merge; numeric
              // aggregates may arrive as strings (ClickHouse JSON) or numbers.
              { showId: "show-1", episodeId: "ep-1", ranged: "0", requests: "5", bytes: "1000" },
              { showId: "show-1", episodeId: "ep-1", ranged: "1", requests: 3, bytes: 300 },
              { showId: "show-1", episodeId: "artwork", ranged: "0", requests: "2", bytes: "20" },
            ],
          }),
        ),
    );

    const res = await requestWithToken("?from=2026-07-01&to=2026-07-10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsEpisodesResponse;
    expect(body.available).toBe(true);
    expect(body.episodes).toEqual([
      { showId: "show-1", episodeId: "ep-1", requests: 8, bytes: 1300, rangedRequests: 3 },
      { showId: "show-1", episodeId: "artwork", requests: 2, bytes: 20, rangedRequests: 0 },
    ]);

    // The request hit the account-scoped SQL endpoint with the bearer token
    // and the blob/double ordering contract from delivery-analytics.ts.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT_ID}/analytics_engine/sql`,
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-analytics-token",
    );
    const sql = init.body as string;
    expect(sql).toContain("blob1 AS showId");
    expect(sql).toContain("blob2 AS episodeId");
    expect(sql).toContain("blob8 AS ranged");
    expect(sql).toContain("FROM podcast_delivery");
    expect(sql).toContain("GROUP BY blob1, blob2, blob8");
  });

  it("maps an SQL API error status to a 502 envelope with a safe message", async () => {
    stubSqlApi(() => new Response("upstream detail that must not leak", { status: 500 }));

    const res = await requestWithToken();
    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ANALYTICS_UNAVAILABLE");
    expect(body.error.message).not.toContain("upstream detail");
  });

  it("maps a network failure to the same 502 envelope", async () => {
    stubSqlApi(() => {
      throw new Error("connection refused");
    });

    const res = await requestWithToken();
    expect(res.status).toBe(502);
    expect(((await res.json()) as ErrorBody).error.code).toBe("ANALYTICS_UNAVAILABLE");
  });
});
