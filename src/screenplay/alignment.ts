/**
 * Cross-language dialogue alignment.
 *
 * Subtitle tracks are not parallel corpora. An English track may split one
 * spoken sentence across two cues where the Korean track uses one, and the two
 * tracks routinely disagree on cue boundaries by several hundred milliseconds.
 *
 * So alignment is *interval-based and many-to-many*: overlapping cues form a
 * group, and a group renders as one dual-language unit. Assuming index-to-index
 * correspondence would silently pair line 12 with line 13's translation.
 */

import { overlapDuration, rangesOverlap, type MediaTimeMs, type TimeRange } from '../utils/time';

export interface TimedText extends TimeRange {
  text: string;
  language: string;
  /** Optional speaker, used to break ties when intervals are ambiguous. */
  speakerId?: string;
}

export interface AlignmentGroup {
  start: MediaTimeMs;
  end: MediaTimeMs;
  primary: TimedText[];
  secondary: TimedText[];
  /** Overlap ratio in [0,1]; low values mean a weak pairing. */
  strength: number;
}

export interface AlignmentOptions {
  /** Minimum overlap (as a fraction of the shorter cue) to pair two cues. */
  minOverlapRatio?: number;
  /** Cues this far apart are never paired even if intervals touch. */
  maxDriftMs?: number;
}

const ALIGN_DEFAULTS: Required<AlignmentOptions> = {
  minOverlapRatio: 0.25,
  maxDriftMs: 2_500,
};

/**
 * Groups two tracks into aligned units.
 *
 * Unmatched cues on either side still produce a group — a line present in one
 * language and missing from the other is information, not an error, and the
 * dual view shows the gap rather than hiding the line.
 */
export function alignCueTracks(
  primary: readonly TimedText[],
  secondary: readonly TimedText[],
  options: AlignmentOptions = {},
): AlignmentGroup[] {
  const opts = { ...ALIGN_DEFAULTS, ...options };
  const a = [...primary].sort((x, y) => x.start - y.start);
  const b = [...secondary].sort((x, y) => x.start - y.start);

  const groups: AlignmentGroup[] = [];
  const matchedB = new Set<number>();
  let bCursor = 0;

  for (const cue of a) {
    // Advance past secondary cues that ended before this one started.
    while (bCursor < b.length && b[bCursor]!.end < cue.start - opts.maxDriftMs) bCursor++;

    const matches: { index: number; cue: TimedText; overlap: number }[] = [];
    for (let i = bCursor; i < b.length; i++) {
      const candidate = b[i]!;
      if (candidate.start > cue.end + opts.maxDriftMs) break;
      if (!rangesOverlap(cue, candidate)) continue;

      const overlap = overlapDuration(cue, candidate);
      const shorter = Math.min(cue.end - cue.start, candidate.end - candidate.start);
      if (shorter <= 0) continue;
      const ratio = overlap / shorter;
      if (ratio >= opts.minOverlapRatio) matches.push({ index: i, cue: candidate, overlap: ratio });
    }

    // A secondary cue is deliberately NOT consumed by the first primary cue
    // that matches it. In a many-to-one split — two English cues over one
    // Korean cue — consuming it would leave the second English cue unpaired.
    // Instead both groups reference the same cue and `mergeAdjacentGroups`
    // folds them into one unit, so the Korean line is printed exactly once.
    for (const match of matches) matchedB.add(match.index);

    const start = Math.min(cue.start, ...matches.map((m) => m.cue.start));
    const end = Math.max(cue.end, ...matches.map((m) => m.cue.end));
    groups.push({
      start,
      end,
      primary: [cue],
      secondary: matches.map((m) => m.cue),
      strength: matches.length > 0 ? Math.max(...matches.map((m) => m.overlap)) : 0,
    });
  }

  // Secondary cues with no primary counterpart: keep them, marked as unmatched.
  b.forEach((cue, index) => {
    if (matchedB.has(index)) return;
    groups.push({ start: cue.start, end: cue.end, primary: [], secondary: [cue], strength: 0 });
  });

  return mergeAdjacentGroups(groups.sort((x, y) => x.start - y.start));
}

/**
 * Merges groups that share a secondary cue.
 *
 * This is the many-to-one case: two English cues both overlapping one Korean
 * cue must become a single unit, or the Korean line would be printed twice.
 */
function mergeAdjacentGroups(groups: readonly AlignmentGroup[]): AlignmentGroup[] {
  const out: AlignmentGroup[] = [];

  for (const group of groups) {
    const previous = out[out.length - 1];
    const sharesSecondary =
      previous &&
      group.secondary.length > 0 &&
      previous.secondary.some((s) => group.secondary.includes(s));

    if (previous && sharesSecondary) {
      previous.end = Math.max(previous.end, group.end);
      previous.primary.push(...group.primary);
      for (const cue of group.secondary) {
        if (!previous.secondary.includes(cue)) previous.secondary.push(cue);
      }
      previous.strength = Math.max(previous.strength, group.strength);
    } else {
      out.push({ ...group, primary: [...group.primary], secondary: [...group.secondary] });
    }
  }
  return out;
}

/** Renders an aligned group as the dual-language pair the UI displays. */
export function groupToDualText(group: AlignmentGroup): { primary: string; secondary?: string } {
  const primary = group.primary.map((c) => c.text).join(' ');
  const secondary = group.secondary.map((c) => c.text).join(' ');
  return secondary ? { primary, secondary } : { primary };
}
