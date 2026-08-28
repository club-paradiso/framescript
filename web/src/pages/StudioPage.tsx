import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildScreenplay,
  cuesToEvidence,
  exportScreenplay,
  languageFromFilename,
  parseFrameScriptProject,
  parseSubtitleFile,
  renderScreenplay,
  searchScreenplay,
  summarizeBeats,
  type EvidenceEvent,
  type ExportFormat,
  type FrameScriptProject,
} from '@/core';
import { DropZone } from '../components/DropZone';
import { ExportBar } from '../components/ExportBar';
import { MediaAnalyzer } from '../components/MediaAnalyzer';
import { ProjectInspector } from '../components/ProjectInspector';
import { SceneNavigator } from '../components/SceneNavigator';
import { ScreenplayReader, type ViewMode } from '../components/ScreenplayReader';
import { SourcePanel } from '../components/SourcePanel';
import type { LoadedSource, StudioIssue, StudioProject } from '../studio/types';

const MEDIA = /[.](mp4|m4v|mov|webm|mkv|mp3|m4a|wav|ogg|aac|flac)$/i;
const SUBTITLE = /[.](srt|vtt)$/i;
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;
const MAX_FILES_AT_ONCE = 32;

export function StudioPage({ reviewOnly = false }: { reviewOnly?: boolean }) {
  const [sources, setSources] = useState<LoadedSource[]>([]);
  const [evidence, setEvidence] = useState<EvidenceEvent[]>([]);
  const [imported, setImported] = useState<FrameScriptProject | null>(null);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [title, setTitle] = useState<string>();
  const [durationMs, setDurationMs] = useState<number>();
  const [language, setLanguage] = useState('');
  const [secondaryLanguage, setSecondaryLanguage] = useState('');
  const [mode, setMode] = useState<ViewMode>('screenplay');
  const [query, setQuery] = useState('');
  const [issues, setIssues] = useState<StudioIssue[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<'scenes' | 'script' | 'evidence'>('script');
  const [exportOpen, setExportOpen] = useState(false);
  const sourceCounter = useRef(0);
  const issueCounter = useRef(0);
  const fileKeys = useRef(new Set<string>());
  const searchRef = useRef<HTMLInputElement | null>(null);

  const built = useMemo((): { project: StudioProject | null; error: string | null } => {
    if (imported && evidence.length === 0) {
      return {
        error: null,
        project: {
          scenes: imported.scenes,
          characters: imported.characters,
          languages: imported.languages,
          coverage: imported.coverage,
          conflicts: imported.conflicts,
          evidence: [],
          ...(imported.metadata.title ? { title: imported.metadata.title } : {}),
          ...(imported.coverage.durationMs === undefined
            ? {}
            : { durationMs: imported.coverage.durationMs }),
        },
      };
    }
    if (evidence.length === 0) return { project: null, error: null };
    try {
      const sourceEnd = evidence.reduce((max, event) => Math.max(max, event.end ?? event.start), 0);
      const result = buildScreenplay(evidence, {
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(!mediaFile && sourceEnd > 0
          ? { completeSourceRange: { start: 0, end: sourceEnd } }
          : {}),
      });
      return {
        error: null,
        project: {
          scenes: imported ? [...imported.scenes, ...result.scenes] : result.scenes,
          characters: imported?.characters.length ? imported.characters : result.characters,
          languages: [...new Set([...(imported?.languages ?? []), ...result.languages])],
          coverage: {
            ...(result.coverage.ratio === undefined ? {} : { ratio: result.coverage.ratio }),
            ...(durationMs === undefined ? {} : { durationMs }),
            observed: result.coverage.observed,
            uncovered: result.coverage.uncovered,
            notes: result.coverage.notes,
          },
          conflicts: [...(imported?.conflicts ?? []), ...result.conflicts],
          evidence,
          ...(title ? { title } : {}),
          ...(durationMs === undefined ? {} : { durationMs }),
        },
      };
    } catch {
      return {
        project: null,
        error:
          'FrameScript could not reconstruct this evidence. Your files remain loaded so you can remove them or start again.',
      };
    }
  }, [durationMs, evidence, imported, mediaFile, title]);

  const project = built.project;
  const activeLanguage = language || project?.languages[0] || 'en';
  const document_ = useMemo(
    () =>
      project
        ? renderScreenplay(project.scenes, {
            language: activeLanguage,
            ...(secondaryLanguage ? { secondaryLanguage } : {}),
            characters: project.characters,
            fallbackLanguages: project.languages,
          })
        : null,
    [activeLanguage, project, secondaryLanguage],
  );
  const results = useMemo(
    () =>
      !project || query.trim().length === 0
        ? []
        : searchScreenplay(project.scenes, query, {
            allLanguages: true,
            characters: project.characters,
            limit: 100,
          }),
    [project, query],
  );
  const activeScene =
    project?.scenes.find((scene) => scene.id === activeSceneId) ?? project?.scenes[0] ?? null;
  const beatCounts = project ? summarizeBeats(project.scenes) : null;

  useEffect(() => {
    if (!activeSceneId && project?.scenes[0]) setActiveSceneId(project.scenes[0].id);
  }, [activeSceneId, project]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  const addIssue = useCallback((severity: StudioIssue['severity'], message: string) => {
    issueCounter.current += 1;
    setIssues((previous) => [
      ...previous,
      { id: 'issue-' + String(issueCounter.current), severity, message },
    ]);
  }, []);

  const addSource = useCallback((source: Omit<LoadedSource, 'id'>) => {
    sourceCounter.current += 1;
    setSources((previous) => [
      ...previous,
      { ...source, id: 'source-' + String(sourceCounter.current) },
    ]);
  }, []);

  const handleFiles = useCallback(
    async (incoming: FileList | File[]) => {
      const files = Array.from(incoming);
      if (files.length > MAX_FILES_AT_ONCE) {
        addIssue('error', 'Choose at most ' + String(MAX_FILES_AT_ONCE) + ' files at a time.');
        return;
      }
      let hasMedia = mediaFile !== null;
      let hasProject = imported !== null;
      for (const file of files) {
        const key = [file.name.toLowerCase(), file.size].join(':');
        if (fileKeys.current.has(key)) {
          addIssue('warning', file.name + ' is already loaded; the duplicate was skipped.');
          continue;
        }
        fileKeys.current.add(key);
        let accepted = false;
        try {
          if (MEDIA.test(file.name)) {
            if (file.size === 0) throw new Error(file.name + ' is empty.');
            if (hasMedia)
              throw new Error(
                'Only one media file can be analyzed at a time. Start over to choose a different file.',
              );
            setMediaFile(file);
            hasMedia = true;
            addSource({
              name: file.name,
              kind: 'media',
              detail: formatBytes(file.size) + ' · ready to analyze',
              warnings: [],
            });
            setTitle((previous) => previous ?? withoutExtension(file.name));
            accepted = true;
            continue;
          }

          if (file.name.toLowerCase().endsWith('.json')) {
            if (file.size > MAX_PROJECT_BYTES)
              throw new Error(file.name + ' is larger than the 25 MB project limit.');
            if (hasProject)
              throw new Error(
                'Only one FrameScript project can be opened at a time. Start over to open another.',
              );
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(await file.text()) as unknown;
            } catch {
              throw new Error(file.name + ' is not valid JSON.');
            }
            const parsedProject = parseFrameScriptProject(parsedJson);
            if (!parsedProject.ok) throw new Error(file.name + ': ' + parsedProject.error);
            setImported(parsedProject.project);
            hasProject = true;
            setTitle(parsedProject.project.metadata.title ?? withoutExtension(file.name));
            setDurationMs(parsedProject.project.coverage.durationMs);
            addSource({
              name: file.name,
              kind: 'project',
              detail:
                String(parsedProject.project.scenes.length) +
                ' scenes · format v' +
                String(parsedProject.project.formatVersion),
              warnings: parsedProject.warnings,
            });
            accepted = true;
            continue;
          }

          if (SUBTITLE.test(file.name)) {
            if (file.size > MAX_SUBTITLE_BYTES)
              throw new Error(file.name + ' is larger than the 10 MB subtitle limit.');
            const parsedFile = parseSubtitleFile(await file.text());
            if (parsedFile.cues.length === 0) {
              throw new Error(
                'No subtitle cues found in ' +
                  file.name +
                  ' (detected format: ' +
                  parsedFile.format +
                  ').',
              );
            }
            const detected = languageFromFilename(file.name);
            const inputLanguage = detected === 'und' ? 'en' : detected;
            setEvidence((previous) => [
              ...previous,
              ...cuesToEvidence(parsedFile.cues, {
                language: inputLanguage,
                idPrefix: 'sub-' + file.name,
              }),
            ]);
            addSource({
              name: file.name,
              kind: 'subtitle',
              detail: String(parsedFile.cues.length) + ' cues · ' + parsedFile.format.toUpperCase(),
              language: inputLanguage,
              cueCount: parsedFile.cues.length,
              warnings: [
                ...parsedFile.warnings,
                ...(detected === 'und'
                  ? [
                      'No language marker in the filename; assumed English. Rename it like episode.ko.srt to identify another track.',
                    ]
                  : []),
              ],
            });
            setTitle((previous) => previous ?? withoutExtension(file.name));
            accepted = true;
            continue;
          }

          throw new Error(
            file.name +
              ' is unsupported. Choose video, audio, SRT, VTT, or a FrameScript JSON project.',
          );
        } catch (error) {
          addIssue('error', error instanceof Error ? error.message : 'A file could not be read.');
        } finally {
          if (!accepted) fileKeys.current.delete(key);
        }
      }
    },
    [addIssue, addSource, imported, mediaFile],
  );

  const handleAnalysisComplete = useCallback(
    (events: EvidenceEvent[], mediaDurationMs: number, summary: string) => {
      setEvidence((previous) => [...previous, ...events]);
      setDurationMs((previous) => Math.max(previous ?? 0, mediaDurationMs));
      setSources((previous) =>
        previous.map((source) =>
          source.kind === 'media' ? { ...source, detail: 'Analyzed · ' + summary } : source,
        ),
      );
    },
    [],
  );

  const handleExport = useCallback(
    (format: ExportFormat, options: Record<string, boolean>) => {
      if (!document_ || !project) return;
      const result = exportScreenplay(
        document_,
        {
          ...(project.title ? { title: project.title } : {}),
          generatedAt: Date.now(),
          coverage: project.coverage.notes,
        },
        {
          format,
          includeTimestamps: options.timestamps ?? false,
          includeConfidence: options.confidence ?? false,
          includeEvidenceRefs: options.evidence ?? false,
          dialogueOnly: options.dialogueOnly ?? false,
          dualLanguage: Boolean(secondaryLanguage),
        },
        {
          scenes: project.scenes,
          characters: project.characters,
          languages: project.languages,
          coverage: project.coverage,
          conflicts: project.conflicts,
          sources: sources.map((source) => ({
            name: source.name,
            kind: source.kind,
            detail: source.detail,
            ...(source.language ? { language: source.language } : {}),
          })),
        },
      );
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }));
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
    [document_, project, secondaryLanguage, sources],
  );

  const navigateToScene = useCallback((sceneId: string) => {
    setQuery('');
    setActiveSceneId(sceneId);
    setMobileTab('script');
    window.setTimeout(
      () =>
        document
          .getElementById('scene-' + sceneId)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      0,
    );
  }, []);

  const reset = useCallback(() => {
    setSources([]);
    setEvidence([]);
    setImported(null);
    setMediaFile(null);
    setTitle(undefined);
    setDurationMs(undefined);
    setLanguage('');
    setSecondaryLanguage('');
    setQuery('');
    setIssues([]);
    setActiveSceneId(null);
    setMobileTab('script');
    setExportOpen(false);
    fileKeys.current.clear();
  }, []);

  const hasWorkspace = project !== null || mediaFile !== null || sources.length > 0;
  return (
    <div className="studio">
      <header className="studio-header">
        <a href="/" className="brand">
          FRAMESCRIPT <span>Studio</span>
        </a>
        {hasWorkspace ? (
          <strong className="studio-header__title">
            {project?.title ?? title ?? 'Untitled project'}
          </strong>
        ) : null}
        <nav aria-label="Studio navigation">
          <a href="/docs">Docs</a>
          {hasWorkspace ? (
            <button type="button" onClick={reset}>
              Start over
            </button>
          ) : null}
        </nav>
      </header>

      {!hasWorkspace ? (
        <StudioEmpty
          reviewOnly={reviewOnly}
          onFiles={handleFiles}
          issues={issues}
          onDismiss={(id) => setIssues((previous) => previous.filter((issue) => issue.id !== id))}
        />
      ) : (
        <main className="studio-workspace">
          <div className="studio-toolbar">
            <div className="studio-toolbar__search">
              <label className="visually-hidden" htmlFor="studio-search">
                Search screenplay
              </label>
              <input
                ref={searchRef}
                id="studio-search"
                type="search"
                placeholder="Search dialogue, speakers, action…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd>⌘K</kbd>
            </div>
            <select
              value={activeLanguage}
              onChange={(event) => setLanguage(event.target.value)}
              aria-label="Script language"
            >
              {(project?.languages.length ? project.languages : ['en']).map((code) => (
                <option key={code} value={code}>
                  {code.toUpperCase()}
                </option>
              ))}
            </select>
            <select
              value={secondaryLanguage}
              onChange={(event) => setSecondaryLanguage(event.target.value)}
              aria-label="Second language"
            >
              <option value="">Single language</option>
              {(project?.languages ?? [])
                .filter((code) => code !== activeLanguage)
                .map((code) => (
                  <option key={code} value={code}>
                    + {code.toUpperCase()}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="button button--primary"
              disabled={!project}
              onClick={() => setExportOpen((open) => !open)}
            >
              Export
            </button>
          </div>

          <div className="mobile-tabs" role="tablist" aria-label="Workspace view">
            {(['scenes', 'script', 'evidence'] as const).map((tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={mobileTab === tab}
                onClick={() => setMobileTab(tab)}
                key={tab}
              >
                {tab[0]!.toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          <IssueList
            issues={issues}
            buildError={built.error}
            onDismiss={(id) => setIssues((previous) => previous.filter((issue) => issue.id !== id))}
          />

          {exportOpen && document_ ? (
            <ExportBar language={activeLanguage} onExport={handleExport} />
          ) : null}

          <div className={'studio-grid studio-grid--' + mobileTab}>
            <aside className="studio-grid__scenes">
              <SceneNavigator
                scenes={project?.scenes ?? []}
                language={activeLanguage}
                activeSceneId={activeScene?.id ?? null}
                onSelect={navigateToScene}
              />
              <SourcePanel sources={sources} onFiles={handleFiles} />
              {mediaFile ? (
                <MediaAnalyzer file={mediaFile} onComplete={handleAnalysisComplete} />
              ) : null}
            </aside>

            <section className="studio-grid__script" aria-label="Screenplay workspace">
              <div className="script-toolbar">
                <div className="segmented" role="tablist" aria-label="Screenplay view">
                  {(['screenplay', 'dialogue', 'evidence'] as ViewMode[]).map((value) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={mode === value}
                      onClick={() => setMode(value)}
                      key={value}
                    >
                      {value[0]!.toUpperCase() + value.slice(1)}
                    </button>
                  ))}
                </div>
                {beatCounts ? (
                  <p>
                    {project?.scenes.length ?? 0} scenes · {beatCounts.dialogue ?? 0} dialogue ·{' '}
                    {project?.characters.length ?? 0} speakers
                  </p>
                ) : null}
              </div>
              {document_ ? (
                <ScreenplayReader
                  document={document_}
                  mode={mode}
                  query={query}
                  results={results}
                  onNavigate={navigateToScene}
                  onSceneChange={setActiveSceneId}
                />
              ) : (
                <div className="reader reader--empty">
                  <h2>Ready to analyze</h2>
                  <p>
                    Choose the analysis sources and start the local pass. Measurable phases will
                    appear here.
                  </p>
                </div>
              )}
            </section>

            <div className="studio-grid__evidence">
              <ProjectInspector
                scene={activeScene}
                coverage={
                  project?.coverage ?? {
                    observed: [],
                    uncovered: [],
                    notes: ['Analysis has not started.'],
                  }
                }
                conflicts={project?.conflicts ?? []}
                evidence={project?.evidence ?? []}
              />
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

function StudioEmpty({
  reviewOnly,
  onFiles,
  issues,
  onDismiss,
}: {
  reviewOnly: boolean;
  onFiles: (files: FileList | File[]) => void;
  issues: readonly StudioIssue[];
  onDismiss: (id: string) => void;
}) {
  return (
    <main className="studio-empty">
      <div className="studio-empty__copy">
        <h1>{reviewOnly ? 'Open a FrameScript project.' : 'Drop files. Build the script.'}</h1>
        <p>
          {reviewOnly
            ? 'Inspect a versioned FrameScript JSON project locally in your browser.'
            : 'Bring video, audio, SRT, VTT, or a FrameScript project. Sources align into one evidence-driven screenplay.'}
        </p>
      </div>
      <DropZone onFiles={onFiles} />
      <div className="format-list" aria-label="Accepted files">
        <span>
          <b>Video</b> MP4 · MOV · MKV · WebM
        </span>
        <span>
          <b>Audio</b> MP3 · M4A · WAV · FLAC
        </span>
        <span>
          <b>Subtitles</b> SRT · VTT
        </span>
        <span>
          <b>Project</b> FrameScript JSON
        </span>
      </div>
      <p className="local-note">
        <strong>Processed on this device.</strong> Your files are not uploaded.
      </p>
      {issues.length > 0 ? (
        <IssueList issues={issues} buildError={null} onDismiss={onDismiss} />
      ) : null}
      <a className="extension-note" href="/docs#extension">
        <span>Watching YouTube or Netflix?</span>
        <strong>Use the Chrome Extension →</strong>
      </a>
    </main>
  );
}

function IssueList({
  issues,
  buildError,
  onDismiss,
}: {
  issues: readonly StudioIssue[];
  buildError: string | null;
  onDismiss: (id: string) => void;
}) {
  if (issues.length === 0 && !buildError) return null;
  return (
    <section className="issue-list" aria-label="File messages" aria-live="polite">
      {buildError ? <p className="issue issue--error">{buildError}</p> : null}
      {issues.map((issue) => (
        <p className={'issue issue--' + issue.severity} key={issue.id}>
          <span>{issue.message}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => onDismiss(issue.id)}>
            ×
          </button>
        </p>
      ))}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function withoutExtension(name: string): string {
  const subtitleBase = name.replace(/[.][a-z]{2,3}(?:-[a-z]{2})?[.](?:srt|vtt)$/i, '');
  if (subtitleBase !== name) return subtitleBase;
  return name.replace(/[.][^.]+$/, '');
}
