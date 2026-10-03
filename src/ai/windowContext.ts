/**
 * Dialogue and sound context for a vision window.
 *
 * A vision model shown three seconds of picture with no words attached has to
 * guess what the scene is about. The evidence timeline usually already knows:
 * a subtitle cue or a transcribed line was on screen at the same moment. This
 * module selects that evidence for a window so both the extension and Studio
 * hand the model the same context.
 *
 * Context is attached as context only. The provider's answer is still clamped
 * into the window, marked inferred, and fused like any other evidence — a
 * dialogue line shown to the model never becomes an action by itself.
 */

import type { EvidenceEvent, SoundEvidence, SpeechEvidence, SubtitleEvidence } from '../evidence/types';
import type { MediaTimeMs } from '../utils/time';
import type { VisionWindowRequest } from './types';

/** A line spoken just before a window often explains what the window shows. */
export const DIALOGUE_LEAD_IN_MS = 2_000;
const MAX_DIALOGUE = 12;
const MAX_SOUNDS = 12;

type WindowDialogue = VisionWindowRequest['dialogue'][number];
type WindowSound = VisionWindowRequest['soundEvents'][number];

function overlaps(event: EvidenceEvent, start: MediaTimeMs, end: MediaTimeMs): boolean {
  return event.start < end && (event.end ?? event.start) >= start;
}

/**
 * Dialogue that overlaps the window or ends shortly before it.
 *
 * Platform subtitles and transcribed speech are both dialogue. Bracketed
 * non-speech captions ("[door slams]") are not, and are left out. Start times
 * are clamped into the window so every offset the model sees is non-negative.
 */
export function dialogueInWindow(
  events: readonly EvidenceEvent[],
  start: MediaTimeMs,
  end: MediaTimeMs,
): WindowDialogue[] {
  const from = Math.max(0, start - DIALOGUE_LEAD_IN_MS);
  return events
    .filter(
      (event): event is SubtitleEvidence | SpeechEvidence =>
        (event.source === 'subtitle' && event.payload.nonSpeech !== true) ||
        event.source === 'audio-asr',
    )
    .filter((event) => event.payload.text.trim().length > 0 && overlaps(event, from, end))
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_DIALOGUE)
    .map((event) => {
      const speaker =
        event.source === 'subtitle' ? event.payload.speakerLabel : event.payload.speakerId;
      return {
        start: Math.min(Math.max(event.start, start), end),
        ...(speaker ? { speakerId: speaker } : {}),
        text: event.payload.text,
      };
    });
}

/** Detected sound events that overlap the window. */
export function soundsInWindow(
  events: readonly EvidenceEvent[],
  start: MediaTimeMs,
  end: MediaTimeMs,
): WindowSound[] {
  return events
    .filter((event): event is SoundEvidence => event.source === 'audio-event')
    .filter((event) => overlaps(event, start, end))
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_SOUNDS)
    .map((event) => ({
      start: Math.min(Math.max(event.start, start), end),
      kind: event.payload.kind,
      ...(event.payload.description ? { description: event.payload.description } : {}),
    }));
}

const CONTEXT_SOURCES = new Set<EvidenceEvent['source']>(['subtitle', 'audio-asr', 'audio-event']);

/**
 * A bounded memory of recent dialogue and sound evidence.
 *
 * The extension's offscreen document analyzes picture windows live and does
 * not hold the session timeline, so it keeps just enough recent context here
 * to describe the window it is about to send. Old entries fall out by media
 * time and by count, so memory stays flat over a feature-length film.
 */
export class RecentWindowContext {
  #events: EvidenceEvent[] = [];
  #horizonMs: number;
  #maxEvents: number;

  constructor(options: { horizonMs?: number; maxEvents?: number } = {}) {
    this.#horizonMs = options.horizonMs ?? 90_000;
    this.#maxEvents = options.maxEvents ?? 400;
  }

  record(events: readonly EvidenceEvent[]): void {
    let latest = -Infinity;
    for (const event of events) {
      if (!CONTEXT_SOURCES.has(event.source)) continue;
      this.#events.push(event);
      latest = Math.max(latest, event.end ?? event.start);
    }
    if (latest === -Infinity) return;

    const cutoff = latest - this.#horizonMs;
    this.#events = this.#events.filter((event) => (event.end ?? event.start) >= cutoff);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  /** Drops everything, e.g. after a seek or when analysis stops. */
  clear(): void {
    this.#events = [];
  }

  get size(): number {
    return this.#events.length;
  }

  forWindow(
    start: MediaTimeMs,
    end: MediaTimeMs,
  ): Pick<VisionWindowRequest, 'dialogue' | 'soundEvents'> {
    return {
      dialogue: dialogueInWindow(this.#events, start, end),
      soundEvents: soundsInWindow(this.#events, start, end),
    };
  }
}
