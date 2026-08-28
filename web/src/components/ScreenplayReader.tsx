import { useMemo, useRef } from 'react';
import {
  describeSources,
  formatTimecode,
  type ScreenplayDocument,
  type SearchResult,
} from '@/core';

export type ViewMode = 'screenplay' | 'dialogue' | 'evidence';

export function ScreenplayReader({
  document,
  mode,
  query,
  results,
  onNavigate,
  onSceneChange,
}: {
  document: ScreenplayDocument;
  mode: ViewMode;
  query: string;
  results: readonly SearchResult[];
  onNavigate: (sceneId: string) => void;
  onSceneChange: (sceneId: string) => void;
}) {
  const readerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const lines = useMemo(
    () =>
      mode === 'dialogue'
        ? document.lines.filter((line) => line.kind === 'dialogue' || line.kind === 'character')
        : document.lines,
    [document.lines, mode],
  );

  if (query.trim().length > 0) return <SearchResults results={results} onNavigate={onNavigate} />;
  if (lines.length === 0)
    return (
      <div className="reader reader--empty">
        <p>Nothing to show yet. Add subtitles or analyze local media.</p>
      </div>
    );

  const seenScenes = new Set<string>();
  return (
    <div
      className="reader"
      ref={readerRef}
      aria-label="Screenplay"
      onScroll={() => {
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          const root = readerRef.current;
          if (!root) return;
          const rootTop = root.getBoundingClientRect().top + 40;
          const anchors = [...root.querySelectorAll<HTMLElement>('[data-scene-anchor="true"]')];
          let nearest = anchors[0];
          for (const anchor of anchors) {
            if (anchor.getBoundingClientRect().top <= rootTop) nearest = anchor;
            else break;
          }
          const id = nearest?.dataset.sceneId;
          if (id) onSceneChange(id);
        });
      }}
    >
      {lines.map((line) => {
        const firstInScene = !seenScenes.has(line.sceneId);
        seenScenes.add(line.sceneId);
        return (
          <div
            key={line.id}
            id={firstInScene ? 'scene-' + line.sceneId : undefined}
            data-scene-anchor={firstInScene ? 'true' : undefined}
            data-scene-id={firstInScene ? line.sceneId : undefined}
            className={'line line--' + line.kind}
          >
            {line.kind !== 'character' ? (
              <span className="line__time">{formatTimecode(line.start)}</span>
            ) : null}
            <div className="line__body">
              <span className="line__text">{line.text}</span>
              {line.secondaryText ? (
                <span className="line__secondary">{line.secondaryText}</span>
              ) : null}
              {line.origin === 'ai-translation' ? (
                <span className="tag tag--warn">AI translation</span>
              ) : null}
              {line.origin === 'audio-asr' ? (
                <span className="tag">Audio transcription</span>
              ) : null}
              {line.fallbackLanguage ? (
                <span className="tag tag--info">Shown in {line.fallbackLanguage}</span>
              ) : null}
              {mode === 'evidence' && line.provenance ? (
                <div className="evidence">
                  <span
                    className={
                      'evidence__confidence evidence__confidence--' + line.provenance.confidence
                    }
                  >
                    {line.provenance.confidence}
                  </span>
                  <span>{describeSources(line.provenance.sources)}</span>
                  <span>{line.provenance.inferred ? 'inferred' : 'observed'}</span>
                  <span>
                    {line.provenance.evidenceIds.length} event
                    {line.provenance.evidenceIds.length === 1 ? '' : 's'}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SearchResults({
  results,
  onNavigate,
}: {
  results: readonly SearchResult[];
  onNavigate: (sceneId: string) => void;
}) {
  if (results.length === 0)
    return (
      <div className="reader reader--empty">
        <p>No matches.</p>
      </div>
    );
  return (
    <div className="reader reader--results" aria-live="polite">
      <p className="search-count">
        {results.length} match{results.length === 1 ? '' : 'es'}
      </p>
      {results.map((result) => (
        <button
          type="button"
          key={result.beatId + '-' + String(result.matchStart)}
          className="result"
          onClick={() => onNavigate(result.sceneId)}
        >
          <span className="result__time">{formatTimecode(result.start)}</span>
          <span className="result__text">
            {result.characterName ? <strong>{result.characterName}: </strong> : null}
            <Highlighted
              text={result.snippet}
              start={result.matchStart}
              length={result.matchLength}
            />
          </span>
          {result.language ? <span className="tag">{result.language}</span> : null}
          <span aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  );
}

function Highlighted({ text, start, length }: { text: string; start: number; length: number }) {
  if (length <= 0 || start < 0 || start >= text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, start + length)}</mark>
      {text.slice(start + length)}
    </>
  );
}
