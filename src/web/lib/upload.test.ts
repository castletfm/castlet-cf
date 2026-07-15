import { describe, expect, it } from "vitest";

import {
  initialUploadState,
  isUploadActive,
  uploadProgressFraction,
  uploadReducer,
  type UploadEvent,
  type UploadState,
} from "./upload";

/** Fold a sequence of events over the reducer starting from idle. */
function run(events: UploadEvent[], from: UploadState = initialUploadState): UploadState {
  return events.reduce(uploadReducer, from);
}

describe("uploadReducer", () => {
  it("walks the happy path idle -> done", () => {
    const state = run([
      { type: "start" },
      { type: "initiated", total: 1000 },
      { type: "progress", loaded: 500, total: 1000 },
      { type: "putDone" },
      { type: "completed" },
    ]);
    expect(state.phase).toBe("done");
    expect(uploadProgressFraction(state)).toBe(1);
  });

  it("sets total on initiate and reports progress fractions", () => {
    const state = run([
      { type: "start" },
      { type: "initiated", total: 2000 },
      { type: "progress", loaded: 500, total: 2000 },
    ]);
    expect(state.phase).toBe("uploading");
    expect(uploadProgressFraction(state)).toBe(0.25);
  });

  it("clamps progress to the total and never goes negative", () => {
    const over = run([
      { type: "start" },
      { type: "initiated", total: 1000 },
      { type: "progress", loaded: 5000, total: 1000 },
    ]);
    expect(over.loaded).toBe(1000);
    expect(uploadProgressFraction(over)).toBe(1);

    const under = uploadReducer(over, { type: "progress", loaded: -50, total: 1000 });
    expect(under.loaded).toBe(0);
  });

  it("ignores progress that arrives outside the uploading phase", () => {
    const initiating = run([{ type: "start" }]);
    expect(uploadReducer(initiating, { type: "progress", loaded: 10, total: 100 })).toBe(
      initiating,
    );
  });

  it("ignores a second start while an upload is active", () => {
    const active = run([{ type: "start" }, { type: "initiated", total: 100 }]);
    expect(isUploadActive(active)).toBe(true);
    expect(uploadReducer(active, { type: "start" })).toBe(active);
  });

  it("allows a start after an error or after done", () => {
    const errored = run([{ type: "start" }, { type: "failed", message: "boom" }]);
    expect(errored.phase).toBe("error");
    expect(uploadReducer(errored, { type: "start" }).phase).toBe("initiating");

    const done = run([
      { type: "start" },
      { type: "initiated", total: 10 },
      { type: "putDone" },
      { type: "completed" },
    ]);
    expect(uploadReducer(done, { type: "start" }).phase).toBe("initiating");
  });

  it("honors failed from any phase and records the message", () => {
    const state = run([
      { type: "start" },
      { type: "initiated", total: 100 },
      { type: "failed", message: "network down" },
    ]);
    expect(state.phase).toBe("error");
    expect(state.error).toBe("network down");
  });

  it("resets to the initial state", () => {
    const state = run([{ type: "start" }, { type: "initiated", total: 100 }]);
    expect(uploadReducer(state, { type: "reset" })).toEqual(initialUploadState);
  });

  it("does not skip phases: putDone before uploading is ignored", () => {
    const initiating = run([{ type: "start" }]);
    expect(uploadReducer(initiating, { type: "putDone" })).toBe(initiating);
    const idle = initialUploadState;
    expect(uploadReducer(idle, { type: "completed" })).toBe(idle);
  });
});

describe("uploadProgressFraction", () => {
  it("is 0 before a total is known", () => {
    expect(uploadProgressFraction(initialUploadState)).toBe(0);
  });
});
