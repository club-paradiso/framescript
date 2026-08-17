/**
 * Character entities.
 *
 * A *speaker* is an anonymous voice cluster from diarization. A *character* is
 * a screenplay entity that may have a name. FrameScript keeps them separate,
 * because collapsing them is exactly how a system starts confidently asserting
 * that voice cluster 2 is a named person it has no evidence for.
 *
 * A character acquires a name from exactly two places: a subtitle track that
 * labels the speaker ("JANE: ..."), or the user. Never from face matching, and
 * never from a model guessing at a cast list.
 */

import { createIdFactory } from '../utils/id';
import { toCharacterCue } from '../utils/text';
import type { ConfidenceLevel } from '../evidence/types';
import type { MediaTimeMs } from '../utils/time';

export interface CharacterEntity {
  id: string;
  displayName?: string;
  aliases: string[];
  /** Diarization clusters attributed to this character. */
  speakerIds: string[];
  /** Visual clusters (provider labels) attributed to this character. */
  visualClusterIds: string[];
  confidence: ConfidenceLevel;
  source: 'subtitle' | 'user' | 'multimodal-inference' | 'unknown';
  firstSeenAt?: MediaTimeMs;
  lastSeenAt?: MediaTimeMs;
  /** Number of dialogue beats attributed to this character. */
  lineCount: number;
}

export interface SceneCharacterPresence {
  characterId: string;
  /** True when the character speaks in the scene. */
  speaks: boolean;
  enteredAt?: MediaTimeMs;
  exitedAt?: MediaTimeMs;
  confidence: ConfidenceLevel;
}

export class CharacterRegistry {
  #characters = new Map<string, CharacterEntity>();
  #bySpeakerId = new Map<string, string>();
  #byNormalizedName = new Map<string, string>();
  #nextId = createIdFactory('character');

  get all(): CharacterEntity[] {
    return [...this.#characters.values()];
  }

  get size(): number {
    return this.#characters.size;
  }

  get(id: string): CharacterEntity | undefined {
    return this.#characters.get(id);
  }

  findBySpeakerId(speakerId: string): CharacterEntity | undefined {
    const id = this.#bySpeakerId.get(speakerId);
    return id ? this.#characters.get(id) : undefined;
  }

  findByName(name: string): CharacterEntity | undefined {
    const id = this.#byNormalizedName.get(normalizeName(name));
    return id ? this.#characters.get(id) : undefined;
  }

  /**
   * Returns the character for an anonymous speaker cluster, creating an unnamed
   * one if needed. Unnamed characters render as "SPEAKER 1" until evidence or
   * the user supplies a name.
   */
  ensureForSpeaker(speakerId: string, at: MediaTimeMs): CharacterEntity {
    const existing = this.findBySpeakerId(speakerId);
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt ?? at, at);
      return existing;
    }
    const character: CharacterEntity = {
      id: this.#nextId(),
      aliases: [],
      speakerIds: [speakerId],
      visualClusterIds: [],
      confidence: 'low',
      source: 'unknown',
      firstSeenAt: at,
      lastSeenAt: at,
      lineCount: 0,
    };
    this.#characters.set(character.id, character);
    this.#bySpeakerId.set(speakerId, character.id);
    return character;
  }

  /**
   * Returns the character for a name found in a subtitle label, creating one if
   * needed. Subtitle labels are strong evidence — the track author wrote them.
   */
  ensureForName(name: string, at: MediaTimeMs, source: CharacterEntity['source'] = 'subtitle'): CharacterEntity {
    const existing = this.findByName(name);
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt ?? at, at);
      // A user naming outranks a subtitle label.
      if (source === 'user') {
        existing.source = 'user';
        existing.confidence = 'high';
      }
      return existing;
    }
    const character: CharacterEntity = {
      id: this.#nextId(),
      displayName: toCharacterCue(name),
      aliases: [],
      speakerIds: [],
      visualClusterIds: [],
      confidence: source === 'user' ? 'high' : 'medium',
      source,
      firstSeenAt: at,
      lastSeenAt: at,
      lineCount: 0,
    };
    this.#characters.set(character.id, character);
    this.#byNormalizedName.set(normalizeName(name), character.id);
    return character;
  }

  /** Links a voice cluster to a character. Used when both are known. */
  linkSpeaker(characterId: string, speakerId: string): void {
    const character = this.#characters.get(characterId);
    if (!character) return;
    if (!character.speakerIds.includes(speakerId)) character.speakerIds.push(speakerId);
    this.#bySpeakerId.set(speakerId, characterId);
  }

  rename(characterId: string, name: string): CharacterEntity | undefined {
    const character = this.#characters.get(characterId);
    if (!character) return undefined;
    if (character.displayName) {
      this.#byNormalizedName.delete(normalizeName(character.displayName));
      if (!character.aliases.includes(character.displayName)) character.aliases.push(character.displayName);
    }
    character.displayName = toCharacterCue(name);
    character.source = 'user';
    character.confidence = 'high';
    this.#byNormalizedName.set(normalizeName(name), characterId);
    return character;
  }

  /**
   * Merges `sourceId` into `targetId`. Used when the user recognises that two
   * voice clusters are one person (common when a voice changes across a phone
   * call or a shouted line).
   */
  merge(targetId: string, sourceId: string): CharacterEntity | undefined {
    const target = this.#characters.get(targetId);
    const source = this.#characters.get(sourceId);
    if (!target || !source || targetId === sourceId) return undefined;

    for (const speakerId of source.speakerIds) {
      if (!target.speakerIds.includes(speakerId)) target.speakerIds.push(speakerId);
      this.#bySpeakerId.set(speakerId, targetId);
    }
    for (const clusterId of source.visualClusterIds) {
      if (!target.visualClusterIds.includes(clusterId)) target.visualClusterIds.push(clusterId);
    }
    if (source.displayName && source.displayName !== target.displayName) {
      if (!target.aliases.includes(source.displayName)) target.aliases.push(source.displayName);
      this.#byNormalizedName.set(normalizeName(source.displayName), targetId);
    }
    target.lineCount += source.lineCount;
    target.firstSeenAt = minDefined(target.firstSeenAt, source.firstSeenAt);
    target.lastSeenAt = maxDefined(target.lastSeenAt, source.lastSeenAt);
    target.confidence = 'high';
    target.source = 'user';

    this.#characters.delete(sourceId);
    return target;
  }

  /**
   * Splits a speaker cluster out of a character into a new one. Used when the
   * user sees that diarization merged two people.
   */
  split(characterId: string, speakerId: string, at: MediaTimeMs): CharacterEntity | undefined {
    const character = this.#characters.get(characterId);
    if (!character || !character.speakerIds.includes(speakerId)) return undefined;
    character.speakerIds = character.speakerIds.filter((s) => s !== speakerId);
    this.#bySpeakerId.delete(speakerId);
    const created = this.ensureForSpeaker(speakerId, at);
    created.source = 'user';
    return created;
  }

  remove(characterId: string): void {
    const character = this.#characters.get(characterId);
    if (!character) return;
    for (const speakerId of character.speakerIds) this.#bySpeakerId.delete(speakerId);
    if (character.displayName) this.#byNormalizedName.delete(normalizeName(character.displayName));
    this.#characters.delete(characterId);
  }

  noteLine(characterId: string, at: MediaTimeMs): void {
    const character = this.#characters.get(characterId);
    if (!character) return;
    character.lineCount++;
    character.firstSeenAt = minDefined(character.firstSeenAt, at);
    character.lastSeenAt = maxDefined(character.lastSeenAt, at);
  }

  /** Serializable snapshot for storage and for the side panel. */
  snapshot(): CharacterEntity[] {
    return this.all.map((c) => ({ ...c, aliases: [...c.aliases], speakerIds: [...c.speakerIds] }));
  }

  restore(characters: readonly CharacterEntity[]): void {
    this.#characters.clear();
    this.#bySpeakerId.clear();
    this.#byNormalizedName.clear();
    for (const character of characters) {
      this.#characters.set(character.id, { ...character });
      for (const speakerId of character.speakerIds) this.#bySpeakerId.set(speakerId, character.id);
      if (character.displayName) this.#byNormalizedName.set(normalizeName(character.displayName), character.id);
    }
  }

  clear(): void {
    this.#characters.clear();
    this.#bySpeakerId.clear();
    this.#byNormalizedName.clear();
  }
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * The name shown in a character cue.
 *
 * Unnamed characters get a stable, obviously-anonymous label. "SPEAKER 2" is
 * honest; inventing "MAN" or "DANIEL" would not be.
 */
export function characterCueName(
  character: CharacterEntity | undefined,
  fallbackIndex?: number,
): string {
  if (character?.displayName) return character.displayName;
  if (character && character.speakerIds.length > 0) {
    const speakerNumber = character.speakerIds[0]!.replace(/^speaker-0*/, '');
    return `SPEAKER ${speakerNumber}`;
  }
  return fallbackIndex !== undefined ? `SPEAKER ${fallbackIndex}` : 'UNKNOWN SPEAKER';
}
