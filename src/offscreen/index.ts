/**
 * Offscreen document controller.
 *
 * Owns the captured `MediaStream` and both analysis pipelines. Receives the
 * stream id from the service worker (which obtained it from a user gesture),
 * resolves it into a real stream here, and tears everything down on stop.
 *
 * Nothing in this file writes media to disk. The only bytes that persist beyond
 * a few seconds are derived evidence — timestamps, scores, text.
 */

import { createIdFactory } from '../utils/id';
import { errorDetail, FrameScriptError } from '../utils/errors';
import type { EvidenceEvent, EvidenceSourceStatus } from '../evidence/types';
import { profileFor, type AnalysisFidelity } from '../temporal/fidelity';
import { onRuntimeMessage, sendRuntime } from '../messaging/bus';
import type { WorkerToOffscreen } from '../messaging/protocol';
import { MediaClock } from './mediaClock';
import { AudioPipeline } from './audioPipeline';
import { VideoPipeline } from './videoPipeline';
import { settingsStore } from '../settings/store';
import type { FrameScriptSettings } from '../settings/types';
import { InferenceCoordinator } from '../ai/coordinator';
import { visionAnalysisToEvidence } from '../ai/evidenceMapping';
import { LocalHeuristicVisionProvider } from '../ai/providers/local';
import { AnthropicVisionProvider } from '../ai/providers/anthropic';
import { OpenAiCompatibleAsrProvider } from '../ai/providers/openaiCompatible';
import type { SpeechRecognitionProvider, VisionAnalysisProvider, VisionFrame } from '../ai/types';
import type { DeepAnalysisRequest } from '../temporal/TemporalScanner';

const nextId = createIdFactory('deep');

/** Batches evidence so the message port is not hit ten times a second. */
class EvidenceBatcher {
  #pending: EvidenceEvent[] = [];
  #handle: ReturnType<typeof setTimeout> | null = null;
  #flushMs: number;
  #maxBatch: number;

  constructor(flushMs = 400, maxBatch = 120) {
    this.#flushMs = flushMs;
    this.#maxBatch = maxBatch;
  }

  push(events: EvidenceEvent[]): void {
    this.#pending.push(...events);
    if (this.#pending.length >= this.#maxBatch) {
      this.flush();
      return;
    }
    this.#handle ??= setTimeout(() => this.flush(), this.#flushMs);
  }

  flush(): void {
    if (this.#handle !== null) {
      clearTimeout(this.#handle);
      this.#handle = null;
    }
    if (this.#pending.length === 0) return;
    const events = this.#pending.splice(0);
    void sendRuntime({ type: 'offscreen/evidence', payload: { events } });
  }
}

class OffscreenController {
  #clock = new MediaClock();
  #batcher = new EvidenceBatcher();
  #audio: AudioPipeline | null = null;
  #video: VideoPipeline | null = null;
  #stream: MediaStream | null = null;
  #coordinator: InferenceCoordinator | null = null;
  #settings: FrameScriptSettings | null = null;
  #fidelity: AnalysisFidelity = 'detailed';
  #statsHandle: ReturnType<typeof setInterval> | null = null;
  #visionProvider: VisionAnalysisProvider = new LocalHeuristicVisionProvider();

  async handle(message: WorkerToOffscreen): Promise<unknown> {
    switch (message.type) {
      case 'offscreen/start':
        return this.#start(message.payload);
      case 'offscreen/stop':
        await this.#stop();
        return { ok: true };
      case 'offscreen/pause':
        this.#audio?.pause();
        this.#video?.pause();
        return { ok: true };
      case 'offscreen/resume':
        this.#audio?.resume();
        this.#video?.resume();
        return { ok: true };
      case 'offscreen/media-time':
        this.#clock.update({
          mediaTimeMs: message.payload.currentTimeMs,
          playing: message.payload.playing,
        });
        return { ok: true };
      case 'offscreen/configure':
        this.#fidelity = message.payload.fidelity;
        return { ok: true };
      default:
        return undefined;
    }
  }

  async #start(payload: {
    streamId: string;
    tabId: number;
    fidelity: AnalysisFidelity;
    sources: Record<string, boolean>;
  }): Promise<{ ok: boolean; message?: string }> {
    await this.#stop();
    this.#fidelity = payload.fidelity;
    this.#settings = await settingsStore.get();

    const wantAudio = payload.sources.audio !== false;
    const wantVideo = payload.sources.video !== false;

    let stream: MediaStream;
    try {
      // The tab-capture constraint shape is Chrome-specific and not in the
      // standard MediaStreamConstraints type.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: wantAudio
          ? ({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: payload.streamId } } as never)
          : false,
        video: wantVideo
          ? ({ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: payload.streamId } } as never)
          : false,
      });
    } catch (err) {
      const message = 'Chrome declined to share this tab’s media with FrameScript.';
      void sendRuntime({
        type: 'offscreen/error',
        payload: { code: 'TAB_CAPTURE_FAILED', message },
      });
      console.error('[FrameScript] tab capture failed:', errorDetail(err));
      return { ok: false, message };
    }

    this.#stream = stream;
    this.#buildProviders();

    const statuses: EvidenceSourceStatus[] = [];
    const profile = profileFor(this.#fidelity);

    if (wantAudio) {
      const asrProvider = this.#buildAsrProvider();
      this.#audio = new AudioPipeline({
        clock: this.#clock,
        emit: (events) => this.#batcher.push(events),
        ...(asrProvider ? { asrProvider } : {}),
        enableSoundEvents: payload.sources.soundEvents !== false,
      });
      const started = await this.#audio
        .start(stream, chrome.runtime.getURL('offscreen/audioWorklet.js'))
        .catch((err: unknown) => {
          console.error('[FrameScript] audio pipeline failed:', errorDetail(err));
          return false;
        });

      statuses.push({
        id: 'audio-asr',
        state: started ? (asrProvider ? 'active' : 'unavailable') : 'failed',
        eventCount: 0,
        ...(asrProvider
          ? {}
          : {
              message:
                'No speech recognition provider is configured, so dialogue comes from platform subtitles only.',
            }),
      });
      statuses.push({ id: 'audio-speaker', state: started ? 'active' : 'unavailable', eventCount: 0 });
      statuses.push({
        id: 'audio-event',
        state: started && payload.sources.soundEvents !== false ? 'active' : 'unavailable',
        eventCount: 0,
      });
      statuses.push({ id: 'audio-silence', state: started ? 'active' : 'unavailable', eventCount: 0 });
    }

    if (wantVideo) {
      this.#video = new VideoPipeline({
        clock: this.#clock,
        profile,
        emit: (events) => this.#batcher.push(events),
        onDeepAnalysis: (request, frames) => void this.#analyzeWindow(request, frames),
        onProtectedContent: () => {
          void sendRuntime({
            type: 'offscreen/source-status',
            payload: {
              statuses: [
                {
                  id: 'video',
                  state: 'protected-content',
                  eventCount: 0,
                  message:
                    'The video image is not available in this protected playback environment. Subtitle and audio analysis continue.',
                },
              ],
            },
          });
        },
      });
      const started = await this.#video.start(stream).catch(() => false);
      statuses.push({ id: 'video', state: started ? 'active' : 'unavailable', eventCount: 0 });
      statuses.push({
        id: 'ocr',
        state: this.#ocrAvailable() ? 'active' : 'unsupported',
        eventCount: 0,
        ...(this.#ocrAvailable()
          ? {}
          : { message: 'On-screen text is detected but not read. Enable an AI provider in Settings to read it.' }),
      });
    }

    void sendRuntime({ type: 'offscreen/source-status', payload: { statuses } });
    this.#startStatsReporting();
    return { ok: true };
  }

  async #stop(): Promise<void> {
    this.#batcher.flush();
    if (this.#statsHandle !== null) {
      clearInterval(this.#statsHandle);
      this.#statsHandle = null;
    }
    this.#coordinator?.clear();
    this.#coordinator = null;

    await this.#audio?.stop();
    this.#audio = null;
    await this.#video?.stop();
    this.#video = null;

    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#clock.reset();
  }

  /**
   * Constructs the vision provider from settings.
   *
   * Remote providers require BOTH the master remote-AI switch and explicit
   * consent. Without both, the local heuristic provider is used and nothing
   * leaves the device.
   */
  #buildProviders(): void {
    const settings = this.#settings;
    const remoteAllowed = settings?.ai.remoteEnabled === true && settings.ai.consentAcknowledged === true;

    if (remoteAllowed && settings.ai.vision.provider === 'anthropic' && settings.ai.vision.apiKey) {
      this.#visionProvider = new AnthropicVisionProvider({
        apiKey: settings.ai.vision.apiKey,
        model: settings.ai.vision.model,
        ...(settings.ai.vision.baseUrl ? { baseUrl: settings.ai.vision.baseUrl } : {}),
      });
    } else {
      this.#visionProvider = new LocalHeuristicVisionProvider();
    }
    this.#coordinator = new InferenceCoordinator({ provider: this.#visionProvider });
  }

  #buildAsrProvider(): SpeechRecognitionProvider | undefined {
    const settings = this.#settings;
    const remoteAllowed = settings?.ai.remoteEnabled === true && settings.ai.consentAcknowledged === true;
    if (!remoteAllowed) return undefined;
    if (settings.ai.asr.provider !== 'openai-compatible') return undefined;
    if (!settings.ai.asr.apiKey || !settings.ai.asr.endpoint) return undefined;

    return new OpenAiCompatibleAsrProvider({
      apiKey: settings.ai.asr.apiKey,
      endpoint: settings.ai.asr.endpoint,
      model: settings.ai.asr.model,
    });
  }

  #ocrAvailable(): boolean {
    const settings = this.#settings;
    return (
      settings?.ai.remoteEnabled === true &&
      settings.ai.consentAcknowledged === true &&
      settings.ai.useProviderForOcr === true &&
      settings.ai.vision.provider !== 'none'
    );
  }

  /**
   * Sends a window for deep analysis and converts the structured result into
   * evidence.
   *
   * The coordinator may return null — dropped under load, or the circuit
   * breaker is open. That is a normal degraded state: local temporal evidence
   * still flows, the screenplay is just thinner.
   */
  async #analyzeWindow(request: DeepAnalysisRequest, frames: VisionFrame[]): Promise<void> {
    const coordinator = this.#coordinator;
    if (!coordinator || frames.length === 0) return;

    const start = frames[0]!.timestamp;
    const end = request.timestamp;

    const analysis = await coordinator.submit(
      {
        start,
        end,
        frames,
        metrics: request.metrics,
        dialogue: [],
        soundEvents: [],
        knownCharacters: [],
        ...(request.textLikely && this.#ocrAvailable() ? { requestOcr: true } : {}),
      },
      request.importance,
    );
    if (!analysis) return;

    // Mapping lives in `src/ai/evidenceMapping.ts` so the extension and Web
    // Studio turn provider output into evidence the same way.
    const events = visionAnalysisToEvidence(analysis, { start, end }, {
      ...(request.metrics ? { metrics: request.metrics } : {}),
      importance: request.importance,
      idFactory: nextId,
    });

    if (events.length > 0) this.#batcher.push(events);
  }

  #startStatsReporting(): void {
    this.#statsHandle = setInterval(() => {
      const stats = this.#video?.stats;
      void sendRuntime({
        type: 'offscreen/stats',
        payload: {
          observedFps: stats?.observedFps ?? 0,
          deepRequests: stats?.deepRequests ?? 0,
          queueLength: this.#coordinator?.stats.queued ?? 0,
          droppedFrames: stats?.droppedKeyframes ?? 0,
        },
      });
    }, 2_000);
  }
}

const controller = new OffscreenController();

onRuntimeMessage<WorkerToOffscreen>((message) => {
  if (!message.type.startsWith('offscreen/')) return undefined;
  return controller.handle(message).catch((err: unknown) => {
    console.error('[FrameScript] offscreen handler failed:', errorDetail(err));
    return {
      ok: false,
      code: FrameScriptError.is(err) ? err.code : 'OFFSCREEN_FAILED',
    };
  });
});

void sendRuntime({ type: 'offscreen/ready', payload: undefined });
