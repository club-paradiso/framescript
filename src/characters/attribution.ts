/**
 * Speaker attribution.
 *
 * Decides who said a line, using a strict priority order. The order matters
 * more than any individual heuristic, because it encodes what FrameScript is
 * willing to assert:
 *
 *   1. an explicit speaker label in the subtitle track   (the author wrote it)
 *   2. a user correction                                  (the viewer knows)
 *   3. diarization agreeing with visual evidence          (two sources agree)
 *   4. diarization alone                                  (one weak source)
 *   5. dialogue context — strict alternation in a two-hander
 *   6. unknown
 *
 * Level 6 is a real, acceptable outcome. An "UNKNOWN SPEAKER" cue is better
 * than a confidently wrong name.
 */

import { temporalIou, type MediaTimeMs } from '../utils/time';
import type { ConfidenceLevel } from '../evidence/types';
import type { CharacterRegistry } from './entities';

export type AttributionMethod =
  | 'subtitle-label'
  | 'user-correction'
  | 'diarization-visual'
  | 'diarization'
  | 'dialogue-context'
  | 'unknown';

export interface AttributionResult {
  characterId?: string;
  speakerId?: string;
  method: AttributionMethod;
  confidence: ConfidenceLevel;
}

export interface AttributionInput {
  start: MediaTimeMs;
  end: MediaTimeMs;
  /** Speaker name parsed out of the subtitle cue, e.g. "JANE" from "JANE: hi". */
  subtitleSpeakerLabel?: string;
  /** Explicit user assignment for this exact line. */
  userCharacterId?: string;
  /** Diarization output overlapping this line. */
  speakerCandidates?: { speakerId: string; start: MediaTimeMs; end: MediaTimeMs; confidence: ConfidenceLevel }[];
  /** Visual evidence: characters observed on screen and apparently speaking. */
  visualSpeakerIds?: string[];
  /** The character attributed to the previous line, for alternation inference. */
  previousCharacterId?: string;
  /** Characters known to be present in the scene. */
  presentCharacterIds?: string[];
}

export function attributeSpeaker(
  input: AttributionInput,
  registry: CharacterRegistry,
): AttributionResult {
  // 1. The subtitle track named the speaker.
  if (input.subtitleSpeakerLabel) {
    const character = registry.ensureForName(input.subtitleSpeakerLabel, input.start, 'subtitle');
    return { characterId: character.id, method: 'subtitle-label', confidence: 'high' };
  }

  // 2. The user said so.
  if (input.userCharacterId && registry.get(input.userCharacterId)) {
    return { characterId: input.userCharacterId, method: 'user-correction', confidence: 'high' };
  }

  const best = bestSpeakerCandidate(input);

  // 3. Diarization plus visual agreement.
  if (best) {
    const character = registry.ensureForSpeaker(best.speakerId, input.start);
    const visuallyConfirmed =
      input.visualSpeakerIds?.some((id) => character.visualClusterIds.includes(id)) ?? false;
    if (visuallyConfirmed) {
      return {
        characterId: character.id,
        speakerId: best.speakerId,
        method: 'diarization-visual',
        confidence: 'high',
      };
    }
    // 4. Diarization alone: a real signal, but a single weak one.
    return {
      characterId: character.id,
      speakerId: best.speakerId,
      method: 'diarization',
      confidence: best.confidence === 'high' ? 'medium' : 'low',
    };
  }

  // 5. Two-hander alternation. Only applied when exactly two characters are
  // present, because alternation is a real convention in a two-person scene and
  // pure guesswork in a crowd.
  if (input.presentCharacterIds?.length === 2 && input.previousCharacterId) {
    const other = input.presentCharacterIds.find((id) => id !== input.previousCharacterId);
    if (other) {
      return { characterId: other, method: 'dialogue-context', confidence: 'low' };
    }
  }

  return { method: 'unknown', confidence: 'unknown' };
}

function bestSpeakerCandidate(
  input: AttributionInput,
): { speakerId: string; confidence: ConfidenceLevel; overlap: number } | null {
  const candidates = input.speakerCandidates ?? [];
  if (candidates.length === 0) return null;

  const line = { start: input.start, end: input.end };
  let best: { speakerId: string; confidence: ConfidenceLevel; overlap: number } | null = null;

  for (const candidate of candidates) {
    const overlap = temporalIou(line, { start: candidate.start, end: candidate.end });
    if (overlap <= 0.1) continue;
    if (!best || overlap > best.overlap) {
      best = { speakerId: candidate.speakerId, confidence: candidate.confidence, overlap };
    }
  }
  return best;
}

/**
 * Extracts an inline speaker label from a subtitle cue.
 *
 * Handles the conventions caption authors actually use:
 *   `JANE: Where are you?`   `- JANE: Hi`   `[JANE] Hi`   `(JANE) Hi`
 *
 * Deliberately conservative: the label must be short and mostly upper case, so
 * that "NOTE: this is important" spoken as dialogue is not mistaken for a
 * character named NOTE.
 */
export function extractSpeakerLabel(text: string): { speaker?: string; remainder: string } {
  const trimmed = text.replace(/^[-–—]\s*/, '').trim();

  const colon = /^([^:]{1,32}):\s*(.+)$/s.exec(trimmed);
  if (colon) {
    const candidate = colon[1]!.trim();
    if (looksLikeSpeakerLabel(candidate)) {
      return { speaker: candidate, remainder: colon[2]!.trim() };
    }
  }

  const bracketed = /^[[(]([^\])]{1,32})[\])]\s*(.+)$/s.exec(trimmed);
  if (bracketed) {
    const candidate = bracketed[1]!.trim();
    if (looksLikeSpeakerLabel(candidate)) {
      return { speaker: candidate, remainder: bracketed[2]!.trim() };
    }
  }

  return { remainder: trimmed };
}

function looksLikeSpeakerLabel(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 32) return false;
  // Sentence punctuation means this is dialogue, not a name.
  if (/[.!?,;]/.test(candidate)) return false;
  if (/\d{3,}/.test(candidate)) return false;
  if (candidate.split(/\s+/).length > 4) return false;

  const letters = candidate.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return false;

  // Names in caption tracks are conventionally upper case. Scripts without case
  // (CJK) have no upper case at all, so accept those on the length rule alone.
  const hasCase = letters.toLocaleLowerCase() !== letters.toLocaleUpperCase();
  if (!hasCase) return true;

  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return upper / letters.length >= 0.6;
}

/**
 * Recognises non-speech captions like `[door slams]` or `(gunshot)`.
 * These become sound evidence, not dialogue.
 */
export function isNonSpeechCaption(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const fullyWrapped = /^[[(][^\])]*[\])]$/.test(trimmed) || /^♪.*♪?$/.test(trimmed);
  if (!fullyWrapped) return false;
  // "[JANE] Where are you?" is dialogue with a label, already handled above.
  return !/[\])]\s*\S/.test(trimmed);
}
