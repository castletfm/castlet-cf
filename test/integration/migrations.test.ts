import { env } from "cloudflare:test";
import { expect, it } from "vitest";

it("migration seeds the account_usage singleton row", async () => {
  const row = await env.DB.prepare(
    "SELECT singleton_id, active_bytes, reserved_bytes FROM account_usage WHERE singleton_id = 1",
  ).first<{ singleton_id: number; active_bytes: number; reserved_bytes: number }>();

  expect(row).toEqual({ singleton_id: 1, active_bytes: 0, reserved_bytes: 0 });
});

it("R2 test binding is usable", async () => {
  await env.MEDIA.put("test/probe.txt", "hello");
  const object = await env.MEDIA.get("test/probe.txt");
  expect(await object?.text()).toBe("hello");
  await env.MEDIA.delete("test/probe.txt");
});
