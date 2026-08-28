/**
 * Media analysis controls.
 *
 * Audio and picture are analyzed very differently here, and the UI says so
 * rather than presenting one progress bar for two unlike jobs:
 *
 *  - Audio decodes in full and analyzes far faster than real time. Coverage is
 *    complete.
 *  - Picture is observed during playback. It takes real time divided by the
 *    scan rate, and whatever the user stops early is genuinely not observed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { profileFor, secondsToMs, type AnalysisFidelity, type EvidenceEvent } from '@/core';
import {
  analyzeAudioBuffer,
  decodeAudio,
  scanVideoDuringPlayback,
  type AnalysisProgress,
} from '../analysis/localMediaAnalyzer';

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
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string>();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    setDone(null);
    setProgress(null);
    setError(null);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(undefined);
      abortRef.current?.abort();
    };
  }, [file]);

  const isVideo = /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name);

  const run = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setDone(null);

    const events: EvidenceEvent[] = [];
    const summary: string[] = [];
    let durationMs = 0;

    try {
      // --- Audio: complete, offline ---------------------------------------
      if (analyzeAudio) {
        setProgress({ phase: 'decoding', message: 'Decoding audio…' });
        const buffer = await decodeAudio(file, controller.signal);
        if (controller.signal.aborted) return;

        if (!buffer) {
          summary.push('no decodable audio track');
        } else {
          durationMs = Math.max(durationMs, secondsToMs(buffer.duration));
          setProgress({
            phase: 'audio',
            ratio: 0,
            message: 'Analyzing speech, speakers and sound…',
          });
          const audio = await analyzeAudioBuffer(buffer, (ratio) =>
            setProgress({
              phase: 'audio',
              ratio,
              message: 'Analyzing speech, speakers and sound…',
            }),
          );
          events.push(...audio.events);
          summary.push(
            `${audio.stats.speechRegions} speech regions, ${audio.stats.speakers} speakers, ${audio.stats.soundEvents} sound events`,
          );
        }
      }

      // --- Picture: playback-driven ----------------------------------------
      if (analyzeVideo && isVideo && videoRef.current) {
        const video = videoRef.current;
        if (video.readyState < 1) {
          await new Promise<void>((resolve) => {
            video.addEventListener('loadedmetadata', () => resolve(), { once: true });
          });
        }
        durationMs = Math.max(durationMs, secondsToMs(video.duration || 0));

        setProgress({
          phase: 'video',
          ratio: 0,
          message: `Observing the picture at ${scanRate}×…`,
        });
        const scan = await scanVideoDuringPlayback(video, {
          fidelity,
          scanRate,
          signal: controller.signal,
          onProgress: (ratio) =>
            setProgress({
              phase: 'video',
              ratio,
              message: `Observing the picture at ${scanRate}×…`,
            }),
        });
        events.push(...scan.events);
        summary.push(
          `${scan.stats.observations} observations, ${scan.stats.sceneCuts} scene changes, ${scan.stats.actionSegments} action segments`,
        );
      }

      setProgress({ phase: 'done', message: 'Done' });
      const text = summary.join(' · ') || 'nothing analyzed';
      setDone(text);
      onComplete(events, durationMs, text);
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === 'NotSupportedError'
          ? 'This browser cannot decode that media file. Try a broadly supported MP4, WebM, MP3, or WAV file.'
          : 'Local analysis failed. The file remains available so you can adjust the sources and try again.',
      );
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }, [analyzeAudio, analyzeVideo, fidelity, file, isVideo, onComplete, scanRate]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const running = progress !== null;
  const profile = profileFor(fidelity);

  return (
    <section className="card">
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

      <div className="field">
        <label className="field__label" htmlFor="fidelity">
          Fidelity
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
      </div>

      {running ? (
        <>
          <div
            className={`progress${progress.ratio === undefined ? ' progress--indeterminate' : ''}`}
            role="progressbar"
            aria-label={progress.message}
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
          <p className="muted small">{progress.message}</p>
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
          Analyze
        </button>
      )}

      {done && <p className="small">Analyzed: {done}</p>}
      {error && <p className="warning small">{error}</p>}

      <p className="muted small">
        Local analysis finds speech, speakers, sound, silence, motion and scene changes. It does not
        transcribe speech or describe what is visible — that needs a model, which this app does not
        bundle.
      </p>
    </section>
  );
}
