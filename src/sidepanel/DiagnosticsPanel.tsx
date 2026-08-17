/**
 * Diagnostics.
 *
 * Off by default and enabled in Settings → Advanced. Reports *measured* values,
 * never configured ones: "10 fps configured" is a setting, "9.6 observations
 * per second measured" is the truth, and only the second is useful when
 * something is wrong.
 *
 * Nothing here is transmitted anywhere.
 */

import type { SessionSnapshot } from '../messaging/protocol';
import { profileFor } from '../temporal/fidelity';
import { formatTimecode } from '../utils/time';

export function DiagnosticsPanel({
  snapshot,
  onClose,
}: {
  snapshot: SessionSnapshot;
  onClose: () => void;
}) {
  const profile = profileFor(snapshot.analysis.fidelity);
  const quality = snapshot.quality;

  return (
    <aside className="fs-drawer" aria-label="Diagnostics">
      <div className="fs-drawer__header">
        <h2>Diagnostics</h2>
        <button className="fs-drawer__close" onClick={onClose} aria-label="Close diagnostics">
          ×
        </button>
      </div>

      <div className="fs-scroll fs-diagnostics">
        <Group title="Platform">
          <Row label="Platform" value={snapshot.identity?.platform ?? '—'} />
          <Row label="Content id" value={snapshot.identity?.contentId ?? '—'} />
          <Row
            label="Duration"
            value={snapshot.player?.durationMs ? formatTimecode(snapshot.player.durationMs) : 'Unknown'}
          />
          <Row
            label="Position"
            value={snapshot.player ? formatTimecode(snapshot.player.currentTimeMs, { millis: true }) : '—'}
          />
          <Row label="Playing" value={String(snapshot.player?.playing ?? false)} />
          <Row
            label="Decoded size"
            value={
              snapshot.player?.videoWidth
                ? `${snapshot.player.videoWidth}×${snapshot.player.videoHeight}`
                : 'Unknown'
            }
          />
          <Row label="Protected playback" value={String(snapshot.player?.protectedPlayback ?? 'unknown')} />
        </Group>

        <Group title="Quality">
          <Row label="State" value={quality?.state ?? '—'} />
          <Row label="Manual override" value={String(quality?.userOverridden ?? false)} />
          <Row label="Menu readable" value={String(quality?.capabilities?.menuReadable ?? false)} />
          <Row label="Options listed" value={String(quality?.capabilities?.options.length ?? 0)} />
          <Row label="Requested" value={quality?.result?.requested?.label ?? '—'} />
          <Row label="Applied" value={quality?.result?.applied?.label ?? '—'} />
          <Row label="Verified" value={String(quality?.result?.verified ?? false)} />
          <Row label="Limited by" value={quality?.result?.limitedBy ?? '—'} />
        </Group>

        <Group title="Temporal engine">
          <Row label="Fidelity" value={profile.label} />
          <Row
            label="Target interval"
            value={profile.temporalIntervalMs === 0 ? 'presented frames' : `${profile.temporalIntervalMs} ms`}
          />
          <Row
            label="Measured observation rate"
            value={`${(snapshot.analysis.observedFps ?? 0).toFixed(2)} /s`}
            emphasis
          />
          <Row label="Deep analyses / min" value={String(snapshot.analysis.deepAnalysisPerMinute ?? 0)} emphasis />
          <Row label="Analysis frame size" value={`${profile.analysisWidth}×${profile.analysisHeight}`} />
          <Row label="Keyframe buffer" value={`${profile.keyframeBufferSize} frames`} />
        </Group>

        <Group title="Sources">
          {Object.values(snapshot.analysis.sources).map((status) => (
            <Row
              key={status.id}
              label={status.id}
              value={`${status.state}${status.eventCount ? ` · ${status.eventCount} events` : ''}`}
            />
          ))}
        </Group>

        <Group title="Reconstruction">
          <Row label="Scenes" value={String(snapshot.scenes.length)} />
          <Row
            label="Finalized scenes"
            value={String(snapshot.scenes.filter((s) => s.status === 'finalized').length)}
          />
          <Row
            label="Beats"
            value={String(snapshot.scenes.reduce((sum, scene) => sum + scene.beats.length, 0))}
          />
          <Row label="Characters" value={String(snapshot.characters.length)} />
          <Row label="Languages with dialogue" value={snapshot.availableLanguages.join(', ') || '—'} />
          <Row
            label="Coverage"
            value={
              snapshot.analysis.coverageRatio === undefined
                ? 'Unknown'
                : `${Math.round(snapshot.analysis.coverageRatio * 100)}%`
            }
          />
          <Row label="Unobserved ranges" value={String(snapshot.analysis.uncovered?.length ?? 0)} />
        </Group>

        {snapshot.analysis.errorMessage && (
          <Group title="Last error">
            <p className="fs-diagnostics__error">{snapshot.analysis.errorMessage}</p>
          </Group>
        )}
      </div>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="fs-diagnostics__group">
      <h3 className="fs-eyebrow">{title}</h3>
      <dl className="fs-diagnostics__list">{children}</dl>
    </section>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={`fs-diagnostics__row${emphasis ? ' fs-diagnostics__row--emphasis' : ''}`}>
      <dt>{label}</dt>
      <dd className="fs-mono">{value}</dd>
    </div>
  );
}
