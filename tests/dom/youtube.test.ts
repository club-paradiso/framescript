/**
 * Platform-layer tests against a synthetic player DOM.
 *
 * The fixture below imitates YouTube's long-standing player structure. It is
 * built by hand rather than captured from the site: FrameScript's tests must
 * never contain copyrighted markup or media, and a synthetic fixture also lets
 * us exercise cases (a Korean UI, an entitlement-blocked tier) that would be
 * hard to reproduce on demand in a live session.
 *
 * These tests verify FrameScript's *reading and driving* logic. They cannot
 * verify that the selectors still match today's YouTube — that requires the
 * manual QA pass documented in docs/QA.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  areCaptionsEnabled,
  findQualityMenuItem,
  isSettingsMenuOpen,
  matchesQualityMenuItem,
  parseQualityMenuItems,
  queryAll,
  queryFirst,
  YOUTUBE_SELECTORS,
} from '@/platforms/youtube/selectors';
import { YouTubeQualityController } from '@/platforms/youtube/YouTubeQualityController';
import { YouTubeSubtitleObserver } from '@/platforms/youtube/YouTubeSubtitleObserver';
import { languageCodeFromLabel } from '@/platforms/youtube/YouTubeAdapter';
import { parseNetflixVideoId, parseYouTubeVideoId } from '@/platforms/shared/navigation';
import { parseEpisodeLabel } from '@/platforms/netflix/selectors';
import { findPrimaryVideo, FrameRateEstimator, readPlayerState } from '@/platforms/shared/media';

interface FixtureOptions {
  /** Quality menu entries, in the order the player lists them. */
  qualities?: { label: string; active?: boolean; disabled?: boolean }[];
  /** Label of the settings row that shows the current quality. */
  qualityRowValue?: string;
  /** Label used on the quality settings row (localized). */
  qualityRowLabel?: string;
  captionsRowLabel?: string;
  captionsRowValue?: string;
  captionsEnabled?: boolean;
  videoHeight?: number;
}

/** Builds a synthetic player and returns handles for driving it. */
function buildPlayer(options: FixtureOptions = {}) {
  const {
    qualities = [
      { label: '2160p60 HDR' },
      { label: '1440p60' },
      { label: '1080p Premium' },
      { label: '1080p', active: true },
      { label: '720p' },
      { label: 'Auto' },
    ],
    qualityRowValue = '1080p',
    qualityRowLabel = 'Quality',
    captionsRowLabel = 'Subtitles/CC',
    captionsRowValue = 'English',
    captionsEnabled = true,
    videoHeight = 1080,
  } = options;

  document.body.innerHTML = `
    <div id="movie_player" class="html5-video-player">
      <video class="html5-main-video"></video>
      <div class="ytp-chrome-controls">
        <button class="ytp-subtitles-button" aria-pressed="${captionsEnabled}"></button>
        <button class="ytp-settings-button" aria-expanded="false"></button>
      </div>
      <div class="ytp-popup ytp-settings-menu" aria-hidden="true">
        <div class="ytp-panel">
          <div class="ytp-panel-menu">
            <div class="ytp-menuitem" data-row="speed">
              <div class="ytp-menuitem-label">Playback speed</div>
              <div class="ytp-menuitem-content">Normal</div>
            </div>
            <div class="ytp-menuitem" data-row="captions">
              <div class="ytp-menuitem-label">${captionsRowLabel}</div>
              <div class="ytp-menuitem-content">${captionsRowValue}</div>
            </div>
            <div class="ytp-menuitem" data-row="quality">
              <div class="ytp-menuitem-label">${qualityRowLabel}</div>
              <div class="ytp-menuitem-content">${qualityRowValue}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="ytp-caption-window-container"></div>
    </div>
  `;

  const video = document.querySelector('video') as HTMLVideoElement;
  // jsdom does not implement media playback, so the read-only properties the
  // controller verifies against are defined here.
  Object.defineProperty(video, 'videoHeight', { value: videoHeight, writable: true, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: (videoHeight * 16) / 9, writable: true, configurable: true });
  Object.defineProperty(video, 'duration', { value: 600, writable: true, configurable: true });
  Object.defineProperty(video, 'readyState', { value: 4, writable: true, configurable: true });
  video.currentTime = 42.5;

  const settingsButton = document.querySelector('.ytp-settings-button') as HTMLElement;
  const menu = document.querySelector('.ytp-settings-menu') as HTMLElement;
  const qualityRow = document.querySelector('[data-row="quality"]') as HTMLElement;

  const openMenu = () => {
    menu.setAttribute('aria-hidden', 'false');
    settingsButton.setAttribute('aria-expanded', 'true');
  };
  const closeMenu = () => {
    menu.setAttribute('aria-hidden', 'true');
    settingsButton.setAttribute('aria-expanded', 'false');
    menu.querySelector('.ytp-quality-menu')?.remove();
  };

  settingsButton.addEventListener('click', () => {
    if (menu.getAttribute('aria-hidden') === 'true') openMenu();
    else closeMenu();
  });

  /** Clicking the Quality row swaps in the quality submenu, as the player does. */
  qualityRow.addEventListener('click', () => {
    if (menu.querySelector('.ytp-quality-menu')) return;
    const submenu = document.createElement('div');
    submenu.className = 'ytp-quality-menu';
    for (const entry of qualities) {
      const row = document.createElement('div');
      row.className = 'ytp-menuitem';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(entry.active ?? false));
      if (entry.disabled) row.setAttribute('aria-disabled', 'true');
      row.innerHTML = `<div class="ytp-menuitem-label">${entry.label}</div>`;
      row.addEventListener('click', () => {
        for (const other of submenu.querySelectorAll('[role="menuitemradio"]')) {
          other.setAttribute('aria-checked', 'false');
        }
        row.setAttribute('aria-checked', 'true');
        selected.push(entry.label);
        closeMenu();
      });
      submenu.appendChild(row);
    }
    menu.appendChild(submenu);
  });

  const selected: string[] = [];
  return { video, settingsButton, menu, qualityRow, selected, openMenu, closeMenu };
}

describe('selector strategies', () => {
  beforeEach(() => buildPlayer());

  it('finds the player, video and settings button', () => {
    expect(queryFirst(YOUTUBE_SELECTORS.player)).not.toBeNull();
    expect(queryFirst(YOUTUBE_SELECTORS.video)).not.toBeNull();
    expect(queryFirst(YOUTUBE_SELECTORS.settingsButton)).not.toBeNull();
  });

  it('falls through a strategy to the next selector', () => {
    // Remove the preferred id; the class-based fallback must still match.
    document.getElementById('movie_player')!.removeAttribute('id');
    expect(queryFirst(YOUTUBE_SELECTORS.player)).not.toBeNull();
  });

  it('returns null rather than throwing when nothing matches', () => {
    document.body.innerHTML = '';
    expect(queryFirst(YOUTUBE_SELECTORS.player)).toBeNull();
    expect(queryAll(YOUTUBE_SELECTORS.menuItem)).toEqual([]);
  });

  it('reports whether the settings menu is open', () => {
    const player = buildPlayer();
    expect(isSettingsMenuOpen()).toBe(false);
    player.openMenu();
    expect(isSettingsMenuOpen()).toBe(true);
  });

  it('reads the caption toggle state', () => {
    buildPlayer({ captionsEnabled: true });
    expect(areCaptionsEnabled()).toBe(true);
    buildPlayer({ captionsEnabled: false });
    expect(areCaptionsEnabled()).toBe(false);
  });
});

describe('locale-independent quality row detection', () => {
  it('finds the quality row in an English UI', () => {
    buildPlayer();
    expect(findQualityMenuItem()?.getAttribute('data-row')).toBe('quality');
  });

  it('finds the quality row in a Korean UI', () => {
    // The label is translated; the value still contains a resolution.
    buildPlayer({ qualityRowLabel: '화질', captionsRowLabel: '자막', captionsRowValue: '한국어' });
    expect(findQualityMenuItem()?.getAttribute('data-row')).toBe('quality');
  });

  it('finds the quality row in a Japanese UI', () => {
    buildPlayer({ qualityRowLabel: '画質', qualityRowValue: '自動 (1080p)', captionsRowLabel: '字幕' });
    expect(findQualityMenuItem()?.getAttribute('data-row')).toBe('quality');
  });

  it('does not mistake the playback-speed row for quality', () => {
    buildPlayer();
    const speedRow = document.querySelector('[data-row="speed"]')!;
    // "Normal" contains no resolution, so it must not match.
    expect(matchesQualityMenuItem(speedRow)).toBe(false);
  });

  it('does not match a numeric playback speed row', () => {
    buildPlayer();
    const speedRow = document.querySelector('[data-row="speed"]')!;
    speedRow.querySelector('.ytp-menuitem-content')!.textContent = '1.25';
    expect(matchesQualityMenuItem(speedRow)).toBe(false);
  });
});

describe('quality menu reading', () => {
  it('reads labels, active state and disabled entries', () => {
    const player = buildPlayer({
      qualities: [
        { label: '2160p60', disabled: true },
        { label: '1080p', active: true },
        { label: '720p' },
      ],
    });
    player.openMenu();
    player.qualityRow.click();

    const entries = parseQualityMenuItems();
    expect(entries.map((e) => e.label)).toEqual(['2160p60', '1080p', '720p']);
    expect(entries[0]!.selectable).toBe(false);
    expect(entries[1]!.active).toBe(true);
  });

  it('returns nothing when the submenu is not open', () => {
    buildPlayer();
    expect(parseQualityMenuItems()).toEqual([]);
  });
});

describe('YouTubeQualityController', () => {
  it('reads capabilities without leaving the menu open', async () => {
    buildPlayer();
    const controller = new YouTubeQualityController({ menuSettleMs: 0 });

    const capabilities = await controller.getCapabilities();
    expect(capabilities.menuReadable).toBe(true);
    expect(capabilities.options).toHaveLength(6);
    expect(capabilities.options.find((o) => o.auto)).toBeDefined();
    // The viewer must not be left staring at an open settings menu.
    expect(isSettingsMenuOpen()).toBe(false);
  });

  it('selects the highest available quality and verifies it', async () => {
    const player = buildPlayer({ videoHeight: 1080 });
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 500 });

    // The fixture's video reports the new height once a tier is chosen.
    player.qualityRow.addEventListener('click', () => {
      setTimeout(() => {
        Object.defineProperty(player.video, 'videoHeight', { value: 2160, configurable: true });
      }, 10);
    });

    const result = await controller.apply({ id: 'best-available', preferEnhancedBitrate: true });
    expect(player.selected).toEqual(['2160p60 HDR']);
    expect(result.requested?.resolution).toBe(2160);
    expect(result.verified).toBe(true);
    expect(result.state).toBe('best-available');
  });

  it('respects a resolution ceiling', async () => {
    const player = buildPlayer();
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 50 });

    await controller.apply({ id: 'max-1080', maxResolution: 1080, preferEnhancedBitrate: true });
    expect(player.selected).toEqual(['1080p Premium']);
  });

  it('picks the standard tier when enhanced bitrate is turned off', async () => {
    // 720p starts active so that reaching 1080p requires an actual click.
    const player = buildPlayer({
      qualities: [
        { label: '2160p60 HDR' },
        { label: '1080p Premium' },
        { label: '1080p' },
        { label: '720p', active: true },
      ],
    });
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 50 });

    await controller.apply({ id: 'max-1080', maxResolution: 1080, preferEnhancedBitrate: false });
    expect(player.selected).toEqual(['1080p']);
  });

  it('reports an entitlement limit instead of forcing a blocked tier', async () => {
    const player = buildPlayer({
      qualities: [{ label: '2160p60', disabled: true }, { label: '1080p' }, { label: '720p' }],
    });
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 50 });

    const result = await controller.apply({ id: 'best-available', preferEnhancedBitrate: true });
    // FrameScript never attempts to click a tier the player refuses.
    expect(player.selected).toEqual(['1080p']);
    expect(result.limitedBy).toBe('entitlement');
    expect(result.state).toBe('platform-limited');
  });

  it('does not re-click a tier that is already active', async () => {
    const player = buildPlayer({
      qualities: [{ label: '1080p', active: true }, { label: '720p' }],
    });
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 50 });

    const result = await controller.apply({ id: 'best-available', preferEnhancedBitrate: true });
    expect(player.selected).toEqual([]);
    expect(result.verified).toBe(true);
  });

  it('reports unverified rather than claiming success when the player does not switch', async () => {
    buildPlayer({ videoHeight: 720 });
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 60 });

    const result = await controller.apply({ id: 'best-available', preferEnhancedBitrate: true });
    expect(result.verified).toBe(false);
    expect(result.message).toContain('720p');
  });

  it('surfaces a changed player instead of guessing', async () => {
    document.body.innerHTML = '<div id="movie_player"><video></video></div>';
    const controller = new YouTubeQualityController({ menuSettleMs: 0 });

    await expect(
      controller.apply({ id: 'best-available', preferEnhancedBitrate: true }),
    ).rejects.toMatchObject({ code: 'QUALITY_MENU_NOT_FOUND' });
  });

  it('stands down once the viewer chooses a quality themselves', async () => {
    const player = buildPlayer();
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 50 });
    const onManual = vi.fn();
    controller.watchForManualChanges(onManual);

    // The viewer opens the menu and clicks 720p.
    player.openMenu();
    player.qualityRow.click();
    const rows = [...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
    rows.find((r) => r.textContent?.includes('720p'))!.click();

    expect(onManual).toHaveBeenCalled();
    expect(controller.userOverridden).toBe(true);

    const result = await controller.apply({ id: 'best-available', preferEnhancedBitrate: true });
    expect(result.state).toBe('user-overridden');
    // FrameScript did not fight the viewer.
    expect(player.selected).toEqual(['720p']);
  });

  it('resumes automatic selection on the next video', async () => {
    const player = buildPlayer();
    const controller = new YouTubeQualityController({ menuSettleMs: 0, verifyTimeoutMs: 50 });
    controller.watchForManualChanges(() => {});

    player.openMenu();
    player.qualityRow.click();
    ([...document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[])[4]!.click();
    expect(controller.userOverridden).toBe(true);

    controller.resetOverride();
    expect(controller.userOverridden).toBe(false);
  });

  it('stands down when configured for platform auto', async () => {
    const player = buildPlayer();
    const controller = new YouTubeQualityController({ menuSettleMs: 0 });
    const result = await controller.apply({ id: 'platform-auto', preferEnhancedBitrate: true });
    expect(result.state).toBe('idle');
    expect(player.selected).toEqual([]);
  });
});

describe('YouTubeSubtitleObserver', () => {
  it('reads caption text and reports only on change', async () => {
    const player = buildPlayer();
    const container = document.querySelector('.ytp-caption-window-container')!;
    const observer = new YouTubeSubtitleObserver({ throttleMs: 0 });
    const observations: string[] = [];

    await observer.start((o) => observations.push(o.text));

    const segment = document.createElement('span');
    segment.className = 'ytp-caption-segment';
    segment.textContent = 'Where are you?';
    container.appendChild(segment);
    await waitForMutations();

    // Re-rendering identical text must not produce a second observation.
    segment.textContent = 'Where are you?';
    await waitForMutations();

    segment.textContent = 'I am here.';
    await waitForMutations();

    observer.stop();
    // No leading empty observation: an initially-blank caption container is not
    // a change, and emitting one would open and immediately close a null cue.
    expect(observations).toEqual(['Where are you?', 'I am here.']);
    expect(player.video.currentTime).toBe(42.5);
  });

  it('reports an empty string when captions clear', async () => {
    buildPlayer();
    const container = document.querySelector('.ytp-caption-window-container')!;
    const observer = new YouTubeSubtitleObserver({ throttleMs: 0 });
    const observations: string[] = [];
    await observer.start((o) => observations.push(o.text));

    const segment = document.createElement('span');
    segment.className = 'ytp-caption-segment';
    segment.textContent = 'Some line';
    container.appendChild(segment);
    await waitForMutations();

    segment.remove();
    await waitForMutations();
    observer.stop();

    expect(observations[observations.length - 1]).toBe('');
  });

  it('stops observing after teardown, leaving no listener behind', async () => {
    buildPlayer();
    const container = document.querySelector('.ytp-caption-window-container')!;
    const observer = new YouTubeSubtitleObserver({ throttleMs: 0 });
    const observations: string[] = [];
    await observer.start((o) => observations.push(o.text));
    observer.stop();

    const segment = document.createElement('span');
    segment.className = 'ytp-caption-segment';
    segment.textContent = 'After teardown';
    container.appendChild(segment);
    await waitForMutations();

    expect(observations.some((o) => o === 'After teardown')).toBe(false);
    expect(observer.active).toBe(false);
  });

  it('reports failure rather than hanging when captions are off', async () => {
    document.body.innerHTML = '<div id="movie_player"><video></video></div>';
    const observer = new YouTubeSubtitleObserver({ throttleMs: 0 });
    // Short timeout via the absent container: start resolves false.
    const started = await observer.start(() => {});
    expect(started).toBe(false);
  }, 15_000);
});

describe('media helpers', () => {
  it('picks the player video over decorative previews', () => {
    document.body.innerHTML = '<video id="preview"></video><video id="main"></video>';
    const [preview, main] = [...document.querySelectorAll('video')] as HTMLVideoElement[];
    Object.defineProperty(main!, 'duration', { value: 600, configurable: true });
    // A hover preview has no duration; the real player does.
    expect(findPrimaryVideo()).toBe(main);
    expect(findPrimaryVideo()).not.toBe(preview);
  });

  it('reads player state from the media element', () => {
    const player = buildPlayer({ videoHeight: 1440 });
    const state = readPlayerState(player.video);
    expect(state.currentTimeMs).toBe(42_500);
    expect(state.durationMs).toBe(600_000);
    expect(state.videoHeight).toBe(1440);
  });

  it('returns a safe default with no media element', () => {
    expect(readPlayerState(null)).toEqual({ playing: false, currentTimeMs: 0, playbackRate: 1 });
  });

  it('estimates frame rate from presented-frame timing', () => {
    const estimator = new FrameRateEstimator();
    // 24 fps ≈ 41.67 ms between frames.
    for (let i = 0; i < 30; i++) estimator.sample(Math.round(i * 41.67));
    expect(estimator.estimate()).toBeGreaterThan(22);
    expect(estimator.estimate()).toBeLessThan(26);
  });

  it('ignores seeks when estimating frame rate', () => {
    const estimator = new FrameRateEstimator();
    for (let i = 0; i < 20; i++) estimator.sample(i * 40);
    estimator.sample(600_000);
    for (let i = 0; i < 20; i++) estimator.sample(600_000 + i * 40);
    expect(estimator.estimate()).toBeCloseTo(25, 0);
  });

  it('reports no estimate from too few samples', () => {
    expect(new FrameRateEstimator().estimate()).toBeUndefined();
  });
});

describe('URL and metadata parsing', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=abc123DEF45&list=PL1', 'abc123DEF45'],
    ['https://www.youtube.com/shorts/abc123DEF45', 'abc123DEF45'],
    ['https://www.youtube.com/embed/abc123DEF45', 'abc123DEF45'],
    ['https://www.youtube.com/live/abc123DEF45', 'abc123DEF45'],
    ['https://youtu.be/abc123DEF45', 'abc123DEF45'],
  ])('parses a video id from %s', (url, expected) => {
    expect(parseYouTubeVideoId(new URL(url))).toBe(expected);
  });

  it('returns null for a non-video YouTube page', () => {
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/'))).toBeNull();
    expect(parseYouTubeVideoId(new URL('https://www.youtube.com/results?search_query=x'))).toBeNull();
  });

  it('parses a Netflix watch id', () => {
    expect(parseNetflixVideoId(new URL('https://www.netflix.com/watch/81234567'))).toBe('81234567');
    expect(parseNetflixVideoId(new URL('https://www.netflix.com/browse'))).toBeNull();
  });

  it.each([
    ['S2:E3 Sundae', 2, 3, 'Sundae'],
    ['Season 2: Episode 3: Sundae', 2, 3, 'Sundae'],
    ['시즌 2: 3화 순대', 2, 3, '순대'],
  ])('parses the episode label %s', (label, season, episode, title) => {
    const parsed = parseEpisodeLabel(label);
    expect(parsed.season).toBe(season);
    expect(parsed.episode).toBe(episode);
    expect(parsed.title).toBe(title);
  });

  it('treats an unrecognised label as a plain title rather than guessing', () => {
    // A wrong season number would attach the screenplay to the wrong record.
    const parsed = parseEpisodeLabel('Some Movie Title');
    expect(parsed.season).toBeUndefined();
    expect(parsed.title).toBe('Some Movie Title');
  });

  it('maps caption labels to language codes conservatively', () => {
    expect(languageCodeFromLabel('English')).toBe('en');
    expect(languageCodeFromLabel('한국어')).toBe('ko');
    expect(languageCodeFromLabel('Japanese (auto-generated)')).toBe('ja');
    // An unrecognised label becomes "undetermined", never a guess.
    expect(languageCodeFromLabel('Klingon')).toBe('und');
    expect(languageCodeFromLabel(null)).toBe('und');
  });
});

/** MutationObserver callbacks are microtask-scheduled. */
function waitForMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
