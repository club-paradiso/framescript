/**
 * Requests a one-use stream id from the MV3 service worker.
 *
 * Chrome 116+ allows an id created here to be consumed by the extension's
 * offscreen document. Keeping both ends on Chrome's documented background
 * capture path avoids tying the id to a popup or side-panel render process.
 */
export function requestTabCaptureStreamId(tabId: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) {
        reject(new Error(error?.message ?? 'No stream id returned'));
        return;
      }
      resolve(streamId);
    });
  });
}
