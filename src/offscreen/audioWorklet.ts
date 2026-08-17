/**
 * Audio capture worklet.
 *
 * Runs on the audio rendering thread. Two jobs, in this order of importance:
 *
 *   1. **Pass the audio through untouched.** Tab capture re-routes the tab's
 *      audio; if this node did not copy input to output, the viewer's film
 *      would go silent the moment analysis started. Nothing here changes gain,
 *      channel count, or timing.
 *   2. Copy mono frames into a buffer and post them to the offscreen document
 *      in fixed-size blocks for analysis.
 *
 * Posting every 128-sample render quantum would flood the message port, so
 * frames are batched. The buffer is a fixed allocation — it cannot grow.
 */

/// <reference lib="webworker" />

declare const sampleRate: number;
declare const currentTime: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;

/** ~85 ms at 48 kHz: fine enough for speech onsets, coarse enough to be cheap. */
const BLOCK_SIZE = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  #buffer = new Float32Array(BLOCK_SIZE);
  #offset = 0;

  override process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const output = outputs[0];

    // --- Passthrough (job 1) ---
    if (input && output) {
      const channels = Math.min(input.length, output.length);
      for (let channel = 0; channel < channels; channel++) {
        const source = input[channel];
        const destination = output[channel];
        if (source && destination) destination.set(source);
      }
      // Input has fewer channels than output (mono source, stereo sink): copy
      // channel 0 across so the audio is not silently half-missing.
      if (input.length === 1 && output.length > 1) {
        const source = input[0];
        for (let channel = 1; channel < output.length; channel++) {
          const destination = output[channel];
          if (source && destination) destination.set(source);
        }
      }
    }

    // --- Analysis copy (job 2) ---
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    const right = input[1];

    for (let i = 0; i < left.length; i++) {
      // Downmix to mono; every analysis stage downstream is mono.
      this.#buffer[this.#offset++] = right ? (left[i]! + right[i]!) * 0.5 : left[i]!;

      if (this.#offset >= BLOCK_SIZE) {
        const copy = this.#buffer.slice(0, BLOCK_SIZE);
        this.port.postMessage(
          {
            samples: copy,
            sampleRate,
            // Wall-clock stamp for the *start* of this block, which the media
            // clock converts to media time on the other side.
            wallTimeSeconds: currentTime - BLOCK_SIZE / sampleRate,
          },
          [copy.buffer],
        );
        this.#offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('framescript-capture', CaptureProcessor);
