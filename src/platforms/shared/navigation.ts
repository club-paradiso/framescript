/**
 * SPA navigation observation.
 *
 * YouTube and Netflix never reload the document. A "new video" is a history
 * mutation plus a DOM swap, and neither site emits a single reliable event for
 * it. So several signals are combined and debounced into one change event:
 *
 *   - the History API (pushState/replaceState, patched in this world only)
 *   - `popstate` for back/forward
 *   - YouTube's own `yt-navigate-finish` when present
 *   - a title-mutation fallback for anything the above misses
 *
 * Debouncing matters: a single navigation fires three or four of these, and
 * acting on each would re-run quality selection several times per video.
 */

import { debounce, DisposableStore } from '../../utils/lifecycle';

export interface NavigationObserverOptions {
  /** Collapse signals arriving within this window into one change. */
  debounceMs?: number;
  /** Extra site-specific DOM events, e.g. `yt-navigate-finish`. */
  customEvents?: readonly string[];
}

/**
 * Calls `onChange` with the new URL whenever the SPA navigates.
 *
 * The History patch is installed on the content script's own window object. It
 * wraps rather than replaces the native methods and restores them on dispose,
 * so page code keeps working exactly as before.
 */
export function observeUrlChanges(
  onChange: (url: string) => void,
  options: NavigationObserverOptions = {},
): DisposableStore {
  const store = new DisposableStore();
  const { debounceMs = 150, customEvents = [] } = options;

  let lastUrl = location.href;
  const notify = debounce(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onChange(lastUrl);
  }, debounceMs);
  store.add(() => notify.cancel());

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function patchedPushState(...args) {
    const result = originalPushState.apply(this, args);
    notify();
    return result;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const result = originalReplaceState.apply(this, args);
    notify();
    return result;
  };
  store.add(() => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
  });

  store.addEventListener(window, 'popstate', () => notify());
  store.addEventListener(window, 'hashchange', () => notify());
  for (const eventName of customEvents) {
    store.addEventListener(window, eventName, () => notify());
  }

  // Last-resort fallback: the document title changes on every real navigation
  // even when no event we listen for fires.
  const titleElement = document.querySelector('title');
  if (titleElement) {
    const observer = new MutationObserver(() => notify());
    observer.observe(titleElement, { childList: true });
    store.add(() => observer.disconnect());
  }

  return store;
}

/** Extracts the YouTube video id from any of its URL shapes. */
export function parseYouTubeVideoId(url: URL): string | null {
  if (url.hostname.endsWith('youtube.com')) {
    const watchId = url.searchParams.get('v');
    if (watchId) return watchId;
    const shorts = /^\/shorts\/([\w-]{6,})/.exec(url.pathname);
    if (shorts) return shorts[1]!;
    const embed = /^\/embed\/([\w-]{6,})/.exec(url.pathname);
    if (embed) return embed[1]!;
    const live = /^\/live\/([\w-]{6,})/.exec(url.pathname);
    if (live) return live[1]!;
  }
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1);
    if (id) return id;
  }
  return null;
}

/** Extracts the Netflix title id from a watch URL. */
export function parseNetflixVideoId(url: URL): string | null {
  const match = /^\/watch\/(\d+)/.exec(url.pathname);
  return match ? match[1]! : null;
}
