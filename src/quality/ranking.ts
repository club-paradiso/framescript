/**
 * Quality ranking and selection.
 *
 * Selection is a pure function of (options, preference). Keeping it pure is
 * what makes "did FrameScript pick the right thing?" a unit test rather than a
 * manual YouTube session.
 */

import type { QualityApplyResult, QualityPreference, VideoQualityOption } from './types';

/**
 * Orders options best-first.
 *
 * Resolution dominates; within a resolution, enhanced bitrate beats standard,
 * then HDR, then higher frame rate. Options with no parseable resolution sort
 * last because we cannot claim they are better than something we can measure.
 */
export function compareQuality(a: VideoQualityOption, b: VideoQualityOption): number {
  const ar = a.resolution ?? -1;
  const br = b.resolution ?? -1;
  if (ar !== br) return br - ar;

  if (a.enhancedBitrate !== b.enhancedBitrate) return a.enhancedBitrate ? -1 : 1;
  if (Boolean(a.hdr) !== Boolean(b.hdr)) return a.hdr ? -1 : 1;

  const af = a.frameRate ?? 0;
  const bf = b.frameRate ?? 0;
  if (af !== bf) return bf - af;

  return a.label.localeCompare(b.label);
}

/** Fixed-tier, selectable options sorted best-first. Auto entries excluded. */
export function rankQualityOptions(options: readonly VideoQualityOption[]): VideoQualityOption[] {
  return options.filter((o) => o.selectable && !o.auto).sort(compareQuality);
}

export interface QualitySelection {
  option?: VideoQualityOption;
  /**
   * Why the selection is not simply "the user's ceiling".
   * - `availability`: the ceiling exists as a concept but the video has nothing that high
   * - `preference`: the user asked for a ceiling below what was available
   * - `entitlement`: a higher tier was listed but the player marked it unselectable
   */
  limitedBy?: QualityApplyResult['limitedBy'];
}

/**
 * Chooses the highest-ranked option at or below the preference ceiling.
 *
 * Never returns an unselectable option, and never invents one: if the ceiling
 * is 2160 and the video maxes out at 1440, the answer is 1440 with
 * `limitedBy: 'availability'`.
 */
export function selectQualityOption(
  options: readonly VideoQualityOption[],
  preference: QualityPreference,
): QualitySelection {
  if (preference.id === 'platform-auto') {
    const auto = options.find((o) => o.auto && o.selectable);
    return auto ? { option: auto } : {};
  }

  const ranked = rankQualityOptions(options);
  if (ranked.length === 0) return {};

  const ceiling = preference.maxResolution;
  const eligible =
    ceiling === undefined
      ? ranked
      : ranked.filter((o) => o.resolution !== undefined && o.resolution <= ceiling);

  // Nothing at or below the ceiling: every option is higher-res than requested.
  // Take the lowest available rather than overshooting the user's explicit cap.
  if (eligible.length === 0) {
    const lowest = ranked[ranked.length - 1]!;
    return { option: lowest, limitedBy: 'availability' };
  }

  const best = pickWithBitratePreference(eligible, preference);

  // Was something better listed but refused by the player?
  const blockedBetter = options.some(
    (o) =>
      !o.selectable &&
      !o.auto &&
      o.resolution !== undefined &&
      (best.resolution === undefined || o.resolution > best.resolution) &&
      (ceiling === undefined || o.resolution <= ceiling),
  );
  if (blockedBetter) return { option: best, limitedBy: 'entitlement' };

  if (ceiling !== undefined) {
    const higherExists = ranked.some(
      (o) => o.resolution !== undefined && o.resolution > ceiling,
    );
    if (higherExists) return { option: best, limitedBy: 'preference' };
    const bestPossible = ranked[0]!;
    if (
      bestPossible.resolution !== undefined &&
      best.resolution !== undefined &&
      bestPossible.resolution < ceiling
    ) {
      return { option: best, limitedBy: 'availability' };
    }
  }

  return { option: best };
}

/**
 * Within the top resolution tier, honour the enhanced-bitrate preference.
 *
 * When the user has turned enhanced bitrate off we pick the standard variant of
 * the same resolution if one exists — we do not drop a tier to avoid it.
 */
function pickWithBitratePreference(
  eligible: readonly VideoQualityOption[],
  preference: QualityPreference,
): VideoQualityOption {
  const best = eligible[0]!;
  if (preference.preferEnhancedBitrate) return best;

  const topResolution = best.resolution;
  const standard = eligible.find(
    (o) => o.resolution === topResolution && !o.enhancedBitrate,
  );
  return standard ?? best;
}

/**
 * Did the player end up where we asked?
 *
 * Verification is deliberately lenient about labels and strict about tiers: a
 * player that reports "1080p60" when we requested "1080p60 Premium" has *not*
 * honoured an enhanced-bitrate request, and we say so instead of claiming success.
 */
export function verifyApplied(
  requested: VideoQualityOption,
  observed: VideoQualityOption | undefined,
): { verified: boolean; message?: string } {
  if (!observed) return { verified: false, message: 'Player did not report an active quality.' };
  if (observed.id === requested.id) return { verified: true };
  if (
    observed.resolution !== undefined &&
    observed.resolution === requested.resolution &&
    observed.enhancedBitrate === requested.enhancedBitrate
  ) {
    return { verified: true };
  }
  return {
    verified: false,
    message: `Player reports "${observed.label}" after requesting "${requested.label}".`,
  };
}

/** Short human summary for the popup, e.g. `2160p60 HDR`. */
export function describeQuality(option: VideoQualityOption | undefined): string {
  if (!option) return 'Unknown';
  if (option.auto) return 'Platform auto';
  const parts: string[] = [];
  parts.push(option.resolution ? `${option.resolution}p` : option.label);
  if (option.frameRate && option.frameRate > 30) parts[0] = `${parts[0]}${option.frameRate}`;
  if (option.hdr) parts.push('HDR');
  if (option.enhancedBitrate) parts.push('Enhanced bitrate');
  return parts.join(' ');
}
