/** Save the fly-in as a video file, without a server.
 *
 * `captureStream` turns the same canvas the animation already paints into a
 * live video track, and MediaRecorder encodes it in the browser. Nothing is
 * uploaded, nothing is transcoded remotely, and the watermark is already
 * part of every frame because animate() draws it there — so the recording
 * is signed by construction rather than composited afterwards.
 *
 * Frames are pulled manually (`captureStream(0)` + `requestFrame`) so the
 * recording contains exactly the frames that were painted, in order, even
 * if the tab drops below 60 fps mid-render. Browsers that don't implement
 * manual capture fall back to a rate-driven stream. */

/** Ordered by preference: VP9 for size, VP8 for reach, then whatever the
 * browser will admit to supporting. */
const CANDIDATES: { mimeType: string; extension: string }[] = [
  { mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
  { mimeType: 'video/mp4;codecs=avc1', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
];

export interface Recording {
  blob: Blob;
  extension: string;
}

export interface Recorder {
  /** Call once per painted frame. */
  frame: () => void;
  /** Stop encoding and resolve with the finished file. */
  stop: () => Promise<Recording>;
}

function pickFormat(): { mimeType: string; extension: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? null;
}

/** Whether this browser can record at all — used to hide the button rather
 * than let it fail after the visitor has waited through a render. */
export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function' &&
    pickFormat() !== null
  );
}

export function startRecording(canvas: HTMLCanvasElement, fps = 60): Recorder | null {
  const format = pickFormat();
  if (!format || typeof canvas.captureStream !== 'function') return null;

  // A zero-fps stream only emits frames we ask for. If the browser doesn't
  // support that, fall back to letting it sample at `fps`.
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  const manual = typeof track?.requestFrame === 'function';
  if (!manual) {
    stream.getTracks().forEach((t) => t.stop());
    stream = canvas.captureStream(fps);
    track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  }

  // ~0.14 bits per pixel per frame, floored so small mosaics still look
  // clean and capped so a 96-tile-wide render doesn't produce a huge file.
  const pixels = canvas.width * canvas.height;
  const bitrate = Math.min(24_000_000, Math.max(3_000_000, Math.round(pixels * fps * 0.14)));

  const recorder = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: bitrate,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.start();

  return {
    frame() {
      if (manual && recorder.state === 'recording') track?.requestFrame();
    },
    stop() {
      return new Promise<Recording>((resolve, reject) => {
        if (recorder.state === 'inactive') {
          reject(new Error('Recording already stopped'));
          return;
        }
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve({ blob: new Blob(chunks, { type: format.mimeType }), extension: format.extension });
        };
        recorder.onerror = () => {
          stream.getTracks().forEach((t) => t.stop());
          reject(new Error('The browser stopped encoding partway through.'));
        };
        recorder.stop();
      });
    },
  };
}

/** Hand a blob to the visitor as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke late: Safari reads the URL after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
