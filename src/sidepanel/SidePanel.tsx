/**
 * The side panel — FrameScript's main workspace.
 *
 * Sits beside playback and renders the shared scene model in the chosen script
 * language. Everything expensive happens elsewhere; this surface only projects
 * the scene model and reacts to playback position.
 */

import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { sendRuntime } from '../messaging/bus';
import { renderScreenplay, SUPPORTED_SCRIPT_LANGUAGES } from '../screenplay/languageRenderer';
import { searchScreenplay } from '../screenplay/search';
import { CoverageBar, ScreenplayView, type ViewMode } from '../ui/components/ScreenplayView';
import { SourceIndicators, SourceNotices } from '../ui/components/SourceIndicators';
import {
  summarizeAnalysis,
  useActiveTabId,
  useAnalysisControls,
  useAppearance,
  usePlaybackPosition,
  useSession,
  useSettings,
} from '../ui/hooks';
import { formatTimecode } from '../utils/time';
import { CharacterPanel } from './CharacterPanel';
import { ExportPanel } from './ExportPanel';
import { DiagnosticsPanel } from './DiagnosticsPanel';

export function SidePanel() {
  const tabId = useActiveTabId();
  const { settings, update } = useSettings();
  const { snapshot, loading, notice, dismissNotice } = useSession(tabId);
  const { start, stop, seek, busy, error } = useAnalysisControls(tabId);
  const positionMs = usePlaybackPosition(snapshot);
  useAppearance(settings);

  const [mode, setMode] = useState<ViewMode>(settings.screenplay.defaultView);
  const [language, setLanguage] = useState<string>(resolveLanguage(settings.languages.scriptLanguage));
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<'none' | 'characters' | 'export' | 'diagnostics'>('none');

  const deferredQuery = useDeferredValue(query);
  const analysis = summarizeAnalysis(snapshot?.analysis);

  const document = useMemo(() => {
    if (!snapshot) return null;
    return renderScreenplay(snapshot.scenes, {
      language,
      ...(settings.languages.dualLanguageView
        ? { secondaryLanguage: settings.languages.secondaryLanguage }
        : {}),
      characters: snapshot.characters,
      fallbackLanguages: snapshot.availableLanguages,
      includeLowConfidence: settings.screenplay.includeLowConfidence,
    });
  }, [
    snapshot,
    language,
    settings.languages.dualLanguageView,
    settings.languages.secondaryLanguage,
    settings.screenplay.includeLowConfidence,
  ]);

  const results = useMemo(() => {
    if (!snapshot || deferredQuery.trim().length === 0) return [];
    return searchScreenplay(snapshot.scenes, deferredQuery, {
      language,
      characters: snapshot.characters,
      allLanguages: true,
      limit: 50,
    });
  }, [snapshot, deferredQuery, language]);

  const handleSeek = useCallback((ms: number) => void seek(ms), [seek]);

  const languageOptions = useMemo(() => {
    const available = new Set([...(snapshot?.availableLanguages ?? []), ...SUPPORTED_SCRIPT_LANGUAGES]);
    return [...available];
  }, [snapshot?.availableLanguages]);

  if (loading) {
    return (
      <div className="fs-panel-shell">
        <p className="fs-muted fs-panel-shell__center">Connecting to the player…</p>
      </div>
    );
  }

  if (!snapshot?.identity) {
    return (
      <div className="fs-panel-shell">
        <header className="fs-panel-header">
          <span className="fs-wordmark">FRAMESCRIPT</span>
        </header>
        <div className="fs-panel-shell__center">
          <p>Open a video on YouTube or Netflix.</p>
          <p className="fs-muted">
            FrameScript builds the screenplay while you watch. Nothing is analyzed until you start it.
          </p>
        </div>
      </div>
    );
  }

  const identity = snapshot.identity;

  return (
    <div className="fs-panel-shell">
      <header className="fs-panel-header">
        <div className="fs-stack">
          <span className="fs-wordmark">FRAMESCRIPT</span>
          <h1 className="fs-panel-header__title">{identity.seriesTitle ?? identity.title ?? 'Untitled'}</h1>
          {identity.seriesTitle && identity.season !== undefined && identity.episode !== undefined && (
            <p className="fs-secondary fs-panel-header__sub">
              S{String(identity.season).padStart(2, '0')} E{String(identity.episode).padStart(2, '0')}
              {identity.title ? ` · ${identity.title}` : ''}
            </p>
          )}
        </div>

        <div className="fs-panel-header__status">
          <span className={`fs-dot ${analysis.running ? 'fs-dot--live' : ''}`} aria-hidden="true" />
          <span className="fs-secondary">{analysis.label}</span>
        </div>
      </header>

      <div className="fs-panel-toolbar">
        <label className="fs-visually-hidden" htmlFor="fs-language">
          Script language
        </label>
        <select
          id="fs-language"
          className="fs-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {languageOptions.map((code) => (
            <option key={code} value={code}>
              {languageLabel(code)}
            </option>
          ))}
        </select>

        <div className="fs-segmented" role="tablist" aria-label="View mode">
          {(['dialogue', 'screenplay', 'evidence'] as ViewMode[]).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={mode === value}
              className={`fs-segmented__item${mode === value ? ' fs-segmented__item--active' : ''}`}
              onClick={() => setMode(value)}
            >
              {value === 'dialogue' ? 'Dialogue' : value === 'screenplay' ? 'Screenplay' : 'Evidence'}
            </button>
          ))}
        </div>

        {analysis.running ? (
          <button className="fs-button" onClick={() => void stop()} disabled={busy}>
            Stop
          </button>
        ) : (
          <button className="fs-button fs-button--primary" onClick={() => void start()} disabled={busy}>
            Start analysis
          </button>
        )}
      </div>

      <div className="fs-panel-search">
        <input
          className="fs-input"
          type="search"
          placeholder="Search dialogue and action…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the screenplay"
        />
      </div>

      {(error ?? notice) && (
        <div className={`fs-banner fs-banner--${notice?.severity ?? 'warning'}`} role="status">
          <span>{error ?? notice?.message}</span>
          {notice && (
            <button className="fs-banner__dismiss" onClick={dismissNotice} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}

      {query.trim().length > 0 ? (
        <SearchResults results={results} onSeek={handleSeek} />
      ) : document ? (
        <ScreenplayView
          document={document}
          positionMs={positionMs}
          mode={mode}
          showTimestamps={settings.screenplay.showTimestamps}
          followPlayback={settings.screenplay.followPlayback}
          autoScroll={settings.screenplay.autoScroll}
          onSeek={handleSeek}
          emptyState={<EmptyState running={analysis.running} />}
        />
      ) : null}

      <footer className="fs-panel-footer">
        {snapshot.analysis && (
          <>
            <SourceIndicators sources={snapshot.analysis.sources} />
            <SourceNotices sources={snapshot.analysis.sources} />
            <CoverageBar
              ratio={snapshot.analysis.coverageRatio}
              durationMs={snapshot.player?.durationMs}
              uncovered={snapshot.analysis.uncovered ?? []}
            />
          </>
        )}

        <div className="fs-panel-footer__toggles">
          <Toggle
            label="Follow playback"
            checked={settings.screenplay.followPlayback}
            onChange={(value) => void update({ screenplay: { followPlayback: value } })}
          />
          <Toggle
            label="Auto scroll"
            checked={settings.screenplay.autoScroll}
            onChange={(value) => void update({ screenplay: { autoScroll: value } })}
          />
          <Toggle
            label="Timestamps"
            checked={settings.screenplay.showTimestamps}
            onChange={(value) => void update({ screenplay: { showTimestamps: value } })}
          />
        </div>

        <div className="fs-panel-footer__actions">
          <button className="fs-button" onClick={() => setDrawer(drawer === 'characters' ? 'none' : 'characters')}>
            Characters ({snapshot.characters.length})
          </button>
          <button className="fs-button" onClick={() => setDrawer(drawer === 'export' ? 'none' : 'export')}>
            Export
          </button>
          <button
            className="fs-button"
            onClick={() => void sendRuntime({ type: 'ui/save-screenplay', payload: { tabId: tabId! } })}
            disabled={tabId === undefined}
          >
            Save
          </button>
          {settings.advanced.diagnosticsEnabled && (
            <button
              className="fs-button"
              onClick={() => setDrawer(drawer === 'diagnostics' ? 'none' : 'diagnostics')}
            >
              Diagnostics
            </button>
          )}
        </div>
      </footer>

      {drawer === 'characters' && tabId !== undefined && (
        <CharacterPanel
          tabId={tabId}
          characters={snapshot.characters}
          onClose={() => setDrawer('none')}
        />
      )}
      {drawer === 'export' && tabId !== undefined && (
        <ExportPanel tabId={tabId} language={language} onClose={() => setDrawer('none')} />
      )}
      {drawer === 'diagnostics' && (
        <DiagnosticsPanel snapshot={snapshot} onClose={() => setDrawer('none')} />
      )}
    </div>
  );
}

function EmptyState({ running }: { running: boolean }) {
  if (running) {
    return (
      <div className="fs-empty">
        <p>Watching.</p>
        <p className="fs-muted">
          Scenes appear as evidence accumulates. Dialogue arrives first; action follows once enough of the
          picture has been observed.
        </p>
      </div>
    );
  }
  return (
    <div className="fs-empty">
      <p>No screenplay yet.</p>
      <p className="fs-muted">
        Start script analysis to begin. FrameScript reads subtitles, listens to the audio and observes the
        picture ten times a second, then reconstructs the scene from what it actually saw.
      </p>
    </div>
  );
}

function SearchResults({
  results,
  onSeek,
}: {
  results: ReturnType<typeof searchScreenplay>;
  onSeek: (ms: number) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="fs-empty">
        <p className="fs-muted">No matches.</p>
      </div>
    );
  }
  return (
    <div className="fs-search-results fs-scroll">
      {results.map((result) => (
        <button
          key={`${result.beatId}-${result.matchStart}`}
          className="fs-search-result"
          onClick={() => onSeek(result.start)}
        >
          <span className="fs-mono fs-muted">{formatTimecode(result.start)}</span>
          <span className="fs-search-result__text">
            {result.characterName && <strong>{result.characterName}: </strong>}
            {result.snippet}
          </span>
          {result.language && <span className="fs-tag">{result.language}</span>}
        </button>
      ))}
    </div>
  );
}

function Toggle({
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

function resolveLanguage(setting: string): string {
  if (setting !== 'system') return setting;
  const uiLanguage = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return uiLanguage.split('-')[0] ?? 'en';
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  it: 'Italiano',
  zh: '中文',
  hi: 'हिन्दी',
  ar: 'العربية',
  ru: 'Русский',
  und: 'Undetermined',
};

function languageLabel(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}
