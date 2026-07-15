import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIO_DURATION_PROBE_TIMEOUT_MS,
  readAudioDuration,
  type AudioProbeDeps,
  type AudioProbeElement,
} from "./audio";

class FakeAudio implements AudioProbeElement {
  preload = "";
  src = "";
  duration = Number.NaN;
  onloadedmetadata: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  loadCalls = 0;
  load(): void {
    this.loadCalls += 1;
  }
  fireLoadedMetadata(): void {
    this.onloadedmetadata?.(new Event("loadedmetadata"));
  }
  fireError(): void {
    this.onerror?.(new Event("error"));
  }
}

function makeHarness() {
  const audio = new FakeAudio();
  const revoked: string[] = [];
  let created = 0;
  const deps: AudioProbeDeps = {
    createElement: () => audio,
    createObjectURL: () => `blob:mock/${(created += 1)}`,
    revokeObjectURL: (url) => revoked.push(url),
    timeoutMs: AUDIO_DURATION_PROBE_TIMEOUT_MS,
  };
  return { audio, revoked, deps };
}

describe("readAudioDuration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves null and cleans up when neither event fires (fail closed, no hang)", async () => {
    vi.useFakeTimers();
    const { audio, revoked, deps } = makeHarness();

    const promise = readAudioDuration(new Blob(["x"]), deps);
    // Simulate a malformed file: neither loadedmetadata nor error ever fires.
    await vi.advanceTimersByTimeAsync(AUDIO_DURATION_PROBE_TIMEOUT_MS);

    await expect(promise).resolves.toBeNull();
    expect(revoked).toEqual(["blob:mock/1"]);
    expect(audio.src).toBe("");
    expect(audio.loadCalls).toBeGreaterThan(0);
    // No pending timer remains; advancing further must not revoke again.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(AUDIO_DURATION_PROBE_TIMEOUT_MS);
    expect(revoked).toHaveLength(1);
  });

  it("resolves the rounded duration on loadedmetadata and clears the timer", async () => {
    vi.useFakeTimers();
    const { audio, revoked, deps } = makeHarness();

    const promise = readAudioDuration(new Blob(["x"]), deps);
    audio.duration = 123.6;
    audio.fireLoadedMetadata();

    await expect(promise).resolves.toBe(124);
    expect(revoked).toEqual(["blob:mock/1"]);
    expect(vi.getTimerCount()).toBe(0);
    // The now-cleared timeout must not fire and revoke a second time.
    await vi.advanceTimersByTimeAsync(AUDIO_DURATION_PROBE_TIMEOUT_MS);
    expect(revoked).toHaveLength(1);
  });

  it("resolves null when the reported duration is not finite", async () => {
    const { audio, revoked, deps } = makeHarness();

    const promise = readAudioDuration(new Blob(["x"]), deps);
    audio.duration = Number.POSITIVE_INFINITY;
    audio.fireLoadedMetadata();

    await expect(promise).resolves.toBeNull();
    expect(revoked).toHaveLength(1);
  });

  it("resolves null on decode error (fail safe)", async () => {
    const { audio, revoked, deps } = makeHarness();

    const promise = readAudioDuration(new Blob(["x"]), deps);
    audio.fireError();

    await expect(promise).resolves.toBeNull();
    expect(revoked).toEqual(["blob:mock/1"]);
    expect(audio.loadCalls).toBeGreaterThan(0);
  });

  it("revokes the object URL only once when events race", async () => {
    const { audio, revoked, deps } = makeHarness();

    const promise = readAudioDuration(new Blob(["x"]), deps);
    audio.duration = 10;
    audio.fireLoadedMetadata();
    // A late error after the probe already settled must be ignored.
    audio.fireError();

    await expect(promise).resolves.toBe(10);
    expect(revoked).toHaveLength(1);
  });
});
