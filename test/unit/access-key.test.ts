import { describe, expect, it } from "vitest";

import { verifyAccessKey } from "../../src/worker/services/access-key";
import { TEST_ADMIN_ACCESS_KEY, TEST_ADMIN_ACCESS_KEY_SHA256 } from "../auth-constants";

describe("access-key verification", () => {
  it("accepts the correct key", async () => {
    await expect(
      verifyAccessKey(TEST_ADMIN_ACCESS_KEY, TEST_ADMIN_ACCESS_KEY_SHA256),
    ).resolves.toBe(true);
  });

  it("accepts an uppercase configured digest", async () => {
    await expect(
      verifyAccessKey(TEST_ADMIN_ACCESS_KEY, TEST_ADMIN_ACCESS_KEY_SHA256.toUpperCase()),
    ).resolves.toBe(true);
  });

  it("rejects a wrong key", async () => {
    await expect(verifyAccessKey("wrong-access-key", TEST_ADMIN_ACCESS_KEY_SHA256)).resolves.toBe(
      false,
    );
  });

  it("rejects an empty key", async () => {
    await expect(verifyAccessKey("", TEST_ADMIN_ACCESS_KEY_SHA256)).resolves.toBe(false);
  });

  it("fails closed on a malformed configured digest", async () => {
    await expect(verifyAccessKey(TEST_ADMIN_ACCESS_KEY, "")).resolves.toBe(false);
    await expect(verifyAccessKey(TEST_ADMIN_ACCESS_KEY, "abc123")).resolves.toBe(false);
    await expect(verifyAccessKey(TEST_ADMIN_ACCESS_KEY, "z".repeat(64))).resolves.toBe(false);
  });
});
