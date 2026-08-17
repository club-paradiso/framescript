/**
 * The screenplay reader.
 *
 * Three view modes over the same rendered document:
 *   - Screenplay: headings, action, dialogue, sound, on-screen text
 *   - Dialogue:   speaker and line only, for language learning
 *   - Evidence:   every line annotated with the sources that justify it
 *
 * Two behaviours matter more than the layout:
 *   1. The active line is highlighted from playback position, and auto-scroll
 *      follows it — but stands down the moment the user scrolls, and offers to
 *      resume rather than yanking them back.
 *   2. Lines are addressable: clicking one seeks the player.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatTimecode } from '../../utils/time';
import { describeSources } from '../../evidence/provenance';
import { activeLineIndex, type ScreenplayDocument, type ScreenplayLine } from '../../screenplay/types';

export type ViewMode = 'screenplay' | 'dialogue' | 'evidence';

export interface ScreenplayViewProps {
  document: ScreenplayDocument;
  positionMs: number;
  mode: ViewMode;
  showTimestamps: boolean;
  followPlayback: boolean;
  autoScroll: boolean;
  onSeek: (ms: number) => void;
  /** Rendered when there is nothing yet. */
  emptyState?: React.ReactNode;
}

export function ScreenplayView({
  document: doc,
  positionMs,
  mode,
  showTimestamps,
  followPlayback,
  autoScroll,
  onSeek,
  emptyState,
}: ScreenplayViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const lines = useMemo(
    () => (mode === 'dialogue' ? doc.lines.filter((l) => l.kind === 'dialogue' || l.kind === 'character') : doc.lines),
    [doc.lines, mode],
  );

  const activeIndex = followPlayback ? activeLineIndex({ ...doc, lines }, positionMs) : -1;

  // Auto-scroll, but never fight the reader.
  useEffect(() => {
    if (!autoScroll || userScrolled || activeIndex < 0) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex, autoScroll, userScrolled]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    const active = activeRef.current;
    if (!container || !active) return;

    // If the active line is still comfortably in view the scroll was probably
    // ours, so auto-scroll stays on.
    const containerBox = container.getBoundingClientRect();
    const activeBox = active.getBoundingClientRect();
    const visible = activeBox.top >= containerBox.top && activeBox.bottom <= containerBox.bottom;
    setUserScrolled(!visible);
  }, []);

  const resumeFollowing = useCallback(() => {
    setUserScrolled(false);
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  if (lines.length === 0) {
    return <div className="fs-screenplay fs-screenplay--empty">{emptyState}</div>;
  }

  return (
    <div className="fs-screenplay-wrapper">
      <div
        className="fs-screenplay fs-scroll"
        ref={containerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Reconstructed screenplay"
      >
        {lines.map((line, index) => (
          <Line
            key={line.id}
            line={line}
            active={index === activeIndex}
            mode={mode}
            showTimestamps={showTimestamps}
            onSeek={onSeek}
            ref={index === activeIndex ? activeRef : undefined}
          />
        ))}
      </div>

      {autoScroll && userScrolled && activeIndex >= 0 && (
        <button className="fs-button fs-resume-follow" onClick={resumeFollowing}>
          Jump to current line
        </button>
      )}
    </div>
  );
}

interface LineProps {
  line: ScreenplayLine;
  active: boolean;
  mode: ViewMode;
  showTimestamps: boolean;
  onSeek: (ms: number) => void;
  ref?: React.Ref<HTMLDivElement>;
}

function Line({ line, active, mode, showTimestamps, onSeek, ref }: LineProps) {
  const seekable = line.kind !== 'character';

  return (
    <div
      ref={ref}
      className={`fs-line fs-line--${line.kind}${active ? ' fs-line--active' : ''}`}
      data-beat-id={line.beatId}
    >
      {showTimestamps && line.kind !== 'character' && (
        <button
          className="fs-line__time fs-mono"
          onClick={() => onSeek(line.start)}
          disabled={!seekable}
          aria-label={`Seek to ${formatTimecode(line.start)}`}
        >
          {formatTimecode(line.start)}
        </button>
      )}

      <div className="fs-line__body">
        <span className="fs-line__text">{line.text}</span>
        {line.secondaryText && <span className="fs-line__secondary">{line.secondaryText}</span>}

        {/* Origin labelling is not decoration: a translation must never be
            mistaken for a subtitle the platform actually supplied. */}
        {line.origin === 'ai-translation' && <span className="fs-tag fs-tag--translation">AI translation</span>}
        {line.origin === 'audio-asr' && <span className="fs-tag">Audio transcription</span>}
        {line.fallbackLanguage && (
          <span className="fs-tag fs-tag--fallback">Shown in {line.fallbackLanguage}</span>
        )}

        {mode === 'evidence' && line.provenance && (
          <div className="fs-evidence">
            <span className={`fs-evidence__confidence fs-evidence__confidence--${line.provenance.confidence}`}>
              {line.provenance.confidence}
            </span>
            <span className="fs-evidence__sources">{describeSources(line.provenance.sources)}</span>
            {line.provenance.inferred && <span className="fs-evidence__inferred">inferred</span>}
            {line.end !== undefined && (
              <span className="fs-evidence__range fs-mono">
                {formatTimecode(line.start, { millis: true })} – {formatTimecode(line.end, { millis: true })}
              </span>
            )}
            <span className="fs-evidence__count">
              {line.provenance.evidenceIds.length} event
              {line.provenance.evidenceIds.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Coverage bar.
 *
 * Renders observed versus unobserved media time. Skipped sections are shown as
 * gaps — the screenplay never implies it analyzed something it did not see.
 */
export function CoverageBar({
  ratio,
  durationMs,
  uncovered,
}: {
  ratio: number | undefined;
  durationMs: number | undefined;
  uncovered: readonly { start: number; end: number }[];
}) {
  if (ratio === undefined || !durationMs) {
    return (
      <div className="fs-coverage">
        <span className="fs-eyebrow">Analysis coverage</span>
        <span className="fs-muted">Unknown</span>
      </div>
    );
  }

  return (
    <div className="fs-coverage">
      <div className="fs-row fs-row--between">
        <span className="fs-eyebrow">Analysis coverage</span>
        <span className="fs-mono fs-secondary">{Math.round(ratio * 100)}% observed</span>
      </div>
      <div className="fs-coverage__track" role="img" aria-label={`${Math.round(ratio * 100)} percent observed`}>
        <div className="fs-coverage__observed" />
        {uncovered.map((gap) => (
          <div
            key={`${gap.start}-${gap.end}`}
            className="fs-coverage__gap"
            style={{
              left: `${(gap.start / durationMs) * 100}%`,
              width: `${((gap.end - gap.start) / durationMs) * 100}%`,
            }}
          />
        ))}
      </div>
      {uncovered.length > 0 && (
        <p className="fs-muted fs-coverage__note">
          {uncovered.length} unobserved range{uncovered.length === 1 ? '' : 's'}. Nothing was reconstructed for
          those.
        </p>
      )}
    </div>
  );
}
