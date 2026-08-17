/**
 * Netflix Maximum Quality Guard.
 *
 * Read this before changing anything here.
 *
 * Netflix decides its delivered representation server-side, inside a protected
 * playback pipeline. There is no legitimate way for an extension to raise it,
 * and every technique that claims to involves either manipulating a DRM-
 * protected manifest or spoofing entitlement. FrameScript does neither, so this
 * class does **not** change Netflix's quality. It is a *guard*, not a lever.
 *
 * What it does instead, all of it honest and all of it useful:
 *   - reports what this environment could display (a ceiling, not a claim);
 *   - reports the decoded frame size when the media element exposes one;
 *   - says "unknown" when it genuinely does not know;
 *   - names the things that legitimately cap quality — account playback
 *     settings, window size, the display — so the viewer can act on them
 *     themselves, in Netflix's own UI.
 *
 * There is no code path in this file that touches EME, mediaKeys, manifests,
 * licences, or any Netflix-internal API.
 */

import { probeEnvironment, buildNetflixReport, displayCeiling } from '../../quality/capabilities';
import type { NetflixQualityReport, PlaybackEnvironment } from '../../quality/types';
import { isProtectedPlayback } from '../shared/media';

export interface QualityAdvice {
  /** Short, actionable, and always something the *user* does, not FrameScript. */
  message: string;
  /** Where the user would act on it. */
  location: 'netflix-account' | 'browser' | 'display' | 'network';
}

export class NetflixQualityGuard {
  #environment: PlaybackEnvironment;

  constructor(environment: PlaybackEnvironment = probeEnvironment()) {
    this.#environment = environment;
  }

  get environment(): PlaybackEnvironment {
    return this.#environment;
  }

  /**
   * Builds the current report.
   *
   * `observedVideoHeight` comes from `HTMLVideoElement.videoHeight`, a standard
   * property describing the decoded frame size. Reading it is not a DRM
   * bypass — it is the same number any page can read — and it is frequently
   * available even under protected playback, which is why it is worth reporting
   * when present and reporting as unknown when absent.
   */
  report(video: HTMLVideoElement | null): NetflixQualityReport {
    const protectedPlayback = video ? (isProtectedPlayback(video) ?? false) : false;
    const observedVideoHeight = video && video.videoHeight > 0 ? video.videoHeight : undefined;

    const report = buildNetflixReport({
      environment: this.#environment,
      ...(observedVideoHeight === undefined ? {} : { observedVideoHeight }),
      protectedPlayback,
    });

    for (const advice of this.advise(video)) report.notes.push(advice.message);
    return report;
  }

  /**
   * Things that could legitimately be capping quality.
   *
   * Every item is a suggestion for the viewer. FrameScript never changes an
   * account setting, resizes a window, or alters playback on the user's behalf.
   */
  advise(video: HTMLVideoElement | null): QualityAdvice[] {
    const advice: QualityAdvice[] = [];

    advice.push({
      message:
        'If playback looks soft, check Netflix → Account → Playback settings and make sure the profile is set to Auto or High.',
      location: 'netflix-account',
    });

    if (video) {
      const rect = video.getBoundingClientRect();
      const ceiling = displayCeiling(this.#environment);
      // ABR players take the rendered player size into account, so a small
      // window genuinely limits the representation that gets requested.
      if (rect.height > 0 && ceiling && rect.height * (this.#environment.devicePixelRatio ?? 1) < ceiling * 0.6) {
        advice.push({
          message:
            'The player is occupying a small part of the screen. Streaming players request lower representations for smaller viewports — full screen usually raises quality.',
          location: 'browser',
        });
      }
      if (video.videoHeight === 0) {
        advice.push({
          message: 'The decoded frame size is not readable here, so the current stream resolution is unknown.',
          location: 'browser',
        });
      }
    }

    if (this.#environment.browser !== 'chrome') {
      advice.push({
        message: 'FrameScript is built and tested for desktop Chrome. Other browsers are not supported.',
        location: 'browser',
      });
    }

    const ceiling = displayCeiling(this.#environment);
    if (ceiling !== undefined && ceiling < 1440) {
      advice.push({
        message: `This display tops out around ${ceiling}p, which bounds what any higher stream could show.`,
        location: 'display',
      });
    }

    return advice;
  }

  /**
   * A short line for the popup.
   *
   * Never prints a resolution it did not observe. "Unknown" is the correct
   * answer when the frame size is not readable, and it is what appears.
   */
  summarize(report: NetflixQualityReport): { ceiling: string; current: string } {
    return {
      ceiling: report.environmentCeiling ? `Up to ${report.environmentCeiling}p` : 'Unknown',
      current: report.observedVideoHeight ? `${report.observedVideoHeight}p` : 'Unknown',
    };
  }
}
