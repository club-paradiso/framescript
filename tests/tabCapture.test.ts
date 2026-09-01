import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestTabCaptureStreamId } from '../src/background/tabCapture';

function installChromeMock(options: { streamId?: string; error?: string } = {}) {
  const getMediaStreamId = vi.fn(
    (
      _options: chrome.tabCapture.GetMediaStreamOptions,
      callback: (streamId: string) => void,
    ) => callback(options.streamId ?? ''),
  );
  const runtime = options.error
    ? { get lastError() { return { message: options.error }; } }
    : { lastError: undefined };

  vi.stubGlobal('chrome', {
    tabCapture: { getMediaStreamId },
    runtime,
  });
  return getMediaStreamId;
}

afterEach(() => vi.unstubAllGlobals());

describe('service-worker tab capture', () => {
  it('requests the user-invoked target tab and returns its one-use stream id', async () => {
    const getMediaStreamId = installChromeMock({ streamId: 'stream-123' });

    await expect(requestTabCaptureStreamId(42)).resolves.toBe('stream-123');
    expect(getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 }, expect.any(Function));
  });

  it('rejects Chrome errors instead of starting an empty capture', async () => {
    installChromeMock({ error: 'Extension has not been invoked for this tab.' });

    await expect(requestTabCaptureStreamId(42)).rejects.toThrow(
      'Extension has not been invoked for this tab.',
    );
  });

  it('rejects a missing stream id', async () => {
    installChromeMock();

    await expect(requestTabCaptureStreamId(42)).rejects.toThrow('No stream id returned');
  });
});
