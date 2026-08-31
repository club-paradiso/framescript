/**
 * React hooks shared by the popup, side panel and options page.
 *
 * These own every piece of extension-API interaction the UI needs, so the
 * components themselves stay declarative and testable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { onRuntimeMessage, sendRuntime } from '../messaging/bus';
import type { AnalysisStatus, SessionSnapshot, WorkerToUi } from '../messaging/protocol';
import { settingsStore } from '../settings/store';
import { DEFAULT_SETTINGS, mergeSettings, type FrameScriptSettings } from '../settings/types';
import type { DeepPartial } from '../settings/store';

/** Recursively applies a partial patch, used for the optimistic update below. */
function applyPatch<T extends Record<string, unknown>>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    const bothPlainObjects =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing);
    out[key] = bothPlainObjects
      ? applyPatch(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return out as T;
}

/** The tab the UI is acting on: the active YouTube/Netflix tab. */
export function useActiveTabId(): number | undefined {
  const [tabId, setTabId] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!cancelled) setTabId(tab?.id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return tabId;
}

export function useSettings(): {
  settings: FrameScriptSettings;
  update: (patch: DeepPartial<FrameScriptSettings>) => Promise<void>;
  loaded: boolean;
} {
  const [settings, setSettings] = useState<FrameScriptSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void settingsStore.get().then((value) => {
      if (cancelled) return;
      setSettings(value);
      setLoaded(true);
    });
    // Also react to changes made from another surface (e.g. options page open
    // beside the side panel).
    const unsubscribe = settingsStore.subscribe((value) => setSettings(value));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  /**
   * Applies a settings change optimistically, then persists it.
   *
   * The local state updates before the storage write completes. Without this a
   * controlled input reverts to its previous value for the duration of the
   * round-trip, so a click on a radio or checkbox visibly fails to register
   * before snapping into place. Persisting still happens, and the store's own
   * emit reconciles the final merged value.
   */
  const update = useCallback(async (patch: DeepPartial<FrameScriptSettings>) => {
    setSettings((current) =>
      mergeSettings(
        applyPatch(current as unknown as Record<string, unknown>, patch as Record<string, unknown>) as
          Partial<FrameScriptSettings>,
      ),
    );
    const next = await settingsStore.update(patch);
    setSettings(next);
  }, []);

  return { settings, update, loaded };
}

export interface SessionState {
  snapshot: SessionSnapshot | null;
  loading: boolean;
  notice: { message: string; severity: 'info' | 'warning' | 'error' } | null;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
}

/**
 * Subscribes to the worker's session broadcasts.
 *
 * Applies incremental updates rather than re-fetching the whole snapshot on
 * every message: `scenes-updated` fires about once a second during analysis,
 * and a full round-trip per update would make the panel visibly stutter.
 */
export function useSession(tabId: number | undefined): SessionState {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<SessionState['notice']>(null);
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const refresh = useCallback(async () => {
    const id = tabIdRef.current;
    if (id === undefined) return;
    const result = (await sendRuntime({
      type: 'ui/get-snapshot',
      payload: { tabId: id },
    })) as SessionSnapshot | null;
    setSnapshot(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (tabId === undefined) return;
    void refresh();

    const unsubscribe = onRuntimeMessage<WorkerToUi>((message) => {
      switch (message.type) {
        case 'worker/snapshot':
          setSnapshot(message.payload);
          setLoading(false);
          break;
        case 'worker/scenes-updated':
          setSnapshot((prev) =>
            prev
              ? { ...prev, scenes: message.payload.scenes, characters: message.payload.characters }
              : prev,
          );
          break;
        case 'worker/analysis-status':
          setSnapshot((prev) => (prev ? { ...prev, analysis: message.payload } : prev));
          break;
        case 'worker/quality-status':
          setSnapshot((prev) => (prev ? { ...prev, quality: message.payload } : prev));
          break;
        case 'worker/player-state':
          setSnapshot((prev) => (prev ? { ...prev, player: message.payload } : prev));
          break;
        case 'worker/notice':
          setNotice({ message: message.payload.message, severity: message.payload.severity });
          break;
        default:
          break;
      }
      return undefined;
    });

    return unsubscribe;
  }, [tabId, refresh]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  return { snapshot, loading, notice, dismissNotice, refresh };
}

/**
 * Starts analysis.
 *
 * The message originates from a click handler so the service worker can use
 * Chrome's user-invoked tab-capture grant. That constraint is also the reason
 * FrameScript can never begin analyzing a tab on its own.
 */
export function useAnalysisControls(tabId: number | undefined) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (tabId === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await sendRuntime({
        type: 'ui/start-analysis',
        payload: { tabId },
      })) as { ok?: boolean; message?: string } | null;
      if (!result?.ok && result?.message) setError(result.message);
    } catch {
      setError(
        'FrameScript could not start analysis. Reopen the popup or side panel while the video tab is active and try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [tabId]);

  const stop = useCallback(async () => {
    if (tabId === undefined) return;
    setBusy(true);
    await sendRuntime({ type: 'ui/stop-analysis', payload: { tabId } });
    setBusy(false);
  }, [tabId]);

  const pause = useCallback(async () => {
    if (tabId === undefined) return;
    await sendRuntime({ type: 'ui/pause-analysis', payload: { tabId } });
  }, [tabId]);

  const resume = useCallback(async () => {
    if (tabId === undefined) return;
    await sendRuntime({ type: 'ui/resume-analysis', payload: { tabId } });
  }, [tabId]);

  const seek = useCallback(
    async (toMs: number) => {
      if (tabId === undefined) return;
      await sendRuntime({ type: 'ui/seek', payload: { tabId, toMs } });
    },
    [tabId],
  );

  return { start, stop, pause, resume, seek, busy, error };
}

/** Applies theme and font-scale settings to the document root. */
export function useAppearance(settings: FrameScriptSettings): void {
  useEffect(() => {
    const root = document.documentElement;
    const theme =
      settings.appearance.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : settings.appearance.theme;
    root.setAttribute('data-theme', theme);
    root.style.setProperty('--fs-font-scale', String(settings.appearance.fontScale));
    root.setAttribute('data-reduced-motion', String(settings.appearance.reducedMotion));
  }, [settings.appearance.theme, settings.appearance.fontScale, settings.appearance.reducedMotion]);
}

/** Live player position, polled from the snapshot's player state. */
export function usePlaybackPosition(snapshot: SessionSnapshot | null): number {
  const [position, setPosition] = useState(0);
  const playerRef = useRef(snapshot?.player);
  playerRef.current = snapshot?.player;

  useEffect(() => {
    setPosition(snapshot?.player?.currentTimeMs ?? 0);
  }, [snapshot?.player?.currentTimeMs]);

  useEffect(() => {
    // Interpolate between reports so the active-line highlight moves smoothly
    // rather than stepping once per player-state message.
    const handle = setInterval(() => {
      const player = playerRef.current;
      if (!player?.playing) return;
      setPosition((prev) => prev + 250 * player.playbackRate);
    }, 250);
    return () => clearInterval(handle);
  }, []);

  return position;
}

export interface AnalysisSummary {
  phase: AnalysisStatus['phase'];
  running: boolean;
  label: string;
}

export function summarizeAnalysis(status: AnalysisStatus | undefined): AnalysisSummary {
  const phase = status?.phase ?? 'idle';
  const labels: Record<AnalysisStatus['phase'], string> = {
    idle: 'Not analyzing',
    starting: 'Starting…',
    running: 'Analyzing',
    paused: 'Paused',
    stopping: 'Stopping…',
    error: 'Stopped',
  };
  return { phase, running: phase === 'running', label: labels[phase] };
}
