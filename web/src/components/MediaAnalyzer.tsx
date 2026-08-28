/**
 * Media analysis controls.
 *
 * The panel's job is to stop the app claiming capabilities it does not have.
 * Three things are shown before anything runs:
 *
 *   - which evidence sources are available *on this deployment*, checked
 *     against `/api/capabilities` rather than assumed;
 *   - what each analysis stage will actually do, including the bounded number
 *     of remote requests;
 *   - what leaves the device, in the same place as the switch that causes it.
 *
 * During a run the phases are named and the progress is measured. Where a
 * ratio genuinely is not knowable the bar is indeterminate rather than
 * animated toward an invented number.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { profileFor, type AnalysisFidelity, type EvidenceEvent } from '@/core';
import {
  UNREACHABLE_CAPABILITIES,
  fetchCapabilities,
  type Capabilities,
} from '../analysis/apiClient';
import {
  runAnalysis,
  summarizeOutcome,
  type AnalysisOutcome,
  type AnalysisProgress,
} from '../analysis/runAnalysis';
import { buildDiagnostics, formatDiagnostics } from '../analysis/diagnostics';

const APP_VERSION = '0.1.0';
/** Scene-understanding budgets. Separate from local fidelity, on purpose. */
const SCENE_BUDGETS = { off: 0, key: 6, extended: 12 } as const;
type SceneDepth = keyof typeof SCENE_BUDGETS;

const SPOKEN_LANGUAGES = [
  { value: 'auto', label: 'Auto detect' },
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어 (Korean)' },
  { value: 'es', label: 'Español (Spanish)' },
] as const;
type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number]['value'];

export function MediaAnalyzer({
  file,
  onComplete,
}: {
  file: File;
  onComplete: (events: EvidenceEvent[], durationMs: number, summary: string) => void;
}) {
  const [fidelity, setFidelity] = useState<AnalysisFidelity>('detailed');
  const [scanRate, setScanRate] = useState(4);
  const [analyzeAudio, setAnalyzeAudio] = useState(true);
  const [analyzeVideo, setAnalyzeVideo] = useState(true);
  const [transcribe, setTranscribe] = useState(true);
  const [spokenLanguage, setSpokenLanguage] = useState<SpokenLanguage>('auto');
  const [sceneDepth, setSceneDepth] = useState<SceneDepth>('key');
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [outcome, setOutcome] = useState<AnalysisOutcome | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [copied, setCopied] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string>();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    setOutcome(null);
    setProgress(null);
    setCopied(false);
    const controller = abortRef.current;
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(undefined);
      controller?.abort();
    };
  }, [file]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCapabilities(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCapabilities(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCapabilities(UNREACHABLE_CAPABILITIES);
      });
    return () => controller.abort();
  }, []);

  const isVideo = /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name);
  const resolved = capabilities ?? UNREACHABLE_CAPABILITIES;
  const canTranscribe = resolved.transcription.configured;
  const canSeeScenes = resolved.vision.configured && isVideo;
  const sceneWindows = SCENE_BUDGETS[sceneDepth];

  const run = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setOutcome(null);

    try {
      const result = await runAnalysis({
        file,
        video: isVideo ? videoRef.current : null,
        fidelity,
        scanRate,
        analyzeAudio,
        analyzeVideo: analyzeVideo && isVideo,
        transcribe: transcribe && canTranscribe,
        ...(spokenLanguage === 'auto' ? {} : { languageHint: spokenLanguage }),
        sceneUnderstanding: canSeeScenes && sceneWindows > 0,
        maxSceneWindows: sceneWindows,
        capabilities: resolved,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setOutcome(result);
      onComplete(result.events, result.durationMs, summarizeOutcome(result));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }, [
    analyzeAudio,
    analyzeVideo,
    canSeeScenes,
    canTranscribe,
    fidelity,
    file,
    isVideo,
    onComplete,
    resolved,
    sceneWindows,
    scanRate,
    spokenLanguage,
    transcribe,
  ]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const copyDiagnostics = useCallback(() => {
    const video = videoRef.current;
    const report = buildDiagnostics({
      version: APP_VERSION,
      file: { name: file.name, size: file.size, type: file.type },
      media: {
        ...(outcome?.durationMs ? { durationMs: outcome.durationMs } : {}),
        ...(video?.videoWidth ? { videoWidth: video.videoWidth } : {}),
        ...(video?.videoHeight ? { videoHeight: video.videoHeight } : {}),
      },
      capabilities: resolved,
      ...(outcome ? { outcome } : {}),
    });
    void navigator.clipboard?.writeText(formatDiagnostics(report)).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [file, outcome, resolved]);

  const running = progress !== null;
  const profile = profileFor(fidelity);
  const summary = useMemo(() => (outcome ? summaryLines(outcome) : []), [outcome]);

  return (
    <section className="card analyzer">
      <h2 className="eyebrow">Analyze media</h2>
      <p className="muted small">{file.name}</p>

      {isVideo && (
        <video
          ref={videoRef}
          src={objectUrl}
          className="analyzer__video"
          playsInline
          muted
          preload="metadata"
        />
      )}

      <dl className="capabilities" aria-label="Analysis capabilities">
        <Capability label="Audio decoding" state="Local" />
        <Capability label="Speech detection" state="Local" />
        <Capability label="Speaker clustering" state="Local" />
        <Capability
          label="Transcription"
          state={capabilities === null ? 'Checking…' : canTranscribe ? 'Ready' : 'Not configured'}
          hint={canTranscribe ? resolved.transcription.model : resolved.transcription.reason}
          muted={!canTranscribe}
        />
        {isVideo && <Capability label="Picture scanning" state="Local" />}
        {isVideo && (
          <Capability
            label="Visual understanding"
            state={
              capabilities === null
                ? 'Checking…'
                : resolved.vision.configured
                  ? 'Ready'
                  : 'Not configured'
            }
            hint={resolved.vision.configured ? resolved.vision.model : resolved.vision.reason}
            muted={!resolved.vision.configured}
          />
        )}
      </dl>

      <div className="field">
        <label className="field__label" htmlFor="fidelity">
          Local observation fidelity
        </label>
        <select
          id="fidelity"
          className="select"
          value={fidelity}
          disabled={running}
          onChange={(e) => setFidelity(e.target.value as AnalysisFidelity)}
        >
          <option value="efficient">Efficient — ~5 observations/s</option>
          <option value="detailed">Detailed — 100 ms observation</option>
          <option value="forensic">Forensic — every presented frame</option>
        </select>
        <p className="muted small">{profile.description}</p>
      </div>

      {isVideo && (
        <div className="field">
          <label className="field__label" htmlFor="rate">
            Scan speed — {scanRate}×
          </label>
          <input
            id="rate"
            type="range"
            min="1"
            max="8"
            step="1"
            value={scanRate}
            disabled={running}
            onChange={(e) => setScanRate(Number(e.target.value))}
          />
          <p className="muted small">
            The picture is observed while the file plays, so a scan takes the runtime divided by
            this rate. Faster means fewer observations per second of media.
          </p>
        </div>
      )}

      <div className="checks">
        <label className="check">
          <input
            type="checkbox"
            checked={analyzeAudio}
            disabled={running}
            onChange={(e) => setAnalyzeAudio(e.target.checked)}
          />
          <span>Audio — speech, speakers, sound, silence</span>
        </label>
        {isVideo && (
          <label className="check">
            <input
              type="checkbox"
              checked={analyzeVideo}
              disabled={running}
              onChange={(e) => setAnalyzeVideo(e.target.checked)}
            />
            <span>Picture — motion and scene changes</span>
          </label>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={transcribe && canTranscribe}
            disabled={running || !canTranscribe}
            onChange={(e) => setTranscribe(e.target.checked)}
          />
          <span>
            Transcribe detected speech
            <em className="muted small">
              {canTranscribe
                ? ' Sends only the detected speech windows, 16 kHz mono, to this site’s own endpoint.'
                : ' Unavailable: this deployment has no transcription provider configured.'}
            </em>
          </span>
        </label>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="spoken-language">
          Spoken language
        </label>
        <select
          id="spoken-language"
          className="select"
          value={spokenLanguage}
          disabled={running || !canTranscribe || !transcribe}
          onChange={(e) => setSpokenLanguage(e.target.value as SpokenLanguage)}
        >
          {SPOKEN_LANGUAGES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="muted small">
          Auto detect is safest for mixed or unknown audio. Choosing English, 한국어 or Español
          sends a language hint to the transcription model, improving recognition accuracy and
          avoiding ambiguous language labels without translating the dialogue.
        </p>
      </div>

      {isVideo && (
        <div className="field">
          <label className="field__label" htmlFor="scene-depth">
            Scene understanding
          </label>
          <select
            id="scene-depth"
            className="select"
            value={sceneDepth}
            disabled={running || !canSeeScenes}
            onChange={(e) => setSceneDepth(e.target.value as SceneDepth)}
          >
            <option value="off">Off — local motion and cuts only</option>
            <option value="key">Key scenes — up to 6 selected windows</option>
            <option value="extended">Extended — up to 12 selected windows</option>
          </select>
          <p className="muted small">
            {canSeeScenes
              ? `At most ${sceneWindows} requests for this file, each carrying up to 3 downscaled keyframes chosen around a cut or a sustained action. Never the video.`
              : 'Unavailable: this deployment has no scene-understanding provider configured.'}
          </p>
        </div>
      )}

      {running ? (
        <>
          <div
            className={`progress${progress.ratio === undefined ? ' progress--indeterminate' : ''}`}
            role="progressbar"
            aria-label={progress.label}
            {...(progress.ratio === undefined
              ? {}
              : {
                  'aria-valuenow': Math.round(progress.ratio * 100),
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                })}
          >
            <div
              className="progress__bar"
              style={
                progress.ratio === undefined ? undefined : { width: `${progress.ratio * 100}%` }
              }
            />
          </div>
          <p className="small" aria-live="polite">
            <strong>{progress.label}</strong>
            {progress.detail ? <span className="muted"> — {progress.detail}</span> : null}
          </p>
          <button className="button" onClick={stop}>
            Stop
          </button>
        </>
      ) : (
        <button
          className="button button--primary"
          disabled={!analyzeAudio && (!isVideo || !analyzeVideo)}
          onClick={() => void run()}
        >
          {outcome ? 'Analyze again' : 'Analyze'}
        </button>
      )}

      {outcome && (
        <div className="analysis-summary">
          <h3 className="small">{outcome.aborted ? 'Analysis stopped' : 'Analysis complete'}</h3>
          <ul className="small">
            {summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {outcome.notices.length > 0 && (
            <ul className="analysis-notices small" aria-label="Analysis notices">
              {outcome.notices.map((notice) => (
                <li className="warning" key={notice.code}>
                  {notice.message}
                </li>
              ))}
            </ul>
          )}
          <button className="button button--ghost" type="button" onClick={copyDiagnostics}>
            {copied ? 'Diagnostics copied' : 'Copy diagnostics'}
          </button>
        </div>
      )}

      <p className="muted small">
        Speech detection, speaker clustering, sound, silence, motion and scene changes all run on
        this device. Dialogue text and scene descriptions require a model: when this deployment has
        one configured, only the detected speech windows and the selected keyframes are sent to this
        site’s own endpoint. The media file itself is never uploaded.
      </p>
    </section>
  );
}

function Capability({
  label,
  state,
  hint,
  muted,
}: {
  label: string;
  state: string;
  hint?: string | undefined;
  muted?: boolean;
}) {
  return (
    <div className={'capability' + (muted ? ' capability--muted' : '')}>
      <dt>{label}</dt>
      <dd>
        {state}
        {hint ? <span className="muted small"> {hint}</span> : null}
      </dd>
    </div>
  );
}

/**
 * Turns the outcome into counted statements.
 *
 * Every line here is a measured value. Coverage claims are kept apart on
 * purpose: observing 100% of a timeline is not the same as transcribing 100%
 * of its speech, and conflating them is the exact overclaim this panel exists
 * to avoid.
 */
function summaryLines(outcome: AnalysisOutcome): string[] {
  const lines: string[] = [];
  const { stats, coverage } = outcome;

  if (coverage.audioDecoded) {
    lines.push(`${stats.speechRegions} speech regions`);
    lines.push(`${stats.speakers} speaker clusters`);
    if (stats.soundEvents > 0) lines.push(`${stats.soundEvents} sound events`);
  } else {
    lines.push('No audio analyzed');
  }

  if (stats.speechWindowsPlanned > 0) {
    lines.push(
      `${stats.dialogueSegments} transcribed dialogue segments from ${stats.speechWindowsTranscribed} of ${stats.speechWindowsPlanned} speech windows`,
    );
  }
  if (stats.observations > 0) {
    lines.push(`${stats.observations} picture observations`);
    lines.push(`${stats.sceneCuts} scene changes`);
  }
  if (stats.keyframeWindows > 0) {
    lines.push(
      `${stats.sceneObservations} semantic scene observations from ${stats.keyframeWindows} analyzed windows`,
    );
  }
  if (coverage.durationMs > 0 && coverage.videoObservedMs > 0) {
    const percent = Math.min(
      100,
      Math.round((coverage.videoObservedMs / coverage.durationMs) * 100),
    );
    lines.push(`${percent}% of the picture timeline observed`);
  }
  if (coverage.transcribedRatio !== undefined) {
    lines.push(`${Math.round(coverage.transcribedRatio * 100)}% of detected speech transcribed`);
  }
  return lines;
}
