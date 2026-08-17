/**
 * YouTube selectors.
 *
 * Every YouTube DOM assumption in FrameScript is in this file. When YouTube
 * changes its player, this is the only file that should need editing.
 *
 * Strategy order, applied everywhere below:
 *   1. semantic attributes and ARIA roles      (survive redesigns)
 *   2. long-lived player classes (`ytp-*`)     (stable for many years)
 *   3. structural relationships                (parent/child shape)
 *   4. visible text                            (last resort; locale-dependent)
 *
 * Deliberately avoided: generated class hashes, and anything that requires
 * reading the player's private JavaScript state.
 *
 * NOTE FOR MAINTAINERS: these selectors are written against YouTube's
 * long-standing player structure but have not been verified against a live
 * session in this build environment. `matchesQualityMenuItem` and
 * `parseQualityMenuItems` are locale-independent by construction (they key off
 * resolution patterns, not translated words), which is the main defence against
 * both redesigns and non-English UIs.
 */

/** Ordered candidates; the first match wins. */
export type SelectorStrategy = readonly string[];

export const YOUTUBE_SELECTORS = {
  /** The player container. `#movie_player` has been stable for over a decade. */
  player: ['#movie_player', '.html5-video-player', 'ytd-player #container'] as SelectorStrategy,

  video: ['#movie_player video.html5-main-video', '#movie_player video', 'video.video-stream'] as SelectorStrategy,

  /** Settings (gear) button that opens the quality menu. */
  settingsButton: [
    '#movie_player .ytp-settings-button',
    '.ytp-chrome-controls .ytp-settings-button',
    'button.ytp-settings-button',
  ] as SelectorStrategy,

  /** The popup panel the settings button opens. */
  settingsMenu: ['#movie_player .ytp-popup.ytp-settings-menu', '.ytp-settings-menu', '.ytp-popup'] as SelectorStrategy,

  /** Rows inside the settings menu. */
  menuItem: ['.ytp-panel-menu .ytp-menuitem', '.ytp-menuitem'] as SelectorStrategy,

  /** The right-hand value shown on a settings row ("1080p", "Auto"). */
  menuItemContent: ['.ytp-menuitem-content'] as SelectorStrategy,

  menuItemLabel: ['.ytp-menuitem-label'] as SelectorStrategy,

  /** Radio rows inside the quality submenu. */
  qualityOption: [
    '.ytp-quality-menu .ytp-menuitem[role="menuitemradio"]',
    '.ytp-panel[aria-label] .ytp-menuitem[role="menuitemradio"]',
    '.ytp-menuitem[role="menuitemradio"]',
  ] as SelectorStrategy,

  /** Caption rendering container. */
  captionWindow: [
    '#movie_player .ytp-caption-window-container',
    '.ytp-caption-window-container',
    '.caption-window',
  ] as SelectorStrategy,

  /** Individual caption text runs. */
  captionSegment: ['.ytp-caption-segment', '.captions-text .caption-visual-line'] as SelectorStrategy,

  subtitlesButton: [
    '#movie_player .ytp-subtitles-button',
    '.ytp-chrome-controls .ytp-subtitles-button',
  ] as SelectorStrategy,

  /** Title, for content identity. */
  title: [
    'ytd-watch-metadata #title h1 yt-formatted-string',
    'h1.ytd-watch-metadata yt-formatted-string',
    '#movie_player .ytp-title-link',
    'meta[name="title"]',
  ] as SelectorStrategy,

  /** Chapter marker container, when the video has chapters. */
  chapterTitle: ['.ytp-chapter-title-content'] as SelectorStrategy,
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

/** Any string that looks like a resolution the player could be showing. */
const RESOLUTION_HINT = /(\d{3,4}\s*p|\b4k\b|\b8k\b|\bhd\b|\d{3,4}\s*[x×]\s*\d{3,4})/i;
/** Localized "auto" spellings we recognise; the resolution test covers the rest. */
const AUTO_HINT = /\b(auto|automatic)\b|자동|自動|автомат/i;

/**
 * Identifies the Quality row in the settings menu **without reading its label**.
 *
 * The row's *value* always contains a resolution or an "auto" marker, in every
 * locale, whereas its *label* is translated. Keying off the value is what makes
 * quality selection work on a Korean or Japanese YouTube UI.
 */
export function matchesQualityMenuItem(item: Element): boolean {
  const content = queryFirst(YOUTUBE_SELECTORS.menuItemContent, item)?.textContent ?? '';
  if (RESOLUTION_HINT.test(content)) return true;
  if (AUTO_HINT.test(content) && /\d/.test(content)) return true;
  return false;
}

export function findQualityMenuItem(root: ParentNode = document): HTMLElement | null {
  const items = queryAll<HTMLElement>(YOUTUBE_SELECTORS.menuItem, root);
  // Several rows can contain digits (playback speed shows "1"), so require a
  // resolution-shaped value and prefer the last match, which is where YouTube
  // has consistently placed Quality.
  const matches = items.filter(matchesQualityMenuItem);
  return matches[matches.length - 1] ?? null;
}

export interface RawQualityEntry {
  element: HTMLElement;
  label: string;
  selectable: boolean;
  active: boolean;
}

/**
 * Reads the quality submenu.
 *
 * `aria-checked` gives the active entry without parsing any text, and
 * `aria-disabled` marks entries the player lists but refuses (which is how an
 * entitlement-limited tier presents). FrameScript reports those as unselectable
 * and never attempts to bypass them.
 */
export function parseQualityMenuItems(root: ParentNode = document): RawQualityEntry[] {
  return queryAll<HTMLElement>(YOUTUBE_SELECTORS.qualityOption, root).map((element) => {
    const labelNode = queryFirst(YOUTUBE_SELECTORS.menuItemLabel, element);
    const label = (labelNode?.textContent ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      element,
      label,
      selectable: element.getAttribute('aria-disabled') !== 'true',
      active: element.getAttribute('aria-checked') === 'true',
    };
  });
}

/** True when the settings popup is currently open. */
export function isSettingsMenuOpen(root: ParentNode = document): boolean {
  const menu = queryFirst<HTMLElement>(YOUTUBE_SELECTORS.settingsMenu, root);
  if (!menu) return false;
  if (menu.hasAttribute('aria-hidden') && menu.getAttribute('aria-hidden') === 'true') return false;
  const button = queryFirst<HTMLElement>(YOUTUBE_SELECTORS.settingsButton, root);
  if (button?.getAttribute('aria-expanded') === 'true') return true;
  return menu.offsetParent !== null || menu.getBoundingClientRect().height > 0;
}

/** True when captions are currently enabled. */
export function areCaptionsEnabled(root: ParentNode = document): boolean {
  const button = queryFirst<HTMLElement>(YOUTUBE_SELECTORS.subtitlesButton, root);
  return button?.getAttribute('aria-pressed') === 'true';
}
