/**
 * MV3 service worker.
 *
 * Coordination only. It routes messages, owns per-tab session state, and
 * manages the offscreen document's lifecycle — it never processes media. A
 * service worker can be terminated at any moment, so anything with a continuous
 * media pipeline has to live in the offscreen document instead.
 */

import { errorDetail, userMessageFor } from '../utils/errors';
import { broadcast, onRuntimeMessage, sendRuntime, sendToTab } from '../messaging/bus';
import type {
  ContentToWorker,
  FrameScriptMessage,
  OffscreenToWorker,
  SessionSnapshot,
  UiToWorker,
} from '../messaging/protocol';
import { AnalysisSession, SessionManager } from './sessionManager';
import { settingsStore } from '../settings/store';
import type { FrameScriptSettings } from '../settings/types';
import { renderScreenplay } from '../screenplay/languageRenderer';
import { coverageNote } from '../screenplay/languageRenderer';
import { exportScreenplay, type ExportFormat } from '../screenplay/export';
import { screenplayRepository } from '../storage/repository';
import { screenplayId } from '../storage/schema';
import type { ReconstructedScene } from '../scenes/types';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const sessions = new SessionManager();

let offscreenReady: Promise<void> | null = null;

// --- Offscreen lifecycle -------------------------------------------------------

/**
 * Creates the offscreen document if it does not exist.
 *
 * Chrome allows exactly one per extension, and creating a second throws, so
 * creation is serialized through a single promise and guarded by an existence
 * check.
 */
async function ensureOffscreen(): Promise<void> {
  offscreenReady ??= (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    });
    if (existing.length > 0) return;

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
      justification:
        'Analyze the captured tab audio and video to reconstruct a screenplay. Media is processed in memory and discarded.',
    });
  })().catch((err: unknown) => {
    offscreenReady = null;
    throw err;
  });

  return offscreenReady;
}

async function closeOffscreen(): Promise<void> {
  offscreenReady = null;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed; nothing to do.
  }
}

// --- Session helpers -----------------------------------------------------------

async function ensureSession(tabId: number): Promise<AnalysisSession> {
  const settings = await settingsStore.get();
  return sessions.ensure(
    tabId,
    () =>
      new AnalysisSession({
        tabId,
        fidelity: settings.analysis.fidelity,
        includeLowConfidence: settings.screenplay.includeLowConfidence,
        onScenesUpdated: (scenes, session) => {
          broadcast({
            type: 'worker/scenes-updated',
            payload: { scenes, characters: session.registry.snapshot() },
          });
        },
      }),
  );
}

function buildSnapshot(session: AnalysisSession): SessionSnapshot {
  return {
    ...(session.identity ? { identity: session.identity } : {}),
    ...(session.player ? { player: session.player } : {}),
    ...(session.quality ? { quality: session.quality } : {}),
    analysis: session.status(),
    scenes: session.scenes,
    characters: session.registry.snapshot(),
    subtitleLanguages: session.subtitleLanguages,
    availableLanguages: collectLanguages(session.scenes),
  };
}

function collectLanguages(scenes: readonly ReconstructedScene[]): string[] {
  const codes = new Set<string>();
  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (beat.type === 'dialogue') for (const code of Object.keys(beat.textVariants)) codes.add(code);
    }
  }
  return [...codes].filter((code) => code !== 'und');
}

/**
 * Keeps the offscreen document's media clock aligned with the player.
 *
 * Without this the offscreen document has wall-clock frames and no idea where
 * they land in the film, and every piece of audio/video evidence would be
 * mis-timestamped relative to the subtitles.
 */
async function pushMediaTime(session: AnalysisSession): Promise<void> {
  const player = session.player;
  if (!player) return;
  await sendRuntime({
    type: 'offscreen/media-time',
    payload: { currentTimeMs: player.currentTimeMs, playing: player.playing },
  });
}

// --- Analysis control ----------------------------------------------------------

async function startAnalysis(tabId: number, streamId: string | undefined): Promise<{ ok: boolean; message?: string }> {
  const settings = await settingsStore.get();
  const session = await ensureSession(tabId);

  if (!streamId) {
    const message = userMessageFor('TAB_CAPTURE_FAILED');
    session.setPhase('error', message);
    broadcast({ type: 'worker/analysis-status', payload: session.status() });
    return { ok: false, message };
  }

  session.setPhase('starting');
  broadcast({ type: 'worker/analysis-status', payload: session.status() });

  // Subtitles come from the content script and need no capture permission, so
  // they start first and keep working even if capture is declined.
  if (settings.analysis.sources.subtitles) {
    await sendToTab(tabId, { type: 'worker/start-subtitles', payload: {} });
  }

  try {
    await ensureOffscreen();
  } catch (err) {
    const message = userMessageFor('OFFSCREEN_FAILED');
    console.error('[FrameScript] offscreen creation failed:', errorDetail(err));
    session.setPhase('error', message);
    broadcast({ type: 'worker/analysis-status', payload: session.status() });
    return { ok: false, message };
  }

  const response = (await sendRuntime({
    type: 'offscreen/start',
    payload: {
      streamId,
      tabId,
      fidelity: settings.analysis.fidelity,
      sources: {
        audio: settings.analysis.sources.audio,
        video: settings.analysis.sources.video,
        soundEvents: settings.analysis.sources.soundEvents,
        ocr: settings.analysis.sources.ocr,
      },
    },
  })) as { ok?: boolean; message?: string } | null;

  if (!response?.ok) {
    const message = response?.message ?? userMessageFor('TAB_CAPTURE_FAILED');
    // Subtitles may still be running; analysis is degraded, not dead.
    session.setPhase(settings.analysis.sources.subtitles ? 'running' : 'error', message);
    broadcast({ type: 'worker/analysis-status', payload: session.status() });
    broadcast({ type: 'worker/notice', payload: { code: 'TAB_CAPTURE_FAILED', message, severity: 'warning' } });
    return { ok: settings.analysis.sources.subtitles, message };
  }

  session.setPhase('running');
  await pushMediaTime(session);
  broadcast({ type: 'worker/analysis-status', payload: session.status() });
  return { ok: true };
}

async function stopAnalysis(tabId: number): Promise<void> {
  const session = sessions.get(tabId);
  session?.setPhase('stopping');

  await sendRuntime({ type: 'offscreen/stop', payload: undefined });
  await sendToTab(tabId, { type: 'worker/stop-subtitles', payload: undefined });

  session?.setPhase('idle');
  if (session) broadcast({ type: 'worker/analysis-status', payload: session.status() });

  // The offscreen document exists only to process media; with no session using
  // it, closing it releases the stream and its buffers immediately.
  if (sessions.activeCount === 0) await closeOffscreen();
}

// --- Message routing -----------------------------------------------------------

onRuntimeMessage<FrameScriptMessage>(async (message, sender) => {
  const tabId = sender.tab?.id;

  if (message.type.startsWith('content/')) {
    return handleContentMessage(message as ContentToWorker, tabId);
  }
  if (message.type.startsWith('offscreen/')) {
    return handleOffscreenMessage(message as OffscreenToWorker);
  }
  if (message.type.startsWith('ui/')) {
    return handleUiMessage(message as UiToWorker);
  }
  return undefined;
});

async function handleContentMessage(message: ContentToWorker, tabId: number | undefined): Promise<unknown> {
  if (tabId === undefined) return { ok: false };
  const session = await ensureSession(tabId);

  switch (message.type) {
    case 'content/ready':
      return { ok: true };

    case 'content/identity':
      session.setIdentity(message.payload);
      broadcast({ type: 'worker/snapshot', payload: buildSnapshot(session) });
      return { ok: true };

    case 'content/player-state':
      session.setPlayerState(message.payload);
      broadcast({ type: 'worker/player-state', payload: message.payload });
      if (session.phase === 'running') await pushMediaTime(session);
      return { ok: true };

    case 'content/evidence':
      session.ingest(message.payload.events);
      return { ok: true };

    case 'content/quality':
      session.setQuality(message.payload);
      broadcast({ type: 'worker/quality-status', payload: message.payload });
      return { ok: true };

    case 'content/subtitle-languages':
      session.setSubtitleLanguages(message.payload.languages);
      return { ok: true };

    case 'content/navigated':
      return { ok: true };

    case 'content/error':
      broadcast({
        type: 'worker/notice',
        payload: { code: message.payload.code, message: message.payload.message, severity: 'warning' },
      });
      return { ok: true };

    default:
      return undefined;
  }
}

async function handleOffscreenMessage(message: OffscreenToWorker): Promise<unknown> {
  // The offscreen document analyzes exactly one tab at a time, so evidence is
  // routed to whichever session is currently running.
  const running = sessions.all().find((s) => s.phase === 'running' || s.phase === 'starting');

  switch (message.type) {
    case 'offscreen/ready':
      return { ok: true };

    case 'offscreen/evidence':
      running?.ingest(message.payload.events);
      return { ok: true };

    case 'offscreen/source-status':
      running?.setSourceStatuses(message.payload.statuses);
      if (running) broadcast({ type: 'worker/analysis-status', payload: running.status() });
      return { ok: true };

    case 'offscreen/stats':
      running?.setStats(message.payload);
      if (running) broadcast({ type: 'worker/analysis-status', payload: running.status() });
      return { ok: true };

    case 'offscreen/error':
      broadcast({
        type: 'worker/notice',
        payload: { code: message.payload.code, message: message.payload.message, severity: 'error' },
      });
      return { ok: true };

    default:
      return undefined;
  }
}

async function handleUiMessage(message: UiToWorker): Promise<unknown> {
  switch (message.type) {
    case 'ui/get-snapshot': {
      const tabId = message.payload.tabId ?? (await activeTabId());
      if (tabId === undefined) return null;
      const session = await ensureSession(tabId);
      // Ask the content script for fresh state; the worker may have restarted.
      const state = (await sendToTab(tabId, { type: 'worker/request-state', payload: undefined })) as
        | { identity?: SessionSnapshot['identity']; state?: SessionSnapshot['player']; quality?: SessionSnapshot['quality'] }
        | null;
      if (state?.identity) session.setIdentity(state.identity);
      if (state?.state) session.setPlayerState(state.state);
      if (state?.quality) session.setQuality(state.quality);
      return buildSnapshot(session);
    }

    case 'ui/start-analysis':
      return startAnalysis(message.payload.tabId, message.payload.streamId);

    case 'ui/stop-analysis':
      await stopAnalysis(message.payload.tabId);
      return { ok: true };

    case 'ui/pause-analysis': {
      await sendRuntime({ type: 'offscreen/pause', payload: undefined });
      const session = sessions.get(message.payload.tabId);
      session?.setPhase('paused');
      if (session) broadcast({ type: 'worker/analysis-status', payload: session.status() });
      return { ok: true };
    }

    case 'ui/resume-analysis': {
      await sendRuntime({ type: 'offscreen/resume', payload: undefined });
      const session = sessions.get(message.payload.tabId);
      session?.setPhase('running');
      if (session) broadcast({ type: 'worker/analysis-status', payload: session.status() });
      return { ok: true };
    }

    case 'ui/seek':
      return sendToTab(message.payload.tabId, {
        type: 'worker/seek',
        payload: { toMs: message.payload.toMs },
      });

    case 'ui/assign-speaker': {
      const session = sessions.get(message.payload.tabId);
      session?.assignSpeaker(message.payload.beatId, message.payload.characterId, message.payload.scope);
      return { ok: true };
    }

    case 'ui/rename-character': {
      const session = sessions.get(message.payload.tabId);
      session?.renameCharacter(message.payload.characterId, message.payload.name);
      return { ok: true };
    }

    case 'ui/merge-characters': {
      const session = sessions.get(message.payload.tabId);
      session?.mergeCharacters(message.payload.targetId, message.payload.sourceId);
      return { ok: true };
    }

    case 'ui/split-speaker': {
      const session = sessions.get(message.payload.tabId);
      session?.splitSpeaker(message.payload.characterId, message.payload.speakerId);
      return { ok: true };
    }

    case 'ui/export':
      return handleExport(message.payload);

    case 'ui/save-screenplay':
      return handleSave(message.payload.tabId);

    case 'ui/list-saved': {
      const items = await screenplayRepository.list().catch(() => []);
      broadcast({ type: 'worker/saved-list', payload: { items } });
      return { items };
    }

    case 'ui/delete-saved':
      await screenplayRepository.delete(message.payload.id).catch(() => undefined);
      return { ok: true };

    case 'ui/set-subtitle-language':
      return sendToTab(message.payload.tabId, {
        type: 'worker/set-subtitle-language',
        payload: { languageId: message.payload.languageId },
      });

    case 'ui/open-side-panel':
      await chrome.sidePanel.open({ tabId: message.payload.tabId }).catch(() => undefined);
      return { ok: true };

    default:
      return undefined;
  }
}

async function handleExport(payload: {
  tabId: number;
  format: ExportFormat;
  language: string;
  options: Record<string, boolean>;
}): Promise<unknown> {
  const session = sessions.get(payload.tabId);
  if (!session) return { ok: false };

  const characters = session.registry.snapshot();
  const document = renderScreenplay(session.scenes, {
    language: payload.language,
    characters,
    includeTransitions: payload.options.includeTransitions !== false,
  });

  const result = exportScreenplay(
    document,
    {
      ...(session.identity?.title ? { title: session.identity.title } : {}),
      ...(session.identity?.seriesTitle ? { seriesTitle: session.identity.seriesTitle } : {}),
      ...(session.identity?.season === undefined ? {} : { season: session.identity.season }),
      ...(session.identity?.episode === undefined ? {} : { episode: session.identity.episode }),
      ...(session.identity?.platform ? { platform: session.identity.platform } : {}),
      generatedAt: Date.now(),
      // Coverage travels with every export so a gap is never implied to be
      // analyzed silence.
      coverage: coverageNote(session.timeline.coverageRatio(), session.timeline.uncoveredRanges()),
    },
    {
      format: payload.format,
      includeTimestamps: payload.options.includeTimestamps ?? false,
      includeConfidence: payload.options.includeConfidence ?? false,
      includeEvidenceRefs: payload.options.includeEvidenceRefs ?? false,
      dialogueOnly: payload.options.dialogueOnly ?? false,
    },
    { scenes: session.scenes, characters },
  );

  broadcast({ type: 'worker/export-ready', payload: result });
  return result;
}

async function handleSave(tabId: number): Promise<unknown> {
  const session = sessions.get(tabId);
  const identity = session?.identity;
  if (!session || !identity) return { ok: false };

  const settings = await settingsStore.get();
  if (!settings.privacy.persistSavedScripts) {
    return { ok: false, message: 'Saving is disabled in Settings → Privacy.' };
  }

  const coverage = session.timeline.coverage();
  const languages = collectLanguages(session.scenes);

  try {
    await screenplayRepository.save({
      id: screenplayId(identity.platform, identity.contentId),
      platform: identity.platform,
      contentId: identity.contentId,
      ...(identity.title ? { title: identity.title } : {}),
      ...(identity.seriesTitle ? { seriesTitle: identity.seriesTitle } : {}),
      ...(identity.season === undefined ? {} : { season: identity.season }),
      ...(identity.episode === undefined ? {} : { episode: identity.episode }),
      createdAt: Date.now(),
      coverage: {
        observed: coverage.observed,
        ...(coverage.durationMs === undefined ? {} : { durationMs: coverage.durationMs }),
        ...(session.timeline.coverageRatio() === undefined ? {} : { ratio: session.timeline.coverageRatio()! }),
      },
      scenes: session.scenes,
      characters: session.registry.snapshot(),
      languageVariants: {
        // Provenance is preserved in storage: a translated line must never be
        // reloaded as though a platform had supplied it.
        platformSubtitles: languages,
        transcribed: [],
        translated: [],
      },
      fidelity: settings.analysis.fidelity,
      usedRemoteAi: settings.ai.remoteEnabled && settings.ai.consentAcknowledged,
    });
    return { ok: true };
  } catch (err) {
    console.error('[FrameScript] save failed:', errorDetail(err));
    return { ok: false, message: userMessageFor('STORAGE_FAILED') };
  }
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

// --- Browser events ------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.remove(tabId);
  if (sessions.activeCount === 0) void closeOffscreen();
});

chrome.runtime.onInstalled.addListener(() => {
  // Opening the side panel from the toolbar icon is the primary entry point.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});

/** Push settings changes to content scripts so quality re-applies immediately. */
settingsStore.subscribe((settings: FrameScriptSettings) => {
  void (async () => {
    const tabs = await chrome.tabs.query({
      url: ['https://www.youtube.com/*', 'https://www.netflix.com/*'],
    });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      await sendToTab(tab.id, { type: 'worker/settings-changed', payload: { settings } });
    }
  })();
});

// Warm the settings cache so the first content-script message is not blocked.
void settingsStore.get();
