import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  MaintenanceRunResponse,
  ShowResource,
  UploadInitiateResponse,
} from "../../src/shared/contracts";
import {
  BASE,
  createAuthContext,
  uniqueSlug,
  writeHeaders,
  type AuthContext,
} from "./session-helper";

const PAST_ISO = "2000-01-01T00:00:00.000Z";

let auth: AuthContext;
let show: ShowResource;

beforeEach(async () => {
  auth = await createAuthContext();
  const showRes = await SELF.fetch(`${BASE}/api/shows`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      slug: uniqueSlug("maint"),
      title: "Maintenance Show",
      authorName: "Author",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
      description: "Show for maintenance tests.",
      categoryPrimary: "Technology",
    }),
  });
  expect(showRes.status).toBe(201);
  show = (await showRes.json()) as ShowResource;
});

async function initiateArtwork(size: number): Promise<UploadInitiateResponse> {
  const res = await SELF.fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({
      ownerKind: "show",
      ownerId: show.id,
      kind: "artwork",
      filename: "cover.png",
      contentType: "image/png",
      size,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as UploadInitiateResponse;
}

async function runMaintenance(): Promise<MaintenanceRunResponse> {
  const res = await SELF.fetch(`${BASE}/api/maintenance/run`, {
    method: "POST",
    headers: writeHeaders(auth),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as MaintenanceRunResponse;
}

async function usage(): Promise<{ active_bytes: number; reserved_bytes: number }> {
  const row = await env.DB.prepare(
    "SELECT active_bytes, reserved_bytes FROM account_usage WHERE singleton_id = 1",
  ).first<{ active_bytes: number; reserved_bytes: number }>();
  expect(row).not.toBeNull();
  return row as { active_bytes: number; reserved_bytes: number };
}

describe("POST /api/maintenance/run", () => {
  it("requires authentication and CSRF", async () => {
    const anonymous = await SELF.fetch(`${BASE}/api/maintenance/run`, { method: "POST" });
    expect(anonymous.status).toBe(401);

    const noCsrf = await SELF.fetch(`${BASE}/api/maintenance/run`, {
      method: "POST",
      headers: { Cookie: auth.cookieHeader, "Content-Type": "application/json" },
    });
    expect(noCsrf.status).toBe(403);
  });

  it("expires overdue intents, releasing reservations and deleting pending objects", async () => {
    const before = await usage();

    // Two overdue intents; one has an uploaded R2 object to delete.
    const withObject = await initiateArtwork(64);
    const withoutObject = await initiateArtwork(32);
    const key = (
      await env.DB.prepare("SELECT object_key FROM storage_objects WHERE id = ?")
        .bind(withObject.storageObjectId)
        .first<{ object_key: string }>()
    )?.object_key as string;
    await env.MEDIA.put(key, new Uint8Array(64), { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare(
      "UPDATE upload_intents SET expires_at = ? WHERE id IN (?, ?) AND status = 'initiated'",
    )
      .bind(PAST_ISO, withObject.uploadId, withoutObject.uploadId)
      .run();

    const report = await runMaintenance();
    expect(report.expiredIntents).toBeGreaterThanOrEqual(2);
    expect(report.releasedBytes).toBeGreaterThanOrEqual(96);
    expect(report.deletedObjects).toBeGreaterThanOrEqual(1);

    const intents = await env.DB.prepare("SELECT id, status FROM upload_intents WHERE id IN (?, ?)")
      .bind(withObject.uploadId, withoutObject.uploadId)
      .all<{ id: string; status: string }>();
    for (const intent of intents.results) {
      expect(intent.status).toBe("expired");
    }
    expect(await env.MEDIA.head(key)).toBeNull();
    expect(await usage()).toEqual(before);
  });

  it("reports and corrects seeded drift in account_usage", async () => {
    // Settle any leftovers from earlier tests so drift starts at zero.
    await runMaintenance();
    const settled = await usage();

    // Skew both counters away from the D1-derived truth.
    await env.DB.prepare(
      "UPDATE account_usage SET active_bytes = active_bytes + 5000, reserved_bytes = reserved_bytes + 300 WHERE singleton_id = 1",
    ).run();

    const report = await runMaintenance();
    expect(report.drift.recordedActiveBytes).toBe(settled.active_bytes + 5000);
    expect(report.drift.computedActiveBytes).toBe(settled.active_bytes);
    expect(report.drift.activeBytesDrift).toBe(5000);
    expect(report.drift.recordedReservedBytes).toBe(settled.reserved_bytes + 300);
    expect(report.drift.computedReservedBytes).toBe(settled.reserved_bytes);
    expect(report.drift.reservedBytesDrift).toBe(300);
    expect(report.corrected).toBe(true);

    // Counters were rewritten to the computed values.
    expect(await usage()).toEqual(settled);
  });

  it("reports zero drift without correcting when counters are consistent", async () => {
    await runMaintenance(); // settle
    const report = await runMaintenance();
    expect(report.drift.activeBytesDrift).toBe(0);
    expect(report.drift.reservedBytesDrift).toBe(0);
    expect(report.corrected).toBe(false);
  });

  it("returns the full structured report shape", async () => {
    const report = await runMaintenance();
    expect(report).toMatchObject({
      expiredIntents: expect.any(Number),
      releasedBytes: expect.any(Number),
      deletedObjects: expect.any(Number),
      corrected: expect.any(Boolean),
      drift: {
        recordedActiveBytes: expect.any(Number),
        computedActiveBytes: expect.any(Number),
        activeBytesDrift: expect.any(Number),
        recordedReservedBytes: expect.any(Number),
        computedReservedBytes: expect.any(Number),
        reservedBytesDrift: expect.any(Number),
      },
    });
    // The R2-listing caveat is always reported, never silently skipped.
    expect(report.notes.length).toBeGreaterThanOrEqual(1);
    expect(report.notes.join(" ")).toContain("R2");
  });
});
