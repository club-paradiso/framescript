/**
 * FrameScript CLI.
 *
 * The shebang is added by the build (see `vite.tools.config.ts`) rather than
 * written here, because esbuild treats a leading `#!` in a `.ts` source as a
 * syntax error.
 *
 * Runs the same reconstruction engine as the extension, over files you already
 * have. It exists so the engine is usable outside a browser — by a person at a
 * terminal, by the Claude Code skill, and by the MCP server.
 *
 * What it can do: build a screenplay from subtitle files, inspect and search a
 * FrameScript export, and convert between export formats.
 *
 * What it cannot do: anything requiring a live player. Maximum Quality and
 * audio/picture capture need the browser extension, because only an extension
 * can see a streaming site's player. The CLI says so rather than pretending.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
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
  type EvidenceEvent,
  type ExportFormat,
  type ExportMetadata,
  type ReconstructedScene,
  type CharacterEntity,
} from '../../src/core';

const EXPORT_FORMATS: ExportFormat[] = ['fountain', 'markdown', 'text', 'srt', 'json'];

interface Args {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal argument parsing; a dependency for this would not earn its place. */
function parseArgs(argv: readonly string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=');
    if (!name) continue;
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (rest[i + 1] && !rest[i + 1]!.startsWith('--')) {
      flags[name] = rest[++i]!;
    } else {
      flags[name] = true;
    }
  }
  return { command, positionals, flags };
}

const str = (flags: Args['flags'], key: string): string | undefined =>
  typeof flags[key] === 'string' ? (flags[key] as string) : undefined;

const bool = (flags: Args['flags'], key: string): boolean => flags[key] === true || flags[key] === 'true';

// --- Loading -------------------------------------------------------------------

interface LoadedScreenplay {
  scenes: ReconstructedScene[];
  characters: CharacterEntity[];
  languages: string[];
  metadata: ExportMetadata;
  coverageNotes: string[];
}

/**
 * Loads either a FrameScript JSON export or one-or-more subtitle files.
 *
 * Mixing both in one command is supported: a JSON export plus an extra
 * subtitle language is exactly how a second language gets added after the fact.
 */
async function load(paths: readonly string[], flags: Args['flags']): Promise<LoadedScreenplay> {
  if (paths.length === 0) throw new UserError('No input file given.');

  const evidence: EvidenceEvent[] = [];
  let jsonScenes: ReconstructedScene[] | null = null;
  let jsonCharacters: CharacterEntity[] = [];
  let metadata: ExportMetadata = {};
  let durationMs: number | undefined;

  for (const path of paths) {
    const content = await readFile(path, 'utf8').catch(() => {
      throw new UserError(`Cannot read ${path}`);
    });

    if (extname(path).toLowerCase() === '.json') {
      const parsed: unknown = JSON.parse(content);
      const record = parsed as {
        scenes?: ReconstructedScene[];
        characters?: CharacterEntity[];
        metadata?: ExportMetadata;
        format?: string;
      };

      // Accept both a FrameScript export and a stored screenplay record.
      const migrated = migrateScreenplay(parsed);
      if (migrated) {
        jsonScenes = migrated.record.scenes;
        jsonCharacters = migrated.record.characters;
        metadata = {
          ...(migrated.record.title ? { title: migrated.record.title } : {}),
          ...(migrated.record.seriesTitle ? { seriesTitle: migrated.record.seriesTitle } : {}),
          ...(migrated.record.season === undefined ? {} : { season: migrated.record.season }),
          ...(migrated.record.episode === undefined ? {} : { episode: migrated.record.episode }),
          ...(migrated.record.platform ? { platform: migrated.record.platform } : {}),
        };
        durationMs = migrated.record.coverage.durationMs;
      } else if (Array.isArray(record.scenes)) {
        jsonScenes = record.scenes;
        jsonCharacters = record.characters ?? [];
        metadata = record.metadata ?? {};
      } else {
        throw new UserError(`${path} is not a FrameScript export.`);
      }
      continue;
    }

    const result = parseSubtitleFile(content);
    if (result.cues.length === 0) {
      throw new UserError(
        `No subtitle cues found in ${path}. Detected format: ${result.format}.` +
          (result.warnings.length > 0 ? `\n  ${result.warnings.join('\n  ')}` : ''),
      );
    }
    for (const warning of result.warnings) process.stderr.write(`warning: ${path}: ${warning}\n`);

    // The file's own marker wins. `--language` selects the language to RENDER;
    // using it as the input language too would tag every file identically and
    // stop the same line in two languages from merging into one beat.
    const detected = languageFromFilename(basename(path));
    const language =
      detected !== 'und' ? detected : (str(flags, 'input-language') ?? str(flags, 'language') ?? 'en');
    evidence.push(
      ...cuesToEvidence(result.cues, {
        language,
        autoGenerated: bool(flags, 'auto-generated'),
        idPrefix: `sub-${basename(path)}`,
      }),
    );
    if (!metadata.title) metadata.title = basename(path, extname(path));
  }

  // A JSON export already contains scenes; subtitle files must be reconstructed.
  if (jsonScenes && evidence.length === 0) {
    return {
      scenes: jsonScenes,
      characters: jsonCharacters,
      languages: languagesOf(jsonScenes),
      metadata,
      coverageNotes: [],
    };
  }

  // Subtitle files are a complete source: the gaps between cues were observed,
  // they simply contained no dialogue.
  const sourceEnd = evidence.reduce((max, e) => Math.max(max, e.end ?? e.start), 0);
  const built = buildScreenplay(evidence, {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(str(flags, 'language') ? { language: str(flags, 'language')! } : {}),
    ...(sourceEnd > 0 ? { completeSourceRange: { start: 0, end: sourceEnd } } : {}),
    includeLowConfidence: bool(flags, 'include-low-confidence'),
  });

  return {
    scenes: jsonScenes ? [...jsonScenes, ...built.scenes] : built.scenes,
    characters: jsonCharacters.length > 0 ? jsonCharacters : built.characters,
    languages: built.languages,
    metadata,
    coverageNotes: built.coverage.notes,
  };
}

function languagesOf(scenes: readonly ReconstructedScene[]): string[] {
  const codes = new Set<string>();
  for (const scene of scenes) {
    for (const beat of scene.beats) {
      if (beat.type === 'dialogue') for (const code of Object.keys(beat.textVariants)) codes.add(code);
    }
  }
  return [...codes].filter((c) => c !== 'und');
}

// --- Commands ------------------------------------------------------------------

async function cmdBuild(args: Args): Promise<void> {
  const loaded = await load(args.positionals, args.flags);
  const language = str(args.flags, 'language') ?? loaded.languages[0] ?? 'en';
  const format = (str(args.flags, 'format') ?? 'fountain') as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) {
    throw new UserError(`Unknown format "${format}". Expected one of: ${EXPORT_FORMATS.join(', ')}`);
  }

  const document = renderScreenplay(loaded.scenes, {
    language,
    ...(str(args.flags, 'secondary-language')
      ? { secondaryLanguage: str(args.flags, 'secondary-language')! }
      : {}),
    characters: loaded.characters,
    fallbackLanguages: loaded.languages,
  });

  const result = exportScreenplay(
    document,
    { ...loaded.metadata, generatedAt: Date.now(), coverage: loaded.coverageNotes },
    {
      format,
      includeTimestamps: bool(args.flags, 'timestamps'),
      includeConfidence: bool(args.flags, 'confidence'),
      includeEvidenceRefs: bool(args.flags, 'evidence'),
      dialogueOnly: bool(args.flags, 'dialogue-only'),
      dualLanguage: Boolean(str(args.flags, 'secondary-language')),
    },
    { scenes: loaded.scenes, characters: loaded.characters },
  );

  const out = str(args.flags, 'out');
  if (out) {
    await writeFile(out, result.content, 'utf8');
    process.stderr.write(`Wrote ${out} (${result.content.length} bytes)\n`);
  } else {
    process.stdout.write(result.content);
  }
}

async function cmdInspect(args: Args): Promise<void> {
  const loaded = await load(args.positionals, args.flags);
  const counts = summarizeBeats(loaded.scenes);
  const last = loaded.scenes[loaded.scenes.length - 1];

  const lines = [
    `Title:        ${loaded.metadata.seriesTitle ?? loaded.metadata.title ?? '(untitled)'}`,
    `Scenes:       ${loaded.scenes.length}`,
    `Characters:   ${loaded.characters.length}`,
    `Languages:    ${loaded.languages.join(', ') || '(none)'}`,
    `Span:         ${formatTimecode(loaded.scenes[0]?.start ?? 0)} - ${formatTimecode(last?.end ?? last?.start ?? 0)}`,
    '',
    'Beats:',
    ...Object.entries(counts).map(([kind, count]) => `  ${kind.padEnd(16)} ${count}`),
  ];

  if (loaded.characters.length > 0) {
    lines.push('', 'Speakers:');
    for (const character of loaded.characters.slice(0, 20)) {
      lines.push(`  ${(character.displayName ?? character.id).padEnd(20)} ${character.lineCount} lines`);
    }
  }
  if (loaded.coverageNotes.length > 0) lines.push('', ...loaded.coverageNotes);

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function cmdSearch(args: Args): Promise<void> {
  const [query, ...paths] = [args.positionals[args.positionals.length - 1], ...args.positionals.slice(0, -1)];
  if (!query || paths.length === 0) {
    throw new UserError('Usage: framescript search <file...> <query>');
  }

  const loaded = await load(paths, args.flags);
  const results = searchScreenplay(loaded.scenes, query, {
    scope: (str(args.flags, 'scope') ?? 'all') as 'all' | 'dialogue' | 'action' | 'speaker',
    allLanguages: !str(args.flags, 'language'),
    ...(str(args.flags, 'language') ? { language: str(args.flags, 'language')! } : {}),
    characters: loaded.characters,
    limit: Number(str(args.flags, 'limit') ?? 50),
  });

  if (results.length === 0) {
    process.stdout.write('No matches.\n');
    return;
  }
  for (const result of results) {
    const who = result.characterName ? `${result.characterName}: ` : '';
    const lang = result.language ? ` [${result.language}]` : '';
    process.stdout.write(`${formatTimecode(result.start).padStart(8)}  ${who}${result.snippet}${lang}\n`);
  }
  process.stderr.write(`\n${results.length} match${results.length === 1 ? '' : 'es'}\n`);
}

function cmdHelp(): void {
  process.stdout.write(`FrameScript CLI — reconstruct and work with screenplays offline.

USAGE
  framescript <command> [files...] [options]

COMMANDS
  build <files...>          Build a screenplay and write it in an export format
  inspect <files...>        Summarize a screenplay: scenes, beats, speakers, coverage
  search <files...> <query> Search dialogue and action
  help                      Show this help

INPUTS
  .srt / .vtt               Subtitle files. Several may be given, including the
                            same content in different languages.
  .json                     A FrameScript export or saved screenplay.

OPTIONS
  --language <code>         Script language to render (default: first with dialogue)
  --input-language <code>   Language of input files whose name has no marker
  --secondary-language <c>  Render a second language alongside dialogue
  --format <f>              ${EXPORT_FORMATS.join(' | ')}   (default: fountain)
  --out <path>              Write to a file instead of stdout
  --timestamps              Include timestamps
  --confidence              Include confidence levels
  --evidence                Include evidence source references
  --dialogue-only           Drop action, sound and on-screen text
  --auto-generated          Treat subtitle input as machine transcription
  --include-low-confidence  Include beats resting only on weak inference
  --scope <s>               search only: all | dialogue | action | speaker
  --limit <n>               search only: maximum results (default 50)

EXAMPLES
  framescript build episode.en.srt --format fountain --out episode.fountain
  framescript build episode.en.srt episode.ko.srt --language ko --secondary-language en
  framescript inspect saved-screenplay.json
  framescript search episode.en.srt "where are you"

NOTE
  Maximum Quality and audio/picture analysis require the browser extension —
  only an extension can see a streaming site's player. This CLI works on files.
`);
}

class UserError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'build':
      await cmdBuild(args);
      break;
    case 'inspect':
      await cmdInspect(args);
      break;
    case 'search':
      await cmdSearch(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n`);
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  // User errors get a plain message; anything else is a bug and says so.
  if (err instanceof UserError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`FrameScript failed unexpectedly: ${String(err)}\n`);
  process.exitCode = 2;
});
