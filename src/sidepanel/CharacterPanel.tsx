/**
 * Character and speaker editing.
 *
 * User corrections are the highest-priority evidence FrameScript has: they
 * outrank diarization, visual correlation and every model output. Naming a
 * speaker here re-attributes their lines immediately and permanently for the
 * session.
 */

import { useState } from 'react';
import { sendRuntime } from '../messaging/bus';
import { characterCueName, type CharacterEntity } from '../characters/entities';
import { formatTimecode } from '../utils/time';

export interface CharacterPanelProps {
  tabId: number;
  characters: readonly CharacterEntity[];
  onClose: () => void;
}

export function CharacterPanel({ tabId, characters, onClose }: CharacterPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [mergeSource, setMergeSource] = useState<string | null>(null);

  const rename = async (characterId: string) => {
    const name = draft.trim();
    if (name.length === 0) return;
    await sendRuntime({ type: 'ui/rename-character', payload: { tabId, characterId, name } });
    setEditing(null);
    setDraft('');
  };

  const merge = async (targetId: string) => {
    if (!mergeSource || mergeSource === targetId) return;
    await sendRuntime({ type: 'ui/merge-characters', payload: { tabId, targetId, sourceId: mergeSource } });
    setMergeSource(null);
  };

  const split = async (characterId: string, speakerId: string) => {
    await sendRuntime({ type: 'ui/split-speaker', payload: { tabId, characterId, speakerId } });
  };

  return (
    <aside className="fs-drawer" aria-label="Characters">
      <div className="fs-drawer__header">
        <h2>Characters</h2>
        <button className="fs-drawer__close" onClick={onClose} aria-label="Close characters">
          ×
        </button>
      </div>

      <p className="fs-drawer__note fs-muted">
        Voices are grouped automatically and labelled anonymously. FrameScript does not try to work out who
        anyone is — naming them is your call, and your names take priority over everything it inferred.
      </p>

      {characters.length === 0 ? (
        <p className="fs-muted fs-drawer__empty">No speakers detected yet.</p>
      ) : (
        <ul className="fs-character-list fs-scroll">
          {characters.map((character) => (
            <li key={character.id} className="fs-character">
              <div className="fs-row fs-row--between">
                {editing === character.id ? (
                  <form
                    className="fs-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(character.id);
                    }}
                  >
                    <input
                      className="fs-input fs-input--sm"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Character name"
                      autoFocus
                      aria-label={`Name for ${characterCueName(character)}`}
                    />
                    <button className="fs-button" type="submit">
                      Save
                    </button>
                    <button className="fs-button" type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="fs-character__name">{characterCueName(character)}</span>
                    <span className="fs-character__meta fs-muted">
                      {character.lineCount} line{character.lineCount === 1 ? '' : 's'}
                    </span>
                  </>
                )}
              </div>

              <div className="fs-character__details fs-muted">
                {character.speakerIds.length > 0 && (
                  <span>
                    {character.speakerIds.length} voice cluster{character.speakerIds.length === 1 ? '' : 's'}
                  </span>
                )}
                {character.firstSeenAt !== undefined && (
                  <span className="fs-mono">first at {formatTimecode(character.firstSeenAt)}</span>
                )}
                <span className={`fs-source-badge fs-source-badge--${character.source}`}>
                  {sourceLabel(character.source)}
                </span>
              </div>

              {editing !== character.id && (
                <div className="fs-character__actions">
                  <button
                    className="fs-button"
                    onClick={() => {
                      setEditing(character.id);
                      setDraft(character.displayName ?? '');
                    }}
                  >
                    Rename
                  </button>

                  {mergeSource === null ? (
                    <button className="fs-button" onClick={() => setMergeSource(character.id)}>
                      Merge…
                    </button>
                  ) : mergeSource === character.id ? (
                    <button className="fs-button" onClick={() => setMergeSource(null)}>
                      Cancel merge
                    </button>
                  ) : (
                    <button className="fs-button fs-button--primary" onClick={() => void merge(character.id)}>
                      Merge into this
                    </button>
                  )}

                  {character.speakerIds.length > 1 && (
                    <button
                      className="fs-button"
                      onClick={() => void split(character.id, character.speakerIds[character.speakerIds.length - 1]!)}
                      title="Separate the most recently added voice cluster into its own character"
                    >
                      Split
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function sourceLabel(source: CharacterEntity['source']): string {
  switch (source) {
    case 'subtitle':
      return 'named by subtitles';
    case 'user':
      return 'named by you';
    case 'multimodal-inference':
      return 'inferred';
    case 'unknown':
      return 'unnamed';
  }
}
