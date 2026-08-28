import { describe, expect, it, vi } from 'vitest';
import {
  normalizeAsrLanguage,
  transcribeWav,
} from '../src/ai/providers/openaiCompatible';
import { preferredAsrConcurrency } from '../web/src/analysis/runAnalysis';

describe('multilingual ASR', () => {
  it('normalizes English, Korean, and Spanish provider labels', () => {
    expect(normalizeAsrLanguage('English')).toBe('en');
    expect(normalizeAsrLanguage('Korean')).toBe('ko');
    expect(normalizeAsrLanguage('ko-KR')).toBe('ko');
    expect(normalizeAsrLanguage('Spanish')).toBe('es');
    expect(normalizeAsrLanguage('es-MX')).toBe('es');
    expect(normalizeAsrLanguage('Español')).toBe('es');
  });

  it('uses the explicit language hint when a provider omits language metadata', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('language')).toBe('ko');
      return new Response(JSON.stringify({ text: '안녕하세요.' }), { status: 200 });
    });

    const result = await transcribeWav({
      wav: new Uint8Array([1, 2, 3, 4]),
      endpoint: 'https://provider.example/transcriptions',
      apiKey: 'test-key',
      model: 'test-model',
      languageHint: 'ko',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ text: '안녕하세요.', language: 'ko' });
  });

  it('canonicalizes a Spanish provider response without translating the dialogue', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ text: '¿Dónde está la estación?', language: 'Spanish' }), {
        status: 200,
      }),
    );

    const result = await transcribeWav({
      wav: new Uint8Array([1, 2, 3, 4]),
      endpoint: 'https://provider.example/transcriptions',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ text: '¿Dónde está la estación?', language: 'es' });
  });
});

describe('adaptive ASR concurrency', () => {
  it('keeps one speech window serial', () => {
    expect(preferredAsrConcurrency(1, 16)).toBe(1);
  });

  it('protects lower-end devices with a concurrency of two', () => {
    expect(preferredAsrConcurrency(10, 4)).toBe(2);
  });

  it('uses four concurrent requests on capable devices', () => {
    expect(preferredAsrConcurrency(10, 8)).toBe(4);
    expect(preferredAsrConcurrency(10, 16)).toBe(4);
  });

  it('never exceeds the number of available windows', () => {
    expect(preferredAsrConcurrency(2, 16)).toBe(2);
  });
});
