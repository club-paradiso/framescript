#!/usr/bin/env node
/**
 * Measures the engine's actual throughput.
 *
 * docs/PERFORMANCE.md makes specific claims — that 100 ms observation is cheap
 * enough to run beside 4K playback, that redundant frames are skipped, that
 * deep analysis stays near 1/second in ordinary material. Those were reasoned
 * from the design; this measures them.
 *
 * Run with: npm run benchmark
 *
 * Caveat worth keeping in mind when reading the output: this is Node on a
 * server, not Chrome on a laptop competing with a video decoder. The *ratios*
 * (redundancy skipping, analysis-to-observation) transfer; the absolute
 * per-observation cost is a floor, not a promise.
 */

import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The engine ships as TypeScript source with path aliases, so it is bundled to
// a temporary file rather than imported directly.
const outDir = mkdtempSync(resolve(tmpdir(), 'fs-bench-'));
const entry = resolve(outDir, 'entry.ts');
writeFileSync(entry, `export * from ${JSON.stringify(resolve(ROOT, 'src/core/index.ts'))};\n`);

await build({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': resolve(ROOT, 'src') } },
  build: {
    outDir,
    emptyOutDir: false,
    ssr: true,
    minify: false,
    target: 'node20',
    rollupOptions: { input: entry, output: { format: 'es', entryFileNames: 'core.js' } },
  },
});

const core = await import(resolve(outDir, 'core.js'));
const {
  TemporalScanner,
  profileFor,
  SIGNATURE_WIDTH,
  SIGNATURE_HEIGHT,
  detectSpeechRegions,
  SpeakerDiarizer,
  SoundEventDetector,
  buildScreenplay,
  cuesToEvidence,
  parseSubtitleFile,
} = core;

const ANALYSIS_W = 480;
const ANALYSIS_H = 270;

/** Builds an RGBA frame: a static background plus a moving block. */
function makeFrame(tick, sceneIndex) {
  const data = new Uint8ClampedArray(ANALYSIS_W * ANALYSIS_H * 4);
  const base = 40 + sceneIndex * 37; // a cut changes the whole field
  data.fill(base);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;

  const bx = 40 + ((tick * 7) % (ANALYSIS_W - 90));
  const by = 60 + ((tick * 3) % (ANALYSIS_H - 90));
  for (let y = by; y < by + 60; y++) {
    for (let x = bx; x < bx + 60; x++) {
      const i = (y * ANALYSIS_W + x) * 4;
      data[i] = 220;
      data[i + 1] = 210;
      data[i + 2] = 200;
    }
  }
  return data;
}

/** A frame identical to its predecessor — the locked-off-shot case. */
function makeStaticFrame(sceneIndex) {
  const data = new Uint8ClampedArray(ANALYSIS_W * ANALYSIS_H * 4);
  data.fill(40 + sceneIndex * 37);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return data;
}

const ms = (fn) => {
  const started = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};

const row = (label, value) => console.log(`  ${label.padEnd(42)} ${value}`);

/**
 * Structural invariants, checked so this can run as a CI gate.
 *
 * Deliberately *not* timings: a shared CI runner's wall clock is noise, and a
 * benchmark that fails when the runner is busy gets ignored within a week. What
 * is asserted here is behaviour that must hold whatever the machine — a static
 * shot skips its frames, a film-shaped subtitle track yields film-shaped
 * scenes. The scene assertion exists because a real regression once made every
 * subtitle-only reconstruction return exactly one scene, and nothing in the
 * unit suite noticed.
 */
const invariants = [];
const invariant = (label, condition, detail) => {
  invariants.push({ label, ok: Boolean(condition), detail });
};

console.log('\nFrameScript engine benchmark');
console.log(`  Node ${process.version} · analysis frame ${ANALYSIS_W}×${ANALYSIS_H} · signature ${SIGNATURE_WIDTH}×${SIGNATURE_HEIGHT}\n`);

// --- 1. Temporal scanning, moving content -------------------------------------

console.log('Temporal scanner — 10 minutes of moving content at 100 ms (Detailed)');
{
  const scanner = new TemporalScanner({ profile: profileFor('detailed') });
  const observations = 6_000; // 10 minutes at 10/s
  const frames = Array.from({ length: 120 }, (_, i) => makeFrame(i, 0));

  const { ms: elapsed } = ms(() => {
    for (let i = 0; i < observations; i++) {
      // A scene cut every ~20 s, as in ordinary edited material.
      const scene = Math.floor(i / 200);
      const data = i % 200 === 0 ? makeFrame(i, scene) : frames[i % frames.length];
      scanner.observe({ data, width: ANALYSIS_W, height: ANALYSIS_H, timestamp: i * 100 });
    }
  });

  const stats = scanner.stats;
  const perObservation = elapsed / observations;
  // 10 observations/second means a 100 ms budget each; report the fraction used.
  const budgetUsed = (perObservation / 100) * 100;

  row('observations', observations.toLocaleString());
  row('total time', `${elapsed.toFixed(0)} ms`);
  row('per observation', `${perObservation.toFixed(3)} ms`);
  row('share of the 100 ms budget', `${budgetUsed.toFixed(2)} %`);
  row('media time processed per wall second', `${(600_000 / elapsed).toFixed(0)}× real time`);
  row('events emitted', stats.emittedEvents.toLocaleString());
  row('scene cuts detected', String(stats.sceneCuts));
  row('deep-analysis requests', String(stats.deepRequests));
  row('deep analyses per minute of media', (stats.deepRequests / 10).toFixed(1));

  invariant('moving content emits evidence', stats.emittedEvents > 0);
  invariant('the planted cuts are found', stats.sceneCuts >= 20, `${stats.sceneCuts} cuts`);
  // The token bucket exists to keep inference bounded however busy the picture
  // gets; 10/minute of media is far above the Detailed baseline and still far
  // below the 600/minute an unrationed pipeline would ask for.
  invariant(
    'deep analysis stays rationed under constant motion',
    stats.deepRequests > 0 && stats.deepRequests / 10 < 120,
    `${(stats.deepRequests / 10).toFixed(1)}/min`,
  );
}

// --- 2. Redundancy skipping ---------------------------------------------------

console.log('\nTemporal scanner — 10 minutes of a locked-off shot');
{
  const scanner = new TemporalScanner({ profile: profileFor('detailed') });
  const observations = 6_000;
  const frame = makeStaticFrame(0);

  const { ms: elapsed } = ms(() => {
    for (let i = 0; i < observations; i++) {
      scanner.observe({ data: frame, width: ANALYSIS_W, height: ANALYSIS_H, timestamp: i * 100 });
    }
  });

  const stats = scanner.stats;
  row('per observation', `${(elapsed / observations).toFixed(3)} ms`);
  row('redundant observations skipped', `${stats.redundantSkipped.toLocaleString()} of ${observations.toLocaleString()}`);
  row('skip rate', `${((stats.redundantSkipped / observations) * 100).toFixed(1)} %`);
  row('deep-analysis requests', String(stats.deepRequests));

  invariant(
    'a locked-off shot skips nearly every observation',
    stats.redundantSkipped / observations > 0.98,
    `${((stats.redundantSkipped / observations) * 100).toFixed(1)} %`,
  );
  invariant('a locked-off shot asks for no deep analysis', stats.deepRequests === 0, `${stats.deepRequests} requests`);
}

// --- 3. Audio ------------------------------------------------------------------

console.log('\nAudio engine — 10 minutes of 16 kHz mono');
{
  const sampleRate = 16_000;
  const duration = 600;
  const samples = new Float32Array(sampleRate * duration);

  let state = 12345 >>> 0;
  for (let i = 0; i < samples.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    samples[i] = ((state / 0xffffffff) * 2 - 1) * 0.002;
  }
  // A two-second utterance every ten seconds.
  for (let block = 0; block < duration / 10; block++) {
    const from = block * 10 * sampleRate;
    const to = from + 2 * sampleRate;
    const fundamental = block % 2 === 0 ? 120 : 240;
    for (let i = from; i < to && i < samples.length; i++) {
      const t = i / sampleRate;
      samples[i] +=
        0.4 * ((Math.sin(2 * Math.PI * fundamental * t) + 0.5 * Math.sin(2 * Math.PI * fundamental * 2 * t)) / 1.5);
    }
  }

  const vad = ms(() => detectSpeechRegions(samples, { sampleRate }));
  row('VAD over 10 minutes', `${vad.ms.toFixed(0)} ms  (${(600_000 / vad.ms).toFixed(0)}× real time)`);
  row('speech regions found', String(vad.value.length));

  const diarizer = new SpeakerDiarizer({ sampleRate });
  const diar = ms(() => {
    for (const region of vad.value) {
      const from = Math.floor((region.start / 1000) * sampleRate);
      const to = Math.min(samples.length, Math.ceil((region.end / 1000) * sampleRate));
      diarizer.assign(samples.subarray(from, to), region.start, region.end);
    }
  });
  row('diarization', `${diar.ms.toFixed(0)} ms`);
  row('speaker clusters', String(diarizer.speakerCount));

  const detector = new SoundEventDetector({ sampleRate });
  const sound = ms(() => {
    for (let offset = 0; offset < samples.length; offset += sampleRate * 10) {
      detector.push(samples.subarray(offset, offset + sampleRate * 10), (offset / sampleRate) * 1000);
    }
  });
  row('sound-event detection', `${sound.ms.toFixed(0)} ms  (${(600_000 / sound.ms).toFixed(0)}× real time)`);

  const total = vad.ms + diar.ms + sound.ms;
  row('full audio pass', `${total.toFixed(0)} ms  (${(600_000 / total).toFixed(0)}× real time)`);

  // 60 utterances were planted; VAD may merge or split a few at the edges.
  invariant('VAD finds the planted utterances', vad.value.length >= 50, `${vad.value.length} regions`);
  invariant('two alternating voices cluster as two speakers', diarizer.speakerCount === 2, `${diarizer.speakerCount}`);
}

// --- 4. Reconstruction ----------------------------------------------------------

console.log('\nReconstruction — a feature-length subtitle track');
{
  // A film is not metronomic. Dialogue arrives in bursts inside a scene and
  // then stops while the story moves elsewhere, so the fixture is written that
  // way: tight exchanges separated by the pauses that mark scene changes. A
  // uniformly spaced track would measure the parser but say nothing about
  // whether boundary detection can find structure in subtitles alone.
  const fmt = (t) => {
    const h = String(Math.floor(t / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor(t / 60_000) % 60).padStart(2, '0');
    const s = String(Math.floor(t / 1_000) % 60).padStart(2, '0');
    return `${h}:${m}:${s},${String(t % 1000).padStart(3, '0')}`;
  };

  // Deterministic pseudo-randomness: the benchmark must be comparable run to run.
  let seed = 987654321 >>> 0;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const lines = [];
  const cast = ['JIYEON', 'DANIEL', 'MI-RAE', 'HOST'];
  let clock = 0;
  let index = 0;
  let sceneCount = 0;

  while (index < 1_200) {
    sceneCount++;
    const exchanges = 8 + Math.floor(rand() * 16); // 8–23 lines in a scene
    for (let i = 0; i < exchanges && index < 1_200; i++, index++) {
      const duration = 1_600 + Math.floor(rand() * 2_400);
      const start = clock;
      const end = start + duration;
      const speaker = cast[(index + sceneCount) % cast.length];
      lines.push(`${index + 1}\n${fmt(start)} --> ${fmt(end)}\n${speaker}: Line number ${index} of the film.\n`);
      clock = end + 400 + Math.floor(rand() * 1_400); // beat between lines
    }
    clock += 18_000 + Math.floor(rand() * 40_000); // the hole between scenes
  }

  const srt = lines.join('\n');
  const durationMs = clock;

  const parsed = ms(() => parseSubtitleFile(srt));
  row('parse 1,200 cues', `${parsed.ms.toFixed(0)} ms`);
  row('track duration', `${(durationMs / 60_000).toFixed(0)} min`);
  row('scenes in the fixture', String(sceneCount));

  const evidence = cuesToEvidence(parsed.value.cues, { language: 'en' });
  const built = ms(() =>
    buildScreenplay(evidence, {
      durationMs,
      completeSourceRange: { start: 0, end: durationMs },
    }),
  );
  row('reconstruct + render', `${built.ms.toFixed(0)} ms`);
  row('scenes detected', String(built.value.scenes.length));
  row('screenplay lines', String(built.value.document.lines.length));
  row('characters', String(built.value.characters.length));

  const detected = built.value.scenes.length;
  // A band, not an exact count: boundary weights are meant to be tunable, and a
  // test that forbids tuning gets deleted. What must not happen is the whole
  // film collapsing into one scene, or every pause becoming one.
  invariant(
    'subtitle-only reconstruction recovers the scene structure',
    detected >= sceneCount * 0.7 && detected <= sceneCount * 1.4,
    `${detected} detected vs ${sceneCount} planted`,
  );
  invariant('every speaker is recovered', built.value.characters.length === cast.length);
}

console.log('\nNote: Node on a server, not Chrome competing with a video decoder.');
console.log('Ratios transfer; absolute per-observation cost is a floor, not a promise.\n');

console.log('Structural invariants');
let failed = 0;
for (const { label, ok, detail } of invariants) {
  if (ok) console.log(`  ok    ${label}${detail ? ` (${detail})` : ''}`);
  else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} invariant(s) failed.\n`);
  process.exit(1);
}
console.log('\nAll invariants hold.\n');
