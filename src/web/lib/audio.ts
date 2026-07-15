/**
 * Client-side audio duration probe (mvp-design.md sections 11.2–11.5).
 *
 * `readAudioDuration` is a best-effort, ADVISORY read: the Worker re-derives the
 * duration when the upload completes, so this value never gates the upload. The
 * probe is bounded and fails safe — a malformed, truncated, or undecodable file
 * that makes the detached <audio> element fire neither `loadedmetadata` nor
 * `error` would otherwise leave the promise pending forever and hang the upload.
 * A timeout resolves `null` (duration unknown) so the upload always proceeds.
 *
 * The DOM dependencies are injected so the probe is unit-testable in a plain
 * Node environment (no jsdom); the component passes no deps and gets the real
 * browser implementations.
 */

/**
 * Maximum time to wait for the detached <audio> element to report metadata
 * before giving up. Reading only container metadata from a local blob is fast,
 * so a few seconds is generous; the bound exists solely to guarantee the probe
 * never hangs on a file that fires neither event.
 */
export const AUDIO_DURATION_PROBE_TIMEOUT_MS = 5000;

/**
 * Minimal subset of HTMLAudioElement the probe drives; keeps it testable. The
 * handler signature takes an `Event` so a real `HTMLAudioElement` is structurally
 * assignable to it.
 */
export interface AudioProbeElement {
  preload: string;
  src: string;
  duration: number;
  onloadedmetadata: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  load(): void;
}

/** Injectable DOM seams; defaults use the real browser APIs. */
export interface AudioProbeDeps {
  createElement: () => AudioProbeElement;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  timeoutMs?: number;
}

function defaultDeps(): AudioProbeDeps {
  return {
    createElement: () => document.createElement("audio"),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

/**
 * Best-effort audio duration read (seconds, rounded) via a detached <audio>
 * element. Resolves `null` when the duration cannot be determined — on decode
 * error, a non-finite reported duration, or the bounded timeout — so the caller
 * can upload without a duration rather than hang. Never rejects.
 */
export function readAudioDuration(
  file: Blob,
  deps: AudioProbeDeps = defaultDeps(),
): Promise<number | null> {
  const timeoutMs = deps.timeoutMs ?? AUDIO_DURATION_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const url = deps.createObjectURL(file);
    const audio = deps.createElement();
    let settled = false;

    const finish = (seconds: number | null) => {
      // Every terminal path funnels through here so the object URL is revoked
      // exactly once and the pending fetch/decode is aborted.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      // Blank src + load() aborts the in-flight metadata fetch/decode.
      audio.src = "";
      audio.load();
      deps.revokeObjectURL(url);
      resolve(seconds);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    audio.onloadedmetadata = () => {
      finish(Number.isFinite(audio.duration) ? Math.round(audio.duration) : null);
    };
    audio.onerror = () => finish(null);
    audio.preload = "metadata";
    audio.src = url;
    audio.load();
  });
}
