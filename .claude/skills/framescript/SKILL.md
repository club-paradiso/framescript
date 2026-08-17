---
name: framescript
description: Reconstruct, inspect, search and convert screenplays from subtitle files (.srt/.vtt) and FrameScript exports (.json) using the FrameScript engine. Use when the user wants to turn subtitles into a screenplay, merge subtitle languages into one dual-language script, convert between Fountain/Markdown/SRT/JSON, search dialogue or action by text or speaker, summarize who speaks and how much, or check a screenplay's analysis coverage. Also use to answer what FrameScript can and cannot do. Triggers on "subtitle to screenplay", "srt to fountain", "make a screenplay from", "dual language script", "search the dialogue", "who speaks the most", ".srt", ".vtt", "fountain", "framescript".
---

# FrameScript

Reconstructs screenplays from subtitle files and works with FrameScript exports.

## Before anything else: what this can and cannot do

**Can**, on files the user already has:

- Build a screenplay from `.srt` / `.vtt`, with speaker attribution, sound beats from bracketed captions, and scene grouping
- Merge several language tracks into one screenplay with per-language dialogue variants
- Inspect: scene and beat counts, speakers and line counts, languages, time span, coverage
- Search dialogue and action, across every language present
- Convert to Fountain, Markdown, plain text, SRT, JSON

**Cannot**, at all, from here:

- Change YouTube or Netflix playback quality
- Capture or analyse audio or video from a streaming site
- Read a live player's subtitles
- Perform speech recognition or describe what is visible in a picture

Those need the **FrameScript browser extension**, because only an extension can
see a streaming site's player. If the user asks for them, say so plainly and
point at the extension rather than approximating.

## Setup

The CLI is built from this repository:

```bash
npm install && npm run build:tools
```

Then invoke it as `node dist-tools/cli.js <command>`.

## Commands

```bash
# Build a screenplay (Fountain by default; writes to stdout without --out)
node dist-tools/cli.js build episode.en.srt --format fountain --out episode.fountain

# Merge two languages into one dual-language screenplay
node dist-tools/cli.js build episode.en.srt episode.ko.srt \
  --language ko --secondary-language en --format markdown

# Summarize: scenes, beats by type, speakers, languages, coverage
node dist-tools/cli.js inspect episode.en.srt

# Search dialogue and action (query goes LAST)
node dist-tools/cli.js search episode.en.srt "where are you"
node dist-tools/cli.js search episode.en.srt --scope speaker "JIYEON"

# Convert an existing FrameScript export
node dist-tools/cli.js build saved.json --format srt --out subtitles.srt
```

### Options worth knowing

| Option | Effect |
| --- | --- |
| `--language <code>` | Language to **render**. Does not change how inputs are read. |
| `--input-language <code>` | Language of input files whose *filename* has no marker. |
| `--secondary-language <code>` | Show a second language under each dialogue line. |
| `--format` | `fountain` \| `markdown` \| `text` \| `srt` \| `json` |
| `--timestamps`, `--confidence`, `--evidence` | Annotate output |
| `--dialogue-only` | Drop action, sound and on-screen text |
| `--auto-generated` | Treat input as machine transcription (lowers its confidence) |

## Language detection matters

Input language is taken from the **filename**: `episode.ko.srt` → Korean,
`episode_en.vtt` → English. This is what lets the same line in two languages
merge into one beat with two variants.

If filenames carry no marker, pass `--input-language`. Do **not** use
`--language` for this — it selects the render language, and using it for input
would tag every file identically and prevent merging.

When a name has no marker and none is supplied, the language is `en`.

## Reading the output honestly

The engine is built to state what it actually knows, and you should preserve
that when summarizing for the user:

- **Coverage** — `inspect` reports what fraction of the span had evidence. For a
  complete subtitle file this is 100%; for a FrameScript export from a partly
  watched film it will be lower, and the gaps are real gaps where nothing was
  reconstructed. Never describe a gap as if it had been analysed.
- **Speaker names** come only from subtitle labels (`JANE: ...`) or from the
  user. Unnamed speakers appear as `SPEAKER 2`. Do not invent names.
- **Bracketed captions** (`[door slams]`) become sound beats, not dialogue.
- **Every export carries a notice** saying it is a reconstruction, not an
  original or production screenplay. Keep it; do not strip it when quoting.

## Typical workflows

**"Turn these subtitles into a screenplay"**
1. `inspect` first, to see what is actually in the file and report it back
2. `build --format fountain --out <name>.fountain`
3. Tell the user the speaker count and coverage from step 1

**"Make a Korean/English study script"**
```bash
node dist-tools/cli.js build show.ko.srt show.en.srt \
  --language ko --secondary-language en --format markdown --out study.md
```

**"Who talks the most?"**
`inspect` — the speaker table is sorted by appearance and lists line counts.

**"Find every mention of X"**
`search <files...> "X"` — searches all languages by default and reports the
timecode, speaker and language of each match.

## MCP alternative

The same capabilities are available as an MCP server (`npm run mcp`, or
`dist-tools/mcp.js`) with tools `framescript_build`, `framescript_inspect`,
`framescript_search`, `framescript_parse_subtitles` and
`framescript_capabilities`. Prefer the MCP server when the client supports it;
prefer the CLI when you need to write files, since the MCP server reads only.

See `docs/INTEGRATIONS.md` for client configuration.
