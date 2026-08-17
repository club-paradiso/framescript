/**
 * Local providers.
 *
 * These are the defaults, and they are what runs when remote AI is off — which
 * is the shipped configuration. They are honest about their limits: the local
 * vision provider describes *change*, because change is genuinely all the local
 * heuristics measure. It does not pretend to recognise objects or read text.
 *
 * The null providers exist so that "no ASR configured" is a first-class,
 * well-typed state rather than a crash or a silent gap.
 */

import type {
  AsrRequest,
  AsrResult,
  OcrLine,
  OcrProvider,
  OcrRequest,
  ProviderAvailability,
  SoundEventProvider,
  SoundEventRequest,
  SoundEventResult,
  SpeechRecognitionProvider,
  TranslationProvider,
  TranslationRequest,
  VisionAnalysisProvider,
  VisionWindowAnalysis,
  VisionWindowRequest,
} from '../types';
import { classifyOnset, describeSoundEvent } from '../../audio/soundEvents';
import { amplitudeToDb, magnitudeSpectrum, rms, spectralCentroid, spectralFlatness } from '../../audio/dsp';

/**
 * Describes observable change from the local scanner's metrics alone.
 *
 * This produces genuinely useful screenplay structure — "the shot changes",
 * "sustained movement", "movement in the centre of frame" — without a model and
 * without any data leaving the device. It never claims to know *what* moved.
 */
export class LocalHeuristicVisionProvider implements VisionAnalysisProvider {
  readonly info = {
    id: 'local-heuristic-vision',
    label: 'Local motion analysis',
    kind: 'local' as const,
    dataLeavingDevice: 'Nothing. Frames are measured on-device and discarded.',
  };

  async isAvailable(): Promise<ProviderAvailability> {
    return { available: true };
  }

  async analyzeWindow(request: VisionWindowRequest): Promise<VisionWindowAnalysis | null> {
    const metrics = request.metrics;
    if (!metrics) return null;

    const actions: VisionWindowAnalysis['actions'] = [];
    const uncertainties: string[] = [];

    const cut = metrics.sceneCutScore ?? 0;
    const motion = metrics.motionScore ?? 0;
    const centre = metrics.faceChangeScore ?? 0;

    if (cut >= 0.6) {
      actions.push({
        offsetMs: 0,
        description: 'The shot changes.',
        participants: [],
        confidence: 'medium',
      });
    }

    if (motion >= 0.35) {
      actions.push({
        offsetMs: Math.round((request.end - request.start) / 2),
        description:
          centre > motion * 0.8
            ? 'Sustained movement in the centre of frame.'
            : 'Sustained movement in frame.',
        participants: [],
        confidence: 'low',
      });
    } else if (motion >= 0.12) {
      actions.push({
        offsetMs: Math.round((request.end - request.start) / 2),
        description: 'Slight movement in frame.',
        participants: [],
        confidence: 'low',
      });
    }

    if ((metrics.luminance ?? 1) < 0.03) {
      uncertainties.push('The frame is effectively black; no visual detail is available.');
    }
    // The honest headline: without a vision model, "what moved" is unknowable.
    uncertainties.push('Local analysis detects change only. Subjects and objects are not identified.');

    return { actions, characters: [], settingChanges: [], text: [], uncertainties };
  }
}

/**
 * ASR is unavailable unless the user configures a provider.
 *
 * Chrome's built-in SpeechRecognition cannot consume a MediaStream from
 * tabCapture (it listens to a microphone), so there is no honest local ASR path
 * in an MV3 extension today. Rather than fake one, FrameScript reports the
 * source as unavailable and relies on platform subtitles.
 */
export class NullSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly info = {
    id: 'null-asr',
    label: 'No speech recognition configured',
    kind: 'local' as const,
    dataLeavingDevice: 'Nothing.',
  };

  async isAvailable(): Promise<ProviderAvailability> {
    return {
      available: false,
      reason:
        'No speech recognition provider is configured. Dialogue comes from platform subtitles only. Configure a provider in Settings → AI to transcribe audio.',
    };
  }

  async transcribe(_request: AsrRequest): Promise<AsrResult | null> {
    return null;
  }
}

/**
 * Detects that text is present without reading it.
 *
 * The local detector measures edge energy in the title band. Reporting "text
 * appeared here, unrecognized" is real information — the Evidence view shows it and
 * an OCR-capable provider can be pointed at exactly those moments — whereas
 * inventing the characters would not be.
 */
export class RegionOnlyOcrProvider implements OcrProvider {
  readonly info = {
    id: 'local-text-region',
    label: 'Local text-region detection',
    kind: 'local' as const,
    dataLeavingDevice: 'Nothing.',
  };

  async isAvailable(): Promise<ProviderAvailability> {
    return {
      available: true,
      reason: 'Detects that on-screen text is present but does not read it. Enable an AI provider to read text.',
    };
  }

  async recognize(_request: OcrRequest): Promise<OcrLine[]> {
    // Deliberately empty: a region detector produces no characters, and
    // returning a guess here would poison the screenplay with invented text.
    return [];
  }
}

/** Wraps the local onset classifier as a provider. */
export class LocalSoundEventProvider implements SoundEventProvider {
  readonly info = {
    id: 'local-sound-events',
    label: 'Local sound analysis',
    kind: 'local' as const,
    dataLeavingDevice: 'Nothing. Audio is analyzed on-device and discarded.',
  };

  async isAvailable(): Promise<ProviderAvailability> {
    return { available: true };
  }

  async classify(request: SoundEventRequest): Promise<SoundEventResult | null> {
    const { samples, sampleRate } = request;
    if (samples.length < 256) return null;

    const spectrum = magnitudeSpectrum(samples.subarray(0, Math.min(2048, samples.length)));
    const level = amplitudeToDb(rms(samples));
    if (level < -55) return null;

    const { kind, classified } = classifyOnset({
      prominenceDb: level + 60,
      attack: 0.5,
      centroidHz: spectralCentroid(spectrum, sampleRate),
      flatness: spectralFlatness(spectrum),
    });

    return {
      kind,
      description: describeSoundEvent(kind),
      // A local classification is a weak signal and is labelled as one.
      confidence: classified ? 'low' : 'unknown',
    };
  }
}

/** Translation requires a provider; there is no offline translator to fall back on. */
export class NullTranslationProvider implements TranslationProvider {
  readonly info = {
    id: 'null-translation',
    label: 'No translation provider configured',
    kind: 'local' as const,
    dataLeavingDevice: 'Nothing.',
  };

  async isAvailable(): Promise<ProviderAvailability> {
    return {
      available: false,
      reason:
        'No translation provider is configured. Screenplays render in languages that have platform subtitle evidence.',
    };
  }

  async translate(_request: TranslationRequest): Promise<string[] | null> {
    return null;
  }
}
