import { describe, expect, it, vi } from "vitest";

import {
  ARTWORK_MARKER,
  classifyClientFamily,
  deliveryDataPoint,
  writeDeliveryEvent,
  type DeliveryEvent,
} from "../../src/worker/services/delivery-analytics";

describe("classifyClientFamily", () => {
  const cases: Array<{ ua: string | null | undefined; expected: string }> = [
    { ua: null, expected: "other" },
    { ua: undefined, expected: "other" },
    { ua: "", expected: "other" },
    { ua: "Spotify/9.0.0 iOS/17.0", expected: "spotify" },
    { ua: "Overcast/2026.1 (+http://overcast.fm/; iOS podcast app)", expected: "overcast" },
    { ua: "Pocket Casts/7.0", expected: "pocketcasts" },
    { ua: "PocketCasts/7.0 Android", expected: "pocketcasts" },
    { ua: "AppleCoreMedia/1.0.0.21A329 (iPhone; U; CPU OS 17_0)", expected: "apple-podcasts" },
    { ua: "iTMS", expected: "apple-podcasts" },
    { ua: "iTunes/12.0", expected: "apple-podcasts" },
    { ua: "Googlebot/2.1 (+http://www.google.com/bot.html)", expected: "bot" },
    { ua: "Mozilla/5.0 (compatible; SemrushBot/7~bl)", expected: "bot" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", expected: "browser" },
    { ua: "curl/8.5.0", expected: "other" },
  ];

  it.each(cases)("classifies $ua as $expected", ({ ua, expected }) => {
    expect(classifyClientFamily(ua)).toBe(expected);
  });
});

const baseEvent: DeliveryEvent = {
  showId: "show-1",
  episodeMarker: "episode-1",
  objectId: "object-1",
  method: "GET",
  status: 206,
  country: "JP",
  clientFamily: "apple-podcasts",
  ranged: true,
  responseBytes: 1024,
  rangeStart: 0,
  rangeEnd: 1023,
  totalBytes: 4096,
};

describe("deliveryDataPoint", () => {
  it("produces the documented blob and double layout", () => {
    expect(deliveryDataPoint(baseEvent)).toEqual({
      indexes: ["show-1"],
      blobs: ["show-1", "episode-1", "object-1", "GET", "206", "JP", "apple-podcasts", "1"],
      doubles: [1024, 0, 1023, 4096],
    });
  });

  it("marks absent range bounds with -1 and unranged with 0", () => {
    const point = deliveryDataPoint({
      ...baseEvent,
      episodeMarker: ARTWORK_MARKER,
      status: 200,
      ranged: false,
      rangeStart: null,
      rangeEnd: null,
      responseBytes: 4096,
    });
    expect(point.blobs).toEqual([
      "show-1",
      ARTWORK_MARKER,
      "object-1",
      "GET",
      "200",
      "JP",
      "apple-podcasts",
      "0",
    ]);
    expect(point.doubles).toEqual([4096, -1, -1, 4096]);
  });
});

describe("writeDeliveryEvent", () => {
  it("writes one data point to the dataset", () => {
    const writeDataPoint = vi.fn();
    writeDeliveryEvent({ writeDataPoint }, baseEvent);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith(deliveryDataPoint(baseEvent));
  });

  it("tolerates a missing dataset binding", () => {
    expect(() => {
      writeDeliveryEvent(undefined, baseEvent);
    }).not.toThrow();
  });

  it("swallows write failures", () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error("dataset unavailable");
    });
    expect(() => {
      writeDeliveryEvent({ writeDataPoint }, baseEvent);
    }).not.toThrow();
  });
});
