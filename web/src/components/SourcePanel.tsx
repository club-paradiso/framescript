/**
 * Loaded sources, with their warnings.
 *
 * Warnings are shown next to the file that produced them rather than pooled
 * into one banner: "12 blocks skipped" is only actionable if you know which
 * file skipped them.
 */

import { DropZone } from './DropZone';
import type { LoadedSource } from '../studio/types';

const KIND_LABEL: Record<LoadedSource['kind'], string> = {
  subtitle: 'Subtitles',
  project: 'Project',
  media: 'Media',
};

export function SourcePanel({
  sources,
  onFiles,
}: {
  sources: readonly LoadedSource[];
  onFiles: (files: FileList | File[]) => void;
}) {
  return (
    <section className="card">
      <h2 className="eyebrow">Sources</h2>

      {sources.length === 0 ? (
        <p className="muted small">Nothing loaded yet.</p>
      ) : (
        <ul className="sources">
          {sources.map((source) => (
            <li key={source.id} className="sources__item">
              <div className="sources__head">
                <span className="sources__name" title={source.name}>
                  {source.name}
                </span>
                <span className="tag">{KIND_LABEL[source.kind]}</span>
              </div>
              <p className="muted small">
                {source.detail}
                {source.language ? ` · ${source.language}` : ''}
              </p>
              {source.warnings.map((warning) => (
                <p key={warning} className="warning small">
                  {warning}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}

      <DropZone onFiles={onFiles} compact />
    </section>
  );
}
