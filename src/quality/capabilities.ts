/**
 * Environment capability diagnostics.
 *
 * Everything here is read from standard, non-invasive browser APIs. None of it
 * proves what a streaming service is *actually* delivering — it only bounds
 * what the environment could display. That distinction is the whole point of
 * this module and is preserved all the way to the UI.
 */

import type { NetflixQualityReport, PlaybackEnvironment } from './types';

export interface EnvironmentProbe {
  userAgent: string;
  userAgentData?: { platform?: string; brands?: { brand: string; version: string }[] };
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
  hardwareConcurrency?: number;
}

export function detectOs(probe: EnvironmentProbe): PlaybackEnvironment['os'] {
  const platform = probe.userAgentData?.platform?.toLowerCase();
  if (platform) {
    if (platform.includes('win')) return 'windows';
    if (platform.includes('mac')) return 'macos';
    if (platform.includes('chrome os') || platform.includes('cros')) return 'chromeos';
    if (platform.includes('android')) return 'android';
    if (platform.includes('linux')) return 'linux';
  }
  const ua = probe.userAgent.toLowerCase();
  if (ua.includes('cros')) return 'chromeos';
  if (ua.includes('android')) return 'android';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac os x') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

export function detectBrowserVersion(probe: EnvironmentProbe): number | undefined {
  const brand = probe.userAgentData?.brands?.find(
    (b) => /google chrome/i.test(b.brand) || /chromium/i.test(b.brand),
  );
  if (brand) {
    const major = Number.parseInt(brand.version, 10);
    if (Number.isFinite(major)) return major;
  }
  const match = /chrome\/(\d+)/i.exec(probe.userAgent);
  if (match) {
    const major = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(major)) return major;
  }
  return undefined;
}

export function buildEnvironment(probe: EnvironmentProbe): PlaybackEnvironment {
  const env: PlaybackEnvironment = {
    os: detectOs(probe),
    browser: /chrome|chromium|crios/i.test(probe.userAgent) ? 'chrome' : 'other',
  };
  const version = detectBrowserVersion(probe);
  if (version !== undefined) env.browserVersion = version;
  if (probe.screenWidth !== undefined) env.displayWidth = probe.screenWidth;
  if (probe.screenHeight !== undefined) env.displayHeight = probe.screenHeight;
  if (probe.devicePixelRatio !== undefined) env.devicePixelRatio = probe.devicePixelRatio;
  if (probe.hardwareConcurrency !== undefined) env.hardwareConcurrency = probe.hardwareConcurrency;
  return env;
}

/** Reads the live environment inside a DOM context. */
export function probeEnvironment(): PlaybackEnvironment {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; brands?: { brand: string; version: string }[] };
  };
  const probe: EnvironmentProbe = { userAgent: nav.userAgent };
  if (nav.userAgentData) probe.userAgentData = nav.userAgentData;
  if (typeof screen !== 'undefined') {
    probe.screenWidth = screen.width;
    probe.screenHeight = screen.height;
  }
  if (typeof devicePixelRatio === 'number') probe.devicePixelRatio = devicePixelRatio;
  if (typeof nav.hardwareConcurrency === 'number') probe.hardwareConcurrency = nav.hardwareConcurrency;
  return buildEnvironment(probe);
}

/**
 * The display's own resolution ceiling, in vertical device pixels. A 1440p
 * panel cannot show 2160p detail no matter what the service sends.
 */
export function displayCeiling(env: PlaybackEnvironment): number | undefined {
  if (env.displayHeight === undefined) return undefined;
  const dpr = env.devicePixelRatio ?? 1;
  return Math.round(env.displayHeight * dpr);
}

/**
 * Netflix capability notes.
 *
 * Netflix publishes that 4K playback in a browser requires specific
 * platform/browser combinations, and its actual delivered representation is
 * decided inside a protected pipeline we deliberately do not touch. So we
 * report an *environment ceiling* plus caveats, and we never assert a stream
 * resolution we did not observe.
 */
export function netflixEnvironmentNotes(env: PlaybackEnvironment): string[] {
  const notes: string[] = [];
  if (env.browser !== 'chrome') {
    notes.push('FrameScript is tuned for desktop Chrome; other browsers are untested.');
  }
  notes.push(
    'Netflix decides the delivered resolution server-side inside protected playback. FrameScript does not modify it.',
  );
  notes.push(
    'Netflix playback settings on your account (Auto / High / Medium / Low) can cap quality independently of this browser.',
  );

  const ceiling = displayCeiling(env);
  if (ceiling !== undefined && ceiling < 2160) {
    notes.push(`This display tops out near ${ceiling}p, so higher representations would not be visible.`);
  }
  return notes;
}

export interface NetflixReportInput {
  environment: PlaybackEnvironment;
  /** videoHeight from the media element, when it is readable. */
  observedVideoHeight?: number;
  /** True when frame access is blocked by protected playback. */
  protectedPlayback: boolean;
}

/**
 * Builds the honest Netflix quality report.
 *
 * The report has three distinct facts and never conflates them:
 *   1. what this environment could display,
 *   2. what the media element reports (often nothing, under DRM),
 *   3. what we therefore do not know.
 */
export function buildNetflixReport(input: NetflixReportInput): NetflixQualityReport {
  const { environment, observedVideoHeight, protectedPlayback } = input;
  const notes = netflixEnvironmentNotes(environment);
  const ceiling = displayCeiling(environment);

  let state: NetflixQualityReport['state'];
  if (environment.browser !== 'chrome') {
    state = 'unsupported';
  } else if (observedVideoHeight && observedVideoHeight > 0) {
    state = 'best-effort-active';
  } else if (protectedPlayback) {
    state = 'actual-resolution-unknown';
    notes.push('Frame-level access is blocked by protected playback, so the exact stream cannot be read.');
  } else {
    state = 'optimizing';
  }

  const report: NetflixQualityReport = { state, environment, notes };
  if (ceiling !== undefined) report.environmentCeiling = Math.min(ceiling, 2160);
  if (observedVideoHeight !== undefined && observedVideoHeight > 0) {
    report.observedVideoHeight = observedVideoHeight;
  }
  return report;
}
