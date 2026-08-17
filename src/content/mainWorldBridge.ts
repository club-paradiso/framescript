/**
 * Optional MAIN-world bridge.
 *
 * Content scripts run in an isolated world and cannot read page-owned
 * JavaScript objects. This tiny script runs in the page's own world purely as a
 * *fallback* for one thing: reading YouTube's reported quality levels when the
 * settings-menu DOM cannot be parsed (a redesign, an unexpected locale, a
 * player variant).
 *
 * Scope discipline, because injecting into a page's world deserves it:
 *   - It only ever READS. It calls no setter and mutates no page state.
 *   - It touches exactly one object, `#movie_player`, and only three methods.
 *   - It posts results to the content script via `window.postMessage` and does
 *     nothing else.
 *   - It is injected only on demand, not on every page load.
 *
 * The deprecated `getAvailableQualityLevels` family is used here and *only*
 * here, as a cross-check. It is never the primary implementation, because those
 * methods report levels rather than what the account may actually select.
 */

const CHANNEL = 'framescript:main-world';

interface LegacyPlayer {
  getAvailableQualityLevels?: () => string[];
  getPlaybackQuality?: () => string;
  getVideoData?: () => { video_id?: string; title?: string; isLive?: boolean };
}

function readPlayer(): LegacyPlayer | null {
  const element = document.getElementById('movie_player') as (HTMLElement & LegacyPlayer) | null;
  if (!element) return null;
  return element;
}

function collect(): Record<string, unknown> {
  const player = readPlayer();
  if (!player) return { available: false };

  const payload: Record<string, unknown> = { available: true };
  try {
    if (typeof player.getAvailableQualityLevels === 'function') {
      payload.qualityLevels = player.getAvailableQualityLevels();
    }
  } catch {
    // A player mid-navigation throws; absence is a valid answer.
  }
  try {
    if (typeof player.getPlaybackQuality === 'function') {
      payload.currentQuality = player.getPlaybackQuality();
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof player.getVideoData === 'function') {
      const data = player.getVideoData();
      // Only the fields needed for content identity; nothing else is read.
      payload.videoId = data?.video_id;
      payload.title = data?.title;
      payload.isLive = data?.isLive;
    }
  } catch {
    /* ignore */
  }
  return payload;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { channel?: string; kind?: string; requestId?: string } | null;
  if (!data || data.channel !== CHANNEL || data.kind !== 'request') return;

  window.postMessage(
    { channel: CHANNEL, kind: 'response', requestId: data.requestId, payload: collect() },
    window.location.origin,
  );
});

// Announce readiness so the content script knows the bridge is live.
window.postMessage({ channel: CHANNEL, kind: 'ready' }, window.location.origin);
