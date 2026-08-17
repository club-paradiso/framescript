/**
 * Netflix selectors.
 *
 * Netflix annotates its player with `data-uia` attributes for its own test
 * automation. Those are semantic and far more durable than class names, so they
 * come first in every strategy here.
 *
 * NOTE FOR MAINTAINERS: not verified against a live authenticated session in
 * this build environment (Netflix playback requires a signed-in account). The
 * `data-uia` attributes below are the documented-by-convention hooks; class
 * fallbacks follow.
 */

export type SelectorStrategy = readonly string[];

export const NETFLIX_SELECTORS = {
  player: ['[data-uia="player"]', '.watch-video', '.NFPlayer', '#appMountPoint .watch-video'] as SelectorStrategy,

  video: ['[data-uia="player"] video', '.watch-video video', 'video'] as SelectorStrategy,

  /** Timed-text (subtitle) container. */
  timedTextContainer: [
    '[data-uia="player-timedtext"]',
    '.player-timedtext',
    '.watch-video .player-timedtext',
  ] as SelectorStrategy,

  /** Individual subtitle text blocks inside the container. */
  timedTextBlock: [
    '.player-timedtext-text-container',
    '[data-uia="player-timedtext"] > div',
  ] as SelectorStrategy,

  videoTitle: [
    '[data-uia="video-title"]',
    '.video-title',
    '.watch-video--title-container h4',
  ] as SelectorStrategy,

  /** Episode label, e.g. "S2:E3 Sundae". */
  episodeLabel: ['[data-uia="video-title"] span', '.video-title span'] as SelectorStrategy,

  /** Audio & subtitles control, used only to read the current selection. */
  audioSubtitleButton: [
    '[data-uia="control-audio-subtitle"]',
    'button[aria-label*="Audio" i]',
    'button[aria-label*="Subtitle" i]',
  ] as SelectorStrategy,

  /** Track list rows within the audio/subtitle popup. */
  trackOption: [
    '[data-uia="selector-audio-subtitle"] li',
    '.track-list-subtitles li',
    '[role="menuitemradio"]',
  ] as SelectorStrategy,
} as const;

export function queryFirst<E extends Element = Element>(
  strategy: SelectorStrategy,
  root: ParentNode = document,
): E | null {
  for (const selector of strategy) {
    const found = root.querySelector<E>(selector);
    if (found) return found;
  }
  return null;
}

export function queryAll<E extends Element = Element>(
  strategy: SelectorStrategy,
  root: ParentNode = document,
): E[] {
  for (const selector of strategy) {
    const found = [...root.querySelectorAll<E>(selector)];
    if (found.length > 0) return found;
  }
  return [];
}

export interface NetflixEpisodeInfo {
  title?: string;
  seriesTitle?: string;
  season?: number;
  episode?: number;
}

/**
 * Parses Netflix's episode label.
 *
 * The player shows series and episode in one string in several shapes across
 * locales: `S2:E3 Sundae`, `Season 2: Episode 3`, `시즌 2: 3화`. Anything not
 * recognised is left as a plain title rather than guessed at, since a wrong
 * season number would attach the screenplay to the wrong stored record.
 */
export function parseEpisodeLabel(raw: string): NetflixEpisodeInfo {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return {};

  const compact = /S(\d{1,2})\s*:\s*E(\d{1,3})\s*(.*)$/i.exec(text);
  if (compact) {
    const info: NetflixEpisodeInfo = {
      season: Number(compact[1]),
      episode: Number(compact[2]),
    };
    const title = compact[3]?.trim();
    if (title) info.title = title;
    return info;
  }

  const verbose = /Season\s+(\d{1,2})\s*[:,-]?\s*Episode\s+(\d{1,3})\s*[:,-]?\s*(.*)$/i.exec(text);
  if (verbose) {
    const info: NetflixEpisodeInfo = { season: Number(verbose[1]), episode: Number(verbose[2]) };
    const title = verbose[3]?.trim();
    if (title) info.title = title;
    return info;
  }

  const korean = /시즌\s*(\d{1,2})\s*[:,-]?\s*(\d{1,3})\s*화\s*(.*)$/.exec(text);
  if (korean) {
    const info: NetflixEpisodeInfo = { season: Number(korean[1]), episode: Number(korean[2]) };
    const title = korean[3]?.trim();
    if (title) info.title = title;
    return info;
  }

  return { title: text };
}
