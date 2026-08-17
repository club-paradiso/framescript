/**
 * Time utilities.
 *
 * FrameScript keeps every evidence timestamp in **milliseconds of media time**
 * (not wall-clock, not seconds). Media time is the only clock all sources
 * agree on: subtitles, audio windows, video frames and user seeks are all
 * anchored to the player's currentTime.
 */

/** Media time in milliseconds since the start of the video. */
export type MediaTimeMs = number;

export const secondsToMs = (s: number): MediaTimeMs => Math.round(s * 1000);
export const msToSeconds = (ms: MediaTimeMs): number => ms / 1000;

/** `1:02:03.400` style timecode used in the Evidence view and exports. */
export function formatTimecode(ms: MediaTimeMs, opts: { millis?: boolean } = {}): string {
  const negative = ms < 0;
  const total = Math.abs(Math.round(ms));
  const millis = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  let out = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  if (opts.millis) out += `.${pad(millis, 3)}`;
  return negative ? `-${out}` : out;
}

/** `00:01:02,345` SRT timestamp. */
export function formatSrtTimestamp(ms: MediaTimeMs): string {
  const total = Math.max(0, Math.round(ms));
  const millis = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(
    totalSeconds % 60,
  )},${pad(millis, 3)}`;
}

export interface TimeRange {
  start: MediaTimeMs;
  end: MediaTimeMs;
}

export const rangeDuration = (r: TimeRange): number => Math.max(0, r.end - r.start);

export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function overlapDuration(a: TimeRange, b: TimeRange): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Intersection-over-union for two intervals. Used to decide whether a subtitle
 * cue and an ASR hypothesis describe the same utterance.
 */
export function temporalIou(a: TimeRange, b: TimeRange): number {
  const inter = overlapDuration(a, b);
  if (inter <= 0) return 0;
  const union = rangeDuration(a) + rangeDuration(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Merges overlapping/adjacent ranges. `tolerance` closes small gaps so that a
 * 40 ms scheduling hiccup does not fragment analysis coverage into slivers.
 */
export function mergeRanges(ranges: readonly TimeRange[], tolerance = 0): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  let current = { ...sorted[0]! };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.start <= current.end + tolerance) {
      current.end = Math.max(current.end, next.end);
    } else {
      out.push(current);
      current = { ...next };
    }
  }
  out.push(current);
  return out;
}

/** Total covered duration of possibly-overlapping ranges. */
export function coveredDuration(ranges: readonly TimeRange[]): number {
  return mergeRanges(ranges).reduce((sum, r) => sum + rangeDuration(r), 0);
}

/** Complement of `ranges` within `[0, duration]` — the parts never observed. */
export function invertRanges(ranges: readonly TimeRange[], duration: number): TimeRange[] {
  const merged = mergeRanges(ranges).filter((r) => r.end > 0 && r.start < duration);
  const gaps: TimeRange[] = [];
  let cursor = 0;
  for (const r of merged) {
    const start = Math.max(0, r.start);
    if (start > cursor) gaps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, Math.min(duration, r.end));
  }
  if (cursor < duration) gaps.push({ start: cursor, end: duration });
  return gaps;
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;
