/**
 * Quality status display.
 *
 * Two different stories, told differently:
 *
 *   - YouTube: FrameScript selected a quality and can usually verify it, so it
 *     shows the selected tier and whether it was confirmed.
 *   - Netflix: FrameScript changed nothing, so it shows an environment ceiling
 *     and the observed stream — and prints "Unknown" rather than guessing when
 *     the decoded frame size is not readable.
 */

import type { QualityStatus } from '../../messaging/protocol';
import { describeQuality } from '../../quality/ranking';

const STATE_LABEL: Record<QualityStatus['state'], string> = {
  idle: 'Off',
  detecting: 'Detecting…',
  'waiting-for-player': 'Waiting for the player…',
  'reading-options': 'Reading available qualities…',
  applying: 'Applying…',
  'best-available': 'Best available',
  'user-overridden': 'Your choice',
  'platform-limited': 'Limited by the platform',
  unsupported: 'Not supported here',
  error: 'Could not verify',
};

export function QualityPanel({ quality }: { quality: QualityStatus | undefined }) {
  if (!quality) {
    return (
      <section className="fs-quality">
        <p className="fs-eyebrow">Maximum quality</p>
        <p className="fs-quality__value fs-muted">Waiting for the player…</p>
      </section>
    );
  }

  if (quality.platform === 'netflix') return <NetflixQuality quality={quality} />;
  return <YouTubeQuality quality={quality} />;
}

function YouTubeQuality({ quality }: { quality: QualityStatus }) {
  const applied = quality.result?.applied ?? quality.result?.requested;
  const verified = quality.result?.verified ?? false;

  return (
    <section className="fs-quality">
      <p className="fs-eyebrow">Maximum quality</p>
      <p className="fs-quality__value">{applied ? describeQuality(applied) : STATE_LABEL[quality.state]}</p>
      <p className="fs-quality__state fs-secondary">
        {STATE_LABEL[quality.state]}
        {applied && !verified && quality.state !== 'user-overridden' && ' · not confirmed'}
      </p>
      {quality.result?.message && <p className="fs-quality__note fs-muted">{quality.result.message}</p>}
    </section>
  );
}

function NetflixQuality({ quality }: { quality: QualityStatus }) {
  const report = quality.netflix;
  const ceiling = report?.environmentCeiling ? `Up to ${report.environmentCeiling}p` : 'Unknown';
  // Never substitute the ceiling for the observed value: they are different
  // claims, and conflating them is the exact dishonesty this panel avoids.
  const current = report?.observedVideoHeight ? `${report.observedVideoHeight}p` : 'Unknown';

  return (
    <section className="fs-quality">
      <p className="fs-eyebrow">Maximum quality</p>
      <dl className="fs-quality__pairs">
        <div>
          <dt>Environment ceiling</dt>
          <dd>{ceiling}</dd>
        </div>
        <div>
          <dt>Current stream</dt>
          <dd>{current}</dd>
        </div>
      </dl>
      <p className="fs-quality__note fs-muted">
        Netflix controls its own playback quality. FrameScript reports what it can observe and does not
        change it.
      </p>
      {report?.notes.slice(0, 2).map((note) => (
        <p key={note} className="fs-quality__note fs-muted">
          {note}
        </p>
      ))}
    </section>
  );
}
