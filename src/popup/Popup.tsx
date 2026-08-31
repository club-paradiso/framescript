/**
 * The popup.
 *
 * Deliberately small: status at a glance, and the two actions that need a user
 * gesture (start analysis, open the screenplay). Everything else lives in the
 * side panel or the options page.
 *
 * Starting analysis MUST originate here or in the side panel. The click grants
 * the service worker access to request tab capture, which is exactly the
 * property that guarantees FrameScript can never begin analyzing a tab on its
 * own.
 */

import { useMemo } from 'react';
import { sendRuntime } from '../messaging/bus';
import { SourceIndicators } from '../ui/components/SourceIndicators';
import { QualityPanel } from '../ui/components/QualityPanel';
import {
  summarizeAnalysis,
  useActiveTabId,
  useAnalysisControls,
  useAppearance,
  useSession,
  useSettings,
} from '../ui/hooks';
import { profileFor } from '../temporal/fidelity';

export function Popup() {
  const tabId = useActiveTabId();
  const { settings } = useSettings();
  const { snapshot, loading, notice } = useSession(tabId);
  const { start, stop, busy, error } = useAnalysisControls(tabId);
  useAppearance(settings);

  const analysis = summarizeAnalysis(snapshot?.analysis);
  const profile = profileFor(settings.analysis.fidelity);
  const identity = snapshot?.identity;

  const platformLabel = useMemo(() => {
    if (!identity) return null;
    return identity.platform === 'youtube' ? 'YouTube' : 'Netflix';
  }, [identity]);

  const openSidePanel = async () => {
    if (tabId === undefined) return;
    await sendRuntime({ type: 'ui/open-side-panel', payload: { tabId } });
    window.close();
  };

  if (loading) {
    return (
      <div className="fs-popup">
        <Header platform={null} />
        <p className="fs-popup__empty fs-muted">Checking this tab…</p>
      </div>
    );
  }

  if (!identity) {
    return (
      <div className="fs-popup">
        <Header platform={null} />
        <div className="fs-popup__empty">
          <p>FrameScript works on YouTube and Netflix.</p>
          <p className="fs-muted">Open a video on either site and reopen this popup.</p>
        </div>
        <button className="fs-button fs-button--block" onClick={() => void chrome.runtime.openOptionsPage()}>
          Settings
        </button>
      </div>
    );
  }

  return (
    <div className="fs-popup">
      <Header platform={platformLabel} />

      <section className="fs-popup__title">
        <h1>{identity.seriesTitle ?? identity.title ?? 'Untitled'}</h1>
        {identity.seriesTitle && identity.season !== undefined && identity.episode !== undefined && (
          <p className="fs-secondary">
            S{String(identity.season).padStart(2, '0')} E{String(identity.episode).padStart(2, '0')}
            {identity.title ? ` · ${identity.title}` : ''}
          </p>
        )}
      </section>

      <hr className="fs-divider" />
      <QualityPanel quality={snapshot?.quality} />
      <hr className="fs-divider" />

      <section className="fs-popup__analysis">
        <div className="fs-row fs-row--between">
          <p className="fs-eyebrow">Script analysis</p>
          <span className="fs-row">
            <span className={`fs-dot ${analysis.running ? 'fs-dot--live' : ''}`} aria-hidden="true" />
            <span className="fs-secondary">{analysis.label}</span>
          </span>
        </div>

        <p className="fs-popup__mode fs-muted">
          {profile.label} · {profile.temporalIntervalMs === 0 ? 'every presented frame' : `${profile.temporalIntervalMs} ms observation`}
        </p>

        {snapshot?.analysis && <SourceIndicators sources={snapshot.analysis.sources} compact />}

        {snapshot?.analysis.observedFps !== undefined && analysis.running && (
          <p className="fs-muted fs-popup__measured">
            Measured {snapshot.analysis.observedFps.toFixed(1)} observations/s
            {snapshot.analysis.deepAnalysisPerMinute
              ? ` · ${snapshot.analysis.deepAnalysisPerMinute} deep analyses/min`
              : ''}
          </p>
        )}
      </section>

      {(error ?? notice) && (
        <p className={`fs-popup__notice fs-popup__notice--${notice?.severity ?? 'warning'}`}>
          {error ?? notice?.message}
        </p>
      )}

      <div className="fs-popup__actions">
        {analysis.running ? (
          <button className="fs-button fs-button--block" onClick={() => void stop()} disabled={busy}>
            Stop analysis
          </button>
        ) : (
          <button
            className="fs-button fs-button--primary fs-button--block"
            onClick={() => void start()}
            disabled={busy}
          >
            Start script analysis
          </button>
        )}
        <button className="fs-button fs-button--block" onClick={() => void openSidePanel()}>
          Open screenplay
        </button>
      </div>

      <button className="fs-popup__settings" onClick={() => void chrome.runtime.openOptionsPage()}>
        Settings
      </button>
    </div>
  );
}

function Header({ platform }: { platform: string | null }) {
  return (
    <header className="fs-popup__header">
      <span className="fs-wordmark">FRAMESCRIPT</span>
      {platform && <span className="fs-secondary">{platform}</span>}
    </header>
  );
}
