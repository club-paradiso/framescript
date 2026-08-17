/**
 * Quality label parsing.
 *
 * Player menus are localized and inconsistent: "2160p60 HDR", "1080p Premium",
 * "4K", "Auto (720p)", "高画質", "自動". Everything downstream ranks structured
 * data, so all the string ugliness is confined to this file.
 */

import type { VideoQualityOption } from './types';

/** Marketing names that do not contain a "<n>p" token. */
const NAMED_RESOLUTIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b8k\b/i, 4320],
  [/\b4k\b/i, 2160],
  [/\buhd\b/i, 2160],
  [/\bquad\s*hd\b/i, 1440],
  [/\bqhd\b/i, 1440],
  [/\bfull\s*hd\b/i, 1080],
  [/\bfhd\b/i, 1080],
  [/\bhd\b/i, 720],
];

/**
 * Tokens YouTube appends to the highest tier for Premium members. Matching is
 * detection only: FrameScript reads the flag, it never sets or forges it.
 */
const ENHANCED_BITRATE_TOKENS = [
  /\bpremium\b/i,
  /\benhanced\s*bitrate\b/i,
  /\bhigher\s*bitrate\b/i,
  /프리미엄/,
  /プレミアム/,
];

const HDR_TOKENS = [/\bhdr\b/i, /\bdolby\s*vision\b/i, /\bhdr10\b/i];

const AUTO_TOKENS = [/\bauto\b/i, /\bautomatic\b/i, /자동/, /自動/, /автоматически/i];

/** Extracts vertical resolution from a player label, or undefined. */
export function parseResolution(label: string): number | undefined {
  // "1080p", "2160p60", "720P"
  const pMatch = /(\d{3,4})\s*p\b/i.exec(label);
  if (pMatch) return Number(pMatch[1]);

  // "1920x1080" / "1920×1080"
  const dims = /(\d{3,4})\s*[x×]\s*(\d{3,4})/i.exec(label);
  if (dims) return Number(dims[2]);

  for (const [pattern, resolution] of NAMED_RESOLUTIONS) {
    if (pattern.test(label)) return resolution;
  }
  return undefined;
}

/** Extracts frame rate when the label encodes one ("1080p60", "1080p 60fps"). */
export function parseFrameRate(label: string): number | undefined {
  const attached = /\d{3,4}\s*p\s*(\d{2,3})\b/i.exec(label);
  if (attached) {
    const fps = Number(attached[1]);
    if (fps >= 20 && fps <= 240) return fps;
  }
  const explicit = /(\d{2,3})\s*(?:fps|hz)\b/i.exec(label);
  if (explicit) {
    const fps = Number(explicit[1]);
    if (fps >= 20 && fps <= 240) return fps;
  }
  return undefined;
}

export function isEnhancedBitrateLabel(label: string): boolean {
  return ENHANCED_BITRATE_TOKENS.some((t) => t.test(label));
}

export function isHdrLabel(label: string): boolean {
  return HDR_TOKENS.some((t) => t.test(label));
}

/**
 * True for the player's adaptive entry. "Auto (1080p)" is auto even though it
 * mentions a resolution — that resolution is a readout, not a selection.
 */
export function isAutoLabel(label: string): boolean {
  return AUTO_TOKENS.some((t) => t.test(label));
}

export interface ParseOptionInit {
  id: string;
  label: string;
  selectable?: boolean;
  active?: boolean;
}

/** Turns one raw menu entry into a structured option. */
export function parseQualityOption(init: ParseOptionInit): VideoQualityOption {
  const label = init.label.replace(/\s+/g, ' ').trim();
  const auto = isAutoLabel(label);
  const resolution = parseResolution(label);
  const frameRate = parseFrameRate(label);
  const hdr = isHdrLabel(label);

  const option: VideoQualityOption = {
    id: init.id,
    label,
    enhancedBitrate: isEnhancedBitrateLabel(label),
    selectable: init.selectable ?? true,
  };
  // `Auto (1080p)` must not be treated as a fixed 1080p tier.
  if (resolution !== undefined && !auto) option.resolution = resolution;
  if (frameRate !== undefined) option.frameRate = frameRate;
  if (hdr) option.hdr = true;
  if (auto) option.auto = true;
  if (init.active !== undefined) option.active = init.active;
  return option;
}

export function parseQualityOptions(entries: readonly ParseOptionInit[]): VideoQualityOption[] {
  return entries.map(parseQualityOption);
}
