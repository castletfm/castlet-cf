import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("GET /api/health returns 200 with status and version", async () => {
  const res = await SELF.fetch("http://example.com/api/health");

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("x-request-id")).toBeTruthy();

  const body = await res.json();
  expect(body).toEqual({ status: "ok", version: expect.any(String) });
});

it("unknown API routes return the standard error envelope", async () => {
  const res = await SELF.fetch("http://example.com/api/does-not-exist");

  expect(res.status).toBe(404);
  const body = (await res.json()) as {
    error: { code: string; message: string; requestId: string };
  };
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.error.requestId).toBeTruthy();
});
