const SHORT_MEDIA_MS = 5 * 60_000;
const MAX_CAPTURE_WINDOWS = 72;

export interface SceneWindowCandidate {
  start: number;
  end: number;
  importance: number;
}

/**
 * Capture more candidate windows than we intend to send remotely.
 *
 * The old pipeline used the remote request budget as the capture budget too,
 * which meant a 12-request run could stop retaining semantic candidates early
 * in the file and leave the rest of the timeline with no chance of being
 * described. For short media we keep a denser local candidate pool, then make
 * the actual network selection later. The hard cap keeps mobile memory bounded.
 */
export function preferredSceneCaptureBudget(requestBudget: number, durationMs: number): number {
  if (!Number.isFinite(requestBudget) || requestBudget <= 0) return 0;

  const boundedRequestBudget = Math.max(1, Math.floor(requestBudget));
  const durationTarget =
    Number.isFinite(durationMs) && durationMs > 0
      ? Math.ceil(durationMs / (durationMs <= SHORT_MEDIA_MS ? 3_000 : 15_000))
      : boundedRequestBudget * 3;

  return Math.min(
    MAX_CAPTURE_WINDOWS,
    Math.max(boundedRequestBudget, boundedRequestBudget * 3, durationTarget),
  );
}

/**
 * Selects remote vision requests with temporal coverage first and salience
 * second.
 *
 * Each equal-width time bucket contributes its most important candidate when it
 * has one. Any remaining budget is filled by global importance. This prevents a
 * cluster of high-motion moments near the beginning of a file from starving the
 * middle or end of semantic analysis while still spending spare requests on the
 * locally strongest observations.
 */
export function selectSceneWindowsForAnalysis<T extends SceneWindowCandidate>(
  windows: readonly T[],
  requestBudget: number,
): T[] {
  const budget = Math.max(0, Math.floor(requestBudget));
  if (budget === 0 || windows.length === 0) return [];

  const sorted = [...windows].sort((a, b) => a.start - b.start || b.importance - a.importance);
  if (sorted.length <= budget) return sorted;

  const timelineStart = sorted[0]!.start;
  const timelineEnd = Math.max(...sorted.map((window) => Math.max(window.end, window.start)));
  const span = Math.max(1, timelineEnd - timelineStart);
  const selected = new Set<T>();

  for (let bucket = 0; bucket < budget; bucket++) {
    const bucketStart = timelineStart + (span * bucket) / budget;
    const bucketEnd = timelineStart + (span * (bucket + 1)) / budget;

    const candidates = sorted.filter((window) => {
      const midpoint = (window.start + Math.max(window.start, window.end)) / 2;
      return midpoint >= bucketStart && (bucket === budget - 1 ? midpoint <= bucketEnd : midpoint < bucketEnd);
    });

    const best = candidates.sort(
      (a, b) => b.importance - a.importance || a.start - b.start,
    )[0];
    if (best) selected.add(best);
  }

  if (selected.size < budget) {
    for (const candidate of [...sorted].sort(
      (a, b) => b.importance - a.importance || a.start - b.start,
    )) {
      selected.add(candidate);
      if (selected.size >= budget) break;
    }
  }

  return [...selected].sort((a, b) => a.start - b.start);
}
