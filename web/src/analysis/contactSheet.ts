/**
 * Contact sheets: many consecutive moments packed into one image.
 *
 * A grid of tiles read left to right, top to bottom, each stamped with its
 * offset from the sheet's window start. Tiles are drawn straight into one
 * canvas, so a sheet costs a single JPEG encode however many moments it holds.
 *
 * Used by the playback scan (tiles arrive as frames are presented) and by the
 * seek-based capture of the two-pass analysis (tiles are fetched by seeking).
 */

import type { MediaTimeMs } from '@/core';
import type { CapturedFrame } from './localMediaAnalyzer';

export interface SheetGeometry {
  columns: number;
  rows: number;
  /** Width of one tile; height follows the source aspect ratio. */
  tileWidth: number;
}

const SHEET_MIME = 'image/jpeg';
const SHEET_QUALITY = 0.72;
/** Re-encode at this quality if the first pass is too large to send. */
const SHEET_FALLBACK_QUALITY = 0.55;
/** Stay under the endpoint's per-frame limit with room for base64 framing. */
export const SHEET_MAX_BYTES = 480 * 1024;

export class ContactSheetBuilder {
  readonly geometry: SheetGeometry;
  readonly windowStart: MediaTimeMs;
  #canvas = document.createElement('canvas');
  #context = this.#canvas.getContext('2d');
  #tiles: MediaTimeMs[] = [];
  #tileWidth = 0;
  #tileHeight = 0;

  constructor(geometry: SheetGeometry, windowStart: MediaTimeMs) {
    this.geometry = geometry;
    this.windowStart = windowStart;
  }

  get capacity(): number {
    return this.geometry.columns * this.geometry.rows;
  }

  get full(): boolean {
    return this.#tiles.length >= this.capacity;
  }

  get tileCount(): number {
    return this.#tiles.length;
  }

  get lastTile(): MediaTimeMs | undefined {
    return this.#tiles[this.#tiles.length - 1];
  }

  /**
   * Draws the video's current frame into the next free tile.
   *
   * Returns false when the sheet is full or the frame cannot be read back; a
   * refused readback means no later tile could be read either.
   */
  addTile(video: HTMLVideoElement, mediaTime: MediaTimeMs): boolean {
    const context = this.#context;
    if (!context || this.full) return false;

    if (this.#tiles.length === 0) {
      const { columns, rows, tileWidth } = this.geometry;
      const sourceWidth = video.videoWidth || tileWidth;
      const sourceHeight = video.videoHeight || Math.round((tileWidth * 9) / 16);
      this.#tileWidth = Math.min(tileWidth, sourceWidth);
      this.#tileHeight = Math.max(1, Math.round((this.#tileWidth / sourceWidth) * sourceHeight));
      this.#canvas.width = this.#tileWidth * columns;
      this.#canvas.height = this.#tileHeight * rows;
      context.fillStyle = '#000';
      context.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    }

    const index = this.#tiles.length;
    const x = (index % this.geometry.columns) * this.#tileWidth;
    const y = Math.floor(index / this.geometry.columns) * this.#tileHeight;
    try {
      context.drawImage(video, x, y, this.#tileWidth, this.#tileHeight);
    } catch {
      return false;
    }

    const label = `+${Math.round(mediaTime - this.windowStart)}ms`;
    context.font = 'bold 13px monospace';
    const labelWidth = context.measureText(label).width + 8;
    context.fillStyle = 'rgba(0, 0, 0, 0.75)';
    context.fillRect(x, y, labelWidth, 18);
    context.fillStyle = '#ffeb3b';
    context.fillText(label, x + 4, y + 13);
    // Separator lines keep adjacent tiles from reading as one picture.
    context.strokeStyle = '#000';
    context.lineWidth = 2;
    context.strokeRect(x, y, this.#tileWidth, this.#tileHeight);

    this.#tiles.push(mediaTime);
    return true;
  }

  /**
   * Encodes the filled tiles as one JPEG, trimming unused rows. Returns null
   * when nothing was drawn or the sheet cannot be made small enough to send.
   */
  encode(): CapturedFrame | null {
    if (this.#tiles.length === 0) return null;
    const rows = Math.ceil(this.#tiles.length / this.geometry.columns);
    const output = document.createElement('canvas');
    output.width = this.#canvas.width;
    output.height = rows * this.#tileHeight;
    const outputContext = output.getContext('2d');
    if (!outputContext) return null;
    outputContext.drawImage(this.#canvas, 0, 0);

    let url = output.toDataURL(SHEET_MIME, SHEET_QUALITY);
    if ((url.length * 3) / 4 > SHEET_MAX_BYTES) {
      url = output.toDataURL(SHEET_MIME, SHEET_FALLBACK_QUALITY);
    }
    const base64 = url.slice(url.indexOf(',') + 1);
    output.width = 0;
    output.height = 0;
    if (!base64 || (base64.length * 3) / 4 > SHEET_MAX_BYTES) return null;
    return {
      timestamp: this.windowStart,
      base64,
      mimeType: SHEET_MIME,
      width: this.#canvas.width,
      height: rows * this.#tileHeight,
      sheet: { columns: this.geometry.columns, rows, tileTimestamps: [...this.#tiles] },
    };
  }

  /** Releases the canvas pixels. */
  dispose(): void {
    this.#canvas.width = 0;
    this.#canvas.height = 0;
    this.#tiles = [];
  }
}

/**
 * Seeks the video and resolves once the new frame is presented.
 *
 * Resolves false on timeout or error rather than rejecting: one unreachable
 * moment should cost one tile, not the whole capture.
 */
export function seekTo(
  video: HTMLVideoElement,
  mediaTime: MediaTimeMs,
  signal?: AbortSignal,
  timeoutMs = 4_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const target = mediaTime / 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (ok: boolean) => {
      if (timer !== null) clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onSeeked = () => done(video.readyState >= 2);
    const onError = () => done(false);
    const onAbort = () => done(false);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);
    timer = setTimeout(() => done(false), timeoutMs);
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
      done(true);
      return;
    }
    video.currentTime = target;
  });
}

export interface SheetPlan {
  start: MediaTimeMs;
  end: MediaTimeMs;
  tileTimestamps: MediaTimeMs[];
  geometry: SheetGeometry;
}

/**
 * Captures planned sheets by seeking, without playback.
 *
 * Used after the playback scan, when the file is fully known: an overview of
 * the whole file, and dense sheets for moments the overview flagged. Each
 * entry of the result corresponds to a plan, or is null when no tile of it
 * could be read.
 */
export async function captureSheetsBySeeking(
  video: HTMLVideoElement,
  plans: readonly SheetPlan[],
  signal?: AbortSignal,
): Promise<(CapturedFrame | null)[]> {
  video.pause();
  const results: (CapturedFrame | null)[] = [];
  for (const plan of plans) {
    if (signal?.aborted) {
      results.push(null);
      continue;
    }
    const builder = new ContactSheetBuilder(plan.geometry, plan.start);
    for (const t of plan.tileTimestamps) {
      if (builder.full || signal?.aborted) break;
      if (!(await seekTo(video, t, signal))) continue;
      if (!builder.addTile(video, t)) break;
    }
    results.push(builder.encode());
    builder.dispose();
  }
  return results;
}
