/**
 * Inference coordinator.
 *
 * Sits between the temporal engine (which can request analysis ten times a
 * second) and providers (which take hundreds of milliseconds each). Its job is
 * to make sure the analysis pipeline can never harm playback:
 *
 *   - the queue is bounded, and overflow drops the *least important* request,
 *     not the newest, so scene cuts survive and idle-shot requests do not;
 *   - concurrency is capped;
 *   - repeated provider failures trip a circuit breaker instead of retrying
 *     into a wall for the rest of the film.
 */

import { FrameScriptError, errorDetail } from '../utils/errors';
import type { VisionAnalysisProvider, VisionWindowAnalysis, VisionWindowRequest } from './types';

export interface QueuedRequest {
  request: VisionWindowRequest;
  importance: number;
  enqueuedAt: number;
  resolve: (value: VisionWindowAnalysis | null) => void;
  reject: (reason: unknown) => void;
}

export interface CoordinatorOptions {
  provider: VisionAnalysisProvider;
  maxQueueLength?: number;
  maxConcurrency?: number;
  /** Consecutive failures before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open, in wall-clock ms. */
  breakerCooldownMs?: number;
  now?: () => number;
}

export interface CoordinatorStats {
  queued: number;
  inFlight: number;
  completed: number;
  failed: number;
  dropped: number;
  breakerOpen: boolean;
  /** Mean provider latency in ms over completed requests. */
  meanLatencyMs: number;
}

const DEFAULTS = {
  maxQueueLength: 12,
  maxConcurrency: 2,
  failureThreshold: 3,
  breakerCooldownMs: 60_000,
} as const;

export class InferenceCoordinator {
  #provider: VisionAnalysisProvider;
  #options: Required<Omit<CoordinatorOptions, 'provider' | 'now'>>;
  #now: () => number;

  #queue: QueuedRequest[] = [];
  #inFlight = 0;
  #consecutiveFailures = 0;
  #breakerOpenedAt: number | null = null;

  #completed = 0;
  #failed = 0;
  #dropped = 0;
  #latencyTotal = 0;

  constructor(options: CoordinatorOptions) {
    this.#provider = options.provider;
    this.#now = options.now ?? (() => Date.now());
    this.#options = {
      maxQueueLength: options.maxQueueLength ?? DEFAULTS.maxQueueLength,
      maxConcurrency: options.maxConcurrency ?? DEFAULTS.maxConcurrency,
      failureThreshold: options.failureThreshold ?? DEFAULTS.failureThreshold,
      breakerCooldownMs: options.breakerCooldownMs ?? DEFAULTS.breakerCooldownMs,
    };
  }

  get stats(): CoordinatorStats {
    return {
      queued: this.#queue.length,
      inFlight: this.#inFlight,
      completed: this.#completed,
      failed: this.#failed,
      dropped: this.#dropped,
      breakerOpen: this.#breakerIsOpen(),
      meanLatencyMs: this.#completed > 0 ? Math.round(this.#latencyTotal / this.#completed) : 0,
    };
  }

  setProvider(provider: VisionAnalysisProvider): void {
    this.#provider = provider;
    this.#consecutiveFailures = 0;
    this.#breakerOpenedAt = null;
  }

  /**
   * Submits a window for analysis.
   *
   * Resolves with `null` when the request was dropped or the breaker is open —
   * a dropped analysis is a normal, expected outcome under load, not an error.
   */
  submit(request: VisionWindowRequest, importance: number): Promise<VisionWindowAnalysis | null> {
    if (this.#breakerIsOpen()) {
      this.#dropped++;
      return Promise.resolve(null);
    }

    return new Promise<VisionWindowAnalysis | null>((resolve, reject) => {
      const entry: QueuedRequest = { request, importance, enqueuedAt: this.#now(), resolve, reject };

      if (this.#queue.length >= this.#options.maxQueueLength) {
        const weakestIndex = this.#weakestIndex();
        const weakest = this.#queue[weakestIndex];
        if (weakest && weakest.importance < importance) {
          this.#queue.splice(weakestIndex, 1);
          this.#dropped++;
          weakest.resolve(null);
        } else {
          // Incoming request is the least important thing in the system.
          this.#dropped++;
          resolve(null);
          return;
        }
      }

      this.#queue.push(entry);
      void this.#pump();
    });
  }

  /** Cancels everything pending. Called when analysis stops or the tab changes. */
  clear(): void {
    const pending = this.#queue.splice(0);
    this.#dropped += pending.length;
    for (const entry of pending) entry.resolve(null);
  }

  #weakestIndex(): number {
    let index = 0;
    let weakest = Infinity;
    for (let i = 0; i < this.#queue.length; i++) {
      const value = this.#queue[i]!.importance;
      if (value < weakest) {
        weakest = value;
        index = i;
      }
    }
    return index;
  }

  #breakerIsOpen(): boolean {
    if (this.#breakerOpenedAt === null) return false;
    if (this.#now() - this.#breakerOpenedAt >= this.#options.breakerCooldownMs) {
      this.#breakerOpenedAt = null;
      this.#consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  async #pump(): Promise<void> {
    while (this.#inFlight < this.#options.maxConcurrency && this.#queue.length > 0) {
      if (this.#breakerIsOpen()) {
        this.clear();
        return;
      }
      // Highest importance first — the queue is a priority queue, not a FIFO.
      this.#queue.sort((a, b) => b.importance - a.importance || a.enqueuedAt - b.enqueuedAt);
      const entry = this.#queue.shift();
      if (!entry) return;

      this.#inFlight++;
      void this.#run(entry);
    }
  }

  async #run(entry: QueuedRequest): Promise<void> {
    const started = this.#now();
    try {
      const result = await this.#provider.analyzeWindow(entry.request);
      this.#completed++;
      this.#latencyTotal += this.#now() - started;
      this.#consecutiveFailures = 0;
      entry.resolve(result);
    } catch (err) {
      this.#failed++;
      this.#consecutiveFailures++;
      if (this.#consecutiveFailures >= this.#options.failureThreshold) {
        this.#breakerOpenedAt = this.#now();
        console.warn(
          `[FrameScript] inference circuit breaker opened after ${this.#consecutiveFailures} failures: ${errorDetail(err)}`,
        );
      }
      // A failed analysis degrades the screenplay; it never breaks playback,
      // so callers get null rather than a rejection they would have to handle.
      if (FrameScriptError.is(err) && !err.recoverable) entry.resolve(null);
      else entry.resolve(null);
    } finally {
      this.#inFlight--;
      void this.#pump();
    }
  }
}
