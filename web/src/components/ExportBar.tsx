/**
 * Export controls.
 *
 * Downloads are generated from an object URL in the page — there is no server
 * to send anything to, which is the point.
 */

import { useState } from 'react';
import type { ExportFormat } from '@/core';

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'fountain', label: 'Fountain' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'text', label: 'Text' },
  { id: 'srt', label: 'SRT' },
  { id: 'json', label: 'JSON' },
];

export function ExportBar({
  language,
  onExport,
}: {
  language: string;
  onExport: (format: ExportFormat, options: Record<string, boolean>) => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('fountain');
  const [options, setOptions] = useState<Record<string, boolean>>({
    timestamps: false,
    confidence: false,
    evidence: false,
    dialogueOnly: false,
  });

  const toggle = (key: string) => setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <footer className="exportbar">
      <select
        className="select"
        value={format}
        onChange={(e) => setFormat(e.target.value as ExportFormat)}
        aria-label="Export format"
      >
        {FORMATS.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>

      <div className="exportbar__options">
        {[
          ['timestamps', 'Timestamps'],
          ['confidence', 'Confidence'],
          ['evidence', 'Sources'],
          ['dialogueOnly', 'Dialogue only'],
        ].map(([key, label]) => (
          <label key={key} className="check check--inline">
            <input type="checkbox" checked={options[key] ?? false} onChange={() => toggle(key!)} />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <button className="button button--primary" onClick={() => onExport(format, options)}>
        Export {language}
      </button>
    </footer>
  );
}
