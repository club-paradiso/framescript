#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, extname, basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
function formatTimecode(ms, opts = {}) {
  const negative = ms < 0;
  const total = Math.abs(Math.round(ms));
  const millis = total % 1e3;
  const totalSeconds = Math.floor(total / 1e3);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  let out = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  if (opts.millis) out += `.${pad(millis, 3)}`;
  return negative ? `-${out}` : out;
}
function formatSrtTimestamp(ms) {
  const total = Math.max(0, Math.round(ms));
  const millis = total % 1e3;
  const totalSeconds = Math.floor(total / 1e3);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(
    totalSeconds % 60
  )},${pad(millis, 3)}`;
}
const rangeDuration = (r) => Math.max(0, r.end - r.start);
function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}
function overlapDuration(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}
function temporalIou(a, b) {
  const inter = overlapDuration(a, b);
  if (inter <= 0) return 0;
  const union = rangeDuration(a) + rangeDuration(b) - inter;
  return union <= 0 ? 0 : inter / union;
}
function mergeRanges(ranges, tolerance = 0) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [];
  let current = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.start <= current.end + tolerance) {
      current.end = Math.max(current.end, next.end);
    } else {
      out.push(current);
      current = { ...next };
    }
  }
  out.push(current);
  return out;
}
function coveredDuration(ranges) {
  return mergeRanges(ranges).reduce((sum, r) => sum + rangeDuration(r), 0);
}
function invertRanges(ranges, duration) {
  const merged = mergeRanges(ranges).filter((r) => r.end > 0 && r.start < duration);
  const gaps = [];
  let cursor = 0;
  for (const r of merged) {
    const start = Math.max(0, r.start);
    if (start > cursor) gaps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, Math.min(duration, r.end));
  }
  if (cursor < duration) gaps.push({ start: cursor, end: duration });
  return gaps;
}
const INVISIBLE = /[\u200B-\u200D\uFEFF\u2060\u00AD]/g;
const WHITESPACE = /[\s\u00A0]+/g;
function stripInvisible(input) {
  return input.replace(INVISIBLE, "");
}
function collapseWhitespace(input) {
  return input.replace(WHITESPACE, " ").trim();
}
function comparableText(input) {
  return stripInvisible(input).normalize("NFKC").toLowerCase().replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[.,!?;:'"()[\]{}\-\u2013\u2014\u2026\u00B7]/g, "").replace(WHITESPACE, " ").trim();
}
function textSimilarity(a, b) {
  const s = comparableText(a);
  const t = comparableText(b);
  if (s === t) return 1;
  if (s.length === 0 || t.length === 0) return 0;
  const distance = levenshtein(s, t);
  return 1 - distance / Math.max(s.length, t.length);
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
const SLUG_KEEP = /[^a-z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/g;
function slugify(input, maxLength = 60) {
  const slug = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").toLowerCase().replace(SLUG_KEEP, "-").replace(/^-+|-+$/g, "").slice(0, maxLength).replace(/-+$/g, "");
  return slug.length > 0 ? slug : "framescript";
}
function toCharacterCue(name) {
  return collapseWhitespace(name).toLocaleUpperCase();
}
function createSourceStatus(id, state = "unavailable") {
  return { id, state, eventCount: 0 };
}
const ALL_SOURCE_IDS = [
  "subtitle",
  "audio-asr",
  "audio-speaker",
  "audio-event",
  "audio-silence",
  "video",
  "ocr",
  "playback",
  "metadata",
  "user"
];
function createSourceStateMap() {
  const map = {};
  for (const id of ALL_SOURCE_IDS) map[id] = createSourceStatus(id);
  return map;
}
const DEFAULTS = { maxEvents: 6e4, dedupeWindowMs: 1500 };
class EvidenceTimeline {
  #events = [];
  #byId = /* @__PURE__ */ new Map();
  /** source -> normalized payload key -> last event start, for deduplication. */
  #recentKeys = /* @__PURE__ */ new Map();
  #sources = createSourceStateMap();
  #coverage = [];
  #durationMs;
  #listeners = /* @__PURE__ */ new Set();
  #options;
  #sorted = true;
  #evictedCount = 0;
  constructor(options = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }
  get size() {
    return this.#events.length;
  }
  get evictedCount() {
    return this.#evictedCount;
  }
  get sources() {
    return this.#sources;
  }
  setDuration(ms) {
    this.#durationMs = ms && ms > 0 ? ms : void 0;
  }
  get durationMs() {
    return this.#durationMs;
  }
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  setSourceState(id, state, message) {
    const existing = this.#sources[id];
    this.#sources[id] = {
      ...existing,
      state,
      ...message === void 0 ? {} : { message }
    };
  }
  /**
   * Appends an event.
   *
   * Returns the stored event, which may be an *existing* event when the
   * incoming one is a duplicate — callers use the identity to decide whether
   * anything actually changed.
   */
  append(event) {
    const existingById = this.#byId.get(event.id);
    if (existingById) {
      Object.assign(existingById, event);
      this.#notify(existingById);
      return { event: existingById, added: false };
    }
    const key = dedupeKey(event);
    if (key) {
      const lastAt = this.#recentKeys.get(key);
      if (lastAt !== void 0 && Math.abs(event.start - lastAt) <= this.#options.dedupeWindowMs) {
        const prior = this.#findRecentMatch(key, event);
        if (prior) {
          prior.end = Math.max(prior.end ?? prior.start, event.end ?? event.start);
          return { event: prior, added: false };
        }
      }
      this.#recentKeys.set(key, event.start);
    }
    this.#events.push(event);
    this.#byId.set(event.id, event);
    this.#sorted = this.#sorted && this.#isTailOrdered();
    const status = this.#sources[event.source];
    this.#sources[event.source] = {
      ...status,
      state: status.state === "active" ? "active" : "active",
      eventCount: status.eventCount + 1,
      lastEventAt: event.start
    };
    if (this.#events.length > this.#options.maxEvents) this.#evict();
    this.#notify(event);
    return { event, added: true };
  }
  appendAll(events) {
    for (const e of events) this.append(e);
  }
  get(id) {
    return this.#byId.get(id);
  }
  getMany(ids) {
    const out = [];
    for (const id of ids) {
      const e = this.#byId.get(id);
      if (e) out.push(e);
    }
    return out;
  }
  /** All events, ordered by start then by source id for stable ties. */
  all() {
    this.#ensureSorted();
    return this.#events;
  }
  /** Events overlapping `[start, end)`. */
  range(start, end) {
    this.#ensureSorted();
    return this.#events.filter((e) => {
      const eEnd = e.end ?? e.start;
      return e.start < end && eEnd >= start;
    });
  }
  bySource(source) {
    this.#ensureSorted();
    return this.#events.filter((e) => e.source === source);
  }
  /** Marks `[start, end)` as observed by at least one source. */
  markObserved(start, end) {
    if (end <= start) return;
    this.#coverage.push({ start, end });
    if (this.#coverage.length > 512) this.#coverage = mergeRanges(this.#coverage, 250);
  }
  coverage() {
    this.#coverage = mergeRanges(this.#coverage, 250);
    const map = { observed: [...this.#coverage] };
    if (this.#durationMs !== void 0) map.durationMs = this.#durationMs;
    return map;
  }
  /** Fraction of the media that was actually observed, in [0,1]. */
  coverageRatio() {
    if (!this.#durationMs) return void 0;
    return Math.min(1, coveredDuration(this.#coverage) / this.#durationMs);
  }
  /** Ranges that were never observed — shown as gaps, never invented. */
  uncoveredRanges() {
    if (!this.#durationMs) return [];
    return invertRanges(this.#coverage, this.#durationMs);
  }
  clear() {
    this.#events = [];
    this.#byId.clear();
    this.#recentKeys.clear();
    this.#coverage = [];
    this.#sources = createSourceStateMap();
    this.#evictedCount = 0;
    this.#sorted = true;
  }
  // --- internals ------------------------------------------------------------
  #notify(event) {
    for (const l of this.#listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("[FrameScript] timeline listener threw", err);
      }
    }
  }
  #isTailOrdered() {
    const n = this.#events.length;
    if (n < 2) return true;
    return this.#events[n - 2].start <= this.#events[n - 1].start;
  }
  #ensureSorted() {
    if (this.#sorted) return;
    this.#events.sort((a, b) => a.start - b.start || a.source.localeCompare(b.source));
    this.#sorted = true;
  }
  #findRecentMatch(key, event) {
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const candidate = this.#events[i];
      if (event.start - candidate.start > this.#options.dedupeWindowMs) break;
      if (dedupeKey(candidate) === key) return candidate;
    }
    return void 0;
  }
  /**
   * Evicts the least informative 10% of events.
   *
   * Priority order for keeping: user corrections > metadata > subtitles/ASR >
   * everything else, with confidence as the tiebreaker. Dialogue and user input
   * are never the first thing dropped.
   */
  #evict() {
    this.#ensureSorted();
    const target = Math.floor(this.#options.maxEvents * 0.1);
    const scored = this.#events.map((e, index) => ({ e, index, score: retentionScore(e) }));
    scored.sort((a, b) => a.score - b.score || a.index - b.index);
    const doomed = new Set(scored.slice(0, target).map((s) => s.e.id));
    this.#events = this.#events.filter((e) => !doomed.has(e.id));
    for (const id of doomed) this.#byId.delete(id);
    this.#evictedCount += doomed.size;
  }
}
const SOURCE_RETENTION = {
  user: 100,
  metadata: 90,
  subtitle: 80,
  "audio-asr": 75,
  ocr: 60,
  "audio-speaker": 55,
  "audio-event": 45,
  video: 40,
  playback: 35,
  "audio-silence": 20
};
const CONFIDENCE_BONUS = { high: 6, medium: 4, low: 2, unknown: 0 };
function retentionScore(event) {
  return SOURCE_RETENTION[event.source] + CONFIDENCE_BONUS[event.confidence];
}
function dedupeKey(event) {
  switch (event.source) {
    case "subtitle":
      return `subtitle|${event.payload.language}|${comparableText(event.payload.text)}`;
    case "audio-asr":
      return `asr|${comparableText(event.payload.text)}`;
    case "ocr":
      return `ocr|${comparableText(event.payload.text)}`;
    case "audio-event":
      return `sound|${event.payload.kind}`;
    case "metadata":
      return `meta|${event.payload.kind}|${event.payload.value}`;
    default:
      return null;
  }
}
const WINDOW_DEFAULTS = {
  minDurationMs: 800,
  maxDurationMs: 12e3,
  targetDurationMs: 4e3,
  dialogueGapMs: 700
};
function emptyWindow(start, end) {
  return {
    start,
    end,
    subtitles: [],
    speech: [],
    speakers: [],
    soundEvents: [],
    silences: [],
    visualEvents: [],
    ocrEvents: [],
    playbackEvents: [],
    peakImportance: 0
  };
}
function addToWindow(window, event) {
  switch (event.source) {
    case "subtitle":
      window.subtitles.push(event);
      break;
    case "audio-asr":
      window.speech.push(event);
      break;
    case "audio-speaker":
      window.speakers.push(event);
      break;
    case "audio-event":
      window.soundEvents.push(event);
      break;
    case "audio-silence":
      window.silences.push(event);
      break;
    case "video":
      window.visualEvents.push(event);
      break;
    case "ocr":
      window.ocrEvents.push(event);
      break;
    case "playback":
      window.playbackEvents.push(event);
      break;
  }
}
function windowIsEmpty(window) {
  return window.subtitles.length === 0 && window.speech.length === 0 && window.speakers.length === 0 && window.soundEvents.length === 0 && window.silences.length === 0 && window.visualEvents.length === 0 && window.ocrEvents.length === 0 && window.playbackEvents.length === 0;
}
function buildEvidenceWindows(events, span, options = {}) {
  const opts = { ...WINDOW_DEFAULTS, ...options };
  const sorted = [...events].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];
  const cuts = collectCutPoints(sorted, span, opts);
  const windows = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    const window = emptyWindow(start, end);
    for (const event of sorted) {
      const eventRange = { start: event.start, end: event.end ?? event.start + 1 };
      if (rangesOverlap(eventRange, { start, end })) addToWindow(window, event);
    }
    window.peakImportance = window.visualEvents.reduce(
      (peak, v) => Math.max(peak, v.payload.metrics?.sceneCutScore ?? 0),
      0
    );
    if (!windowIsEmpty(window)) windows.push(window);
  }
  return windows;
}
function collectCutPoints(sorted, span, opts) {
  const hard = /* @__PURE__ */ new Set([span.start, span.end]);
  for (const event of sorted) {
    if (event.source === "video" && event.payload.kind === "scene-change") hard.add(event.start);
    if (event.source === "playback" && event.payload.kind === "seek") hard.add(event.start);
  }
  const ordered = [...hard].filter((t) => t >= span.start && t <= span.end).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i];
    out.push(start);
    const next = ordered[i + 1];
    if (next === void 0) continue;
    let cursor = start;
    while (next - cursor > opts.maxDurationMs) {
      const candidate = findDialogueGap(sorted, cursor + opts.targetDurationMs, next, opts) ?? cursor + opts.targetDurationMs;
      const bounded = Math.min(Math.max(candidate, cursor + opts.minDurationMs), next - opts.minDurationMs);
      if (bounded <= cursor) break;
      out.push(bounded);
      cursor = bounded;
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
function findDialogueGap(events, from, to, opts) {
  const spoken = events.filter((e) => e.source === "subtitle" || e.source === "audio-asr").map((e) => ({ start: e.start, end: e.end ?? e.start + 500 })).sort((a, b) => a.start - b.start);
  let cursor = from;
  for (const s of spoken) {
    if (s.end <= from) continue;
    if (s.start >= to) break;
    if (s.start - cursor >= opts.dialogueGapMs) return cursor + Math.floor((s.start - cursor) / 2);
    cursor = Math.max(cursor, s.end);
  }
  return cursor > from && cursor < to ? cursor : void 0;
}
const ORDER = { unknown: 0, low: 1, medium: 2, high: 3 };
const BY_RANK = ["unknown", "low", "medium", "high"];
const confidenceRank = (level) => ORDER[level];
function fromRank(rank2) {
  const clamped = Math.max(0, Math.min(BY_RANK.length - 1, Math.round(rank2)));
  return BY_RANK[clamped];
}
function minConfidence(...levels) {
  if (levels.length === 0) return "unknown";
  return fromRank(Math.min(...levels.map(confidenceRank)));
}
function corroborate(levels, distinctSources) {
  if (levels.length === 0) return "unknown";
  const best = Math.max(...levels.map(confidenceRank));
  const bonus = distinctSources >= 2 ? 1 : 0;
  return fromRank(Math.min(ORDER.high, best + bonus));
}
function fromScore(score, opts = {}) {
  if (!Number.isFinite(score)) return "unknown";
  const ceiling = opts.strongEvidence ? ORDER.high : ORDER.medium;
  let rank2;
  if (score >= 0.75) rank2 = ORDER.high;
  else if (score >= 0.45) rank2 = ORDER.medium;
  else if (score > 0) rank2 = ORDER.low;
  else rank2 = ORDER.unknown;
  return fromRank(Math.min(rank2, ceiling));
}
function provenanceFrom(events, options = {}) {
  const evidenceIds = events.map((e) => e.id);
  const sources = [...new Set(events.map((e) => e.source))];
  const confidence = options.confidence ?? corroborate(
    events.map((e) => e.confidence),
    sources.length
  );
  return {
    evidenceIds,
    sources,
    confidence,
    inferred: options.inferred ?? false
  };
}
function emptyProvenance() {
  return { evidenceIds: [], sources: [], confidence: "unknown", inferred: false };
}
function mergeProvenance(...items) {
  const present = items.filter(Boolean);
  if (present.length === 0) return emptyProvenance();
  const evidenceIds = [...new Set(present.flatMap((p) => p.evidenceIds))];
  const sources = [...new Set(present.flatMap((p) => p.sources))];
  return {
    evidenceIds,
    sources,
    // A merged claim is only as trustworthy as its weakest constituent.
    confidence: minConfidence(...present.map((p) => p.confidence)),
    inferred: present.some((p) => p.inferred)
  };
}
function describeSources(sources) {
  const labels = {
    subtitle: "Subtitle",
    "audio-asr": "Audio ASR",
    "audio-speaker": "Speaker",
    "audio-event": "Sound",
    "audio-silence": "Silence",
    video: "Video",
    ocr: "On-screen text",
    playback: "Playback",
    metadata: "Metadata",
    user: "User correction"
  };
  return sources.map((s) => labels[s]).join(" + ") || "No source";
}
function createIdFactory(prefix, start = 0) {
  let n = start;
  return () => `${prefix}-${(++n).toString(36).padStart(4, "0")}`;
}
function hash32(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function shortHash(input) {
  return hash32(input).toString(36);
}
function describeSoundEvent(kind, description) {
  if (description) return description;
  switch (kind) {
    case "door":
      return "A door opens.";
    case "knock":
      return "A knock at the door.";
    case "footsteps":
      return "Footsteps approach.";
    case "phone":
      return "A phone rings.";
    case "alarm":
      return "An alarm sounds.";
    case "glass":
      return "Glass breaks.";
    case "gunshot":
      return "A gunshot cracks.";
    case "vehicle":
      return "A vehicle passes.";
    case "laughter":
      return "Laughter.";
    case "applause":
      return "Applause.";
    case "impact":
      return "A sharp impact.";
    case "music-start":
      return "Music begins.";
    case "music-end":
      return "The music fades.";
    case "music-swell":
      return "The music swells.";
    case "ambience-change":
      return "The ambience shifts.";
    case "unclassified":
      return "A sudden sound.";
  }
}
function describeSilence(gap) {
  if (gap.durationMs >= 8e3) return "A long silence.";
  if (gap.durationMs >= 4e3) return "Silence.";
  return "A pause.";
}
function normalizeSubtitleText(input) {
  const lines = stripInvisible(input).replace(/\r\n?/g, "\n").split("\n").map((line) => collapseWhitespace(line)).filter((line) => line.length > 0);
  return { text: lines.join(" "), lines };
}
const TIMESTAMP = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
const CUE_TIMING = new RegExp(`^\\s*${TIMESTAMP.source}\\s*-->\\s*${TIMESTAMP.source}`);
function parseTimestamp(input) {
  const match = TIMESTAMP.exec(input.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  const ms = Number(millis?.padEnd(3, "0") ?? 0);
  return Number(hours ?? 0) * 36e5 + Number(minutes) * 6e4 + Number(seconds) * 1e3 + ms;
}
function detectSubtitleFormat(content) {
  const head = content.replace(/^\uFEFF/, "").trimStart();
  if (/^WEBVTT/i.test(head)) return "vtt";
  if (CUE_TIMING.test(head) || /^\d+\s*\r?\n\s*\d{1,3}:\d{2}/.test(head)) return "srt";
  return "unknown";
}
function parseSubtitleFile(content) {
  const format = detectSubtitleFormat(content);
  const warnings = [];
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/^(?:NOTE|STYLE|REGION)[\s\S]*?(?=\n\n|$)/gm, "");
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  let skipped = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => CUE_TIMING.test(line));
    if (timingIndex < 0) {
      if (lines.some((line) => /\S/.test(line))) skipped++;
      continue;
    }
    const timingLine = lines[timingIndex];
    const [startRaw, endRaw] = timingLine.split("-->");
    const start = parseTimestamp(startRaw ?? "");
    const end = parseTimestamp(endRaw ?? "");
    if (start === null || end === null) {
      skipped++;
      continue;
    }
    const textLines = lines.slice(timingIndex + 1);
    const { text: text2, lines: cleanLines } = normalizeSubtitleText(textLines.join("\n"));
    if (text2.length === 0) {
      skipped++;
      continue;
    }
    if (end <= start) {
      warnings.push(`Cue at ${startRaw?.trim()} ends before it starts; using a 2s duration.`);
    }
    cues.push({
      index: cues.length + 1,
      start,
      end: end > start ? end : start + 2e3,
      text: text2,
      lines: cleanLines
    });
  }
  if (cues.length === 0 && skipped > 0) {
    warnings.push("No cues could be read. The file may not be SRT or WebVTT.");
  }
  if (skipped > 0) {
    warnings.push(`${skipped} block${skipped === 1 ? "" : "s"} skipped as unparseable.`);
  }
  cues.sort((a, b) => a.start - b.start);
  return { format, cues, skipped, warnings };
}
function cuesToEvidence(cues, options) {
  const nextId = createIdFactory(options.idPrefix ?? "file-sub");
  return cues.map((cue) => ({
    id: nextId(),
    source: "subtitle",
    start: cue.start,
    end: cue.end,
    confidence: options.autoGenerated ? "medium" : "high",
    provisional: false,
    payload: {
      text: cue.text,
      language: options.language,
      ...options.autoGenerated ? { autoGenerated: true } : {}
    }
  }));
}
function languageFromFilename(filename) {
  const match = /[._-]([a-z]{2})(?:[-_][A-Za-z]{2,4})?\.(?:srt|vtt|sbv|ass|ssa)$/i.exec(filename);
  return match ? match[1].toLowerCase() : "und";
}
class CharacterRegistry {
  #characters = /* @__PURE__ */ new Map();
  #bySpeakerId = /* @__PURE__ */ new Map();
  #byNormalizedName = /* @__PURE__ */ new Map();
  #nextId = createIdFactory("character");
  get all() {
    return [...this.#characters.values()];
  }
  get size() {
    return this.#characters.size;
  }
  get(id) {
    return this.#characters.get(id);
  }
  findBySpeakerId(speakerId) {
    const id = this.#bySpeakerId.get(speakerId);
    return id ? this.#characters.get(id) : void 0;
  }
  findByName(name) {
    const id = this.#byNormalizedName.get(normalizeName(name));
    return id ? this.#characters.get(id) : void 0;
  }
  /**
   * Returns the character for an anonymous speaker cluster, creating an unnamed
   * one if needed. Unnamed characters render as "SPEAKER 1" until evidence or
   * the user supplies a name.
   */
  ensureForSpeaker(speakerId, at) {
    const existing = this.findBySpeakerId(speakerId);
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt ?? at, at);
      return existing;
    }
    const character = {
      id: this.#nextId(),
      aliases: [],
      speakerIds: [speakerId],
      visualClusterIds: [],
      confidence: "low",
      source: "unknown",
      firstSeenAt: at,
      lastSeenAt: at,
      lineCount: 0
    };
    this.#characters.set(character.id, character);
    this.#bySpeakerId.set(speakerId, character.id);
    return character;
  }
  /**
   * Returns the character for a name found in a subtitle label, creating one if
   * needed. Subtitle labels are strong evidence — the track author wrote them.
   */
  ensureForName(name, at, source = "subtitle") {
    const existing = this.findByName(name);
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt ?? at, at);
      if (source === "user") {
        existing.source = "user";
        existing.confidence = "high";
      }
      return existing;
    }
    const character = {
      id: this.#nextId(),
      displayName: toCharacterCue(name),
      aliases: [],
      speakerIds: [],
      visualClusterIds: [],
      confidence: source === "user" ? "high" : "medium",
      source,
      firstSeenAt: at,
      lastSeenAt: at,
      lineCount: 0
    };
    this.#characters.set(character.id, character);
    this.#byNormalizedName.set(normalizeName(name), character.id);
    return character;
  }
  /** Links a voice cluster to a character. Used when both are known. */
  linkSpeaker(characterId, speakerId) {
    const character = this.#characters.get(characterId);
    if (!character) return;
    if (!character.speakerIds.includes(speakerId)) character.speakerIds.push(speakerId);
    this.#bySpeakerId.set(speakerId, characterId);
  }
  rename(characterId, name) {
    const character = this.#characters.get(characterId);
    if (!character) return void 0;
    if (character.displayName) {
      this.#byNormalizedName.delete(normalizeName(character.displayName));
      if (!character.aliases.includes(character.displayName)) character.aliases.push(character.displayName);
    }
    character.displayName = toCharacterCue(name);
    character.source = "user";
    character.confidence = "high";
    this.#byNormalizedName.set(normalizeName(name), characterId);
    return character;
  }
  /**
   * Merges `sourceId` into `targetId`. Used when the user recognises that two
   * voice clusters are one person (common when a voice changes across a phone
   * call or a shouted line).
   */
  merge(targetId, sourceId) {
    const target = this.#characters.get(targetId);
    const source = this.#characters.get(sourceId);
    if (!target || !source || targetId === sourceId) return void 0;
    for (const speakerId of source.speakerIds) {
      if (!target.speakerIds.includes(speakerId)) target.speakerIds.push(speakerId);
      this.#bySpeakerId.set(speakerId, targetId);
    }
    for (const clusterId of source.visualClusterIds) {
      if (!target.visualClusterIds.includes(clusterId)) target.visualClusterIds.push(clusterId);
    }
    if (source.displayName && source.displayName !== target.displayName) {
      if (!target.aliases.includes(source.displayName)) target.aliases.push(source.displayName);
      this.#byNormalizedName.set(normalizeName(source.displayName), targetId);
    }
    target.lineCount += source.lineCount;
    target.firstSeenAt = minDefined(target.firstSeenAt, source.firstSeenAt);
    target.lastSeenAt = maxDefined(target.lastSeenAt, source.lastSeenAt);
    target.confidence = "high";
    target.source = "user";
    this.#characters.delete(sourceId);
    return target;
  }
  /**
   * Splits a speaker cluster out of a character into a new one. Used when the
   * user sees that diarization merged two people.
   */
  split(characterId, speakerId, at) {
    const character = this.#characters.get(characterId);
    if (!character || !character.speakerIds.includes(speakerId)) return void 0;
    character.speakerIds = character.speakerIds.filter((s) => s !== speakerId);
    this.#bySpeakerId.delete(speakerId);
    const created = this.ensureForSpeaker(speakerId, at);
    created.source = "user";
    return created;
  }
  remove(characterId) {
    const character = this.#characters.get(characterId);
    if (!character) return;
    for (const speakerId of character.speakerIds) this.#bySpeakerId.delete(speakerId);
    if (character.displayName) this.#byNormalizedName.delete(normalizeName(character.displayName));
    this.#characters.delete(characterId);
  }
  noteLine(characterId, at) {
    const character = this.#characters.get(characterId);
    if (!character) return;
    character.lineCount++;
    character.firstSeenAt = minDefined(character.firstSeenAt, at);
    character.lastSeenAt = maxDefined(character.lastSeenAt, at);
  }
  /** Serializable snapshot for storage and for the side panel. */
  snapshot() {
    return this.all.map((c) => ({ ...c, aliases: [...c.aliases], speakerIds: [...c.speakerIds] }));
  }
  restore(characters) {
    this.#characters.clear();
    this.#bySpeakerId.clear();
    this.#byNormalizedName.clear();
    for (const character of characters) {
      this.#characters.set(character.id, { ...character });
      for (const speakerId of character.speakerIds) this.#bySpeakerId.set(speakerId, character.id);
      if (character.displayName) this.#byNormalizedName.set(normalizeName(character.displayName), character.id);
    }
  }
  clear() {
    this.#characters.clear();
    this.#bySpeakerId.clear();
    this.#byNormalizedName.clear();
  }
}
function normalizeName(name) {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}
function minDefined(a, b) {
  if (a === void 0) return b;
  if (b === void 0) return a;
  return Math.min(a, b);
}
function maxDefined(a, b) {
  if (a === void 0) return b;
  if (b === void 0) return a;
  return Math.max(a, b);
}
function characterCueName(character, fallbackIndex) {
  if (character?.displayName) return character.displayName;
  if (character && character.speakerIds.length > 0) {
    const speakerNumber = character.speakerIds[0].replace(/^speaker-0*/, "");
    return `SPEAKER ${speakerNumber}`;
  }
  return fallbackIndex !== void 0 ? `SPEAKER ${fallbackIndex}` : "UNKNOWN SPEAKER";
}
function attributeSpeaker(input, registry) {
  if (input.subtitleSpeakerLabel) {
    const character = registry.ensureForName(input.subtitleSpeakerLabel, input.start, "subtitle");
    return { characterId: character.id, method: "subtitle-label", confidence: "high" };
  }
  if (input.userCharacterId && registry.get(input.userCharacterId)) {
    return { characterId: input.userCharacterId, method: "user-correction", confidence: "high" };
  }
  const best = bestSpeakerCandidate(input);
  if (best) {
    const character = registry.ensureForSpeaker(best.speakerId, input.start);
    const visuallyConfirmed = input.visualSpeakerIds?.some((id) => character.visualClusterIds.includes(id)) ?? false;
    if (visuallyConfirmed) {
      return {
        characterId: character.id,
        speakerId: best.speakerId,
        method: "diarization-visual",
        confidence: "high"
      };
    }
    return {
      characterId: character.id,
      speakerId: best.speakerId,
      method: "diarization",
      confidence: best.confidence === "high" ? "medium" : "low"
    };
  }
  if (input.presentCharacterIds?.length === 2 && input.previousCharacterId) {
    const other = input.presentCharacterIds.find((id) => id !== input.previousCharacterId);
    if (other) {
      return { characterId: other, method: "dialogue-context", confidence: "low" };
    }
  }
  return { method: "unknown", confidence: "unknown" };
}
function bestSpeakerCandidate(input) {
  const candidates = input.speakerCandidates ?? [];
  if (candidates.length === 0) return null;
  const line = { start: input.start, end: input.end };
  let best = null;
  for (const candidate of candidates) {
    const overlap = temporalIou(line, { start: candidate.start, end: candidate.end });
    if (overlap <= 0.1) continue;
    if (!best || overlap > best.overlap) {
      best = { speakerId: candidate.speakerId, confidence: candidate.confidence, overlap };
    }
  }
  return best;
}
function extractSpeakerLabel(text2) {
  const trimmed = text2.replace(/^[-–—]\s*/, "").trim();
  const colon = /^([^:]{1,32}):\s*(.+)$/s.exec(trimmed);
  if (colon) {
    const candidate = colon[1].trim();
    if (looksLikeSpeakerLabel(candidate)) {
      return { speaker: candidate, remainder: colon[2].trim() };
    }
  }
  const bracketed = /^[[(]([^\])]{1,32})[\])]\s*(.+)$/s.exec(trimmed);
  if (bracketed) {
    const candidate = bracketed[1].trim();
    if (looksLikeSpeakerLabel(candidate)) {
      return { speaker: candidate, remainder: bracketed[2].trim() };
    }
  }
  return { remainder: trimmed };
}
function looksLikeSpeakerLabel(candidate) {
  if (candidate.length === 0 || candidate.length > 32) return false;
  if (/[.!?,;]/.test(candidate)) return false;
  if (/\d{3,}/.test(candidate)) return false;
  if (candidate.split(/\s+/).length > 4) return false;
  const letters = candidate.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return false;
  const hasCase = letters.toLocaleLowerCase() !== letters.toLocaleUpperCase();
  if (!hasCase) return true;
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  return upper / letters.length >= 0.6;
}
function isNonSpeechCaption(text2) {
  const trimmed = text2.trim();
  if (trimmed.length === 0) return false;
  const fullyWrapped = /^[[(][^\])]*[\])]$/.test(trimmed) || /^♪.*♪?$/.test(trimmed);
  if (!fullyWrapped) return false;
  return !/[\])]\s*\S/.test(trimmed);
}
const SIGNAL_WEIGHTS = {
  "chapter-change": 0.9,
  "location-change": 0.6,
  "user-seek": 0.55,
  "long-silence": 0.35,
  "ambience-change": 0.35,
  "sustained-visual-change": 0.35,
  "on-screen-text": 0.3,
  "music-transition": 0.25,
  "dialogue-gap": 0.25,
  "visual-cut": 0.2
};
const BOUNDARY_DEFAULTS = {
  clusterWindowMs: 1200,
  threshold: 0.55,
  minSceneDurationMs: 6e3,
  dialogueGapMs: 6e3
};
function collectBoundarySignals(events, options = {}) {
  const opts = { ...BOUNDARY_DEFAULTS, ...options };
  const signals = [];
  const spoken = [];
  for (const event of events) {
    switch (event.source) {
      case "video": {
        const cutScore = event.payload.metrics?.sceneCutScore ?? 0;
        if (event.payload.kind === "scene-change" && cutScore > 0) {
          signals.push({ kind: "visual-cut", timestamp: event.start, strength: Math.min(1, cutScore) });
        }
        if (event.payload.kind === "setting") {
          signals.push({ kind: "location-change", timestamp: event.start, strength: 0.8 });
        }
        break;
      }
      case "audio-event": {
        if (event.payload.kind === "ambience-change") {
          signals.push({ kind: "ambience-change", timestamp: event.start, strength: 0.7 });
        }
        if (event.payload.kind === "music-start" || event.payload.kind === "music-end") {
          signals.push({ kind: "music-transition", timestamp: event.start, strength: 0.5 });
        }
        break;
      }
      case "audio-silence": {
        if (event.payload.significant) {
          signals.push({
            kind: "long-silence",
            timestamp: event.end ?? event.start,
            strength: Math.min(1, event.payload.durationMs / 8e3)
          });
        }
        break;
      }
      case "playback": {
        if (event.payload.kind === "seek") {
          signals.push({ kind: "user-seek", timestamp: event.start, strength: 1 });
        }
        break;
      }
      case "metadata": {
        if (event.payload.kind === "chapter") {
          signals.push({ kind: "chapter-change", timestamp: event.start, strength: 1 });
        }
        break;
      }
      case "ocr": {
        signals.push({ kind: "on-screen-text", timestamp: event.start, strength: 0.6 });
        break;
      }
      case "subtitle":
      case "audio-asr": {
        spoken.push({ start: event.start, end: event.end ?? event.start + 1e3 });
        break;
      }
    }
  }
  spoken.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spoken.length; i++) {
    const gap = spoken[i].start - spoken[i - 1].end;
    if (gap >= opts.dialogueGapMs) {
      signals.push({
        kind: "dialogue-gap",
        timestamp: spoken[i - 1].end + Math.floor(gap / 2),
        strength: Math.min(1, gap / 15e3)
      });
    }
  }
  return signals.sort((a, b) => a.timestamp - b.timestamp);
}
function scoreBoundaryCandidates(signals, options = {}) {
  const opts = { ...BOUNDARY_DEFAULTS, ...options };
  const sorted = [...signals].sort((a, b) => a.timestamp - b.timestamp);
  const clusters = [];
  for (const signal of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && signal.timestamp - current[0].timestamp <= opts.clusterWindowMs) {
      current.push(signal);
    } else {
      clusters.push([signal]);
    }
  }
  return clusters.map((cluster) => {
    const byKind = /* @__PURE__ */ new Map();
    for (const signal of cluster) {
      const value = SIGNAL_WEIGHTS[signal.kind] * signal.strength;
      byKind.set(signal.kind, Math.max(byKind.get(signal.kind) ?? 0, value));
    }
    const contributions = [...byKind.values()].sort((a, b) => b - a);
    let score = 0;
    contributions.forEach((value, index) => {
      score += value * 0.6 ** index;
    });
    score = Math.min(1, score);
    const strongEvidence = byKind.size >= 2;
    return {
      timestamp: pickBoundaryTimestamp(cluster),
      signals: cluster,
      score,
      confidence: fromScore(score, { strongEvidence })
    };
  });
}
function pickBoundaryTimestamp(cluster) {
  const cut = cluster.find((s) => s.kind === "visual-cut");
  if (cut) return cut.timestamp;
  const chapter = cluster.find((s) => s.kind === "chapter-change");
  if (chapter) return chapter.timestamp;
  const seek = cluster.find((s) => s.kind === "user-seek");
  if (seek) return seek.timestamp;
  return cluster[0].timestamp;
}
function selectBoundaries(candidates, options = {}) {
  const opts = { ...BOUNDARY_DEFAULTS, ...options };
  const out = [];
  for (const candidate of [...candidates].sort((a, b) => a.timestamp - b.timestamp)) {
    if (candidate.score < opts.threshold) continue;
    const previous = out[out.length - 1];
    if (previous && candidate.timestamp - previous.timestamp < opts.minSceneDurationMs) {
      if (candidate.score > previous.score) out[out.length - 1] = candidate;
      continue;
    }
    out.push(candidate);
  }
  return out;
}
function detectSceneBoundaries(events, options = {}) {
  return selectBoundaries(scoreBoundaryCandidates(collectBoundarySignals(events, options), options), options);
}
const SAME_LINE_SIMILARITY = 0.6;
const SAME_LINE_IOU = 0.25;
function fuseWindow(window, context) {
  const nextId = context.idFactory ?? createIdFactory("beat");
  const beats = [];
  const conflicts = [];
  let lastCharacterId = context.previousCharacterId;
  const { dialogueBeats, nonSpeechCaptions, updatedLastCharacter, dialogueConflicts } = fuseDialogue(
    window,
    context,
    nextId
  );
  beats.push(...dialogueBeats);
  conflicts.push(...dialogueConflicts);
  if (updatedLastCharacter) lastCharacterId = updatedLastCharacter;
  for (const caption of nonSpeechCaptions) {
    const text2 = caption.payload.text.replace(/^[[(♪]\s*/, "").replace(/\s*[\])♪]$/, "").trim();
    if (!text2) continue;
    const beat = {
      type: "sound",
      id: nextId(),
      start: caption.start,
      ...caption.end === void 0 ? {} : { end: caption.end },
      kind: "unclassified",
      description: capitalizeSentence(text2),
      provenance: provenanceFrom([caption])
    };
    beats.push(beat);
  }
  for (const sound of window.soundEvents) {
    const describedByCaption = nonSpeechCaptions.some(
      (c) => Math.abs(c.start - sound.start) < 1200
    );
    if (describedByCaption) continue;
    if (!context.includeLowConfidence && sound.confidence === "unknown" && sound.payload.kind === "unclassified") {
      continue;
    }
    const beat = {
      type: "sound",
      id: nextId(),
      start: sound.start,
      ...sound.end === void 0 ? {} : { end: sound.end },
      kind: sound.payload.kind,
      description: describeSoundEvent(sound.payload.kind, sound.payload.description),
      provenance: provenanceFrom([sound])
    };
    beats.push(beat);
  }
  for (const silence of window.silences) {
    if (!silence.payload.significant) continue;
    const beat = {
      type: "sound",
      id: nextId(),
      start: silence.start,
      ...silence.end === void 0 ? {} : { end: silence.end },
      kind: "unclassified",
      description: describeSilence({
        start: silence.start,
        end: silence.end ?? silence.start,
        durationMs: silence.payload.durationMs
      }),
      provenance: provenanceFrom([silence])
    };
    beats.push(beat);
  }
  for (const visual of window.visualEvents) {
    if (visual.payload.kind === "scene-change") {
      const beat2 = {
        type: "transition",
        id: nextId(),
        start: visual.start,
        label: "CUT TO:",
        provenance: provenanceFrom([visual])
      };
      beats.push(beat2);
      continue;
    }
    const description = visual.payload.description;
    if (!description) continue;
    if (!context.includeLowConfidence && visual.confidence === "low" && visual.payload.inferred) continue;
    const beat = {
      type: "action",
      id: nextId(),
      start: visual.start,
      ...visual.end === void 0 ? {} : { end: visual.end },
      description: capitalizeSentence(description),
      ...visual.payload.participantIds ? { participantIds: visual.payload.participantIds } : {},
      provenance: provenanceFrom([visual], { inferred: visual.payload.inferred ?? false })
    };
    beats.push(beat);
  }
  for (const ocr of window.ocrEvents) {
    if (ocr.payload.unrecognized || !ocr.payload.text.trim()) continue;
    const beat = {
      type: "on-screen-text",
      id: nextId(),
      start: ocr.start,
      ...ocr.end === void 0 ? {} : { end: ocr.end },
      text: ocr.payload.text.trim(),
      provenance: provenanceFrom([ocr])
    };
    beats.push(beat);
  }
  return {
    beats: beats.sort((a, b) => a.start - b.start),
    conflicts,
    ...lastCharacterId ? { lastCharacterId } : {}
  };
}
function fuseDialogue(window, context, nextId) {
  const dialogueBeats = [];
  const nonSpeechCaptions = [];
  const dialogueConflicts = [];
  const consumedSpeech = /* @__PURE__ */ new Set();
  let lastCharacterId = context.previousCharacterId;
  const speakerCandidates = window.speakers.map((s) => ({
    speakerId: s.payload.speakerId,
    start: s.start,
    end: s.end ?? s.start,
    confidence: s.confidence
  }));
  const groups = groupSubtitlesByTime(window.subtitles);
  for (const group of groups) {
    const speechEvents = window.speech.filter((speech) => {
      const overlap = temporalIou(
        { start: group.start, end: group.end },
        { start: speech.start, end: speech.end ?? speech.start }
      );
      if (overlap < SAME_LINE_IOU) return false;
      const primary = group.cues[0];
      return textSimilarity(primary.payload.text, speech.payload.text) >= SAME_LINE_SIMILARITY;
    });
    for (const speech of speechEvents) consumedSpeech.add(speech.id);
    const captions = group.cues.filter((c) => isNonSpeechCaption(c.payload.text));
    if (captions.length === group.cues.length) {
      nonSpeechCaptions.push(...captions);
      continue;
    }
    const spoken = group.cues.filter((c) => !isNonSpeechCaption(c.payload.text));
    nonSpeechCaptions.push(...captions);
    const textVariants = {};
    let speakerLabel;
    for (const cue of spoken) {
      const explicit = cue.payload.speakerLabel;
      const parsed = extractSpeakerLabel(cue.payload.text);
      const label = explicit ?? parsed.speaker;
      if (label && !speakerLabel) speakerLabel = label;
      textVariants[cue.payload.language] = {
        language: cue.payload.language,
        text: parsed.remainder || cue.payload.text,
        origin: "platform-subtitle",
        // An auto-generated caption track is machine transcription and is
        // labelled as less reliable than an authored one.
        confidence: cue.payload.autoGenerated ? "medium" : "high"
      };
    }
    let start = group.start;
    let confidence = corroborate(
      [...spoken.map((c) => c.confidence), ...speechEvents.map((s) => s.confidence)],
      speechEvents.length > 0 ? 2 : 1
    );
    if (speechEvents.length > 0) {
      const earliestSpeech = Math.min(...speechEvents.map((s) => s.start));
      if (earliestSpeech > start && earliestSpeech - start < 1500) start = earliestSpeech;
      for (const speech of speechEvents) {
        if (speech.payload.language && !textVariants[speech.payload.language]) {
          textVariants[speech.payload.language] = {
            language: speech.payload.language,
            text: speech.payload.text,
            origin: "audio-asr",
            confidence: speech.confidence
          };
        }
      }
    }
    const supporting = [...spoken, ...speechEvents];
    const userAssignment = findUserAssignment(context, supporting);
    const attribution = attributeSpeaker(
      {
        start,
        end: group.end,
        ...speakerLabel ? { subtitleSpeakerLabel: speakerLabel } : {},
        ...userAssignment ? { userCharacterId: userAssignment } : {},
        speakerCandidates,
        ...lastCharacterId ? { previousCharacterId: lastCharacterId } : {},
        ...context.presentCharacterIds ? { presentCharacterIds: context.presentCharacterIds } : {}
      },
      context.registry
    );
    if (attribution.characterId) {
      context.registry.noteLine(attribution.characterId, start);
      lastCharacterId = attribution.characterId;
    }
    confidence = minConfidence(confidence, "high");
    const beat = {
      type: "dialogue",
      id: nextId(),
      start,
      end: group.end,
      ...attribution.characterId ? { characterId: attribution.characterId } : {},
      attributionMethod: attribution.method,
      textVariants,
      provenance: provenanceFrom(supporting, { confidence })
    };
    dialogueBeats.push(beat);
  }
  for (const speech of window.speech) {
    if (consumedSpeech.has(speech.id)) continue;
    const text2 = speech.payload.text.trim();
    if (!text2) continue;
    const overlappingSubtitle = window.subtitles.find(
      (cue) => temporalIou(
        { start: speech.start, end: speech.end ?? speech.start },
        { start: cue.start, end: cue.end ?? cue.start }
      ) > SAME_LINE_IOU
    );
    if (overlappingSubtitle) {
      dialogueConflicts.push({
        timestamp: speech.start,
        description: `Audio transcription differs from the subtitle track ("${truncate(text2)}" vs "${truncate(
          overlappingSubtitle.payload.text
        )}").`,
        evidenceIds: [speech.id, overlappingSubtitle.id]
      });
      if (!context.includeLowConfidence) continue;
    }
    const userAssignment = findUserAssignment(context, [speech]);
    const attribution = attributeSpeaker(
      {
        start: speech.start,
        end: speech.end ?? speech.start,
        ...userAssignment ? { userCharacterId: userAssignment } : {},
        ...speech.payload.speakerId ? {
          speakerCandidates: [
            {
              speakerId: speech.payload.speakerId,
              start: speech.start,
              end: speech.end ?? speech.start,
              confidence: speech.confidence
            }
          ]
        } : { speakerCandidates },
        ...lastCharacterId ? { previousCharacterId: lastCharacterId } : {},
        ...context.presentCharacterIds ? { presentCharacterIds: context.presentCharacterIds } : {}
      },
      context.registry
    );
    if (attribution.characterId) {
      context.registry.noteLine(attribution.characterId, speech.start);
      lastCharacterId = attribution.characterId;
    }
    const language = speech.payload.language ?? "und";
    const beat = {
      type: "dialogue",
      id: nextId(),
      start: speech.start,
      ...speech.end === void 0 ? {} : { end: speech.end },
      ...attribution.characterId ? { characterId: attribution.characterId } : {},
      attributionMethod: attribution.method,
      textVariants: {
        [language]: { language, text: text2, origin: "audio-asr", confidence: speech.confidence }
      },
      provenance: provenanceFrom([speech])
    };
    dialogueBeats.push(beat);
  }
  return {
    dialogueBeats: dialogueBeats.sort((a, b) => a.start - b.start),
    nonSpeechCaptions,
    ...lastCharacterId ? { updatedLastCharacter: lastCharacterId } : {},
    dialogueConflicts
  };
}
function groupSubtitlesByTime(subtitles) {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start);
  const groups = [];
  for (const cue of sorted) {
    const end = cue.end ?? cue.start + 2e3;
    const target = groups.find(
      (g) => temporalIou({ start: g.start, end: g.end }, { start: cue.start, end }) > 0.5 && !g.cues.some((c) => c.payload.language === cue.payload.language)
    );
    if (target) {
      target.cues.push(cue);
      target.start = Math.min(target.start, cue.start);
      target.end = Math.max(target.end, end);
    } else {
      groups.push({ start: cue.start, end, cues: [cue] });
    }
  }
  return groups;
}
function findUserAssignment(context, events) {
  if (!context.userAssignments) return void 0;
  for (const event of events) {
    const assigned = context.userAssignments.get(event.id);
    if (assigned) return assigned;
  }
  return void 0;
}
function capitalizeSentence(text2) {
  const trimmed = text2.trim();
  if (trimmed.length === 0) return trimmed;
  const capitalized = trimmed[0].toLocaleUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
function truncate(text2, max = 40) {
  return text2.length <= max ? text2 : `${text2.slice(0, max - 1)}…`;
}
const TYPE_ORDER = {
  transition: 0,
  "on-screen-text": 1,
  sound: 2,
  action: 3,
  dialogue: 4
};
function compareBeats(a, b) {
  return a.start - b.start || TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
}
function dialogueTextFor(beat, language, fallbackOrder = []) {
  const exact = beat.textVariants[language];
  if (exact) return exact;
  for (const code of fallbackOrder) {
    const variant = beat.textVariants[code];
    if (variant) return variant;
  }
  const variants = Object.values(beat.textVariants);
  return variants.find((v) => v.origin === "platform-subtitle") ?? variants.find((v) => v.origin === "audio-asr") ?? variants[0];
}
const DEFAULT_STABILIZATION_MS = 8e3;
class SceneBuilder {
  #registry;
  #stabilizationMs;
  #includeLowConfidence;
  #userAssignments;
  #finalized = [];
  #finalizedUntil = 0;
  #provisional = [];
  #conflicts = [];
  #lastCharacterId;
  constructor(options) {
    this.#registry = options.registry;
    this.#stabilizationMs = options.stabilizationMs ?? DEFAULT_STABILIZATION_MS;
    this.#includeLowConfidence = options.includeLowConfidence ?? false;
    this.#userAssignments = options.userAssignments ?? /* @__PURE__ */ new Map();
  }
  get scenes() {
    return [...this.#finalized, ...this.#provisional];
  }
  get conflicts() {
    return this.#conflicts;
  }
  setUserAssignments(assignments) {
    this.#userAssignments = assignments;
  }
  setIncludeLowConfidence(value) {
    this.#includeLowConfidence = value;
  }
  /**
   * Recomputes the provisional tail from the timeline and promotes anything
   * that has settled.
   */
  rebuild(timeline, currentTime) {
    const duration = timeline.durationMs ?? currentTime;
    const tailStart = this.#finalizedUntil;
    const tailEnd = Math.max(currentTime, duration > 0 ? Math.min(duration, currentTime + 1) : currentTime);
    const events = timeline.all().filter((e) => (e.end ?? e.start) >= tailStart);
    const { scenes, conflicts } = this.#buildScenes(events, tailStart, Math.max(tailEnd, tailStart + 1));
    this.#provisional = scenes;
    this.#conflicts = conflicts;
    const newlyFinalized = this.#promoteStableScenes(currentTime);
    return { scenes: this.scenes, conflicts: this.#conflicts, newlyFinalized };
  }
  /**
   * Handles a seek.
   *
   * Nothing is invented for the skipped range: the timeline simply has no
   * coverage there, and the coverage report says so. Seeking *backwards* into
   * analyzed material is handled by the ordinary rebuild path, which reuses
   * existing evidence rather than creating a second copy of the scene.
   */
  handleSeek(to) {
    if (to < this.#finalizedUntil) {
      const reopened = this.#finalized.filter((s) => (s.end ?? s.start) >= to);
      this.#finalized = this.#finalized.filter((s) => (s.end ?? s.start) < to);
      this.#finalizedUntil = this.#finalized.reduce((max, s) => Math.max(max, s.end ?? s.start), 0);
      for (const scene of reopened) scene.status = "provisional";
    }
    this.#lastCharacterId = void 0;
  }
  reset() {
    this.#finalized = [];
    this.#provisional = [];
    this.#conflicts = [];
    this.#finalizedUntil = 0;
    this.#lastCharacterId = void 0;
  }
  /** Restores previously saved scenes, e.g. when reopening a saved screenplay. */
  restore(scenes) {
    this.#finalized = scenes.filter((s) => s.status === "finalized").map((s) => ({ ...s }));
    this.#provisional = scenes.filter((s) => s.status !== "finalized").map((s) => ({ ...s }));
    this.#finalizedUntil = this.#finalized.reduce((max, s) => Math.max(max, s.end ?? s.start), 0);
  }
  #buildScenes(events, spanStart, spanEnd) {
    if (events.length === 0) return { scenes: [], conflicts: [] };
    const boundaries = detectSceneBoundaries(events);
    const cuts = [spanStart, ...boundaries.map((b) => b.timestamp), spanEnd].filter((t) => t >= spanStart && t <= spanEnd).sort((a, b) => a - b);
    const uniqueCuts = [...new Set(cuts)];
    const scenes = [];
    const conflicts = [];
    let previousCharacterId = this.#lastCharacterId;
    for (let i = 0; i < uniqueCuts.length - 1; i++) {
      const start = uniqueCuts[i];
      const end = uniqueCuts[i + 1];
      const sceneEvents = events.filter((e) => e.start >= start && e.start < end);
      if (sceneEvents.length === 0) continue;
      const windows = buildEvidenceWindows(sceneEvents, { start, end });
      const beats = [];
      const presentCharacterIds = /* @__PURE__ */ new Set();
      for (const window of windows) {
        const result = fuseWindow(window, {
          registry: this.#registry,
          ...previousCharacterId ? { previousCharacterId } : {},
          presentCharacterIds: [...presentCharacterIds],
          userAssignments: this.#userAssignments,
          includeLowConfidence: this.#includeLowConfidence,
          idFactory: () => "pending"
        });
        for (const beat of result.beats) {
          beats.push(withStableId(beat));
          if (beat.type === "dialogue" && beat.characterId) presentCharacterIds.add(beat.characterId);
        }
        conflicts.push(...result.conflicts);
        if (result.lastCharacterId) previousCharacterId = result.lastCharacterId;
      }
      if (beats.length === 0) continue;
      beats.sort(compareBeats);
      const lastEvidenceEnd = sceneEvents.reduce(
        (max, event) => Math.max(max, event.end ?? event.start),
        start
      );
      const sceneEnd = Math.max(start + 1, Math.min(end, lastEvidenceEnd));
      const scene = {
        id: `scene-${shortHash(`${start}`)}`,
        start,
        end: sceneEnd,
        characters: buildPresence([...presentCharacterIds], beats),
        beats: dedupeBeats(beats),
        provenance: mergeProvenance(...beats.map((b) => b.provenance)),
        status: "provisional"
      };
      const setting = deriveSetting(sceneEvents);
      if (setting) scene.setting = setting;
      scenes.push(scene);
    }
    this.#lastCharacterId = previousCharacterId;
    return { scenes, conflicts };
  }
  /**
   * Promotes scenes that playback has moved safely past.
   *
   * Once finalized a scene stops being recomputed, which bounds the cost of
   * rebuilding regardless of how long the film runs.
   */
  #promoteStableScenes(currentTime) {
    const cutoff = currentTime - this.#stabilizationMs;
    const stable = this.#provisional.filter((s) => (s.end ?? s.start) < cutoff);
    if (stable.length === 0) return [];
    const promoted = stable.map((scene) => ({ ...scene, status: "finalized" }));
    this.#finalized.push(...promoted);
    this.#finalized.sort((a, b) => a.start - b.start);
    this.#provisional = this.#provisional.filter((s) => (s.end ?? s.start) >= cutoff);
    this.#finalizedUntil = this.#finalized.reduce((max, s) => Math.max(max, s.end ?? s.start), 0);
    return promoted;
  }
}
function withStableId(beat) {
  const signature = `${beat.type}|${beat.start}|${beat.provenance.evidenceIds.join(",")}`;
  return { ...beat, id: `beat-${shortHash(signature)}` };
}
function dedupeBeats(beats) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const beat of beats) {
    if (seen.has(beat.id)) continue;
    seen.add(beat.id);
    out.push(beat);
  }
  return out;
}
function buildPresence(characterIds, beats) {
  return characterIds.map((characterId) => {
    const lines = beats.filter((b) => b.type === "dialogue" && b.characterId === characterId);
    const first = lines[0];
    return {
      characterId,
      speaks: lines.length > 0,
      ...first ? { enteredAt: first.start } : {},
      confidence: lines.length > 1 ? "high" : "medium"
    };
  });
}
function deriveSetting(events) {
  const settingEvents = events.filter(
    (e) => e.source === "video" && e.payload.kind === "setting" && Boolean(e.payload.description)
  );
  if (settingEvents.length === 0) return void 0;
  const best = settingEvents.reduce((a, b) => rank(b.confidence) > rank(a.confidence) ? b : a);
  const description = best.payload.description;
  const setting = {
    description,
    confidence: minConfidence(best.confidence, "medium"),
    inferred: best.payload.inferred ?? true
  };
  const interiorExterior = parseInteriorExterior(description);
  if (interiorExterior) setting.interiorExterior = interiorExterior;
  const timeOfDay = parseTimeOfDay(description);
  if (timeOfDay) setting.timeOfDay = timeOfDay;
  void provenanceFrom(settingEvents);
  return setting;
}
function rank(confidence) {
  return { high: 3, medium: 2, low: 1, unknown: 0 }[confidence] ?? 0;
}
function parseInteriorExterior(description) {
  if (/\b(int\.?|interior|indoors?|inside)\b/i.test(description)) return "INT";
  if (/\b(ext\.?|exterior|outdoors?|outside|street|park|forest|beach)\b/i.test(description)) return "EXT";
  return void 0;
}
function parseTimeOfDay(description) {
  const match = /\b(day|night|dawn|dusk|morning|afternoon|evening|sunset|sunrise)\b/i.exec(description);
  return match ? match[1].toUpperCase() : void 0;
}
const STRUCTURAL = {
  en: {
    interior: "INT.",
    exterior: "EXT.",
    unknownPlace: "UNKNOWN LOCATION",
    unknownTime: "UNKNOWN TIME",
    offScreen: "O.S.",
    onScreenText: "ON SCREEN:",
    continuous: "CONTINUOUS",
    timesOfDay: { DAY: "DAY", NIGHT: "NIGHT", DAWN: "DAWN", DUSK: "DUSK", MORNING: "MORNING", EVENING: "EVENING" }
  },
  ko: {
    interior: "실내.",
    exterior: "실외.",
    unknownPlace: "장소 불명",
    unknownTime: "시간 불명",
    offScreen: "(소리)",
    onScreenText: "화면 자막:",
    continuous: "연속",
    timesOfDay: { DAY: "낮", NIGHT: "밤", DAWN: "새벽", DUSK: "해질녘", MORNING: "아침", EVENING: "저녁" }
  },
  ja: {
    interior: "屋内.",
    exterior: "屋外.",
    unknownPlace: "場所不明",
    unknownTime: "時間不明",
    offScreen: "(声)",
    onScreenText: "画面表示:",
    continuous: "連続",
    timesOfDay: { DAY: "昼", NIGHT: "夜", DAWN: "夜明け", DUSK: "夕暮れ", MORNING: "朝", EVENING: "夕方" }
  },
  es: {
    interior: "INT.",
    exterior: "EXT.",
    unknownPlace: "LUGAR DESCONOCIDO",
    unknownTime: "HORA DESCONOCIDA",
    offScreen: "F.C.",
    onScreenText: "EN PANTALLA:",
    continuous: "CONTINUO",
    timesOfDay: { DAY: "DÍA", NIGHT: "NOCHE", DAWN: "AMANECER", DUSK: "ANOCHECER", MORNING: "MAÑANA", EVENING: "TARDE" }
  }
};
function structuralFor(language) {
  return STRUCTURAL[language] ?? STRUCTURAL[language.split("-")[0] ?? ""] ?? STRUCTURAL.en;
}
function formatSceneHeading(setting, language) {
  const strings = structuralFor(language);
  if (!setting?.description) return null;
  const prefix = setting.interiorExterior === "INT" ? strings.interior : setting.interiorExterior === "EXT" ? strings.exterior : "";
  const place = setting.description.trim().toLocaleUpperCase(language === "en" ? "en" : void 0);
  const time = setting.timeOfDay ? strings.timesOfDay[setting.timeOfDay] ?? setting.timeOfDay : strings.unknownTime;
  return [prefix, place, "-", time].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
function renderScreenplay(scenes, options) {
  const strings = structuralFor(options.language);
  const characterMap = new Map(options.characters.map((c) => [c.id, c]));
  const lines = [];
  const fallbacks = options.fallbackLanguages ?? [];
  const ordered = [...scenes].sort((a, b) => a.start - b.start);
  for (const scene of ordered) {
    const heading = formatSceneHeading(scene.setting, options.language);
    if (heading) {
      lines.push({
        id: `${scene.id}-heading`,
        kind: "scene-heading",
        text: heading,
        start: scene.start,
        sceneId: scene.id,
        ...scene.setting ? { confidence: scene.setting.confidence } : {}
      });
    }
    for (const beat of scene.beats) {
      lines.push(...renderBeat(beat, scene.id, options, strings, characterMap, fallbacks));
    }
  }
  lines.sort((a, b) => a.start - b.start);
  return {
    language: options.language,
    ...options.secondaryLanguage ? { secondaryLanguage: options.secondaryLanguage } : {},
    lines,
    start: ordered[0]?.start ?? 0,
    end: ordered[ordered.length - 1]?.end ?? ordered[ordered.length - 1]?.start ?? 0
  };
}
function renderBeat(beat, sceneId, options, strings, characters, fallbacks) {
  switch (beat.type) {
    case "dialogue": {
      const variant = dialogueTextFor(beat, options.language, fallbacks);
      if (!variant) return [];
      const character = beat.characterId ? characters.get(beat.characterId) : void 0;
      const cue = characterCueName(character);
      const out = [
        {
          id: `${beat.id}-cue`,
          kind: "character",
          text: beat.parenthetical ? `${cue} (${beat.parenthetical})` : cue,
          start: beat.start,
          sceneId,
          beatId: beat.id,
          ...beat.characterId ? { characterId: beat.characterId } : {},
          provenance: beat.provenance
        }
      ];
      const line = {
        id: `${beat.id}-text`,
        kind: "dialogue",
        text: variant.text,
        start: beat.start,
        ...beat.end === void 0 ? {} : { end: beat.end },
        sceneId,
        beatId: beat.id,
        ...beat.characterId ? { characterId: beat.characterId } : {},
        provenance: beat.provenance,
        origin: variant.origin,
        confidence: variant.confidence
      };
      if (variant.language !== options.language) line.fallbackLanguage = variant.language;
      if (options.secondaryLanguage) {
        const secondary = dialogueTextFor(beat, options.secondaryLanguage, []);
        if (secondary && secondary.language !== variant.language) line.secondaryText = secondary.text;
      }
      out.push(line);
      return out;
    }
    case "action": {
      const text2 = beat.localized?.[options.language] ?? beat.description;
      const line = {
        id: beat.id,
        kind: "action",
        text: text2,
        start: beat.start,
        ...beat.end === void 0 ? {} : { end: beat.end },
        sceneId,
        beatId: beat.id,
        provenance: beat.provenance,
        confidence: beat.provenance.confidence
      };
      if (!beat.localized?.[options.language] && options.language !== "en") line.fallbackLanguage = "en";
      return [line];
    }
    case "sound": {
      const text2 = beat.localized?.[options.language] ?? beat.description;
      const line = {
        id: beat.id,
        kind: "sound",
        text: text2,
        start: beat.start,
        ...beat.end === void 0 ? {} : { end: beat.end },
        sceneId,
        beatId: beat.id,
        provenance: beat.provenance,
        confidence: beat.provenance.confidence
      };
      if (!beat.localized?.[options.language] && options.language !== "en") line.fallbackLanguage = "en";
      return [line];
    }
    case "on-screen-text":
      return [
        {
          id: beat.id,
          kind: "on-screen-text",
          text: `${strings.onScreenText} "${beat.text}"`,
          start: beat.start,
          ...beat.end === void 0 ? {} : { end: beat.end },
          sceneId,
          beatId: beat.id,
          provenance: beat.provenance,
          confidence: beat.provenance.confidence
        }
      ];
    case "transition":
      if (options.includeTransitions === false) return [];
      return [
        {
          id: beat.id,
          kind: "transition",
          text: beat.label,
          start: beat.start,
          sceneId,
          beatId: beat.id,
          provenance: beat.provenance
        }
      ];
  }
}
function documentToText(document, options = {}) {
  const out = [];
  let lastKind = null;
  for (const line of document.lines) {
    const prefix = options.timestamps ? `[${formatTimecode(line.start)}] ` : "";
    switch (line.kind) {
      case "scene-heading":
        if (lastKind !== null) out.push("");
        out.push(`${prefix}${line.text}`);
        out.push("");
        break;
      case "character":
        out.push(`${prefix}${indent(line.text, 20)}`);
        break;
      case "dialogue":
        out.push(indent(line.text, 10));
        if (line.secondaryText) out.push(indent(line.secondaryText, 10));
        out.push("");
        break;
      case "transition":
        out.push("");
        out.push(indent(line.text, 50));
        out.push("");
        break;
      default:
        out.push(`${prefix}${line.text}`);
        out.push("");
        break;
    }
    lastKind = line.kind;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}
function indent(text2, columns) {
  return `${" ".repeat(columns)}${text2}`;
}
function coverageNote(observedRatio, uncovered) {
  if (observedRatio === void 0) return ["Analysis coverage: unknown (media duration was not reported)."];
  const lines = [`Analysis coverage: ${Math.round(observedRatio * 100)}% of the media was observed.`];
  if (uncovered.length > 0) {
    lines.push("Unobserved ranges (nothing was reconstructed for these):");
    for (const range of uncovered.slice(0, 20)) {
      lines.push(`  ${formatTimecode(range.start)} - ${formatTimecode(range.end)}`);
    }
    if (uncovered.length > 20) lines.push(`  ...and ${uncovered.length - 20} more.`);
  }
  return lines;
}
function searchScreenplay(scenes, query, options = {}) {
  const needle = comparableText(query);
  if (needle.length === 0) return [];
  const scope = options.scope ?? "all";
  const limit = options.limit ?? 200;
  const characterNames = new Map(
    (options.characters ?? []).map((c) => [c.id, c.displayName ?? c.id])
  );
  const results = [];
  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (results.length >= limit) return results;
      if (beat.type === "dialogue" && (scope === "all" || scope === "dialogue" || scope === "speaker")) {
        if (scope === "speaker") {
          const name = beat.characterId ? characterNames.get(beat.characterId) : void 0;
          if (name && comparableText(name).includes(needle)) {
            const variant = pickVariant(beat.textVariants, options);
            results.push(
              makeResult(beat, scene.id, variant?.text ?? "", 0, 0, {
                ...variant?.language ? { language: variant.language } : {},
                characterName: name
              })
            );
          }
          continue;
        }
        const variants = options.allLanguages ? Object.values(beat.textVariants) : [pickVariant(beat.textVariants, options)].filter(Boolean);
        for (const variant of variants) {
          if (!variant) continue;
          const match = findMatch(variant.text, needle);
          if (!match) continue;
          const name = beat.characterId ? characterNames.get(beat.characterId) : void 0;
          results.push(
            makeResult(beat, scene.id, variant.text, match.start, match.length, {
              language: variant.language,
              ...name ? { characterName: name } : {}
            })
          );
          break;
        }
        continue;
      }
      if (scope === "all" || scope === "action") {
        const text2 = beatText(beat);
        if (!text2) continue;
        const match = findMatch(text2, needle);
        if (match) results.push(makeResult(beat, scene.id, text2, match.start, match.length, {}));
      }
    }
  }
  return results;
}
function beatText(beat) {
  switch (beat.type) {
    case "action":
      return beat.description;
    case "sound":
      return beat.description;
    case "on-screen-text":
      return beat.text;
    case "transition":
      return beat.label;
    case "dialogue":
      return null;
  }
}
function pickVariant(variants, options) {
  if (options.language && variants[options.language]) return variants[options.language];
  return Object.values(variants)[0];
}
function findMatch(text2, needle) {
  const { normalized, indexMap } = normalizeWithMap(text2);
  const index = normalized.indexOf(needle);
  if (index < 0) return null;
  const start = indexMap[index] ?? 0;
  const endNormalized = index + needle.length;
  const end = endNormalized < indexMap.length ? indexMap[endNormalized] ?? text2.length : text2.length;
  return { start, length: Math.max(1, end - start) };
}
function normalizeWithMap(text2) {
  let normalized = "";
  const indexMap = [];
  let lastWasSpace = true;
  for (let i = 0; i < text2.length; i++) {
    const char = text2[i];
    if (/[\s ]/.test(char)) {
      if (lastWasSpace) continue;
      normalized += " ";
      indexMap.push(i);
      lastWasSpace = true;
      continue;
    }
    if (/[.,!?;:'"()[\]{}\-–—…·‘’ʼ“”]/.test(char)) continue;
    normalized += char.toLowerCase();
    indexMap.push(i);
    lastWasSpace = false;
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    indexMap.pop();
  }
  return { normalized, indexMap };
}
function makeResult(beat, sceneId, snippet, matchStart, matchLength, extra) {
  return {
    beatId: beat.id,
    sceneId,
    start: beat.start,
    kind: beat.type,
    snippet,
    matchStart,
    matchLength,
    ...extra
  };
}
const DISCLAIMER = [
  "This document was reconstructed by FrameScript from observable playback evidence",
  "(subtitles, audio, picture, on-screen text, playback timing and user corrections).",
  "It is NOT an original, shooting, or production screenplay, and it is not a transcript",
  "supplied by the streaming service. Descriptions and scene headings are inferred and",
  "may be wrong or incomplete."
];
function toFountain(document, metadata = {}, options = {}) {
  const out = [];
  const title = buildTitle(metadata);
  out.push(`Title: ${title}`);
  if (metadata.seriesTitle) out.push(`Series: ${metadata.seriesTitle}`);
  if (metadata.platform) out.push(`Source: ${platformLabel(metadata.platform)}`);
  out.push(`Language: ${document.language}`);
  out.push("Generated By: FrameScript (reconstructed screenplay)");
  if (metadata.generatedAt) out.push(`Date: ${new Date(metadata.generatedAt).toISOString().slice(0, 10)}`);
  out.push("");
  for (const line of DISCLAIMER) out.push(`= ${line}`);
  out.push("");
  if (metadata.coverage?.length) {
    for (const line of metadata.coverage) out.push(`= ${line}`);
    out.push("");
  }
  for (const line of document.lines) {
    out.push(...renderLine(line, options));
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}
`;
}
function renderLine(line, options) {
  const out = [];
  const note = buildNote(line, options);
  switch (line.kind) {
    case "scene-heading":
      out.push("");
      out.push(`.${line.text}`);
      if (note) out.push(note);
      out.push("");
      break;
    case "character":
      out.push("");
      out.push(line.text.toUpperCase());
      break;
    case "dialogue":
      out.push(line.text);
      if (options.dualLanguage && line.secondaryText) out.push(line.secondaryText);
      if (note) out.push(note);
      out.push("");
      break;
    case "transition":
      out.push("");
      out.push(`> ${line.text}`);
      out.push("");
      break;
    case "on-screen-text":
    case "sound":
    case "action":
      out.push(line.text);
      if (note) out.push(note);
      out.push("");
      break;
  }
  return out;
}
function buildNote(line, options) {
  const parts = [];
  if (options.includeTimestamps) parts.push(formatTimecode(line.start, { millis: true }));
  if (options.includeConfidence && line.confidence) parts.push(line.confidence);
  if (line.origin === "ai-translation") parts.push("AI translation");
  else if (line.origin === "audio-asr") parts.push("audio transcription");
  if (line.fallbackLanguage) parts.push(`shown in ${line.fallbackLanguage}`);
  if (options.includeEvidenceRefs && line.provenance) {
    parts.push(describeSources(line.provenance.sources));
    if (line.provenance.inferred) parts.push("inferred");
  }
  return parts.length > 0 ? `[[${parts.join(" | ")}]]` : null;
}
function buildTitle(metadata) {
  if (metadata.seriesTitle && metadata.season !== void 0 && metadata.episode !== void 0) {
    const code = `S${String(metadata.season).padStart(2, "0")}E${String(metadata.episode).padStart(2, "0")}`;
    return metadata.title ? `${metadata.seriesTitle} ${code} — ${metadata.title}` : `${metadata.seriesTitle} ${code}`;
  }
  return metadata.title ?? "Untitled";
}
function platformLabel(platform) {
  return platform === "youtube" ? "YouTube" : "Netflix";
}
const RECONSTRUCTION_NOTICE = "Reconstructed by FrameScript from observable playback evidence. This is not an original, shooting, or production screenplay, and it was not supplied by the streaming service.";
function exportScreenplay(document, metadata, options, extras = {}) {
  const filtered = options.dialogueOnly ? { ...document, lines: document.lines.filter((l) => l.kind === "dialogue" || l.kind === "character") } : document;
  switch (options.format) {
    case "fountain":
      return {
        filename: buildFilename(metadata, document.language, "fountain"),
        mimeType: "text/plain;charset=utf-8",
        content: toFountain(filtered, metadata, options)
      };
    case "markdown":
      return {
        filename: buildFilename(metadata, document.language, "md"),
        mimeType: "text/markdown;charset=utf-8",
        content: toMarkdown(filtered, metadata, options)
      };
    case "text":
      return {
        filename: buildFilename(metadata, document.language, "txt"),
        mimeType: "text/plain;charset=utf-8",
        content: `${RECONSTRUCTION_NOTICE}

${documentToText(filtered, { timestamps: options.includeTimestamps ?? false })}
`
      };
    case "srt":
      return {
        filename: buildFilename(metadata, document.language, "srt"),
        mimeType: "application/x-subrip;charset=utf-8",
        content: toSrt(filtered)
      };
    case "json":
      return {
        filename: buildFilename(metadata, document.language, "json"),
        mimeType: "application/json;charset=utf-8",
        content: toJson(filtered, metadata, extras)
      };
  }
}
function toMarkdown(document, metadata, options) {
  const out = [];
  out.push(`# ${metadata.title ?? "Untitled"}`);
  if (metadata.seriesTitle) out.push(`**${metadata.seriesTitle}**`);
  out.push("");
  out.push(`> ${RECONSTRUCTION_NOTICE}`);
  out.push("");
  if (metadata.coverage?.length) {
    for (const line of metadata.coverage) out.push(`> ${line}`);
    out.push("");
  }
  for (const line of document.lines) {
    const stamp = options.includeTimestamps ? ` \`${formatTimecode(line.start)}\`` : "";
    switch (line.kind) {
      case "scene-heading":
        out.push("");
        out.push(`## ${line.text}${stamp}`);
        out.push("");
        break;
      case "character":
        out.push(`**${line.text}**`);
        break;
      case "dialogue": {
        out.push(`> ${line.text}`);
        if (options.dualLanguage && line.secondaryText) out.push(`> ${line.secondaryText}`);
        const tags = buildTags(line, options);
        if (tags) out.push(`> <sub>${tags}</sub>`);
        out.push("");
        break;
      }
      case "transition":
        out.push("");
        out.push(`*${line.text}*`);
        out.push("");
        break;
      default:
        out.push(`${line.text}${stamp}`);
        out.push("");
        break;
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}
`;
}
function buildTags(line, options) {
  const parts = [];
  if (line.origin === "ai-translation") parts.push("AI translation");
  if (line.origin === "audio-asr") parts.push("audio transcription");
  if (line.fallbackLanguage) parts.push(`shown in ${line.fallbackLanguage}`);
  if (options.includeConfidence && line.confidence) parts.push(line.confidence);
  if (options.includeEvidenceRefs && line.provenance) parts.push(describeSources(line.provenance.sources));
  return parts.length > 0 ? parts.join(" · ") : null;
}
function toSrt(document) {
  const dialogue = document.lines.filter((l) => l.kind === "dialogue");
  const out = [];
  dialogue.forEach((line, index) => {
    const end = line.end ?? line.start + 2e3;
    out.push(String(index + 1));
    out.push(`${formatSrtTimestamp(line.start)} --> ${formatSrtTimestamp(Math.max(end, line.start + 500))}`);
    out.push(line.text);
    if (line.secondaryText) out.push(line.secondaryText);
    out.push("");
  });
  return out.join("\n");
}
function toJson(document, metadata, extras = {}) {
  return `${JSON.stringify(
    {
      format: "framescript-screenplay",
      formatVersion: 1,
      notice: RECONSTRUCTION_NOTICE,
      metadata,
      language: document.language,
      lines: document.lines,
      scenes: extras.scenes ?? void 0,
      characters: extras.characters ?? void 0
    },
    null,
    2
  )}
`;
}
function buildFilename(metadata, language, extension) {
  const parts = [];
  if (metadata.seriesTitle) parts.push(slugify(metadata.seriesTitle));
  else if (metadata.title) parts.push(slugify(metadata.title));
  else parts.push("framescript");
  if (metadata.season !== void 0 && metadata.episode !== void 0) {
    parts.push(`s${String(metadata.season).padStart(2, "0")}e${String(metadata.episode).padStart(2, "0")}`);
  } else if (metadata.seriesTitle && metadata.title) {
    parts.push(slugify(metadata.title, 40));
  }
  const base = parts.filter(Boolean).join("-");
  return `${base}.${slugify(language, 12)}.${extension}`;
}
const SCREENPLAY_SCHEMA_VERSION = 2;
const MIGRATIONS = {
  /**
   * v1 -> v2: language tracking split into three lists.
   *
   * v1 stored a flat `languages: string[]`, which lost the distinction between
   * a real platform subtitle and an AI translation — a distinction the product
   * now treats as load-bearing. Unknown provenance migrates to
   * `platformSubtitles`, the conservative choice, because v1 had no translation
   * feature and therefore could not contain translated text.
   */
  1: (record) => {
    const legacy = Array.isArray(record.languages) ? record.languages : [];
    const existing = record.languageVariants;
    return {
      ...record,
      languageVariants: {
        platformSubtitles: existing?.platformSubtitles ?? legacy,
        transcribed: existing?.transcribed ?? [],
        translated: existing?.translated ?? []
      },
      schemaVersion: 2
    };
  }
};
function migrateScreenplay(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const record = { ...raw };
  const fromVersion = typeof record.schemaVersion === "number" ? record.schemaVersion : 1;
  if (fromVersion > SCREENPLAY_SCHEMA_VERSION) return null;
  if (fromVersion === SCREENPLAY_SCHEMA_VERSION) {
    return { record, migrated: false, fromVersion };
  }
  let current = record;
  let version = fromVersion;
  while (version < SCREENPLAY_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) return null;
    current = migrate(current);
    const next = typeof current.schemaVersion === "number" ? current.schemaVersion : version + 1;
    if (next <= version) return null;
    version = next;
  }
  return { record: current, migrated: true, fromVersion };
}
function buildScreenplay(events, options = {}) {
  const timeline = new EvidenceTimeline();
  const registry = new CharacterRegistry();
  const lastEventEnd = events.reduce((max, e) => Math.max(max, e.end ?? e.start), 0);
  const durationMs = options.durationMs ?? lastEventEnd;
  if (durationMs > 0) timeline.setDuration(durationMs);
  for (const event of events) {
    const { added } = timeline.append(event);
    if (!added) continue;
    const end = event.end ?? event.start;
    timeline.markObserved(event.start, end > event.start ? end : event.start + 100);
  }
  if (options.completeSourceRange && options.completeSourceRange.end > options.completeSourceRange.start) {
    timeline.markObserved(options.completeSourceRange.start, options.completeSourceRange.end);
  }
  const builder = new SceneBuilder({
    registry,
    // Everything is already known, so nothing needs to stay provisional.
    stabilizationMs: options.stabilizationMs ?? 0,
    includeLowConfidence: options.includeLowConfidence ?? false
  });
  const result = builder.rebuild(timeline, Math.max(durationMs, lastEventEnd) + 1);
  const scenes = result.scenes;
  const characters = registry.snapshot();
  const languages = collectLanguages(scenes);
  const language = options.language ?? languages[0] ?? "en";
  const document = renderScreenplay(scenes, {
    language,
    ...options.secondaryLanguage ? { secondaryLanguage: options.secondaryLanguage } : {},
    characters,
    fallbackLanguages: languages,
    ...options.includeTransitions === void 0 ? {} : { includeTransitions: options.includeTransitions },
    includeLowConfidence: options.includeLowConfidence ?? false
  });
  const coverageMap = timeline.coverage();
  const ratio = timeline.coverageRatio();
  const uncovered = timeline.uncoveredRanges();
  return {
    scenes,
    characters,
    document,
    conflicts: [...result.conflicts],
    coverage: {
      ...ratio === void 0 ? {} : { ratio },
      observed: coverageMap.observed,
      uncovered,
      notes: coverageNote(ratio, uncovered)
    },
    languages
  };
}
function collectLanguages(scenes) {
  const codes = [];
  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (beat.type !== "dialogue") continue;
      for (const code of Object.keys(beat.textVariants)) {
        if (code !== "und" && !codes.includes(code)) codes.push(code);
      }
    }
  }
  return codes;
}
function summarizeBeats(scenes) {
  const counts = {
    dialogue: 0,
    action: 0,
    sound: 0,
    "on-screen-text": 0,
    transition: 0
  };
  for (const scene of scenes) {
    for (const beat of scene.beats) counts[beat.type] = (counts[beat.type] ?? 0) + 1;
  }
  return counts;
}
const EXPORT_FORMATS = ["fountain", "markdown", "text", "srt", "json"];
const ROOT = process.cwd();
function resolveWithinRoot(path) {
  const full = isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
  if (full !== ROOT && !full.startsWith(`${ROOT}/`)) {
    throw new Error(`Refusing to read outside the working directory: ${path}`);
  }
  return full;
}
async function loadInputs(paths, language) {
  if (paths.length === 0) throw new Error("At least one input file is required.");
  const evidence = [];
  const warnings = [];
  let jsonScenes = null;
  let jsonCharacters = [];
  let metadata = {};
  let durationMs;
  for (const path of paths) {
    const full = resolveWithinRoot(path);
    const content = await readFile(full, "utf8").catch(() => {
      throw new Error(`Cannot read ${path}`);
    });
    if (extname(full).toLowerCase() === ".json") {
      const parsed = JSON.parse(content);
      const migrated = migrateScreenplay(parsed);
      const record = parsed;
      if (migrated) {
        jsonScenes = migrated.record.scenes;
        jsonCharacters = migrated.record.characters;
        durationMs = migrated.record.coverage.durationMs;
        metadata = {
          ...migrated.record.title ? { title: migrated.record.title } : {},
          ...migrated.record.seriesTitle ? { seriesTitle: migrated.record.seriesTitle } : {},
          ...migrated.record.season === void 0 ? {} : { season: migrated.record.season },
          ...migrated.record.episode === void 0 ? {} : { episode: migrated.record.episode }
        };
      } else if (Array.isArray(record.scenes)) {
        jsonScenes = record.scenes;
        jsonCharacters = record.characters ?? [];
        metadata = record.metadata ?? {};
      } else {
        throw new Error(`${path} is not a FrameScript export or saved screenplay.`);
      }
      continue;
    }
    const parsedFile = parseSubtitleFile(content);
    warnings.push(...parsedFile.warnings.map((w) => `${basename(path)}: ${w}`));
    if (parsedFile.cues.length === 0) {
      throw new Error(`No subtitle cues found in ${path} (detected format: ${parsedFile.format}).`);
    }
    const detected = languageFromFilename(basename(path));
    evidence.push(
      ...cuesToEvidence(parsedFile.cues, {
        language: detected !== "und" ? detected : language ?? "en",
        idPrefix: `sub-${basename(path)}`
      })
    );
    if (!metadata.title) metadata.title = basename(path, extname(path));
  }
  if (jsonScenes && evidence.length === 0) {
    const languages = /* @__PURE__ */ new Set();
    for (const scene of jsonScenes) {
      for (const beat of scene.beats) {
        if (beat.type === "dialogue") for (const code of Object.keys(beat.textVariants)) languages.add(code);
      }
    }
    return {
      scenes: jsonScenes,
      characters: jsonCharacters,
      languages: [...languages].filter((c) => c !== "und"),
      metadata,
      coverageNotes: [],
      conflicts: [],
      warnings
    };
  }
  const sourceEnd = evidence.reduce((max, e) => Math.max(max, e.end ?? e.start), 0);
  const built = buildScreenplay(evidence, {
    ...durationMs === void 0 ? {} : { durationMs },
    ...language ? { language } : {},
    ...sourceEnd > 0 ? { completeSourceRange: { start: 0, end: sourceEnd } } : {}
  });
  return {
    scenes: jsonScenes ? [...jsonScenes, ...built.scenes] : built.scenes,
    characters: jsonCharacters.length > 0 ? jsonCharacters : built.characters,
    languages: built.languages,
    metadata,
    coverageNotes: built.coverage.notes,
    conflicts: built.conflicts.map((c) => `${formatTimecode(c.timestamp)}: ${c.description}`),
    warnings
  };
}
const FILES_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description: "Paths to subtitle files (.srt/.vtt) and/or a FrameScript export (.json), relative to the working directory. Several subtitle files may be given, including the same content in different languages."
};
const TOOLS = [
  {
    name: "framescript_build",
    description: "Reconstruct a screenplay from subtitle files and/or a FrameScript export, and return it in a screenplay format. Returns the document content; it does not write any file. Note: this operates on files only — analysing a live YouTube or Netflix stream requires the FrameScript browser extension.",
    inputSchema: {
      type: "object",
      properties: {
        files: FILES_SCHEMA,
        language: { type: "string", description: "Script language code, e.g. en, ko, ja. Defaults to the first language with dialogue." },
        secondaryLanguage: { type: "string", description: "Render a second language alongside each dialogue line." },
        format: { type: "string", enum: EXPORT_FORMATS, description: "Output format. Default: fountain." },
        includeTimestamps: { type: "boolean" },
        includeConfidence: { type: "boolean" },
        includeEvidenceRefs: { type: "boolean", description: "Annotate each line with the evidence sources that justify it." },
        dialogueOnly: { type: "boolean" }
      },
      required: ["files"]
    }
  },
  {
    name: "framescript_inspect",
    description: "Summarize a screenplay or subtitle file: scene count, beat counts by type, speakers, languages, time span, analysis coverage, and any unresolved source conflicts. Use this before building to understand what the input actually contains.",
    inputSchema: {
      type: "object",
      properties: { files: FILES_SCHEMA, language: { type: "string" } },
      required: ["files"]
    }
  },
  {
    name: "framescript_search",
    description: "Search dialogue and action across a screenplay or subtitle file. Returns matches with timecodes, speaker names where known, and the language each match was found in.",
    inputSchema: {
      type: "object",
      properties: {
        files: FILES_SCHEMA,
        query: { type: "string", description: "Text to find. Matching ignores case and punctuation." },
        scope: { type: "string", enum: ["all", "dialogue", "action", "speaker"], description: "Default: all." },
        language: { type: "string", description: "Restrict to one language. Omit to search every language present." },
        limit: { type: "number", description: "Maximum results. Default 50." }
      },
      required: ["files", "query"]
    }
  },
  {
    name: "framescript_parse_subtitles",
    description: "Parse a subtitle file and return its cues with timings, plus the detected format and any blocks that could not be read. Use this when you want the raw cues rather than a reconstructed screenplay.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to an .srt or .vtt file." },
        limit: { type: "number", description: "Maximum cues to return. Default 200." }
      },
      required: ["file"]
    }
  },
  {
    name: "framescript_capabilities",
    description: "Describe what this server can and cannot do, including the limitations that require the browser extension. Call this if you are unsure whether a task is possible here.",
    inputSchema: { type: "object", properties: {} }
  }
];
const text = (value) => ({ content: [{ type: "text", text: value }] });
async function handleBuild(args) {
  const files = args.files;
  const language = args.language;
  const loaded = await loadInputs(files, language);
  const format = args.format ?? "fountain";
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(`Unknown format "${format}". Expected: ${EXPORT_FORMATS.join(", ")}`);
  }
  const resolved = language ?? loaded.languages[0] ?? "en";
  const secondary = args.secondaryLanguage;
  const document = renderScreenplay(loaded.scenes, {
    language: resolved,
    ...secondary ? { secondaryLanguage: secondary } : {},
    characters: loaded.characters,
    fallbackLanguages: loaded.languages
  });
  const result = exportScreenplay(
    document,
    { ...loaded.metadata, generatedAt: Date.now(), coverage: loaded.coverageNotes },
    {
      format,
      includeTimestamps: Boolean(args.includeTimestamps),
      includeConfidence: Boolean(args.includeConfidence),
      includeEvidenceRefs: Boolean(args.includeEvidenceRefs),
      dialogueOnly: Boolean(args.dialogueOnly),
      dualLanguage: Boolean(secondary)
    },
    { scenes: loaded.scenes, characters: loaded.characters }
  );
  const preamble = [
    `Suggested filename: ${result.filename}`,
    `Language: ${resolved}${secondary ? ` (with ${secondary})` : ""}`,
    ...loaded.warnings.map((w) => `Warning: ${w}`),
    ...loaded.conflicts.length > 0 ? [`Unresolved source conflicts: ${loaded.conflicts.length}`, ...loaded.conflicts.slice(0, 5)] : [],
    ""
  ].join("\n");
  return text(preamble + result.content);
}
async function handleInspect(args) {
  const loaded = await loadInputs(args.files, args.language);
  const counts = summarizeBeats(loaded.scenes);
  const last = loaded.scenes[loaded.scenes.length - 1];
  const payload = {
    title: loaded.metadata.seriesTitle ?? loaded.metadata.title ?? null,
    scenes: loaded.scenes.length,
    beats: counts,
    characters: loaded.characters.map((c) => ({
      name: c.displayName ?? null,
      id: c.id,
      lines: c.lineCount,
      source: c.source,
      voiceClusters: c.speakerIds.length
    })),
    languages: loaded.languages,
    span: {
      start: formatTimecode(loaded.scenes[0]?.start ?? 0),
      end: formatTimecode(last?.end ?? last?.start ?? 0)
    },
    coverage: loaded.coverageNotes,
    conflicts: loaded.conflicts,
    warnings: loaded.warnings
  };
  return text(JSON.stringify(payload, null, 2));
}
async function handleSearch(args) {
  const language = args.language;
  const loaded = await loadInputs(args.files, language);
  const results = searchScreenplay(loaded.scenes, args.query, {
    scope: args.scope ?? "all",
    allLanguages: !language,
    ...language ? { language } : {},
    characters: loaded.characters,
    limit: Number(args.limit ?? 50)
  });
  if (results.length === 0) return text("No matches.");
  const lines = results.map(
    (r) => JSON.stringify({
      time: formatTimecode(r.start),
      timeMs: r.start,
      kind: r.kind,
      speaker: r.characterName ?? null,
      language: r.language ?? null,
      text: r.snippet
    })
  );
  return text(`${results.length} match${results.length === 1 ? "" : "es"}
${lines.join("\n")}`);
}
async function handleParseSubtitles(args) {
  const full = resolveWithinRoot(args.file);
  const content = await readFile(full, "utf8").catch(() => {
    throw new Error(`Cannot read ${String(args.file)}`);
  });
  const parsed = parseSubtitleFile(content);
  const limit = Number(args.limit ?? 200);
  return text(
    JSON.stringify(
      {
        format: parsed.format,
        totalCues: parsed.cues.length,
        skipped: parsed.skipped,
        warnings: parsed.warnings,
        returned: Math.min(limit, parsed.cues.length),
        cues: parsed.cues.slice(0, limit).map((cue) => ({
          index: cue.index,
          start: formatTimecode(cue.start, { millis: true }),
          end: formatTimecode(cue.end, { millis: true }),
          startMs: cue.start,
          endMs: cue.end,
          text: cue.text
        }))
      },
      null,
      2
    )
  );
}
function handleCapabilities() {
  return text(
    `FrameScript MCP server — what it can and cannot do.

CAN:
  - Reconstruct a screenplay from .srt/.vtt subtitle files
  - Read, inspect, search and convert FrameScript exports and saved screenplays
  - Merge several language tracks into one screenplay with per-language variants
  - Export to Fountain, Markdown, plain text, SRT and JSON
  - Report analysis coverage, source conflicts and unparseable input honestly

CANNOT:
  - Change YouTube or Netflix playback quality
  - Capture or analyse audio or video from a streaming site
  - Read a live player's subtitles
  These need the FrameScript browser extension: only an extension can see a
  streaming site's player. Nothing here can substitute for it.

  - Perform speech recognition, describe picture content, or read on-screen text
  Those need media plus a model. This server works on text-bearing files.

ALSO:
  - It reads files only, never writes them. Build results are returned as
    content for the client to save.
  - It reads only within its working directory (${ROOT}).

WHAT A RECONSTRUCTED SCREENPLAY IS:
  Derived from observed evidence, with provenance. It is not an original,
  shooting, or production screenplay, and should never be presented as one.`
  );
}
const server = new Server(
  { name: "framescript", version: "0.1.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  try {
    switch (request.params.name) {
      case "framescript_build":
        return await handleBuild(args);
      case "framescript_inspect":
        return await handleInspect(args);
      case "framescript_search":
        return await handleSearch(args);
      case "framescript_parse_subtitles":
        return await handleParseSubtitles(args);
      case "framescript_capabilities":
        return handleCapabilities();
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true
    };
  }
});
await server.connect(new StdioServerTransport());
