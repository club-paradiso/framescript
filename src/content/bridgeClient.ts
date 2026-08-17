/**
 * Client for the optional MAIN-world bridge.
 *
 * Injection is on demand and one-shot: FrameScript only reaches into the page's
 * world when its own DOM reading has already failed. If the bridge does not
 * answer within a short timeout the caller carries on without it — a missing
 * fallback is not an error.
 */

import { randomId } from '../utils/id';

const CHANNEL = 'framescript:main-world';
const RESPONSE_TIMEOUT_MS = 1_500;

export interface BridgePayload {
  available: boolean;
  qualityLevels?: string[];
  currentQuality?: string;
  videoId?: string;
  title?: string;
  isLive?: boolean;
}

let injected = false;

/** Injects the bridge script into the page's world, once per document. */
export async function ensureBridge(): Promise<boolean> {
  if (injected) return true;
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return false;

  return new Promise<boolean>((resolve) => {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/mainWorldBridge.js');
      script.async = false;
      script.onload = () => {
        // The element has done its job; leaving it would litter the page.
        script.remove();
        injected = true;
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        resolve(false);
      };
      (document.head ?? document.documentElement).appendChild(script);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Asks the bridge for the player's reported quality levels.
 * Resolves null when the bridge is unavailable or does not answer in time.
 */
export async function requestBridgePayload(): Promise<BridgePayload | null> {
  if (!(await ensureBridge())) return null;

  const requestId = randomId('bridge');
  return new Promise<BridgePayload | null>((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', listener);
      resolve(null);
    }, RESPONSE_TIMEOUT_MS);

    const listener = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as
        | { channel?: string; kind?: string; requestId?: string; payload?: BridgePayload }
        | null;
      if (!data || data.channel !== CHANNEL || data.kind !== 'response' || data.requestId !== requestId) return;

      clearTimeout(timer);
      window.removeEventListener('message', listener);
      resolve(data.payload ?? null);
    };

    window.addEventListener('message', listener);
    window.postMessage({ channel: CHANNEL, kind: 'request', requestId }, window.location.origin);
  });
}
