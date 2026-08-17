import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortError,
  anySignal,
  debounce,
  DisposableStore,
  ObserverRegistry,
  retryWithBackoff,
  sleep,
  throttle,
  TimeoutError,
  waitForCondition,
} from '@/utils/lifecycle';
import { createIdFactory, hash32, shortHash } from '@/utils/id';
import { MediaClock } from '@/offscreen/mediaClock';
import { KeyframeBuffer, toFrameRef } from '@/temporal/KeyframeBuffer';
import { describeError, errorDetail, FrameScriptError, userMessageFor } from '@/utils/errors';
import { isFrameScriptMessage } from '@/messaging/protocol';

describe('DisposableStore', () => {
  it('runs disposers once, in reverse order', () => {
    const order: number[] = [];
    const store = new DisposableStore();
    store.add(() => order.push(1));
    store.add(() => order.push(2));
    store.add(() => order.push(3));

    store.dispose();
    store.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it('runs a disposer immediately if the store is already disposed', () => {
    const store = new DisposableStore();
    store.dispose();
    const fn = vi.fn();
    store.add(fn);
    // Registering into a dead store would otherwise leak the resource forever.
    expect(fn).toHaveBeenCalledOnce();
  });

  it('keeps disposing after one disposer throws', () => {
    const after = vi.fn();
    const store = new DisposableStore();
    store.add(after);
    store.add(() => {
      throw new Error('boom');
    });
    store.dispose();
    expect(after).toHaveBeenCalledOnce();
  });

  it('removes event listeners it registered', () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const store = new DisposableStore();
    store.addEventListener(target, 'ping', handler);

    target.dispatchEvent(new Event('ping'));
    store.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('clears intervals and timeouts', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const store = new DisposableStore();
    store.addInterval(tick, 100);
    vi.advanceTimersByTime(250);
    store.dispose();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('ObserverRegistry', () => {
  it('disposes the previous entry when a key is re-registered', () => {
    // This is the property that stops SPA navigation stacking observers.
    const first = vi.fn();
    const second = vi.fn();
    const registry = new ObserverRegistry();

    registry.register('player', first);
    registry.register('player', second);
    expect(first).toHaveBeenCalledOnce();
    expect(registry.size).toBe(1);

    registry.dispose();
    expect(second).toHaveBeenCalledOnce();
  });

  it('unregisters a single key', () => {
    const registry = new ObserverRegistry();
    const fn = vi.fn();
    registry.register('a', fn);
    expect(registry.unregister('a')).toBe(true);
    expect(registry.unregister('a')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('tracks keys', () => {
    const registry = new ObserverRegistry();
    registry.register('a', () => {});
    registry.register('b', () => {});
    expect(registry.keys.sort()).toEqual(['a', 'b']);
    expect(registry.has('a')).toBe(true);
  });
});

describe('waitForCondition', () => {
  it('resolves immediately when already true', async () => {
    await expect(waitForCondition(() => 'ready')).resolves.toBe('ready');
  });

  it('resolves once the condition becomes true', async () => {
    let value: string | null = null;
    setTimeout(() => {
      value = 'ready';
    }, 30);
    await expect(waitForCondition(() => value, { pollMs: 10 })).resolves.toBe('ready');
  });

  it('times out rather than polling forever', async () => {
    await expect(waitForCondition(() => null, { timeoutMs: 50, pollMs: 10 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it('treats a throwing predicate as not-yet-true', async () => {
    let attempts = 0;
    const value = await waitForCondition(
      () => {
        attempts++;
        if (attempts < 3) throw new Error('DOM not ready');
        return 'ready';
      },
      { pollMs: 5 },
    );
    expect(value).toBe('ready');
  });

  it('aborts on signal', async () => {
    const controller = new AbortController();
    const promise = waitForCondition(() => null, { pollMs: 5, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(AbortError);
  });
});

describe('retryWithBackoff', () => {
  it('returns the first successful result', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(retryWithBackoff(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries a bounded number of times and then gives up', async () => {
    const fn = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(retryWithBackoff(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('nope');
    // Bounded: never an infinite retry loop against a changed DOM.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops early when shouldRetry says not to', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fatal');
    });
    await expect(
      retryWithBackoff(fn, { attempts: 5, baseDelayMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('succeeds after transient failures', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'recovered';
      },
      { attempts: 5, baseDelayMs: 1 },
    );
    expect(result).toBe('recovered');
  });
});

describe('debounce and throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces to a single trailing call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('a');
    debounced('b');
    debounced('c');
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('cancels a pending debounced call so teardown leaves nothing behind', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flushes a pending debounced call', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('a');
    debounced.flush();
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('throttles with a leading call and a trailing call', () => {
    let now = 0;
    const fn = vi.fn();
    const throttled = throttle(fn, 100, () => now);

    throttled('first');
    expect(fn).toHaveBeenCalledOnce();

    now = 20;
    throttled('second');
    throttled('third');
    expect(fn).toHaveBeenCalledOnce();

    now = 100;
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('third');
  });
});

describe('signals and sleep', () => {
  it('combines abort signals', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
    b.abort();
    expect(combined.aborted).toBe(true);
  });

  it('propagates an already-aborted signal', () => {
    const controller = new AbortController();
    controller.abort();
    expect(anySignal([controller.signal]).aborted).toBe(true);
  });

  it('rejects sleep when aborted', async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(AbortError);
  });
});

describe('identifiers', () => {
  it('produces monotonic, reproducible ids', () => {
    const a = createIdFactory('ev');
    const b = createIdFactory('ev');
    expect(a()).toBe('ev-0001');
    expect(a()).toBe('ev-0002');
    // Two factories from the same seed produce the same sequence.
    expect(b()).toBe('ev-0001');
  });

  it('hashes deterministically', () => {
    expect(hash32('framescript')).toBe(hash32('framescript'));
    expect(hash32('a')).not.toBe(hash32('b'));
    expect(shortHash('a')).toMatch(/^[a-z0-9]+$/);
  });
});

describe('media clock', () => {
  it('returns null before any sample rather than guessing zero', () => {
    // A guessed timestamp would silently misalign every audio event.
    expect(new MediaClock().now()).toBeNull();
  });

  it('interpolates while playing', () => {
    let wall = 1000;
    const clock = new MediaClock({ now: () => wall });
    clock.update({ mediaTimeMs: 60_000, playing: true });

    wall = 1500;
    expect(clock.now()).toBe(60_500);
  });

  it('scales interpolation by playback rate', () => {
    let wall = 0;
    const clock = new MediaClock({ now: () => wall });
    clock.update({ mediaTimeMs: 10_000, playing: true, playbackRate: 2 });
    wall = 1000;
    expect(clock.now()).toBe(12_000);
  });

  it('holds position while paused', () => {
    let wall = 0;
    const clock = new MediaClock({ now: () => wall });
    clock.update({ mediaTimeMs: 30_000, playing: false });
    wall = 10_000;
    expect(clock.now()).toBe(30_000);
  });

  it('refuses to extrapolate from a stale sample', () => {
    let wall = 0;
    const clock = new MediaClock({ now: () => wall, maxExtrapolationMs: 3_000 });
    clock.update({ mediaTimeMs: 10_000, playing: true });
    wall = 10_000;
    expect(clock.now()).toBeNull();
  });

  it('maps a recent wall-clock instant back to media time', () => {
    const wall = 5_000;
    const clock = new MediaClock({ now: () => wall });
    clock.update({ mediaTimeMs: 60_000, playing: true });
    expect(clock.at(4_800)).toBe(59_800);
  });
});

describe('keyframe buffer', () => {
  const keyframe = (timestamp: number, bytes = 100) => ({
    timestamp,
    width: 480,
    height: 270,
    data: new Uint8Array(bytes),
    mimeType: 'image/jpeg',
  });

  it('is bounded by frame count and cannot become a recording', () => {
    const buffer = new KeyframeBuffer(5);
    for (let i = 0; i < 50; i++) buffer.push(keyframe(i * 100));
    expect(buffer.size).toBe(5);
    expect(buffer.droppedCount).toBe(45);
  });

  it('is bounded by total bytes', () => {
    const buffer = new KeyframeBuffer(1000, 1000);
    for (let i = 0; i < 50; i++) buffer.push(keyframe(i * 100, 200));
    expect(buffer.byteLength).toBeLessThanOrEqual(1000);
  });

  it('returns frames within a window', () => {
    const buffer = new KeyframeBuffer(100);
    for (let i = 0; i < 20; i++) buffer.push(keyframe(i * 100));
    expect(buffer.range(500, 900)).toHaveLength(5);
  });

  it('samples a window evenly to preserve the shape of an action', () => {
    const buffer = new KeyframeBuffer(100);
    for (let i = 0; i < 20; i++) buffer.push(keyframe(i * 100));

    const sampled = buffer.sampleWindow(0, 1900, 5);
    expect(sampled).toHaveLength(5);
    // Beginning, middle and end are all represented.
    expect(sampled[0]!.timestamp).toBe(0);
    expect(sampled[4]!.timestamp).toBe(1900);
  });

  it('finds the nearest frame within tolerance', () => {
    const buffer = new KeyframeBuffer(100);
    buffer.push(keyframe(1000));
    expect(buffer.nearest(1100, 250)?.timestamp).toBe(1000);
    expect(buffer.nearest(5000, 250)).toBeUndefined();
  });

  it('drops every retained frame on clear', () => {
    const buffer = new KeyframeBuffer(100);
    for (let i = 0; i < 10; i++) buffer.push(keyframe(i * 100));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.byteLength).toBe(0);
  });

  it('produces frame references that carry no pixel data', () => {
    const ref = toFrameRef(keyframe(1000));
    expect(ref).toEqual({ timestamp: 1000, width: 480, height: 270 });
    expect('data' in ref).toBe(false);
  });
});

describe('errors', () => {
  it('maps every code to user-facing copy with no stack', () => {
    const error = new FrameScriptError({ code: 'PROTECTED_CONTENT', detail: 'canvas readback threw' });
    const described = describeError(error);
    expect(described.code).toBe('PROTECTED_CONTENT');
    expect(described.message).toContain('protected playback environment');
    expect(described.message).not.toContain('canvas readback');
  });

  it('falls back safely for unknown throwables', () => {
    expect(describeError(new Error('raw internal failure')).code).toBe('UNSUPPORTED');
    expect(describeError('a string').message).toBe(userMessageFor('UNSUPPORTED'));
  });

  it('keeps developer detail separate from user copy', () => {
    const error = new FrameScriptError({ code: 'TAB_CAPTURE_FAILED', detail: 'getUserMedia rejected' });
    expect(errorDetail(error)).toBe('getUserMedia rejected');
  });

  it('marks recoverable errors', () => {
    expect(new FrameScriptError({ code: 'AI_PROVIDER_FAILED', recoverable: true }).recoverable).toBe(true);
    expect(new FrameScriptError({ code: 'UNSUPPORTED' }).recoverable).toBe(false);
  });
});

describe('message protocol', () => {
  it('recognises FrameScript messages by their namespaced type', () => {
    expect(isFrameScriptMessage({ type: 'content/ready', payload: {} })).toBe(true);
    expect(isFrameScriptMessage({ type: 'ui/get-snapshot', payload: {} })).toBe(true);
  });

  it('ignores foreign messages from the page or other extensions', () => {
    expect(isFrameScriptMessage({ type: 'somethingElse' })).toBe(false);
    expect(isFrameScriptMessage(null)).toBe(false);
    expect(isFrameScriptMessage('string')).toBe(false);
    expect(isFrameScriptMessage({ payload: {} })).toBe(false);
  });
});
