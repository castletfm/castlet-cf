import { expect, it } from "vitest";

import {
  MAX_ARTWORK_BYTES,
  MAX_AUDIO_BYTES,
  MAX_FEED_EPISODES,
  MAX_TOTAL_STORAGE_BYTES,
} from "../../src/shared/constants";

it("storage limits match the design document", () => {
  expect(MAX_TOTAL_STORAGE_BYTES).toBe(9126805504); // 8.5 GiB
  expect(MAX_AUDIO_BYTES).toBe(262144000); // 250 MiB
  expect(MAX_ARTWORK_BYTES).toBe(10485760); // 10 MiB
  expect(MAX_FEED_EPISODES).toBe(300);
});
