import { describe, expect, it } from 'vitest';
import { parseQualityOption, parseResolution, parseFrameRate, isAutoLabel } from '@/quality/parser';
import { compareQuality, rankQualityOptions, selectQualityOption, verifyApplied, describeQuality } from '@/quality/ranking';
import { buildEnvironment, buildNetflixReport, displayCeiling } from '@/quality/capabilities';
import type { QualityPreference, VideoQualityOption } from '@/quality/types';

const pref = (
  id: QualityPreference['id'],
  maxResolution?: number,
  preferEnhancedBitrate = true,
): QualityPreference => ({
  id,
  ...(maxResolution === undefined ? {} : { maxResolution }),
  preferEnhancedBitrate,
});

const opts = (labels: string[], overrides: Partial<Record<string, Partial<VideoQualityOption>>> = {}) =>
  labels.map((label, i) => ({
    ...parseQualityOption({ id: `o${i}`, label }),
    ...(overrides[label] ?? {}),
  }));

describe('resolution parsing', () => {
  it.each([
    ['2160p60 HDR', 2160],
    ['1080p Premium', 1080],
    ['1440p', 1440],
    ['720P', 720],
    ['144p', 144],
    ['4K', 2160],
    ['8K', 4320],
    ['1920x1080', 1080],
    ['1920×1080', 1080],
  ])('parses %s as %ip', (label, expected) => {
    expect(parseResolution(label)).toBe(expected);
  });

  it('returns undefined for labels with no resolution', () => {
    expect(parseResolution('Auto')).toBeUndefined();
    expect(parseResolution('자동')).toBeUndefined();
  });

  it('parses frame rate from attached and explicit forms', () => {
    expect(parseFrameRate('2160p60')).toBe(60);
    expect(parseFrameRate('1080p 30fps')).toBe(30);
    expect(parseFrameRate('1080p')).toBeUndefined();
    // 8 is not a plausible frame rate and must not be accepted.
    expect(parseFrameRate('1080p8')).toBeUndefined();
  });

  it('recognises localized auto labels', () => {
    expect(isAutoLabel('Auto')).toBe(true);
    expect(isAutoLabel('자동 (720p)')).toBe(true);
    expect(isAutoLabel('自動')).toBe(true);
    expect(isAutoLabel('1080p')).toBe(false);
  });

  it('does not treat "Auto (1080p)" as a fixed 1080p tier', () => {
    const option = parseQualityOption({ id: 'a', label: 'Auto (1080p)' });
    expect(option.auto).toBe(true);
    // Critical: if this carried resolution 1080 it would be ranked and selected
    // as though it were a fixed tier.
    expect(option.resolution).toBeUndefined();
  });

  it('detects enhanced bitrate across locales', () => {
    expect(parseQualityOption({ id: 'a', label: '1080p Premium' }).enhancedBitrate).toBe(true);
    expect(parseQualityOption({ id: 'b', label: '1080p 프리미엄' }).enhancedBitrate).toBe(true);
    expect(parseQualityOption({ id: 'c', label: '1080p' }).enhancedBitrate).toBe(false);
  });
});

describe('quality ranking', () => {
  it('orders by resolution, then bitrate, then HDR, then frame rate', () => {
    const ranked = rankQualityOptions(opts(['720p', '2160p60 HDR', '1080p', '1080p Premium', '1440p']));
    expect(ranked.map((o) => o.label)).toEqual(['2160p60 HDR', '1440p', '1080p Premium', '1080p', '720p']);
  });

  it('sorts unparseable options last rather than assuming they are good', () => {
    const [first, last] = [
      parseQualityOption({ id: 'a', label: '480p' }),
      parseQualityOption({ id: 'b', label: 'Mystery' }),
    ];
    expect(compareQuality(first, last)).toBeLessThan(0);
  });

  it('excludes auto and unselectable entries from the ranking', () => {
    const ranked = rankQualityOptions(
      opts(['Auto', '2160p', '1080p'], { '2160p': { selectable: false } }),
    );
    expect(ranked.map((o) => o.label)).toEqual(['1080p']);
  });
});

describe('quality selection', () => {
  it('picks the highest available with no ceiling', () => {
    const result = selectQualityOption(opts(['2160p', '1440p', '1080p', '720p']), pref('best-available'));
    expect(result.option?.label).toBe('2160p');
    expect(result.limitedBy).toBeUndefined();
  });

  it('falls back to the best available below a ceiling the video cannot reach', () => {
    const result = selectQualityOption(opts(['1440p', '1080p', '720p']), pref('max-2160', 2160));
    expect(result.option?.label).toBe('1440p');
    expect(result.limitedBy).toBe('availability');
  });

  it('respects a ceiling below what is available', () => {
    const result = selectQualityOption(opts(['2160p', '1440p', '1080p']), pref('max-1080', 1080));
    expect(result.option?.label).toBe('1080p');
    expect(result.limitedBy).toBe('preference');
  });

  it('reports entitlement limits when a higher tier is listed but refused', () => {
    const result = selectQualityOption(
      opts(['2160p', '1080p'], { '2160p': { selectable: false } }),
      pref('best-available'),
    );
    expect(result.option?.label).toBe('1080p');
    expect(result.limitedBy).toBe('entitlement');
  });

  it('prefers the standard variant when enhanced bitrate is turned off', () => {
    const result = selectQualityOption(
      opts(['1080p Premium', '1080p', '720p']),
      pref('best-available', undefined, false),
    );
    expect(result.option?.label).toBe('1080p');
  });

  it('keeps enhanced bitrate when preferred', () => {
    const result = selectQualityOption(
      opts(['1080p Premium', '1080p', '720p']),
      pref('best-available', undefined, true),
    );
    expect(result.option?.label).toBe('1080p Premium');
  });

  it('never drops a tier just to avoid enhanced bitrate', () => {
    // Only the top tier has a Premium variant; turning the preference off must
    // not push the selection down to 720p.
    const result = selectQualityOption(
      opts(['1080p Premium', '720p']),
      pref('best-available', undefined, false),
    );
    expect(result.option?.label).toBe('1080p Premium');
  });

  it('returns the lowest option when everything exceeds the ceiling', () => {
    const result = selectQualityOption(opts(['2160p', '1440p']), pref('max-720', 720));
    expect(result.option?.label).toBe('1440p');
    expect(result.limitedBy).toBe('availability');
  });

  it('selects the platform auto entry when configured to stand down', () => {
    const result = selectQualityOption(opts(['Auto', '1080p']), pref('platform-auto'));
    expect(result.option?.auto).toBe(true);
  });

  it('returns nothing when no option is selectable', () => {
    const result = selectQualityOption(
      opts(['1080p'], { '1080p': { selectable: false } }),
      pref('best-available'),
    );
    expect(result.option).toBeUndefined();
  });
});

describe('verification', () => {
  it('accepts a matching resolution and bitrate class', () => {
    const requested = parseQualityOption({ id: 'a', label: '1080p60' });
    const observed = parseQualityOption({ id: 'b', label: '1080p' });
    expect(verifyApplied(requested, { ...observed, enhancedBitrate: false }).verified).toBe(true);
  });

  it('rejects an enhanced-bitrate request satisfied by the standard tier', () => {
    const requested = parseQualityOption({ id: 'a', label: '1080p Premium' });
    const observed = parseQualityOption({ id: 'b', label: '1080p' });
    const result = verifyApplied(requested, observed);
    expect(result.verified).toBe(false);
    expect(result.message).toContain('1080p');
  });

  it('reports unverified rather than assuming success when nothing was observed', () => {
    const requested = parseQualityOption({ id: 'a', label: '2160p' });
    expect(verifyApplied(requested, undefined).verified).toBe(false);
  });
});

describe('quality description', () => {
  it('summarizes structured options for display', () => {
    expect(describeQuality(parseQualityOption({ id: 'a', label: '2160p60 HDR' }))).toBe('2160p60 HDR');
    expect(describeQuality(parseQualityOption({ id: 'b', label: '1080p Premium' }))).toBe(
      '1080p Enhanced bitrate',
    );
    expect(describeQuality(undefined)).toBe('Unknown');
  });
});

describe('environment capabilities', () => {
  it('detects Chrome on Windows and its major version', () => {
    const env = buildEnvironment({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      screenWidth: 3840,
      screenHeight: 2160,
      devicePixelRatio: 1,
    });
    expect(env.os).toBe('windows');
    expect(env.browser).toBe('chrome');
    expect(env.browserVersion).toBe(131);
  });

  it('computes the display ceiling from height and pixel ratio', () => {
    expect(displayCeiling({ os: 'macos', browser: 'chrome', displayHeight: 900, devicePixelRatio: 2 })).toBe(1800);
    expect(displayCeiling({ os: 'macos', browser: 'chrome' })).toBeUndefined();
  });

  it('reports Netflix resolution as unknown under protected playback', () => {
    const report = buildNetflixReport({
      environment: { os: 'macos', browser: 'chrome', displayHeight: 1080, devicePixelRatio: 1 },
      protectedPlayback: true,
    });
    expect(report.state).toBe('actual-resolution-unknown');
    // The whole point: no fabricated resolution.
    expect(report.observedVideoHeight).toBeUndefined();
    expect(report.notes.some((n) => n.includes('protected'))).toBe(true);
  });

  it('reports an observed height when the element exposes one', () => {
    const report = buildNetflixReport({
      environment: { os: 'windows', browser: 'chrome', displayHeight: 2160, devicePixelRatio: 1 },
      observedVideoHeight: 1080,
      protectedPlayback: true,
    });
    expect(report.state).toBe('best-effort-active');
    expect(report.observedVideoHeight).toBe(1080);
    // Ceiling and observed value are separate claims and must not be equal by construction.
    expect(report.environmentCeiling).toBe(2160);
  });

  it('caps the reported ceiling at 2160 and never claims more', () => {
    const report = buildNetflixReport({
      environment: { os: 'windows', browser: 'chrome', displayHeight: 4320, devicePixelRatio: 1 },
      protectedPlayback: false,
    });
    expect(report.environmentCeiling).toBe(2160);
  });
});
