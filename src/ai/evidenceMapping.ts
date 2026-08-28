/**
 * Provider output → evidence.
 *
 * This is the seam that keeps FrameScript's central claim true: **AI acquires
 * evidence; the deterministic engine writes the screenplay.** A model never
 * produces a beat, a scene heading, or a line of dialogue. It produces
 * timestamped evidence, which then goes through exactly the same timeline,
 * fusion and scene construction as a subtitle file.
 *
 * Two consequences are enforced here rather than by convention:
 *
 *   1. Every event a model contributed is marked `inferred`, so provenance can
 *      distinguish "we measured this" from "a model said this".
 *   2. Timestamps are clamped into the window the evidence came from. A model
 *      that reports an offset past the end of its own window cannot move a
 *      line somewhere it was never observed.
 *
 * The extension and Web Studio both call this. Neither has its own copy.
 */

import { createIdFactory } from '../utils/id';
import { clamp, overlapDuration, type MediaTimeMs, type TimeRange } from '../utils/time';
import { fromScore } from '../evidence/confidence';
import type {
  ConfidenceLevel,
  EvidenceEvent,
  OcrEvidence,
  SpeakerEvidence,
  SpeechEvidence,
  TemporalMetrics,
  VisualEvidence,
} from '../evidence/types';
import type { AsrResult, VisionWindowAnalysis } from './types';

// --- Speech -------------------------------------------------------------------

export interface TranscriptMappingOptions {
  /** Speaker clusters already assigned locally, used to attribute the line. */
  speakers?: readonly SpeakerEvidence[];
  /** Confidence for a provider that reports no calibrated score. */
  defaultConfidence?: ConfidenceLevel;
  idFactory?: () => string;
}

const defaultIds = createIdFactory('asr');

/**
 * Picks the speaker cluster that overlaps a range the most.
 *
 * Returns undefined rather than a guess when nothing overlaps: an unattributed
 * line is honest, and the screenplay renderer already has a neutral form for it.
 */
export function speakerForRange(
  speakers: readonly SpeakerEvidence[],
  range: TimeRange,
): string | undefined {
  let best: { id: string; overlap: number } | undefined;
  for (const speaker of speakers) {
    const overlap = overlapDuration(range, {
      start: speaker.start,
      end: speaker.end ?? speaker.start,
    });
    if (overlap <= 0) continue;
    if (!best || overlap > best.overlap) best = { id: speaker.payload.speakerId, overlap };
  }
  return best?.id;
}

/**
 * Converts one transcription result into speech evidence.
 *
 * When the provider returned segment timestamps they are used, because a
 * 20-second window transcribed as one blob is one very long "line" that fuses
 * badly against subtitles. Segments are clamped into the window; a provider
 * cannot place text outside the audio it was given.
 *
 * Empty text yields no evidence at all. "Someone spoke" is already recorded by
 * the speaker and VAD evidence — an empty transcript must not become a line.
 */
export function transcriptToEvidence(
  window: TimeRange,
  result: AsrResult,
  options: TranscriptMappingOptions = {},
): SpeechEvidence[] {
  const nextId = options.idFactory ?? defaultIds;
  const confidence = options.defaultConfidence ?? 'medium';
  const speakers = options.speakers ?? [];

  const pieces: { start: MediaTimeMs; end: MediaTimeMs; text: string }[] = [];
  const segments = (result.segments ?? []).filter((segment) => segment.text.trim().length > 0);

  if (segments.length > 0) {
    for (const segment of segments) {
      const start = clamp(window.start + Math.round(segment.startMs), window.start, window.end);
      const end = clamp(window.start + Math.round(segment.endMs), start, window.end);
      pieces.push({
        start,
        end: end > start ? end : Math.min(window.end, start + 500),
        text: segment.text.trim(),
      });
    }
  } else {
    const text = result.text.trim();
    if (text) pieces.push({ start: window.start, end: window.end, text });
  }

  return pieces
    .filter((piece) => piece.text.length > 0)
    .map((piece) => {
      const speakerId = speakerForRange(speakers, piece);
      const event: SpeechEvidence = {
        id: nextId(),
        source: 'audio-asr',
        start: piece.start,
        end: piece.end,
        confidence,
        provisional: false,
        payload: {
          text: piece.text,
          ...(result.language ? { language: result.language } : {}),
          ...(speakerId ? { speakerId } : {}),
          ...(result.providerScore === undefined ? {} : { providerScore: result.providerScore }),
        },
      };
      return event;
    });
}

// --- Vision -------------------------------------------------------------------

export interface VisionMappingOptions {
  metrics?: TemporalMetrics;
  /** Local salience of the window, used when the provider reports none. */
  importance?: number;
  idFactory?: () => string;
}

const defaultVisionIds = createIdFactory('vis');

/**
 * Converts a validated vision analysis into visual and OCR evidence.
 *
 * Setting observations become `setting` evidence rather than a scene heading:
 * headings are the scene builder's decision, made from all sources at once.
 */
export function visionAnalysisToEvidence(
  analysis: VisionWindowAnalysis,
  window: TimeRange,
  options: VisionMappingOptions = {},
): EvidenceEvent[] {
  const nextId = options.idFactory ?? defaultVisionIds;
  const span = Math.max(0, window.end - window.start);
  const events: EvidenceEvent[] = [];

  for (const action of analysis.actions) {
    const description = action.description.trim();
    if (!description) continue;
    const event: VisualEvidence = {
      id: nextId(),
      source: 'video',
      start: window.start + clamp(action.offsetMs, 0, span),
      end: window.end,
      confidence: action.confidence,
      provisional: false,
      payload: {
        kind: 'action',
        description,
        ...(options.metrics ? { metrics: options.metrics } : {}),
        inferred: true,
        ...(action.participants.length > 0 ? { participantIds: action.participants } : {}),
      },
    };
    events.push(event);
  }

  for (const setting of analysis.settingChanges) {
    const description = [
      setting.interiorExterior && setting.interiorExterior !== 'UNKNOWN'
        ? setting.interiorExterior
        : '',
      setting.description.trim(),
      setting.timeOfDay ?? '',
    ]
      .filter((part) => part.length > 0)
      .join(' ')
      .trim();
    if (!description) continue;
    const event: VisualEvidence = {
      id: nextId(),
      source: 'video',
      start: window.start,
      end: window.end,
      confidence: setting.confidence,
      provisional: false,
      payload: { kind: 'setting', description, inferred: true },
    };
    events.push(event);
  }

  for (const text of analysis.text) {
    const value = text.text.trim();
    if (!value) continue;
    const event: OcrEvidence = {
      id: nextId(),
      source: 'ocr',
      start: window.start + clamp(text.offsetMs, 0, span),
      confidence: fromScore(options.importance ?? 0.5),
      provisional: false,
      payload: { text: value },
    };
    events.push(event);
  }

  return events;
}
