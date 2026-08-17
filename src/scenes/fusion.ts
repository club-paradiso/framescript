/**
 * Multimodal fusion.
 *
 * Turns one evidence window into scene beats. This is where sources meet, and
 * where the product's central discipline is enforced:
 *
 *   **Dialogue and action are separate evidence and are never derived from one
 *   another.** If a subtitle says "I'm leaving" while the picture shows someone
 *   still sitting down, FrameScript writes the line and does not write
 *   "she stands and leaves". Action beats come only from visual and audio
 *   evidence. Nothing in this file reads dialogue text to invent an action.
 *
 * Where sources genuinely disagree, the disagreement is recorded as a conflict
 * and surfaced rather than silently resolved.
 */

import { createIdFactory } from '../utils/id';
import { temporalIou, type MediaTimeMs } from '../utils/time';
import { textSimilarity } from '../utils/text';
import { corroborate, minConfidence } from '../evidence/confidence';
import { provenanceFrom } from '../evidence/provenance';
import type { ConfidenceLevel, EvidenceEvent, SubtitleEvidence } from '../evidence/types';
import type { EvidenceWindow } from '../evidence/windows';
import { attributeSpeaker, extractSpeakerLabel, isNonSpeechCaption } from '../characters/attribution';
import type { CharacterRegistry } from '../characters/entities';
import { describeSoundEvent } from '../audio/soundEvents';
import { describeSilence } from '../audio/silence';
import type {
  ActionBeat,
  DialogueBeat,
  DialogueVariant,
  OnScreenTextBeat,
  SceneBeat,
  SoundBeat,
  TransitionBeat,
} from './types';

export interface FusionContext {
  registry: CharacterRegistry;
  /** Character attributed to the previous dialogue beat, for alternation. */
  previousCharacterId?: string;
  /** Characters believed present in the current scene. */
  presentCharacterIds?: string[];
  /** User speaker assignments keyed by evidence id. */
  userAssignments?: Map<string, string>;
  /** Include beats whose only support is low-confidence inference. */
  includeLowConfidence?: boolean;
  idFactory?: () => string;
}

export interface FusionConflict {
  timestamp: MediaTimeMs;
  description: string;
  evidenceIds: string[];
}

export interface FusionResult {
  beats: SceneBeat[];
  conflicts: FusionConflict[];
  /** Character id of the last dialogue beat, to thread into the next window. */
  lastCharacterId?: string;
}

/** Similarity above which a subtitle and an ASR hypothesis are the same line. */
const SAME_LINE_SIMILARITY = 0.6;
/** Temporal overlap required before texts are even compared. */
const SAME_LINE_IOU = 0.25;

export function fuseWindow(window: EvidenceWindow, context: FusionContext): FusionResult {
  const nextId = context.idFactory ?? createIdFactory('beat');
  const beats: SceneBeat[] = [];
  const conflicts: FusionConflict[] = [];
  let lastCharacterId = context.previousCharacterId;

  // --- Dialogue ---------------------------------------------------------------

  const { dialogueBeats, nonSpeechCaptions, updatedLastCharacter, dialogueConflicts } = fuseDialogue(
    window,
    context,
    nextId,
  );
  beats.push(...dialogueBeats);
  conflicts.push(...dialogueConflicts);
  if (updatedLastCharacter) lastCharacterId = updatedLastCharacter;

  // --- Sound ------------------------------------------------------------------

  // Bracketed captions like "[door slams]" are authored sound descriptions and
  // are stronger evidence than our own acoustic classifier, so they win.
  for (const caption of nonSpeechCaptions) {
    const text = caption.payload.text.replace(/^[[(♪]\s*/, '').replace(/\s*[\])♪]$/, '').trim();
    if (!text) continue;
    const beat: SoundBeat = {
      type: 'sound',
      id: nextId(),
      start: caption.start,
      ...(caption.end === undefined ? {} : { end: caption.end }),
      kind: 'unclassified',
      description: capitalizeSentence(text),
      provenance: provenanceFrom([caption]),
    };
    beats.push(beat);
  }

  for (const sound of window.soundEvents) {
    // Skip anything the subtitle track already described at the same moment.
    const describedByCaption = nonSpeechCaptions.some(
      (c) => Math.abs(c.start - sound.start) < 1_200,
    );
    if (describedByCaption) continue;
    if (!context.includeLowConfidence && sound.confidence === 'unknown' && sound.payload.kind === 'unclassified') {
      continue;
    }
    const beat: SoundBeat = {
      type: 'sound',
      id: nextId(),
      start: sound.start,
      ...(sound.end === undefined ? {} : { end: sound.end }),
      kind: sound.payload.kind,
      description: describeSoundEvent(sound.payload.kind, sound.payload.description),
      provenance: provenanceFrom([sound]),
    };
    beats.push(beat);
  }

  for (const silence of window.silences) {
    if (!silence.payload.significant) continue;
    const beat: SoundBeat = {
      type: 'sound',
      id: nextId(),
      start: silence.start,
      ...(silence.end === undefined ? {} : { end: silence.end }),
      kind: 'unclassified',
      description: describeSilence({
        start: silence.start,
        end: silence.end ?? silence.start,
        durationMs: silence.payload.durationMs,
        significant: true,
        relativeLength: 1,
      }),
      provenance: provenanceFrom([silence]),
    };
    beats.push(beat);
  }

  // --- Visual -----------------------------------------------------------------

  for (const visual of window.visualEvents) {
    if (visual.payload.kind === 'scene-change') {
      const beat: TransitionBeat = {
        type: 'transition',
        id: nextId(),
        start: visual.start,
        label: 'CUT TO:',
        provenance: provenanceFrom([visual]),
      };
      beats.push(beat);
      continue;
    }
    const description = visual.payload.description;
    if (!description) continue;
    if (!context.includeLowConfidence && visual.confidence === 'low' && visual.payload.inferred) continue;

    const beat: ActionBeat = {
      type: 'action',
      id: nextId(),
      start: visual.start,
      ...(visual.end === undefined ? {} : { end: visual.end }),
      description: capitalizeSentence(description),
      ...(visual.payload.participantIds ? { participantIds: visual.payload.participantIds } : {}),
      provenance: provenanceFrom([visual], { inferred: visual.payload.inferred ?? false }),
    };
    beats.push(beat);
  }

  // --- On-screen text ---------------------------------------------------------

  for (const ocr of window.ocrEvents) {
    // A region detection with no recognized characters is evidence, but it is
    // not text: it must not become a screenplay line claiming words we never read.
    if (ocr.payload.unrecognized || !ocr.payload.text.trim()) continue;
    const beat: OnScreenTextBeat = {
      type: 'on-screen-text',
      id: nextId(),
      start: ocr.start,
      ...(ocr.end === undefined ? {} : { end: ocr.end }),
      text: ocr.payload.text.trim(),
      provenance: provenanceFrom([ocr]),
    };
    beats.push(beat);
  }

  return {
    beats: beats.sort((a, b) => a.start - b.start),
    conflicts,
    ...(lastCharacterId ? { lastCharacterId } : {}),
  };
}

interface DialogueFusionOutput {
  dialogueBeats: DialogueBeat[];
  nonSpeechCaptions: SubtitleEvidence[];
  updatedLastCharacter?: string;
  dialogueConflicts: FusionConflict[];
}

/**
 * Fuses subtitle and ASR dialogue.
 *
 * Subtitles anchor the text when present — they were authored by a human and
 * are near-always more accurate than machine transcription. ASR then serves
 * three purposes the subtitle cannot: catching lines the track omits, refining
 * onset timing, and supplying speaker evidence.
 */
function fuseDialogue(
  window: EvidenceWindow,
  context: FusionContext,
  nextId: () => string,
): DialogueFusionOutput {
  const dialogueBeats: DialogueBeat[] = [];
  const nonSpeechCaptions: SubtitleEvidence[] = [];
  const dialogueConflicts: FusionConflict[] = [];
  const consumedSpeech = new Set<string>();
  let lastCharacterId = context.previousCharacterId;

  const speakerCandidates = window.speakers.map((s) => ({
    speakerId: s.payload.speakerId,
    start: s.start,
    end: s.end ?? s.start,
    confidence: s.confidence,
  }));

  // Group subtitle cues by time so several language tracks of the same line
  // become one beat with several variants rather than several beats.
  const groups = groupSubtitlesByTime(window.subtitles);

  for (const group of groups) {
    const speechEvents = window.speech.filter((speech) => {
      const overlap = temporalIou(
        { start: group.start, end: group.end },
        { start: speech.start, end: speech.end ?? speech.start },
      );
      if (overlap < SAME_LINE_IOU) return false;
      const primary = group.cues[0]!;
      return textSimilarity(primary.payload.text, speech.payload.text) >= SAME_LINE_SIMILARITY;
    });
    for (const speech of speechEvents) consumedSpeech.add(speech.id);

    const captions = group.cues.filter((c) => isNonSpeechCaption(c.payload.text));
    if (captions.length === group.cues.length) {
      nonSpeechCaptions.push(...captions);
      continue;
    }

    const spoken = group.cues.filter((c) => !isNonSpeechCaption(c.payload.text));
    nonSpeechCaptions.push(...captions);

    const textVariants: Record<string, DialogueVariant> = {};
    let speakerLabel: string | undefined;

    for (const cue of spoken) {
      const explicit = cue.payload.speakerLabel;
      const parsed = extractSpeakerLabel(cue.payload.text);
      const label = explicit ?? parsed.speaker;
      if (label && !speakerLabel) speakerLabel = label;

      textVariants[cue.payload.language] = {
        language: cue.payload.language,
        text: parsed.remainder || cue.payload.text,
        origin: 'platform-subtitle',
        // An auto-generated caption track is machine transcription and is
        // labelled as less reliable than an authored one.
        confidence: cue.payload.autoGenerated ? 'medium' : 'high',
      };
    }

    // ASR agrees: corroboration, and a better onset time.
    let start = group.start;
    let confidence: ConfidenceLevel = corroborate(
      [...spoken.map((c) => c.confidence), ...speechEvents.map((s) => s.confidence)],
      speechEvents.length > 0 ? 2 : 1,
    );
    if (speechEvents.length > 0) {
      const earliestSpeech = Math.min(...speechEvents.map((s) => s.start));
      // Subtitles are routinely displayed slightly before the line is spoken.
      if (earliestSpeech > start && earliestSpeech - start < 1_500) start = earliestSpeech;
      for (const speech of speechEvents) {
        if (speech.payload.language && !textVariants[speech.payload.language]) {
          textVariants[speech.payload.language] = {
            language: speech.payload.language,
            text: speech.payload.text,
            origin: 'audio-asr',
            confidence: speech.confidence,
          };
        }
      }
    }

    const supporting: EvidenceEvent[] = [...spoken, ...speechEvents];
    const userAssignment = findUserAssignment(context, supporting);
    const attribution = attributeSpeaker(
      {
        start,
        end: group.end,
        ...(speakerLabel ? { subtitleSpeakerLabel: speakerLabel } : {}),
        ...(userAssignment ? { userCharacterId: userAssignment } : {}),
        speakerCandidates,
        ...(lastCharacterId ? { previousCharacterId: lastCharacterId } : {}),
        ...(context.presentCharacterIds ? { presentCharacterIds: context.presentCharacterIds } : {}),
      },
      context.registry,
    );

    if (attribution.characterId) {
      context.registry.noteLine(attribution.characterId, start);
      lastCharacterId = attribution.characterId;
    }
    confidence = minConfidence(confidence, 'high');

    const beat: DialogueBeat = {
      type: 'dialogue',
      id: nextId(),
      start,
      end: group.end,
      ...(attribution.characterId ? { characterId: attribution.characterId } : {}),
      attributionMethod: attribution.method,
      textVariants,
      provenance: provenanceFrom(supporting, { confidence }),
    };
    dialogueBeats.push(beat);
  }

  // ASR-only dialogue: a line the subtitle track does not contain. This is one
  // of the main reasons audio is a first-class source rather than a fallback.
  for (const speech of window.speech) {
    if (consumedSpeech.has(speech.id)) continue;
    const text = speech.payload.text.trim();
    if (!text) continue;

    const overlappingSubtitle = window.subtitles.find(
      (cue) =>
        temporalIou(
          { start: speech.start, end: speech.end ?? speech.start },
          { start: cue.start, end: cue.end ?? cue.start },
        ) > SAME_LINE_IOU,
    );
    if (overlappingSubtitle) {
      // Same moment, different words: a real conflict. Record it, keep both,
      // and let the Evidence view show the disagreement.
      dialogueConflicts.push({
        timestamp: speech.start,
        description: `Audio transcription differs from the subtitle track ("${truncate(text)}" vs "${truncate(
          overlappingSubtitle.payload.text,
        )}").`,
        evidenceIds: [speech.id, overlappingSubtitle.id],
      });
      if (!context.includeLowConfidence) continue;
    }

    const userAssignment = findUserAssignment(context, [speech]);
    const attribution = attributeSpeaker(
      {
        start: speech.start,
        end: speech.end ?? speech.start,
        ...(userAssignment ? { userCharacterId: userAssignment } : {}),
        ...(speech.payload.speakerId
          ? {
              speakerCandidates: [
                {
                  speakerId: speech.payload.speakerId,
                  start: speech.start,
                  end: speech.end ?? speech.start,
                  confidence: speech.confidence,
                },
              ],
            }
          : { speakerCandidates }),
        ...(lastCharacterId ? { previousCharacterId: lastCharacterId } : {}),
        ...(context.presentCharacterIds ? { presentCharacterIds: context.presentCharacterIds } : {}),
      },
      context.registry,
    );
    if (attribution.characterId) {
      context.registry.noteLine(attribution.characterId, speech.start);
      lastCharacterId = attribution.characterId;
    }

    const language = speech.payload.language ?? 'und';
    const beat: DialogueBeat = {
      type: 'dialogue',
      id: nextId(),
      start: speech.start,
      ...(speech.end === undefined ? {} : { end: speech.end }),
      ...(attribution.characterId ? { characterId: attribution.characterId } : {}),
      attributionMethod: attribution.method,
      textVariants: {
        [language]: { language, text, origin: 'audio-asr', confidence: speech.confidence },
      },
      provenance: provenanceFrom([speech]),
    };
    dialogueBeats.push(beat);
  }

  return {
    dialogueBeats: dialogueBeats.sort((a, b) => a.start - b.start),
    nonSpeechCaptions,
    ...(lastCharacterId ? { updatedLastCharacter: lastCharacterId } : {}),
    dialogueConflicts,
  };
}

interface SubtitleGroup {
  start: MediaTimeMs;
  end: MediaTimeMs;
  cues: SubtitleEvidence[];
}

/**
 * Groups cues that are the same utterance rendered in different languages.
 *
 * Two cues in *the same* language at the same moment are two lines (overlapping
 * speakers), so only cross-language cues are merged.
 */
function groupSubtitlesByTime(subtitles: readonly SubtitleEvidence[]): SubtitleGroup[] {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start);
  const groups: SubtitleGroup[] = [];

  for (const cue of sorted) {
    const end = cue.end ?? cue.start + 2_000;
    const target = groups.find(
      (g) =>
        temporalIou({ start: g.start, end: g.end }, { start: cue.start, end }) > 0.5 &&
        !g.cues.some((c) => c.payload.language === cue.payload.language),
    );
    if (target) {
      target.cues.push(cue);
      target.start = Math.min(target.start, cue.start);
      target.end = Math.max(target.end, end);
    } else {
      groups.push({ start: cue.start, end, cues: [cue] });
    }
  }
  return groups;
}

function findUserAssignment(context: FusionContext, events: readonly EvidenceEvent[]): string | undefined {
  if (!context.userAssignments) return undefined;
  for (const event of events) {
    const assigned = context.userAssignments.get(event.id);
    if (assigned) return assigned;
  }
  return undefined;
}

function capitalizeSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  const capitalized = trimmed[0]!.toLocaleUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function truncate(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
