/**
 * Browser direct-upload flow.
 *
 * The upload runs in three server-visible steps: initiate (reserve quota and
 * get a presigned PUT), PUT the bytes straight to R2 with progress, then
 * complete (verify and activate). Progress requires XMLHttpRequest because
 * fetch() upload progress is not consistently available (section 11.4).
 *
 * `uploadReducer` is a pure state machine describing that flow and is the
 * unit-tested core; `putToR2` and `runUpload` are the browser-only glue.
 */

import type { StorageObjectResource, UploadInitiateResponse } from "../../shared/contracts";

export type UploadPhase = "idle" | "initiating" | "uploading" | "completing" | "done" | "error";

export interface UploadState {
  phase: UploadPhase;
  /** Bytes transferred to R2 so far. */
  loaded: number;
  /** Total bytes to transfer, known once the upload is initiated. */
  total: number;
  /** Failure message when phase is "error", otherwise null. */
  error: string | null;
}

export const initialUploadState: UploadState = {
  phase: "idle",
  loaded: 0,
  total: 0,
  error: null,
};

export type UploadEvent =
  | { type: "start" }
  | { type: "initiated"; total: number }
  | { type: "progress"; loaded: number; total: number }
  | { type: "putDone" }
  | { type: "completed" }
  | { type: "failed"; message: string }
  | { type: "reset" };

const ACTIVE_PHASES: ReadonlySet<UploadPhase> = new Set<UploadPhase>([
  "initiating",
  "uploading",
  "completing",
]);

/** Whether the machine is mid-flight (a start event should be ignored). */
export function isUploadActive(state: UploadState): boolean {
  return ACTIVE_PHASES.has(state.phase);
}

/**
 * Pure transition for the upload state machine. Unknown transitions are
 * ignored (the state is returned unchanged) except "failed" and "reset",
 * which are always honored so a stuck upload can surface an error or restart.
 */
export function uploadReducer(state: UploadState, event: UploadEvent): UploadState {
  switch (event.type) {
    case "start":
      if (isUploadActive(state)) {
        return state;
      }
      return { phase: "initiating", loaded: 0, total: 0, error: null };
    case "initiated":
      if (state.phase !== "initiating") {
        return state;
      }
      return { phase: "uploading", loaded: 0, total: Math.max(0, event.total), error: null };
    case "progress": {
      if (state.phase !== "uploading") {
        return state;
      }
      const total = Math.max(0, event.total);
      const loaded = Math.min(Math.max(0, event.loaded), total);
      return { ...state, loaded, total };
    }
    case "putDone":
      if (state.phase !== "uploading") {
        return state;
      }
      return { ...state, phase: "completing", loaded: state.total };
    case "completed":
      if (state.phase !== "completing") {
        return state;
      }
      return { ...state, phase: "done", loaded: state.total };
    case "failed":
      return { ...state, phase: "error", error: event.message };
    case "reset":
      return initialUploadState;
    default:
      return state;
  }
}

/** Progress as a fraction in [0, 1]; 1 once the upload is done. */
export function uploadProgressFraction(state: UploadState): number {
  if (state.phase === "done") {
    return 1;
  }
  if (state.total <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, state.loaded / state.total));
}

export interface PutToR2Options {
  url: string;
  /** Signed headers to send verbatim; must include the exact Content-Type. */
  headers: Record<string, string>;
  body: Blob;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * PUT a file's bytes directly to the presigned R2 URL. Sends only the signed
 * headers and never cookies or application auth headers (section 11.4).
 * Browser-only.
 */
export function putToR2(options: PutToR2Options): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", options.url);
    // Cross-origin request to R2: never attach our session/CSRF cookies.
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(options.headers)) {
      xhr.setRequestHeader(name, value);
    }

    const onAbort = () => xhr.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("Upload aborted", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);

    if (options.onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          options.onProgress?.(event.loaded, event.total);
        }
      };
    }
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`R2 upload failed with status ${xhr.status}.`));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("R2 upload failed. Check your connection and try again."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload aborted", "AbortError"));
    };
    xhr.send(options.body);
  });
}

export interface RunUploadArgs {
  file: File;
  /** Reserve quota and obtain the presigned PUT (POST /api/uploads). */
  initiate: () => Promise<UploadInitiateResponse>;
  /** Verify and activate the object (POST /api/uploads/{id}/complete). */
  complete: (uploadId: string) => Promise<StorageObjectResource>;
  /** Receives every state-machine event so the caller can drive a reducer. */
  onEvent: (event: UploadEvent) => void;
  signal?: AbortSignal;
}

/**
 * Orchestrate initiate → PUT → complete, emitting events for a `uploadReducer`
 * consumer. Rejects (after emitting a "failed" event) on any step failure so
 * the caller can also surface the thrown error. Browser-only.
 */
export async function runUpload(args: RunUploadArgs): Promise<StorageObjectResource> {
  args.onEvent({ type: "start" });
  try {
    const init = await args.initiate();
    args.onEvent({ type: "initiated", total: args.file.size });
    await putToR2({
      url: init.putUrl,
      headers: init.headers,
      body: args.file,
      signal: args.signal,
      onProgress: (loaded, total) => args.onEvent({ type: "progress", loaded, total }),
    });
    args.onEvent({ type: "putDone" });
    const object = await args.complete(init.uploadId);
    args.onEvent({ type: "completed" });
    return object;
  } catch (error: unknown) {
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? "Upload canceled."
        : error instanceof Error
          ? error.message
          : "Upload failed.";
    args.onEvent({ type: "failed", message });
    throw error;
  }
}
