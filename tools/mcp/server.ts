/**
 * FrameScript MCP server.
 *
 * Exposes the reconstruction engine over the Model Context Protocol so that
 * Codex, Claude Desktop, or any other MCP client can build, inspect, search and
 * convert screenplays without shelling out.
 *
 * Design notes that matter for a tool server:
 *
 *  - **It reads files, it never writes them.** A model deciding to overwrite a
 *    user's screenplay is not a risk worth taking for convenience; `build`
 *    returns content and the client decides what to do with it.
 *  - **Every tool reports uncertainty.** Coverage, conflicts and unparseable
 *    blocks come back in the response rather than being smoothed away, because
 *    a model reading the output has no other way to know.
 *  - **It cannot touch a streaming site.** Maximum Quality and media capture
 *    need the browser extension. The tool descriptions say so, so a client does
 *    not plan around a capability that does not exist here.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildScreenplay,
  cuesToEvidence,
  exportScreenplay,
  formatTimecode,
  languageFromFilename,
  migrateScreenplay,
  parseSubtitleFile,
  renderScreenplay,
  searchScreenplay,
  summarizeBeats,
  type CharacterEntity,
  type EvidenceEvent,
  type ExportFormat,
  type ExportMetadata,
  type ReconstructedScene,
} from '../../src/core';

const EXPORT_FORMATS: ExportFormat[] = ['fountain', 'markdown', 'text', 'srt', 'json'];

/**
 * Files may only be read beneath the directory the server was started in.
 * An MCP server is driven by a model, so the filesystem surface it exposes
 * should be the workspace and nothing above it.
 */
const ROOT = process.cwd();

function resolveWithinRoot(path: string): string {
  const full = isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
  if (full !== ROOT && !full.startsWith(`${ROOT}/`)) {
    throw new Error(`Refusing to read outside the working directory: ${path}`);
  }
  return full;
}

interface Loaded {
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  languages: string[];
  metadata: ExportMetadata;
  coverageNotes: string[];
  conflicts: string[];
  warnings: string[];
}

async function loadInputs(paths: readonly string[], language?: string): Promise<Loaded> {
  if (paths.length === 0) throw new Error('At least one input file is required.');

  const evidence: EvidenceEvent[] = [];
  const warnings: string[] = [];
  let jsonScenes: ReconstructedScene[] | null = null;
  let jsonCharacters: CharacterEntity[] = [];
  let metadata: ExportMetadata = {};
  let durationMs: number | undefined;

  for (const path of paths) {
    const full = resolveWithinRoot(path);
    const content = await readFile(full, 'utf8').catch(() => {
      throw new Error(`Cannot read ${path}`);
    });

    if (extname(full).toLowerCase() === '.json') {
      const parsed: unknown = JSON.parse(content);
      const migrated = migrateScreenplay(parsed);
      const record = parsed as { scenes?: ReconstructedScene[]; characters?: CharacterEntity[]; metadata?: ExportMetadata };

      if (migrated) {
        jsonScenes = migrated.record.scenes;
        jsonCharacters = migrated.record.characters;
        durationMs = migrated.record.coverage.durationMs;
        metadata = {
          ...(migrated.record.title ? { title: migrated.record.title } : {}),
          ...(migrated.record.seriesTitle ? { seriesTitle: migrated.record.seriesTitle } : {}),
          ...(migrated.record.season === undefined ? {} : { season: migrated.record.season }),
          ...(migrated.record.episode === undefined ? {} : { episode: migrated.record.episode }),
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

    // The file's own marker wins; `language` selects what to RENDER. Using it
    // as the input language too would tag every file identically and stop the
    // same line in two languages from merging into one beat.
    const detected = languageFromFilename(basename(path));
    evidence.push(
      ...cuesToEvidence(parsedFile.cues, {
        language: detected !== 'und' ? detected : (language ?? 'en'),
        idPrefix: `sub-${basename(path)}`,
      }),
    );
    if (!metadata.title) metadata.title = basename(path, extname(path));
  }

  if (jsonScenes && evidence.length === 0) {
    const languages = new Set<string>();
    for (const scene of jsonScenes) {
      for (const beat of scene.beats) {
        if (beat.type === 'dialogue') for (const code of Object.keys(beat.textVariants)) languages.add(code);
      }
    }
    return {
      scenes: jsonScenes,
      characters: jsonCharacters,
      languages: [...languages].filter((c) => c !== 'und'),
      metadata,
      coverageNotes: [],
      conflicts: [],
      warnings,
    };
  }

  // Subtitle files are a complete source; see BuildOptions.completeSourceRange.
  const sourceEnd = evidence.reduce((max, e) => Math.max(max, e.end ?? e.start), 0);
  const built = buildScreenplay(evidence, {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(language ? { language } : {}),
    ...(sourceEnd > 0 ? { completeSourceRange: { start: 0, end: sourceEnd } } : {}),
  });

  return {
    scenes: jsonScenes ? [...jsonScenes, ...built.scenes] : built.scenes,
    characters: jsonCharacters.length > 0 ? jsonCharacters : built.characters,
    languages: built.languages,
    metadata,
    coverageNotes: built.coverage.notes,
    conflicts: built.conflicts.map((c) => `${formatTimecode(c.timestamp)}: ${c.description}`),
    warnings,
  };
}

// --- Tool definitions ----------------------------------------------------------

const FILES_SCHEMA = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description:
    'Paths to subtitle files (.srt/.vtt) and/or a FrameScript export (.json), relative to the working directory. Several subtitle files may be given, including the same content in different languages.',
};

const TOOLS: Tool[] = [
  {
    name: 'framescript_build',
    description:
      'Reconstruct a screenplay from subtitle files and/or a FrameScript export, and return it in a screenplay format. Returns the document content; it does not write any file. Note: this operates on files only — analysing a live YouTube or Netflix stream requires the FrameScript browser extension.',
    inputSchema: {
      type: 'object',
      properties: {
        files: FILES_SCHEMA,
        language: { type: 'string', description: 'Script language code, e.g. en, ko, ja. Defaults to the first language with dialogue.' },
        secondaryLanguage: { type: 'string', description: 'Render a second language alongside each dialogue line.' },
        format: { type: 'string', enum: EXPORT_FORMATS, description: 'Output format. Default: fountain.' },
        includeTimestamps: { type: 'boolean' },
        includeConfidence: { type: 'boolean' },
        includeEvidenceRefs: { type: 'boolean', description: 'Annotate each line with the evidence sources that justify it.' },
        dialogueOnly: { type: 'boolean' },
      },
      required: ['files'],
    },
  },
  {
    name: 'framescript_inspect',
    description:
      'Summarize a screenplay or subtitle file: scene count, beat counts by type, speakers, languages, time span, analysis coverage, and any unresolved source conflicts. Use this before building to understand what the input actually contains.',
    inputSchema: {
      type: 'object',
      properties: { files: FILES_SCHEMA, language: { type: 'string' } },
      required: ['files'],
    },
  },
  {
    name: 'framescript_search',
    description:
      'Search dialogue and action across a screenplay or subtitle file. Returns matches with timecodes, speaker names where known, and the language each match was found in.',
    inputSchema: {
      type: 'object',
      properties: {
        files: FILES_SCHEMA,
        query: { type: 'string', description: 'Text to find. Matching ignores case and punctuation.' },
        scope: { type: 'string', enum: ['all', 'dialogue', 'action', 'speaker'], description: 'Default: all.' },
        language: { type: 'string', description: 'Restrict to one language. Omit to search every language present.' },
        limit: { type: 'number', description: 'Maximum results. Default 50.' },
      },
      required: ['files', 'query'],
    },
  },
  {
    name: 'framescript_parse_subtitles',
    description:
      'Parse a subtitle file and return its cues with timings, plus the detected format and any blocks that could not be read. Use this when you want the raw cues rather than a reconstructed screenplay.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to an .srt or .vtt file.' },
        limit: { type: 'number', description: 'Maximum cues to return. Default 200.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'framescript_capabilities',
    description:
      'Describe what this server can and cannot do, including the limitations that require the browser extension. Call this if you are unsure whether a task is possible here.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// --- Handlers ------------------------------------------------------------------

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

async function handleBuild(args: Record<string, unknown>): Promise<CallToolResult> {
  const files = args.files as string[];
  const language = args.language as string | undefined;
  const loaded = await loadInputs(files, language);

  const format = (args.format as ExportFormat) ?? 'fountain';
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(`Unknown format "${format}". Expected: ${EXPORT_FORMATS.join(', ')}`);
  }

  const resolved = language ?? loaded.languages[0] ?? 'en';
  const secondary = args.secondaryLanguage as string | undefined;

  const document = renderScreenplay(loaded.scenes, {
    language: resolved,
    ...(secondary ? { secondaryLanguage: secondary } : {}),
    characters: loaded.characters,
    fallbackLanguages: loaded.languages,
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
      dualLanguage: Boolean(secondary),
    },
    { scenes: loaded.scenes, characters: loaded.characters },
  );

  // Uncertainty travels with the result, not in a footnote the model may skip.
  const preamble = [
    `Suggested filename: ${result.filename}`,
    `Language: ${resolved}${secondary ? ` (with ${secondary})` : ''}`,
    ...loaded.warnings.map((w) => `Warning: ${w}`),
    ...(loaded.conflicts.length > 0
      ? [`Unresolved source conflicts: ${loaded.conflicts.length}`, ...loaded.conflicts.slice(0, 5)]
      : []),
    '',
  ].join('\n');

  return text(preamble + result.content);
}

async function handleInspect(args: Record<string, unknown>): Promise<CallToolResult> {
  const loaded = await loadInputs(args.files as string[], args.language as string | undefined);
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
      voiceClusters: c.speakerIds.length,
    })),
    languages: loaded.languages,
    span: {
      start: formatTimecode(loaded.scenes[0]?.start ?? 0),
      end: formatTimecode(last?.end ?? last?.start ?? 0),
    },
    coverage: loaded.coverageNotes,
    conflicts: loaded.conflicts,
    warnings: loaded.warnings,
  };
  return text(JSON.stringify(payload, null, 2));
}

async function handleSearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const language = args.language as string | undefined;
  const loaded = await loadInputs(args.files as string[], language);

  const results = searchScreenplay(loaded.scenes, args.query as string, {
    scope: (args.scope as 'all' | 'dialogue' | 'action' | 'speaker') ?? 'all',
    allLanguages: !language,
    ...(language ? { language } : {}),
    characters: loaded.characters,
    limit: Number(args.limit ?? 50),
  });

  if (results.length === 0) return text('No matches.');

  const lines = results.map((r) =>
    JSON.stringify({
      time: formatTimecode(r.start),
      timeMs: r.start,
      kind: r.kind,
      speaker: r.characterName ?? null,
      language: r.language ?? null,
      text: r.snippet,
    }),
  );
  return text(`${results.length} match${results.length === 1 ? '' : 'es'}\n${lines.join('\n')}`);
}

async function handleParseSubtitles(args: Record<string, unknown>): Promise<CallToolResult> {
  const full = resolveWithinRoot(args.file as string);
  const content = await readFile(full, 'utf8').catch(() => {
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
          text: cue.text,
        })),
      },
      null,
      2,
    ),
  );
}

function handleCapabilities(): CallToolResult {
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
  shooting, or production screenplay, and should never be presented as one.`,
  );
}

// --- Wiring --------------------------------------------------------------------

const server = new Server(
  { name: 'framescript', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (request.params.name) {
      case 'framescript_build':
        return await handleBuild(args);
      case 'framescript_inspect':
        return await handleInspect(args);
      case 'framescript_search':
        return await handleSearch(args);
      case 'framescript_parse_subtitles':
        return await handleParseSubtitles(args);
      case 'framescript_capabilities':
        return handleCapabilities();
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (err) {
    // Surface the reason as tool output rather than a protocol error, so the
    // model can read it and correct course.
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
