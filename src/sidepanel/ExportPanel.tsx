/**
 * Export.
 *
 * Every format carries the reconstruction disclaimer and, optionally, the
 * coverage report — so a document that leaves FrameScript cannot be mistaken
 * for a production screenplay or imply it analyzed material it never saw.
 */

import { useEffect, useState } from 'react';
import { onRuntimeMessage, sendRuntime } from '../messaging/bus';
import type { WorkerToUi } from '../messaging/protocol';
import type { ExportFormat } from '../screenplay/export';

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'fountain', label: 'Fountain', hint: 'Opens in Final Draft, Highland, Slugline' },
  { id: 'markdown', label: 'Markdown', hint: 'Readable anywhere' },
  { id: 'text', label: 'Plain text', hint: 'Screenplay layout, no markup' },
  { id: 'srt', label: 'SRT', hint: 'Dialogue only, as subtitles' },
  { id: 'json', label: 'JSON', hint: 'Full scene model with provenance' },
];

export interface ExportPanelProps {
  tabId: number;
  language: string;
  onClose: () => void;
}

export function ExportPanel({ tabId, language, onClose }: ExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>('fountain');
  const [options, setOptions] = useState({
    includeTimestamps: false,
    includeConfidence: false,
    includeEvidenceRefs: false,
    dialogueOnly: false,
    includeTransitions: true,
  });
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    return onRuntimeMessage<WorkerToUi>((message) => {
      if (message.type !== 'worker/export-ready') return undefined;
      downloadFile(message.payload);
      setStatus(`Saved ${message.payload.filename}`);
      return undefined;
    });
  }, []);

  const run = async () => {
    setStatus('Preparing…');
    await sendRuntime({
      type: 'ui/export',
      payload: { tabId, format, language, options },
    });
  };

  return (
    <aside className="fs-drawer" aria-label="Export">
      <div className="fs-drawer__header">
        <h2>Export</h2>
        <button className="fs-drawer__close" onClick={onClose} aria-label="Close export">
          ×
        </button>
      </div>

      <fieldset className="fs-fieldset">
        <legend className="fs-eyebrow">Format</legend>
        {FORMATS.map((entry) => (
          <label key={entry.id} className="fs-radio">
            <input
              type="radio"
              name="format"
              value={entry.id}
              checked={format === entry.id}
              onChange={() => setFormat(entry.id)}
            />
            <span className="fs-radio__body">
              <span>{entry.label}</span>
              <span className="fs-muted">{entry.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="fs-fieldset">
        <legend className="fs-eyebrow">Include</legend>
        <Check
          label="Timestamps"
          checked={options.includeTimestamps}
          onChange={(v) => setOptions({ ...options, includeTimestamps: v })}
        />
        <Check
          label="Confidence levels"
          checked={options.includeConfidence}
          onChange={(v) => setOptions({ ...options, includeConfidence: v })}
        />
        <Check
          label="Evidence sources"
          checked={options.includeEvidenceRefs}
          onChange={(v) => setOptions({ ...options, includeEvidenceRefs: v })}
        />
        <Check
          label="Transitions (CUT TO:)"
          checked={options.includeTransitions}
          onChange={(v) => setOptions({ ...options, includeTransitions: v })}
        />
        <Check
          label="Dialogue only"
          checked={options.dialogueOnly}
          onChange={(v) => setOptions({ ...options, dialogueOnly: v })}
        />
      </fieldset>

      <p className="fs-drawer__note fs-muted">
        Exports state clearly that they are reconstructions from observed playback, and include an analysis
        coverage report.
      </p>

      <button className="fs-button fs-button--primary fs-button--block" onClick={() => void run()}>
        Export {language}
      </button>

      {status && <p className="fs-drawer__status fs-secondary">{status}</p>}
    </aside>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="fs-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/**
 * Triggers a download from a generated blob.
 *
 * Uses an object URL rather than `chrome.downloads`, which keeps the extension
 * out of the downloads permission entirely.
 */
function downloadFile(payload: { filename: string; mimeType: string; content: string }): void {
  const blob = new Blob([payload.content], { type: payload.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = payload.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick; revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
