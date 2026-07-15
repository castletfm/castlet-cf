/**
 * File-upload widgets for show artwork and episode audio (mvp-design.md
 * sections 11.1–11.5). Both run the browser direct-upload flow with XHR
 * progress and repeat the server-enforced rules client-side for fast feedback.
 */

import { useCallback, useReducer, useRef, useState, type ReactNode } from "react";

import { MAX_ARTWORK_BYTES, MAX_AUDIO_BYTES } from "../../shared/constants";
import type { EpisodeResource, StorageObjectResource } from "../../shared/contracts";
import { ApiError, completeUpload, initiateUpload } from "../api";
import { readAudioDuration } from "../lib/audio";
import { formatBytes } from "../lib/format";
import { checkArtworkDimensions, readImageDimensions } from "../lib/image";
import {
  initialUploadState,
  runUpload,
  uploadProgressFraction,
  uploadReducer,
  type RunUploadArgs,
} from "../lib/upload";
import { Banner } from "./ui";

type StartUploadArgs = Omit<RunUploadArgs, "onEvent" | "signal">;

function useFileUpload() {
  const [state, dispatch] = useReducer(uploadReducer, initialUploadState);
  const controllerRef = useRef<AbortController | null>(null);

  const start = useCallback(async (args: StartUploadArgs) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    return await runUpload({ ...args, onEvent: dispatch, signal: controller.signal });
  }, []);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, start, cancel, reset };
}

function UploadProgress({ fraction, active }: { fraction: number; active: boolean }) {
  const pct = Math.round(fraction * 100);
  return (
    <div className="upload-progress">
      <div
        className="meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Upload progress"
      >
        <span className="meter-fill meter-active" style={{ width: `${pct}%` }} />
      </div>
      <span className="muted" aria-live="polite">
        {active ? `${pct}%` : `${pct}% — done`}
      </span>
    </div>
  );
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Upload failed.";
}

function artworkContentType(file: File): "image/jpeg" | "image/png" | null {
  if (file.type === "image/jpeg" || file.type === "image/png") return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  return null;
}

function audioContentType(file: File): "audio/mpeg" | "audio/mp4" | null {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return null;
}

export function ArtworkUploader({
  showId,
  onUploaded,
}: {
  showId: string;
  onUploaded: (object: StorageObjectResource) => void;
}) {
  const { state, start, reset } = useFileUpload();
  const [file, setFile] = useState<File | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active =
    state.phase === "initiating" || state.phase === "uploading" || state.phase === "completing";

  async function onSelect(selected: File | null) {
    reset();
    setError(null);
    setDims(null);
    setFile(null);
    if (selected === null) return;

    const contentType = artworkContentType(selected);
    if (contentType === null) {
      setError("Artwork must be a .jpg or .png file.");
      return;
    }
    if (selected.size > MAX_ARTWORK_BYTES) {
      setError(`Artwork must be at most ${formatBytes(MAX_ARTWORK_BYTES)}.`);
      return;
    }
    try {
      const measured = await readImageDimensions(selected);
      const check = checkArtworkDimensions(measured.width, measured.height);
      if (!check.ok) {
        setError(check.reason);
        return;
      }
      setDims(measured);
      setFile(selected);
    } catch {
      setError("Could not read the selected image.");
    }
  }

  async function upload() {
    if (file === null || dims === null) return;
    const contentType = artworkContentType(file);
    if (contentType === null) return;
    setError(null);
    try {
      const object = await start({
        file,
        initiate: () =>
          initiateUpload({
            ownerKind: "show",
            ownerId: showId,
            kind: "artwork",
            filename: file.name,
            contentType,
            size: file.size,
          }),
        complete: (uploadId) =>
          completeUpload(uploadId, { imageWidth: dims.width, imageHeight: dims.height }),
      });
      onUploaded(object);
      setFile(null);
      setDims(null);
      reset();
    } catch (err: unknown) {
      setError(apiMessage(err));
    }
  }

  return (
    <div className="uploader">
      <input
        type="file"
        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
        aria-label="Choose artwork file"
        disabled={active}
        onChange={(e) => void onSelect(e.target.files?.[0] ?? null)}
      />
      {file !== null && dims !== null && (
        <p className="muted">
          {file.name} — {dims.width}×{dims.height}, {formatBytes(file.size)}
        </p>
      )}
      {error !== null && <Banner variant="error">{error}</Banner>}
      {active || state.phase === "done" ? (
        <UploadProgress fraction={uploadProgressFraction(state)} active={active} />
      ) : (
        <button
          type="button"
          className="btn-primary"
          disabled={file === null}
          onClick={() => void upload()}
        >
          Upload artwork
        </button>
      )}
    </div>
  );
}

export function AudioUploader({
  episode,
  onUploaded,
}: {
  episode: EpisodeResource;
  onUploaded: (object: StorageObjectResource) => void;
}) {
  const { state, start, reset } = useFileUpload();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active =
    state.phase === "initiating" || state.phase === "uploading" || state.phase === "completing";

  const replacingPublished = episode.status === "published" && episode.audioObjectId !== null;

  function onSelect(selected: File | null) {
    reset();
    setError(null);
    setFile(null);
    if (selected === null) return;
    if (audioContentType(selected) === null) {
      setError("Audio must be a .mp3 or .m4a file.");
      return;
    }
    if (selected.size > MAX_AUDIO_BYTES) {
      setError(`Audio must be at most ${formatBytes(MAX_AUDIO_BYTES)}.`);
      return;
    }
    setFile(selected);
  }

  async function upload() {
    if (file === null) return;
    const contentType = audioContentType(file);
    if (contentType === null) return;
    setError(null);
    try {
      const duration = await readAudioDuration(file);
      const object = await start({
        file,
        initiate: () =>
          initiateUpload({
            ownerKind: "episode",
            ownerId: episode.id,
            kind: "audio",
            filename: file.name,
            contentType,
            size: file.size,
          }),
        complete: (uploadId) =>
          completeUpload(uploadId, duration === null ? {} : { durationSeconds: duration }),
      });
      onUploaded(object);
      setFile(null);
      reset();
    } catch (err: unknown) {
      setError(apiMessage(err));
    }
  }

  return (
    <div className="uploader">
      {replacingPublished && (
        <Banner variant="warning" title="Replacing published audio">
          Uploading new audio changes the public enclosure URL for this episode. The episode GUID is
          preserved, so existing subscribers keep the same item but will re-download from the new
          URL.
        </Banner>
      )}
      <input
        type="file"
        accept="audio/mpeg,audio/mp4,.mp3,.m4a"
        aria-label="Choose audio file"
        disabled={active}
        onChange={(e) => onSelect(e.target.files?.[0] ?? null)}
      />
      {file !== null && (
        <p className="muted">
          {file.name} — {formatBytes(file.size)}
        </p>
      )}
      {error !== null && <Banner variant="error">{error}</Banner>}
      {active || state.phase === "done" ? (
        <UploadProgress fraction={uploadProgressFraction(state)} active={active} />
      ) : (
        <button
          type="button"
          className="btn-primary"
          disabled={file === null}
          onClick={() => void upload()}
        >
          Upload audio
        </button>
      )}
    </div>
  );
}

/**
 * Render show artwork by public path. The stored extension is not on the show
 * resource, so try .jpg and fall back to .png on load error.
 */
export function ArtworkPreview({
  showId,
  objectId,
}: {
  showId: string;
  objectId: string;
}): ReactNode {
  const [ext, setExt] = useState<"jpg" | "png">("jpg");
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <p className="muted">Artwork set (object {objectId.slice(0, 8)}…).</p>;
  }
  return (
    <img
      className="artwork-preview"
      src={`/artwork/${showId}/${objectId}.${ext}`}
      alt="Show artwork"
      width={160}
      height={160}
      onError={() => (ext === "jpg" ? setExt("png") : setFailed(true))}
    />
  );
}
