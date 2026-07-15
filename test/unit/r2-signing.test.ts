import { describe, expect, it } from "vitest";

import { createPresignedPutUrl } from "../../src/worker/services/r2-signing";

const PARAMS = {
  accountId: "test-account",
  bucketName: "castlet-media-test",
  accessKeyId: "test-r2-access-key-id",
  secretAccessKey: "test-r2-secret-access-key",
  objectKey: "audio/show-1/episode-1/object-1.mp3",
  contentType: "audio/mpeg",
  expiresSeconds: 900,
};

describe("createPresignedPutUrl", () => {
  it("signs the exact object key on the R2 S3 endpoint", async () => {
    const url = new URL(await createPresignedPutUrl(PARAMS));
    expect(url.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/castlet-media-test/audio/show-1/episode-1/object-1.mp3");
  });

  it("query-signs with SigV4 and the configured credentials", async () => {
    const url = new URL(await createPresignedPutUrl(PARAMS));
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^test-r2-access-key-id\//);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs the Content-Type header so R2 enforces it", async () => {
    const url = new URL(await createPresignedPutUrl(PARAMS));
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signedHeaders.split(";")).toContain("content-type");
  });

  it("expires within the 15-minute ceiling", async () => {
    const url = new URL(await createPresignedPutUrl(PARAMS));
    const expires = Number(url.searchParams.get("X-Amz-Expires"));
    expect(expires).toBe(900);
    expect(expires).toBeLessThanOrEqual(900);
  });
});
