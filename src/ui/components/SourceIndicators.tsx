/**
 * Source status indicators.
 *
 * Shows, at a glance, which evidence sources are actually contributing. This is
 * a core honesty surface: when Netflix blocks frame access the user sees
 * "Video — Protected", not a silently thinner screenplay.
 */

import type { EvidenceSourceState, SourceStateMap } from '../../evidence/types';

const DISPLAY_ORDER: { key: keyof SourceStateMap; label: string }[] = [
  { key: 'subtitle', label: 'Subtitles' },
  { key: 'audio-asr', label: 'Speech' },
  { key: 'audio-speaker', label: 'Speakers' },
  { key: 'audio-event', label: 'Sound' },
  { key: 'video', label: 'Video' },
  { key: 'ocr', label: 'On-screen text' },
  { key: 'playback', label: 'Timeline' },
];

const STATE_MODIFIER: Record<EvidenceSourceState, string> = {
  active: 'fs-dot--active',
  available: 'fs-dot--active',
  starting: 'fs-dot--warn',
  unavailable: '',
  'permission-required': 'fs-dot--warn',
  'protected-content': 'fs-dot--protected',
  unsupported: '',
  failed: 'fs-dot--error',
};

const STATE_LABEL: Record<EvidenceSourceState, string> = {
  active: 'Active',
  available: 'Available',
  starting: 'Starting',
  unavailable: 'Unavailable',
  'permission-required': 'Permission needed',
  'protected-content': 'Protected',
  unsupported: 'Not supported',
  failed: 'Failed',
};

export interface SourceIndicatorsProps {
  sources: SourceStateMap;
  /** Compact mode omits the state word, for the popup. */
  compact?: boolean;
}

export function SourceIndicators({ sources, compact = false }: SourceIndicatorsProps) {
  return (
    <ul className="fs-sources" aria-label="Evidence sources">
      {DISPLAY_ORDER.map(({ key, label }) => {
        const status = sources[key];
        const state = status?.state ?? 'unavailable';
        return (
          <li key={key} className="fs-sources__item" title={status?.message ?? STATE_LABEL[state]}>
            <span className={`fs-dot ${STATE_MODIFIER[state]}`} aria-hidden="true" />
            <span className="fs-sources__label">{label}</span>
            {!compact && <span className="fs-sources__state">{STATE_LABEL[state]}</span>}
            <span className="fs-visually-hidden">
              {label}: {STATE_LABEL[state]}
              {status?.message ? `. ${status.message}` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Explanations for any source that is not contributing.
 *
 * Rendered as prose beneath the dots, because a grey dot alone does not tell
 * the user what to do about it.
 */
export function SourceNotices({ sources }: { sources: SourceStateMap }) {
  const notices = DISPLAY_ORDER.map(({ key, label }) => ({ label, status: sources[key] })).filter(
    (entry) => entry.status?.message && entry.status.state !== 'active',
  );

  if (notices.length === 0) return null;

  return (
    <ul className="fs-source-notices">
      {notices.map(({ label, status }) => (
        <li key={label} className="fs-source-notices__item">
          <strong>{label}:</strong> {status!.message}
        </li>
      ))}
    </ul>
  );
}
