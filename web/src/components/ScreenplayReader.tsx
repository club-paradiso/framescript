/**
 * The screenplay reader.
 *
 * A reading surface rather than a live one: there is no player to follow, so
 * this is optimized for scanning, searching and understanding provenance
 * instead of tracking a playhead.
 */

import { useMemo } from 'react';
import { describeSources, formatTimecode, type ScreenplayDocument, type SearchResult } from '@/core';

export type ViewMode = 'screenplay' | 'dialogue' | 'evidence';

export function ScreenplayReader({
  document,
  mode,
  query,
  results,
}: {
  document: ScreenplayDocument;
  mode: ViewMode;
  query: string;
  results: readonly SearchResult[];
}) {
  const lines = useMemo(
    () =>
      mode === 'dialogue'
        ? document.lines.filter((l) => l.kind === 'dialogue' || l.kind === 'character')
        : document.lines,
    [document.lines, mode],
  );

  if (query.trim().length > 0) {
    return <SearchResults results={results} />;
  }

  if (lines.length === 0) {
    return (
      <div className="reader reader--empty">
        <p className="muted">Nothing to show yet. Add a subtitle file or analyze some media.</p>
      </div>
    );
  }

  return (
    <div className="reader">
      {lines.map((line) => (
        <div key={line.id} className={`line line--${line.kind}`}>
          {line.kind !== 'character' && (
            <span className="line__time mono">{formatTimecode(line.start)}</span>
          )}
          <div className="line__body">
            <span className="line__text">{line.text}</span>
            {line.secondaryText && <span className="line__secondary">{line.secondaryText}</span>}

            {/* Origin is never decoration: a translation must not read as a
                subtitle the source actually supplied. */}
            {line.origin === 'ai-translation' && <span className="tag tag--warn">AI translation</span>}
            {line.origin === 'audio-asr' && <span className="tag">Audio transcription</span>}
            {line.fallbackLanguage && (
              <span className="tag tag--info">Shown in {line.fallbackLanguage}</span>
            )}

            {mode === 'evidence' && line.provenance && (
              <div className="evidence">
                <span className={`evidence__confidence evidence__confidence--${line.provenance.confidence}`}>
                  {line.provenance.confidence}
                </span>
                <span>{describeSources(line.provenance.sources)}</span>
                {line.provenance.inferred && <span className="evidence__inferred">inferred</span>}
                <span className="mono">
                  {line.provenance.evidenceIds.length} event
                  {line.provenance.evidenceIds.length === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchResults({ results }: { results: readonly SearchResult[] }) {
  if (results.length === 0) {
    return (
      <div className="reader reader--empty">
        <p className="muted">No matches.</p>
      </div>
    );
  }
  return (
    <div className="reader reader--results">
      <p className="muted small">
        {results.length} match{results.length === 1 ? '' : 'es'}
      </p>
      {results.map((result) => (
        <div key={`${result.beatId}-${result.matchStart}`} className="result">
          <span className="mono muted">{formatTimecode(result.start)}</span>
          <span className="result__text">
            {result.characterName && <strong>{result.characterName}: </strong>}
            <Highlighted text={result.snippet} start={result.matchStart} length={result.matchLength} />
          </span>
          {result.language && <span className="tag">{result.language}</span>}
        </div>
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
