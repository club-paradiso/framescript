/**
 * Deterministic synthetic media, encoded by the browser under test.
 *
 * The WAV fixture in `tests/fixtures/` proves the audio detectors work on real
 * PCM. It does not prove that *video* works, and the two paths share almost no
 * code: an MP4 has to be demuxed, its audio decoded through
 * `decodeAudioData`, its picture played back, and its frames read off a canvas.
 * A green WAV test says nothing about any of that.
 *
 * So this generates an actual encoded MP4 — container, encoded video track,
 * encoded audio track, no subtitle track — inside the browser that will then
 * analyze it, using `MediaRecorder` over a canvas capture stream plus a
 * Web Audio stream. Nothing is committed to the repository: the clip is built
 * at test time and lives only in memory.
 *
 * The *structure* is deterministic even though the encoded bytes are not:
 *
 *   0.0 –  1.5 s   quiet room tone            (establishes the noise floor)
 *   1.5 –  3.5 s   voice A (120 Hz)           speech region 1
 *   3.5 –  6.0 s   quiet                      a long, significant pause
 *   6.0 –  8.0 s   voice B (250 Hz)           speech region 2
 *   8.0 –  8.15 s  broadband impact           a percussive sound event
 *   8.15 – 10.0 s  quiet
 *  10.0 – 11.5 s   voice A (120 Hz)           speech region 3
 *
 * Picture: three flat-coloured "scenes" with a moving block, cutting at 4 s and
 * 8 s, so the temporal scanner has real cuts and real motion to find.
 */

import type { Page } from '@playwright/test';

export interface SyntheticClip {
  bytes: Buffer;
  mimeType: string;
  durationSeconds: number;
}

export interface SyntheticClipOptions {
  /** Total clip length. Keep it short: recording happens in real time. */
  durationSeconds?: number;
  width?: number;
  height?: number;
}

/**
 * Records a synthetic clip in `page` and returns its bytes.
 *
 * The page must already be on a document (any origin); nothing about the app is
 * used, only the browser's own encoders.
 */
export async function recordSyntheticClip(
  page: Page,
  options: SyntheticClipOptions = {},
): Promise<SyntheticClip> {
  const durationSeconds = options.durationSeconds ?? 12;
  const width = options.width ?? 320;
  const height = options.height ?? 180;

  const result = await page.evaluate(
    async ({ durationSeconds, width, height }) => {
      const sampleRate = 44_100;
      const total = Math.round(sampleRate * durationSeconds);

      // --- Audio: the same synthesis the WAV fixture uses ---------------------
      const context = new AudioContext({ sampleRate });
      const buffer = context.createBuffer(2, total, sampleRate);
      const left = buffer.getChannelData(0);

      const sec = (s: number) => Math.round(s * sampleRate);
      let seed = 7 >>> 0;
      const noise = (from: number, to: number, amplitude: number) => {
        for (let i = from; i < to && i < total; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          left[i]! += ((seed / 0xffffffff) * 2 - 1) * amplitude;
        }
      };
      const voice = (from: number, to: number, fundamental: number, amplitude: number) => {
        for (let i = from; i < to && i < total; i++) {
          const t = i / sampleRate;
          const syllable = 0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t);
          left[i]! +=
            amplitude *
            syllable *
            ((Math.sin(2 * Math.PI * fundamental * t) +
              0.5 * Math.sin(2 * Math.PI * fundamental * 2 * t) +
              0.25 * Math.sin(2 * Math.PI * fundamental * 3 * t)) /
              1.75);
        }
      };

      noise(0, total, 0.002);
      voice(sec(1.5), sec(3.5), 120, 0.5);
      voice(sec(6), sec(8), 250, 0.5);
      noise(sec(8), sec(8.15), 0.9);
      voice(sec(10), sec(11.5), 120, 0.5);
      buffer.getChannelData(1).set(left);

      const source = context.createBufferSource();
      source.buffer = buffer;
      const destination = context.createMediaStreamDestination();
      source.connect(destination);

      // --- Picture -----------------------------------------------------------
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const stream = canvas.captureStream(30);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

      const mimeType = MediaRecorder.isTypeSupported('video/mp4')
        ? 'video/mp4'
        : 'video/webm;codecs=vp8,opus';
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 400_000 });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.start();
      source.start();
      const startedAt = performance.now();

      await new Promise<void>((resolve) => {
        const draw = () => {
          const elapsed = (performance.now() - startedAt) / 1000;
          const scene = elapsed < 4 ? 0 : elapsed < 8 ? 1 : 2;
          ctx.fillStyle = ['#101a2c', '#e8c33a', '#12341f'][scene]!;
          ctx.fillRect(0, 0, width, height);
          ctx.fillStyle = scene === 1 ? '#221a05' : '#f4f4f4';
          const travel = (elapsed % 4) / 4;
          ctx.fillRect(travel * (width - 40), height / 2 - 20, 40, 40);
          if (elapsed < durationSeconds) requestAnimationFrame(draw);
          else resolve();
        };
        draw();
      });

      recorder.stop();
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      source.stop();
      await context.close();

      const blob = new Blob(chunks, { type: mimeType });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // Playwright can only bring back JSON, so hand the bytes over as numbers
      // in chunks small enough to serialize.
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step));
      }
      return { base64: btoa(binary), mimeType };
    },
    { durationSeconds, width, height },
  );

  return {
    bytes: Buffer.from(result.base64, 'base64'),
    mimeType: result.mimeType,
    durationSeconds,
  };
}

/** True when the recorder produced a real MP4 rather than the WebM fallback. */
export function isMp4(clip: SyntheticClip): boolean {
  return clip.mimeType.startsWith('video/mp4') && clip.bytes.subarray(4, 8).toString() === 'ftyp';
}
