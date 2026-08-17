/**
 * Lifecycle primitives.
 *
 * Every observer, interval, listener and stream FrameScript creates must be
 * registered with something disposable. YouTube and Netflix are single-page
 * applications that replace their player wholesale during navigation; without
 * deterministic teardown we would accumulate duplicate MutationObservers on
 * every video change.
 */

export interface Disposable {
  dispose(): void;
}

export type DisposeFn = () => void;

/**
 * Collects teardown functions and runs them exactly once, in reverse order of
 * registration (so dependents are torn down before their dependencies).
 */
export class DisposableStore implements Disposable {
  #disposers: DisposeFn[] = [];
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  add<T extends DisposeFn | Disposable>(item: T): T {
    if (this.#disposed) {
      // Registering into an already-disposed store would leak; run immediately.
      runDisposer(item);
      return item;
    }
    this.#disposers.push(typeof item === 'function' ? item : () => item.dispose());
    return item;
  }

  /** Registers a DOM listener and returns its removal function. */
  addEventListener<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (ev: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): DisposeFn;
  addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): DisposeFn;
  addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): DisposeFn {
    target.addEventListener(type, listener, options);
    const off = () => target.removeEventListener(type, listener, options);
    this.add(off);
    return off;
  }

  addInterval(fn: () => void, ms: number): DisposeFn {
    const handle = setInterval(fn, ms);
    const off = () => clearInterval(handle);
    this.add(off);
    return off;
  }

  addTimeout(fn: () => void, ms: number): DisposeFn {
    const handle = setTimeout(fn, ms);
    const off = () => clearTimeout(handle);
    this.add(off);
    return off;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const disposers = this.#disposers.splice(0).reverse();
    for (const d of disposers) {
      try {
        d();
      } catch (err) {
        console.error('[FrameScript] disposer threw', err);
      }
    }
  }
}

function runDisposer(item: DisposeFn | Disposable): void {
  try {
    if (typeof item === 'function') item();
    else item.dispose();
  } catch (err) {
    console.error('[FrameScript] disposer threw', err);
  }
}

/**
 * Keyed observer registry. Re-registering the same key disposes the previous
 * entry first, which is the property that keeps SPA navigation from stacking
 * duplicate observers.
 */
export class ObserverRegistry implements Disposable {
  #entries = new Map<string, DisposeFn>();
  #disposed = false;

  get size(): number {
    return this.#entries.size;
  }

  get keys(): string[] {
    return [...this.#entries.keys()];
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  register(key: string, disposer: DisposeFn): void {
    if (this.#disposed) {
      runDisposer(disposer);
      return;
    }
    this.unregister(key);
    this.#entries.set(key, disposer);
  }

  /** Registers a MutationObserver under `key` and wires up its disconnect. */
  observe(key: string, target: Node, init: MutationObserverInit, cb: MutationCallback): void {
    const observer = new MutationObserver(cb);
    observer.observe(target, init);
    this.register(key, () => observer.disconnect());
  }

  unregister(key: string): boolean {
    const existing = this.#entries.get(key);
    if (!existing) return false;
    this.#entries.delete(key);
    runDisposer(existing);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const key of [...this.#entries.keys()]) this.unregister(key);
  }
}

export interface WaitOptions {
  /** Give up after this many milliseconds. Default 10_000. */
  timeoutMs?: number;
  /** Polling floor for conditions that MutationObserver cannot detect. */
  pollMs?: number;
  signal?: AbortSignal;
}

export class TimeoutError extends Error {
  constructor(message = 'Timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Resolves when `predicate` returns a truthy value.
 *
 * Uses polling rather than MutationObserver because many of the conditions we
 * wait on are not DOM mutations at all (media readyState, player API presence,
 * duration becoming known).
 */
export function waitForCondition<T>(
  predicate: () => T | null | undefined | false,
  options: WaitOptions = {},
): Promise<T> {
  const { timeoutMs = 10_000, pollMs = 100, signal } = options;
  return new Promise<T>((resolve, reject) => {
    const immediate = safePredicate(predicate);
    if (immediate) {
      resolve(immediate);
      return;
    }
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }

    const started = Date.now();
    const interval = setInterval(() => {
      const value = safePredicate(predicate);
      if (value) {
        cleanup();
        resolve(value);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        cleanup();
        reject(new TimeoutError(`waitForCondition timed out after ${timeoutMs}ms`));
      }
    }, pollMs);

    const onAbort = () => {
      cleanup();
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      clearInterval(interval);
      signal?.removeEventListener('abort', onAbort);
    }
  });
}

function safePredicate<T>(predicate: () => T | null | undefined | false): T | null {
  try {
    const value = predicate();
    return value ? (value as T) : null;
  } catch {
    return null;
  }
}

/** Resolves with the first element matching any of `selectors`, in priority order. */
export function waitForElement<E extends Element = Element>(
  selectors: readonly string[],
  options: WaitOptions & { root?: ParentNode } = {},
): Promise<E> {
  const root = options.root ?? document;
  return waitForCondition<E>(() => {
    for (const selector of selectors) {
      const el = root.querySelector<E>(selector);
      if (el) return el;
    }
    return null;
  }, options);
}

export interface RetryOptions {
  attempts?: number;
  /** Delay before the first retry; doubles each attempt. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Return false to stop retrying a given error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Bounded exponential backoff. Never retries forever — an unbounded retry loop
 * against a changed YouTube DOM would spin a core for the whole movie.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 5_000,
    signal,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new AbortError();
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (err instanceof AbortError) throw err;
      const isLast = attempt === attempts - 1;
      if (isLast || !shouldRetry(err, attempt)) break;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      onRetry?.(err, attempt, delay);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
}

/** Trailing-edge debounce with cancel/flush, so teardown cannot leave a pending call. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const debounced = ((...args: A) => {
    pending = args;
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      const call = pending;
      pending = null;
      if (call) fn(...call);
    }, waitMs);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (handle) clearTimeout(handle);
    handle = null;
    pending = null;
  };
  debounced.flush = () => {
    if (handle) clearTimeout(handle);
    handle = null;
    const call = pending;
    pending = null;
    if (call) fn(...call);
  };
  return debounced;
}

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

/** Leading-edge throttle with a trailing call, used for high-rate progress events. */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  now: () => number = () => Date.now(),
): Throttled<A> {
  let last = -Infinity;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const throttled = ((...args: A) => {
    const elapsed = now() - last;
    if (elapsed >= intervalMs) {
      last = now();
      fn(...args);
      return;
    }
    pending = args;
    if (handle) return;
    handle = setTimeout(() => {
      handle = null;
      last = now();
      const call = pending;
      pending = null;
      if (call) fn(...call);
    }, intervalMs - elapsed);
  }) as Throttled<A>;

  throttled.cancel = () => {
    if (handle) clearTimeout(handle);
    handle = null;
    pending = null;
  };
  return throttled;
}

/** Combines several abort signals into one. */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
