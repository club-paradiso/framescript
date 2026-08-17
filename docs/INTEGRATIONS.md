# Integrations

FrameScript ships four surfaces over one engine:

| Surface | Runs where | Use it for |
| --- | --- | --- |
| **Browser extension** | Chrome, on YouTube/Netflix | Maximum Quality, and reconstruction while you watch |
| **Studio (web/mobile)** | Any modern browser, installable | Your own media files, and reading exports |
| **CLI** | Node 20+ | Scripting, batch conversion, terminal use |
| **MCP server** | Any MCP client (Codex, Claude Desktop…) | Letting a model work with screenplays |

The extension is the only one that can see a streaming site's player. The other
three work on files.

---

## CLI

```bash
npm install
npm run build:tools          # produces dist-tools/cli.js and dist-tools/mcp.js
node dist-tools/cli.js help
```

### Commands

```bash
# Subtitle file -> screenplay
node dist-tools/cli.js build episode.en.srt --format fountain --out episode.fountain

# Two languages -> one dual-language script
node dist-tools/cli.js build episode.en.srt episode.ko.srt \
  --language ko --secondary-language en --format markdown --out study.md

# Summary: scenes, beats, speakers, languages, coverage
node dist-tools/cli.js inspect episode.en.srt

# Search (the query goes last)
node dist-tools/cli.js search episode.en.srt episode.ko.srt "우유"

# Convert an existing export
node dist-tools/cli.js build saved.json --format srt --out subtitles.srt
```

### Language handling

Input language comes from the **filename**: `episode.ko.srt` → Korean. That is
what lets the same line in two languages merge into one beat with two variants.

`--language` selects the language to **render**, not how inputs are read. For a
file whose name carries no marker, use `--input-language`.

Installing globally (`npm link`) exposes `framescript` and `framescript-mcp`.

---

## MCP server (Codex, Claude Desktop, and other MCP clients)

### Tools

| Tool | Does |
| --- | --- |
| `framescript_build` | Reconstruct a screenplay and return it in a chosen format |
| `framescript_inspect` | Scene/beat counts, speakers, languages, span, coverage, conflicts |
| `framescript_search` | Search dialogue and action across all languages |
| `framescript_parse_subtitles` | Return raw cues with timings and any parse failures |
| `framescript_capabilities` | Describe what the server can and cannot do |

### Configuration

**Codex** — in `~/.codex/config.toml`:

```toml
[mcp_servers.framescript]
command = "node"
args = ["/absolute/path/to/framescript/dist-tools/mcp.js"]
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "framescript": {
      "command": "node",
      "args": ["/absolute/path/to/framescript/dist-tools/mcp.js"]
    }
  }
}
```

**Claude Code** — from the repository root:

```bash
claude mcp add framescript -- node "$PWD/dist-tools/mcp.js"
```

Run `npm run build:tools` first; the config points at build output.

### Behaviour worth knowing before you wire it up

- **Read-only.** The server never writes files. `framescript_build` returns the
  document as content and the client decides what to do with it — a model
  silently overwriting someone's screenplay is not a trade worth making.
- **Sandboxed to its working directory.** Paths outside the directory the
  server was started in are refused. Start it in the project you want it to see.
- **Uncertainty is in the response.** Coverage, source conflicts and unparseable
  blocks come back with the result rather than being smoothed away, because a
  model reading the output has no other way to know.

---

## Claude Code skill

`.claude/skills/framescript/SKILL.md` is picked up automatically when this
repository is open in Claude Code. It teaches the CLI's commands, the
input-vs-render language distinction, and — importantly — what to tell a user
who asks for something only the extension can do.

Invoke it by asking naturally ("turn these subtitles into a screenplay", "who
speaks the most", "make a Korean/English study script") or by name with
`/framescript`.

Use the **skill** when you want files written. Use the **MCP server** when you
want a model to read and reason without touching the filesystem.

---

## Studio (web / mobile)

```bash
npm run dev:web              # http://localhost:5173
npm run build:web            # static output in dist-web/
npm run preview:web
```

`dist-web/` is a static bundle — deploy it to any static host. It has no
backend, and none of the code paths it contains can reach one.

### What it does

- **Subtitle files** → screenplay, with speaker attribution, sound beats from
  bracketed captions, and multi-language merging
- **Your own media** → speech regions, speakers, sound events, silence (audio,
  analyzed in full offline) plus motion and scene changes (picture, observed
  during accelerated playback)
- **FrameScript exports** → read, search, re-render in another language, convert

### Installing on a phone

It is a PWA: open it in the mobile browser and use "Add to Home Screen". It then
runs offline, since all the work is local anyway.

**iOS caveat:** Safari's media codec support is narrower than Chrome's, so some
containers will not decode for analysis. Subtitle files and exports work
everywhere.

### What it cannot do, and why

Studio cannot analyze YouTube or Netflix, and cannot change their playback
quality. A web page has no way to observe or control another site's player;
that is what an extension is for. The app says this on its first screen rather
than letting a user discover it by failing.

Use the extension while watching, then open its export in Studio.

---

## One engine, four surfaces

All four import from `src/core` — the same timeline, fusion, scene builder,
renderer and exporters. There is no second implementation to drift.

```
src/core ──┬── extension  (src/background, src/content, src/offscreen, UI)
           ├── studio     (web/)
           ├── cli        (tools/cli)
           └── mcp        (tools/mcp)
```

The consequence worth stating: a fix to speaker attribution or scene boundary
scoring lands in all four at once, and the 433 unit tests cover the engine for
every one of them.
