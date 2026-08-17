/**
 * FrameScript Studio — the web/mobile app.
 *
 * Runs the same reconstruction engine as the extension, on files the user
 * provides. It is deliberately explicit, on screen, about the one thing it
 * cannot do: analyse YouTube or Netflix. Only an extension can see a streaming
 * site's player, and a web app that implied otherwise would be lying.
 *
 * Everything happens on device. There is no server, no upload, no account.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  buildScreenplay,
  cuesToEvidence,
  exportScreenplay,
  languageFromFilename,
  migrateScreenplay,
  parseSubtitleFile,
  renderScreenplay,
  searchScreenplay,
  summarizeBeats,
  type BuildResult,
  type CharacterEntity,
  type EvidenceEvent,
  type ExportFormat,
  type ReconstructedScene,
} from '@/core';
import { DropZone } from './components/DropZone';
import { ScreenplayReader, type ViewMode } from './components/ScreenplayReader';
import { MediaAnalyzer } from './components/MediaAnalyzer';
import { SourcePanel } from './components/SourcePanel';
import { ExportBar } from './components/ExportBar';

export interface LoadedSource {
  id: string;
  name: string;
  kind: 'subtitle' | 'export' | 'media';
  detail: string;
  language?: string;
  cueCount?: number;
  warnings: string[];
}

export interface Project {
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  languages: string[];
  coverageNotes: string[];
  coverageRatio?: number;
  title?: string;
  durationMs?: number;
}

export function App() {
  const [sources, setSources] = useState<LoadedSource[]>([]);
  const [evidence, setEvidence] = useState<EvidenceEvent[]>([]);
  const [importedScenes, setImportedScenes] = useState<ReconstructedScene[] | null>(null);
  const [importedCharacters, setImportedCharacters] = useState<CharacterEntity[]>([]);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [durationMs, setDurationMs] = useState<number | undefined>(undefined);

  const [language, setLanguage] = useState<string>('');
  const [secondaryLanguage, setSecondaryLanguage] = useState<string>('');
  const [mode, setMode] = useState<ViewMode>('screenplay');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(0);

  /** Rebuilds the project whenever evidence or imports change. */
  const project = useMemo<Project | null>(() => {
    if (importedScenes && evidence.length === 0) {
      const languages = new Set<string>();
      for (const scene of importedScenes) {
        for (const beat of scene.beats) {
          if (beat.type === 'dialogue') for (const code of Object.keys(beat.textVariants)) languages.add(code);
        }
      }
      return {
        scenes: importedScenes,
        characters: importedCharacters,
        languages: [...languages].filter((c) => c !== 'und'),
        coverageNotes: [],
        ...(title ? { title } : {}),
      };
    }
    if (evidence.length === 0) return null;

    const sourceEnd = evidence.reduce((max, e) => Math.max(max, e.end ?? e.start), 0);
    let built: BuildResult;
    try {
      built = buildScreenplay(evidence, {
        ...(durationMs === undefined ? {} : { durationMs }),
        // Subtitle-only input is a complete source; media analysis is not, and
        // reports whatever it actually observed.
        ...(mediaFile ? {} : { completeSourceRange: { start: 0, end: sourceEnd } }),
      });
    } catch {
      return null;
    }

    return {
      scenes: importedScenes ? [...importedScenes, ...built.scenes] : built.scenes,
      characters: importedCharacters.length > 0 ? importedCharacters : built.characters,
      languages: built.languages,
      coverageNotes: built.coverage.notes,
      ...(built.coverage.ratio === undefined ? {} : { coverageRatio: built.coverage.ratio }),
      ...(title ? { title } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }, [evidence, importedScenes, importedCharacters, title, durationMs, mediaFile]);

  const activeLanguage = language || project?.languages[0] || 'en';

  const document_ = useMemo(() => {
    if (!project) return null;
    return renderScreenplay(project.scenes, {
      language: activeLanguage,
      ...(secondaryLanguage ? { secondaryLanguage } : {}),
      characters: project.characters,
      fallbackLanguages: project.languages,
    });
  }, [project, activeLanguage, secondaryLanguage]);

  const results = useMemo(() => {
    if (!project || query.trim().length === 0) return [];
    return searchScreenplay(project.scenes, query, {
      allLanguages: true,
      characters: project.characters,
      limit: 100,
    });
  }, [project, query]);

  const addSource = useCallback((source: Omit<LoadedSource, 'id'>) => {
    idRef.current += 1;
    setSources((prev) => [...prev, { ...source, id: `s${idRef.current}` }]);
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();

        // --- Media file: hand off to the analyzer ---------------------------
        if (/\.(mp4|m4v|mov|webm|mkv|mp3|m4a|wav|ogg|aac|flac)$/.test(lower)) {
          setMediaFile(file);
          addSource({
            name: file.name,
            kind: 'media',
            detail: `${(file.size / 1_048_576).toFixed(1)} MB — ready to analyze`,
            warnings: [],
          });
          if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
          continue;
        }

        const text = await file.text();

        // --- FrameScript export --------------------------------------------
        if (lower.endsWith('.json')) {
          try {
            const parsed: unknown = JSON.parse(text);
            const migrated = migrateScreenplay(parsed);
            const record = parsed as { scenes?: ReconstructedScene[]; characters?: CharacterEntity[] };

            const scenes = migrated?.record.scenes ?? record.scenes;
            if (!Array.isArray(scenes)) {
              setError(`${file.name} is not a FrameScript export.`);
              continue;
            }
            setImportedScenes(scenes);
            setImportedCharacters(migrated?.record.characters ?? record.characters ?? []);
            if (migrated?.record.title) setTitle(migrated.record.title);
            if (migrated?.record.coverage.durationMs) setDurationMs(migrated.record.coverage.durationMs);
            addSource({
              name: file.name,
              kind: 'export',
              detail: `${scenes.length} scenes imported`,
              warnings: migrated?.migrated ? [`Upgraded from schema v${migrated.fromVersion}.`] : [],
            });
          } catch {
            setError(`${file.name} is not valid JSON.`);
          }
          continue;
        }

        // --- Subtitle file --------------------------------------------------
        const parsedFile = parseSubtitleFile(text);
        if (parsedFile.cues.length === 0) {
          setError(
            `No subtitle cues found in ${file.name} (detected format: ${parsedFile.format}).`,
          );
          continue;
        }
        const detected = languageFromFilename(file.name);
        const lang = detected === 'und' ? 'en' : detected;
        setEvidence((prev) => [
          ...prev,
          ...cuesToEvidence(parsedFile.cues, { language: lang, idPrefix: `sub-${file.name}` }),
        ]);
        addSource({
          name: file.name,
          kind: 'subtitle',
          detail: `${parsedFile.cues.length} cues · ${parsedFile.format.toUpperCase()}`,
          language: lang,
          cueCount: parsedFile.cues.length,
          warnings: [
            ...parsedFile.warnings,
            ...(detected === 'und'
              ? ['No language marker in the filename; assumed English. Rename to e.g. name.ko.srt to set it.']
              : []),
          ],
        });
        if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
      }
    },
    [addSource, title],
  );

  const handleAnalysisComplete = useCallback(
    (events: EvidenceEvent[], mediaDurationMs: number, summary: string) => {
      setEvidence((prev) => [...prev, ...events]);
      setDurationMs((prev) => Math.max(prev ?? 0, mediaDurationMs));
      addSource({ name: mediaFile?.name ?? 'media', kind: 'media', detail: summary, warnings: [] });
    },
    [addSource, mediaFile],
  );

  const handleExport = useCallback(
    (format: ExportFormat, options: Record<string, boolean>) => {
      if (!document_ || !project) return;
      const result = exportScreenplay(
        document_,
        {
          ...(project.title ? { title: project.title } : {}),
          generatedAt: Date.now(),
          coverage: project.coverageNotes,
        },
        {
          format,
          includeTimestamps: options.timestamps ?? false,
          includeConfidence: options.confidence ?? false,
          includeEvidenceRefs: options.evidence ?? false,
          dialogueOnly: options.dialogueOnly ?? false,
          dualLanguage: Boolean(secondaryLanguage),
        },
        { scenes: project.scenes, characters: project.characters },
      );

      const blob = new Blob([result.content], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
    [document_, project, secondaryLanguage],
  );

  const reset = useCallback(() => {
    setSources([]);
    setEvidence([]);
    setImportedScenes(null);
    setImportedCharacters([]);
    setMediaFile(null);
    setTitle(undefined);
    setDurationMs(undefined);
    setQuery('');
    setError(null);
  }, []);

  const beatCounts = project ? summarizeBeats(project.scenes) : null;

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <span className="wordmark">FRAMESCRIPT</span>
          <span className="app__sub">Studio</span>
        </div>
        {project && (
          <button className="button" onClick={reset}>
            Start over
          </button>
        )}
      </header>

      {!project && !mediaFile ? (
        <Welcome onFiles={handleFiles} error={error} />
      ) : (
        <main className="app__main">
          <aside className="app__side">
            <SourcePanel sources={sources} onFiles={handleFiles} />

            {mediaFile && (
              <MediaAnalyzer file={mediaFile} onComplete={handleAnalysisComplete} />
            )}

            {beatCounts && (
              <section className="card">
                <h2 className="eyebrow">Reconstruction</h2>
                <dl className="stats">
                  <Stat label="Scenes" value={String(project!.scenes.length)} />
                  <Stat label="Dialogue" value={String(beatCounts.dialogue ?? 0)} />
                  <Stat label="Action" value={String(beatCounts.action ?? 0)} />
                  <Stat label="Sound" value={String(beatCounts.sound ?? 0)} />
                  <Stat label="Speakers" value={String(project!.characters.length)} />
                </dl>
                {project!.coverageNotes.map((note) => (
                  <p key={note} className="muted small">
                    {note}
                  </p>
                ))}
              </section>
            )}
          </aside>

          <section className="app__reader">
            <div className="toolbar">
              <select
                className="select"
                value={activeLanguage}
                onChange={(e) => setLanguage(e.target.value)}
                aria-label="Script language"
              >
                {(project?.languages.length ? project.languages : ['en']).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>

              <select
                className="select"
                value={secondaryLanguage}
                onChange={(e) => setSecondaryLanguage(e.target.value)}
                aria-label="Second language"
              >
                <option value="">Single language</option>
                {(project?.languages ?? [])
                  .filter((c) => c !== activeLanguage)
                  .map((code) => (
                    <option key={code} value={code}>
                      + {code}
                    </option>
                  ))}
              </select>

              <div className="segmented" role="tablist" aria-label="View mode">
                {(['dialogue', 'screenplay', 'evidence'] as ViewMode[]).map((value) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={mode === value}
                    className={`segmented__item${mode === value ? ' segmented__item--active' : ''}`}
                    onClick={() => setMode(value)}
                  >
                    {value === 'dialogue' ? 'Dialogue' : value === 'screenplay' ? 'Screenplay' : 'Evidence'}
                  </button>
                ))}
              </div>

              <input
                className="input"
                type="search"
                placeholder="Search dialogue and action…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search"
              />
            </div>

            {error && <p className="banner banner--error">{error}</p>}

            {document_ && (
              <ScreenplayReader
                document={document_}
                mode={mode}
                query={query}
                results={results}
              />
            )}

            {document_ && <ExportBar language={activeLanguage} onExport={handleExport} />}
          </section>
        </main>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats__item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Welcome({ onFiles, error }: { onFiles: (files: FileList | File[]) => void; error: string | null }) {
  return (
    <main className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">Understand it like a screenplay.</h1>
        <p className="welcome__lede">
          Reconstruct a screenplay from subtitle files or from your own video and audio. Everything runs on
          this device — nothing is uploaded, and there is no account.
        </p>

        <DropZone onFiles={onFiles} />

        {error && <p className="banner banner--error">{error}</p>}

        <div className="welcome__grid">
          <Capability
            title="Subtitle files"
            body="Drop .srt or .vtt files. Speaker labels become characters, bracketed captions become sound beats, and several languages merge into one script with per-language dialogue."
          />
          <Capability
            title="Your own media"
            body="Drop a video or audio file. Audio is analyzed in full for speech, speakers, sound events and silence; the picture is observed during playback for motion and scene changes."
          />
          <Capability
            title="FrameScript exports"
            body="Open a .json export from the browser extension to read, search, re-render in another language, and convert to Fountain, Markdown, text or SRT."
          />
        </div>

        {/* The single most important honest statement in this app. */}
        <section className="notice">
          <h2>What this cannot do</h2>
          <p>
            This app cannot analyze YouTube or Netflix, and cannot change their playback quality. A web page
            has no way to see or control another site's player — that needs the{' '}
            <strong>FrameScript browser extension</strong>. Use the extension while watching, then open its
            export here.
          </p>
        </section>
      </div>
    </main>
  );
}

function Capability({ title, body }: { title: string; body: string }) {
  return (
    <div className="card">
      <h2 className="card__title">{title}</h2>
      <p className="muted small">{body}</p>
    </div>
  );
}
