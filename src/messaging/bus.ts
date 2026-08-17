/**
 * Message transport.
 *
 * Thin, typed wrappers over `chrome.runtime` / `chrome.tabs` messaging that
 * handle the failure modes MV3 actually produces:
 *
 *   - "Receiving end does not exist" when no listener is present (a closed side
 *     panel, a tab without the content script). That is normal, not an error,
 *     and is swallowed rather than logged as a crash.
 *   - The service worker being asleep, which the caller cannot detect in advance.
 */

import { errorDetail } from '../utils/errors';
import {
  isFrameScriptMessage,
  type ContentToWorker,
  type FrameScriptMessage,
  type OffscreenToWorker,
  type UiToWorker,
  type WorkerToContent,
  type WorkerToOffscreen,
  type WorkerToUi,
} from './protocol';

/** True for the benign "nobody is listening" family of runtime errors. */
function isNoReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection') ||
    message.includes('The message port closed')
  );
}

/** Sends to the extension's own contexts (worker, side panel, offscreen). */
export async function sendRuntime<R = unknown>(
  message: UiToWorker | WorkerToUi | WorkerToOffscreen | OffscreenToWorker | ContentToWorker,
): Promise<R | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as R;
  } catch (err) {
    if (isNoReceiverError(err)) return null;
    console.error('[FrameScript] runtime message failed', errorDetail(err));
    return null;
  }
}

/** Sends to a specific tab's content script. */
export async function sendToTab<R = unknown>(
  tabId: number,
  message: WorkerToContent,
): Promise<R | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as R;
  } catch (err) {
    if (isNoReceiverError(err)) return null;
    console.error('[FrameScript] tab message failed', errorDetail(err));
    return null;
  }
}

export type MessageHandler<M extends FrameScriptMessage> = (
  message: M,
  sender: chrome.runtime.MessageSender,
) => void | Promise<unknown>;

/**
 * Registers a runtime listener and returns its disposer.
 *
 * Async handlers are supported: returning `true` from the Chrome listener keeps
 * the response channel open, and the promise's result is sent when it settles.
 * Anything that is not a FrameScript message is ignored outright.
 */
export function onRuntimeMessage<M extends FrameScriptMessage = FrameScriptMessage>(
  handler: MessageHandler<M>,
): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    if (!isFrameScriptMessage(message)) return undefined;

    let result: void | Promise<unknown>;
    try {
      result = handler(message as M, sender);
    } catch (err) {
      console.error('[FrameScript] message handler threw', errorDetail(err));
      sendResponse({ ok: false });
      return undefined;
    }

    if (result instanceof Promise) {
      result.then(
        (value) => sendResponse(value ?? { ok: true }),
        (err: unknown) => {
          console.error('[FrameScript] async message handler failed', errorDetail(err));
          sendResponse({ ok: false });
        },
      );
      return true;
    }
    return undefined;
  };

  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Broadcasts to every open UI surface.
 *
 * Fire-and-forget by design: the side panel may be closed, and that must not
 * produce noise or block the analysis pipeline.
 */
export function broadcast(message: WorkerToUi): void {
  void sendRuntime(message);
}
