import {
  ALL_SOURCE_IDS,
  describeSources,
  formatTimecode,
  type EvidenceEvent,
  type FusionConflict,
  type ProjectCoverage,
  type ReconstructedScene,
} from '@/core';
import { useMemo, useState } from 'react';

type InspectorTab = 'evidence' | 'coverage' | 'conflicts';

const SOURCE_LABELS: Record<(typeof ALL_SOURCE_IDS)[number], string> = {
  subtitle: 'Subtitle',
  'audio-asr': 'Audio transcription',
  'audio-speaker': 'Speaker',
  'audio-event': 'Sound event',
  'audio-silence': 'Silence',
  video: 'Video',
  ocr: 'On-screen text',
  playback: 'Playback',
  metadata: 'Metadata',
  user: 'User correction',
};

export function ProjectInspector({
  scene,
  coverage,
  conflicts,
  evidence,
}: {
  scene: ReconstructedScene | null;
  coverage: ProjectCoverage;
  conflicts: readonly FusionConflict[];
  evidence: readonly EvidenceEvent[];
}) {
  const [tab, setTab] = useState<InspectorTab>('evidence');
  const sceneEvidence = useMemo(() => {
    if (!scene) return [];
    const ids = new Set(scene.provenance.evidenceIds);
    return evidence.filter(
      (event) =>
        ids.has(event.id) || (event.start >= scene.start && event.start <= (scene.end ?? Infinity)),
    );
  }, [evidence, scene]);

  return (
    <aside className="inspector" aria-label="Project inspector">
      <div className="inspector__tabs" role="tablist" aria-label="Inspector view">
        {(['evidence', 'coverage', 'conflicts'] as const).map((value) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            key={value}
          >
            {value[0]!.toUpperCase() + value.slice(1)}
            {value === 'conflicts' && conflicts.length > 0 ? <span>{conflicts.length}</span> : null}
          </button>
        ))}
      </div>
      {tab === 'evidence' ? (
        <EvidenceView scene={scene} events={sceneEvidence} />
      ) : tab === 'coverage' ? (
        <CoverageView coverage={coverage} />
      ) : (
        <ConflictView conflicts={conflicts} />
      )}
    </aside>
  );
}

function EvidenceView({
  scene,
  events,
}: {
  scene: ReconstructedScene | null;
  events: readonly EvidenceEvent[];
}) {
  const sourceStates = ALL_SOURCE_IDS.map((source) => ({
    source,
    matching: events.filter((event) => event.source === source),
  })).filter(({ matching }) => matching.length > 0);

  return (
    <div className="inspector__content">
      <div className="inspector__context">
        <span>{scene ? formatTimecode(scene.start) : 'No scene selected'}</span>
        <strong>
          {scene
            ? (scene.provenance.inferred ? 'Inferred' : 'Observed') +
              ' · ' +
              scene.provenance.confidence
            : 'Select a scene to inspect its support.'}
        </strong>
      </div>
      {sourceStates.length === 0 ? (
        <p className="panel-empty">
          Detailed source events are unavailable in this project. Beat-level provenance remains
          attached to the screenplay.
        </p>
      ) : (
        <ul className="evidence-list">
          {sourceStates.map(({ source, matching }) => {
            const inferred = matching.some(
              (event) => event.source === 'video' && event.payload.inferred,
            );
            const confidence = matching.reduce(
              (best, event) => confidenceMax(best, event.confidence),
              'unknown',
            );
            return (
              <li key={source}>
                <span className="evidence-list__mark" aria-hidden="true" />
                <div>
                  <strong>{SOURCE_LABELS[source]}</strong>
                  <small>
                    {matching.length} event{matching.length === 1 ? '' : 's'} ·{' '}
                    {describeSources([source])}
                  </small>
                </div>
                <span>
                  {inferred ? 'Inferred' : 'Observed'} · {confidence}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {scene ? (
        <details className="inspector__details">
          <summary>Scene provenance details</summary>
          <dl>
            <div>
              <dt>Evidence events</dt>
              <dd>{scene.provenance.evidenceIds.length}</dd>
            </div>
            <div>
              <dt>Sources</dt>
              <dd>{describeSources(scene.provenance.sources)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{scene.status}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </div>
  );
}

function CoverageView({ coverage }: { coverage: ProjectCoverage }) {
  const ratio = coverage.ratio;
  const percent = ratio === undefined ? null : Math.round(ratio * 100);
  return (
    <div className="inspector__content">
      <div className="coverage-summary">
        <strong>{percent === null ? 'Coverage unknown' : percent + '% observed'}</strong>
        <span>
          {percent === null
            ? 'The project does not contain enough duration information for a ratio.'
            : 'This measures observed ranges, not screenplay completeness.'}
        </span>
      </div>
      {percent !== null ? (
        <div className="coverage-track" role="img" aria-label={percent + ' percent observed'}>
          <i style={{ width: percent + '%' }} />
        </div>
      ) : null}
      {coverage.notes.map((note) => (
        <p className="coverage-note" key={note}>
          {note}
        </p>
      ))}
      <dl className="coverage-ranges">
        <div>
          <dt>Observed ranges</dt>
          <dd>{coverage.observed.length}</dd>
        </div>
        <div>
          <dt>Unobserved ranges</dt>
          <dd>{coverage.uncovered.length}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>
            {coverage.durationMs === undefined ? 'Unknown' : formatTimecode(coverage.durationMs)}
          </dd>
        </div>
      </dl>
      {coverage.uncovered.length > 0 ? (
        <ol className="range-list">
          {coverage.uncovered.slice(0, 20).map((range) => (
            <li key={String(range.start) + '-' + String(range.end)}>
              {formatTimecode(range.start)}–{formatTimecode(range.end)}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ConflictView({ conflicts }: { conflicts: readonly FusionConflict[] }) {
  if (conflicts.length === 0)
    return (
      <div className="inspector__content">
        <p className="panel-empty">No source conflicts are recorded in this project.</p>
      </div>
    );
  return (
    <div className="inspector__content">
      <p className="conflict-intro">
        FrameScript keeps disagreements visible instead of silently choosing the cleaner line.
      </p>
      <ol className="conflict-list">
        {conflicts.map((conflict, index) => (
          <li key={String(conflict.timestamp) + '-' + String(index)}>
            <time>{formatTimecode(conflict.timestamp)}</time>
            <strong>Evidence conflict</strong>
            <p>{conflict.description}</p>
            <small>{conflict.evidenceIds.length} evidence references</small>
          </li>
        ))}
      </ol>
    </div>
  );
}

function confidenceMax(a: string, b: string): 'high' | 'medium' | 'low' | 'unknown' {
  const order = { unknown: 0, low: 1, medium: 2, high: 3 };
  return order[b as keyof typeof order] > order[a as keyof typeof order]
    ? (b as 'high' | 'medium' | 'low' | 'unknown')
    : (a as 'high' | 'medium' | 'low' | 'unknown');
}
