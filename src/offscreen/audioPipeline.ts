/**
 * Audio analysis pipeline.
 *
 * Builds the Web Audio graph and runs VAD, diarization, silence and sound-event
 * detection over the captured tab audio.
 *
 * The single most important property of this file: **normal playback audio must
 * keep working.** `tabCapture` moves the tab's audio into the captured stream,
 * so unless the graph reconnects it to the destination the viewer hears
 * nothing. The worklet passes audio through and the node is connected to
 * `destination`; the gain is never touched.
 */

import { createIdFactory } from '../utils/id';
import type { MediaTimeMs } from '../utils/time';
import type {
  EvidenceEvent,
  SilenceEvidence,
  SoundEvidence,
  SpeakerEvidence,
  SpeechEvidence,
} from '../evidence/types';
import { VoiceActivityDetector, type SpeechRegion } from '../audio/vad';
import { SoundEventDetector } from '../audio/soundEvents';
import { SpeakerDiarizer } from '../audio/diarization';
import { findSilences } from '../audio/silence';
import type { SpeechRecognitionProvider } from '../ai/types';
import type { MediaClock } from './mediaClock';
import { errorDetail } from '../utils/errors';

export interface AudioPipelineOptions {
  clock: MediaClock;
  emit: (events: EvidenceEvent[]) => void;
  /** Optional ASR provider; absent means dialogue comes from subtitles only. */
  asrProvider?: SpeechRecognitionProvider;
  enableSoundEvents?: boolean;
  /** Seconds of audio retained for a pending ASR window. Bounded on purpose. */
  maxPendingSeconds?: number;
}

const nextId = createIdFactory('audio');

export class AudioPipeline {
  #context: AudioContext | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #worklet: AudioWorkletNode | null = null;
  #stream: MediaStream | null = null;

  #vad: VoiceActivityDetector | null = null;
  #soundDetector: SoundEventDetector | null = null;
  #diarizer: SpeakerDiarizer | null = null;

  #options: AudioPipelineOptions;
  #sampleRate = 48_000;
  #running = false;
  #paused = false;

  /** Ring of recent samples so a completed speech region can be re-read. */
  #recent: Float32Array[] = [];
  #recentStartMs: MediaTimeMs | null = null;
  #maxPendingSamples = 0;

  #speechRegions: SpeechRegion[] = [];
  #lastSilenceEmittedAt = -1;
  #asrInFlight = 0;
  #maxAsrConcurrency = 2;

  constructor(options: AudioPipelineOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#running;
  }

  get sampleRate(): number {
    return this.#sampleRate;
  }

  /**
   * Starts the graph.
   *
   * Returns false when the stream carries no audio track — a legitimate state
   * that the caller reports as `audio: unavailable` rather than an error.
   */
  async start(stream: MediaStream, workletUrl: string): Promise<boolean> {
    if (this.#running) return true;
    if (stream.getAudioTracks().length === 0) return false;

    this.#stream = stream;
    const context = new AudioContext();
    this.#context = context;
    this.#sampleRate = context.sampleRate;
    this.#maxPendingSamples = Math.round(this.#sampleRate * (this.#options.maxPendingSeconds ?? 35));

    await context.audioWorklet.addModule(workletUrl);

    this.#source = context.createMediaStreamSource(stream);
    this.#worklet = new AudioWorkletNode(context, 'framescript-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    // Analysis tap and, critically, the path back to the speakers.
    this.#source.connect(this.#worklet);
    this.#worklet.connect(context.destination);

    this.#vad = new VoiceActivityDetector({ sampleRate: this.#sampleRate });
    this.#soundDetector = new SoundEventDetector({ sampleRate: this.#sampleRate });
    this.#diarizer = new SpeakerDiarizer({ sampleRate: this.#sampleRate });

    this.#worklet.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { samples: Float32Array; wallTimeSeconds: number } | null;
      if (!data?.samples) return;
      this.#handleBlock(data.samples, data.wallTimeSeconds);
    };

    // Chrome starts AudioContexts suspended in some contexts; without this the
    // graph — including the passthrough — would never run.
    if (context.state === 'suspended') await context.resume();

    this.#running = true;
    return true;
  }

  pause(): void {
    this.#paused = true;
    this.#flushPending();
  }

  resume(): void {
    this.#paused = false;
  }

  /** Closes the graph and drops every retained sample. */
  async stop(): Promise<void> {
    this.#running = false;
    this.#flushPending();

    if (this.#worklet) {
      this.#worklet.port.onmessage = null;
      this.#worklet.disconnect();
      this.#worklet = null;
    }
    this.#source?.disconnect();
    this.#source = null;

    if (this.#context && this.#context.state !== 'closed') {
      await this.#context.close().catch(() => undefined);
    }
    this.#context = null;

    for (const track of this.#stream?.getAudioTracks() ?? []) track.stop();
    this.#stream = null;

    // Raw audio retention is off by default and there is no code path that
    // persists it; dropping the ring here makes that structural.
    this.#recent = [];
    this.#recentStartMs = null;
    this.#speechRegions = [];
    this.#vad?.reset();
    this.#soundDetector?.reset();
    this.#diarizer?.reset();
  }

  #handleBlock(samples: Float32Array, wallTimeSeconds: number): void {
    if (!this.#running || this.#paused) return;

    const mediaTime = this.#options.clock.at(wallTimeSeconds * 1000) ?? this.#options.clock.now();
    if (mediaTime === null) return; // No reliable media time: drop rather than misalign.

    this.#retain(samples, mediaTime);

    const vad = this.#vad;
    if (vad) {
      const { regions } = vad.push(samples, mediaTime);
      for (const region of regions) this.#handleSpeechRegion(region);
    }

    if (this.#options.enableSoundEvents !== false && this.#soundDetector) {
      const onsets = this.#soundDetector.push(samples, mediaTime);
      for (const onset of onsets) {
        const event: SoundEvidence = {
          id: nextId(),
          source: 'audio-event',
          start: onset.timestamp,
          end: onset.timestamp + 250,
          // A local acoustic classification is a weak signal and says so.
          confidence: onset.classified ? 'low' : 'unknown',
          provisional: false,
          payload: {
            kind: onset.kind,
            prominenceDb: Math.round(onset.prominenceDb * 10) / 10,
          },
        };
        this.#options.emit([event]);
      }
    }
  }

  /** Keeps a bounded window of recent audio for completed-region analysis. */
  #retain(samples: Float32Array, mediaTime: MediaTimeMs): void {
    if (this.#recentStartMs === null) this.#recentStartMs = mediaTime;
    this.#recent.push(samples);

    let total = this.#recent.reduce((sum, chunk) => sum + chunk.length, 0);
    while (total > this.#maxPendingSamples && this.#recent.length > 1) {
      const dropped = this.#recent.shift();
      if (!dropped) break;
      total -= dropped.length;
      this.#recentStartMs += Math.round((dropped.length / this.#sampleRate) * 1000);
    }
  }

  #extract(start: MediaTimeMs, end: MediaTimeMs): Float32Array | null {
    if (this.#recentStartMs === null) return null;
    const offsetSamples = Math.round(((start - this.#recentStartMs) / 1000) * this.#sampleRate);
    const lengthSamples = Math.round(((end - start) / 1000) * this.#sampleRate);
    if (offsetSamples < 0 || lengthSamples <= 0) return null;

    const flat = new Float32Array(this.#recent.reduce((sum, chunk) => sum + chunk.length, 0));
    let cursor = 0;
    for (const chunk of this.#recent) {
      flat.set(chunk, cursor);
      cursor += chunk.length;
    }
    if (offsetSamples + lengthSamples > flat.length) return null;
    return flat.subarray(offsetSamples, offsetSamples + lengthSamples);
  }

  #handleSpeechRegion(region: SpeechRegion): void {
    this.#speechRegions.push(region);
    if (this.#speechRegions.length > 500) this.#speechRegions.splice(0, 100);

    const samples = this.#extract(region.start, region.end);

    // Diarization: anonymous voice clustering, never identification.
    if (samples && this.#diarizer) {
      const assignment = this.#diarizer.assign(samples, region.start, region.end);
      if (assignment) {
        const event: SpeakerEvidence = {
          id: nextId(),
          source: 'audio-speaker',
          start: assignment.start,
          end: assignment.end,
          confidence: assignment.confidence,
          provisional: false,
          payload: {
            speakerId: assignment.speakerId,
            distance: Math.round(assignment.distance * 1000) / 1000,
            ...(assignment.turnChange ? { turnChange: true } : {}),
          },
        };
        this.#options.emit([event]);
      }
    }

    // Silence between utterances, evaluated against the local rhythm.
    const silences = findSilences(this.#speechRegions.slice(-12));
    for (const gap of silences) {
      if (!gap.significant || gap.start <= this.#lastSilenceEmittedAt) continue;
      this.#lastSilenceEmittedAt = gap.start;
      const event: SilenceEvidence = {
        id: nextId(),
        source: 'audio-silence',
        start: gap.start,
        end: gap.end,
        confidence: 'medium',
        provisional: false,
        payload: { durationMs: gap.durationMs, significant: true },
      };
      this.#options.emit([event]);
    }

    if (samples) void this.#transcribe(samples, region);
  }

  /**
   * Sends one speech region to the ASR provider.
   *
   * Concurrency is capped so that a slow provider cannot build an unbounded
   * backlog. Over the cap, the region is simply not transcribed — subtitles
   * still carry the dialogue, and dropping is far better than queueing minutes
   * of audio in memory.
   */
  async #transcribe(samples: Float32Array, region: SpeechRegion): Promise<void> {
    const provider = this.#options.asrProvider;
    if (!provider) return;
    if (this.#asrInFlight >= this.#maxAsrConcurrency) return;

    // Copy: the ring buffer this view points into will be recycled.
    const copy = new Float32Array(samples);
    this.#asrInFlight++;
    try {
      const result = await provider.transcribe({
        samples: copy,
        sampleRate: this.#sampleRate,
        start: region.start,
        end: region.end,
      });
      if (!result?.text) return;

      const event: SpeechEvidence = {
        id: nextId(),
        source: 'audio-asr',
        start: region.start,
        end: region.end,
        confidence: 'medium',
        provisional: false,
        payload: {
          text: result.text,
          ...(result.language ? { language: result.language } : {}),
          ...(result.providerScore === undefined ? {} : { providerScore: result.providerScore }),
        },
      };
      this.#options.emit([event]);
    } catch (err) {
      console.warn('[FrameScript] transcription failed:', errorDetail(err));
    } finally {
      this.#asrInFlight--;
    }
  }

  #flushPending(): void {
    const region = this.#vad?.flush();
    if (region) this.#handleSpeechRegion(region);
  }
}
