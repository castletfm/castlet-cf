import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  commitReservedBytes,
  getAccountUsage,
  releaseReservedBytes,
  reserveBytes,
} from "../../src/worker/services/quota";

const MAX = 1000;

async function resetUsage(): Promise<void> {
  await env.DB.prepare(
    "UPDATE account_usage SET active_bytes = 0, reserved_bytes = 0 WHERE singleton_id = 1",
  ).run();
}

beforeEach(resetUsage);

describe("reserveBytes", () => {
  it("reserves under the limit", async () => {
    expect(await reserveBytes(env.DB, 400, MAX)).toBe(true);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: 400 });
  });

  it("allows a reservation that lands exactly on the limit", async () => {
    expect(await reserveBytes(env.DB, MAX, MAX)).toBe(true);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: MAX });
  });

  it("rejects one byte past the limit", async () => {
    expect(await reserveBytes(env.DB, MAX, MAX)).toBe(true);
    expect(await reserveBytes(env.DB, 1, MAX)).toBe(false);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: MAX });
  });

  it("counts active bytes against the ceiling", async () => {
    await env.DB.prepare(
      "UPDATE account_usage SET active_bytes = 700 WHERE singleton_id = 1",
    ).run();
    expect(await reserveBytes(env.DB, 300, MAX)).toBe(true);
    expect(await reserveBytes(env.DB, 1, MAX)).toBe(false);
  });

  it("does not overshoot across successive reservations", async () => {
    expect(await reserveBytes(env.DB, 600, MAX)).toBe(true);
    expect(await reserveBytes(env.DB, 600, MAX)).toBe(false);
    // The failed reservation must not have changed anything.
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: 600 });
    expect(await reserveBytes(env.DB, 400, MAX)).toBe(true);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: 1000 });
  });
});

describe("releaseReservedBytes", () => {
  it("restores quota headroom", async () => {
    await reserveBytes(env.DB, MAX, MAX);
    expect(await releaseReservedBytes(env.DB, MAX)).toBe(true);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: 0 });
    expect(await reserveBytes(env.DB, 500, MAX)).toBe(true);
  });

  it("refuses to release more than is reserved", async () => {
    await reserveBytes(env.DB, 100, MAX);
    expect(await releaseReservedBytes(env.DB, 200)).toBe(false);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: 100 });
  });
});

describe("commitReservedBytes", () => {
  it("moves the declared reservation to active using actual bytes", async () => {
    await reserveBytes(env.DB, 500, MAX);
    expect(await commitReservedBytes(env.DB, 500, 450)).toBe(true);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 450, reservedBytes: 0 });
  });

  it("refuses to commit more than is reserved", async () => {
    await reserveBytes(env.DB, 100, MAX);
    expect(await commitReservedBytes(env.DB, 200, 200)).toBe(false);
    expect(await getAccountUsage(env.DB)).toEqual({ activeBytes: 0, reservedBytes: 100 });
  });
});
