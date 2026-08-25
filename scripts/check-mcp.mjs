#!/usr/bin/env node
/**
 * Smoke-tests the MCP server over its real transport.
 *
 * Spawns `dist-tools/mcp.js`, performs the JSON-RPC handshake on stdio, lists
 * tools, calls one, and checks that the path sandbox refuses to escape the
 * working directory.
 *
 * This runs the actual protocol rather than importing the handlers, because the
 * things most likely to break — transport framing, tool schema shape, the
 * sandbox — only exist at that boundary.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = resolve(ROOT, 'dist-tools/mcp.js');
const FIXTURE = 'tests/fixtures/sample.en.srt';

if (!existsSync(SERVER)) {
  console.error('dist-tools/mcp.js not found — run `npm run build:tools` first.');
  process.exit(1);
}

const REQUESTS = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'framescript-ci', version: '1' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'framescript_inspect', arguments: { files: [FIXTURE] } },
  },
  {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    // Must be refused: an MCP server is model-driven, so escaping its working
    // directory is a real risk rather than a theoretical one.
    params: { name: 'framescript_inspect', arguments: { files: ['../../../../etc/passwd'] } },
  },
];

const EXPECTED_TOOLS = [
  'framescript_build',
  'framescript_inspect',
  'framescript_search',
  'framescript_parse_subtitles',
  'framescript_capabilities',
];

const child = spawn('node', [SERVER], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });

const responses = new Map();
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) responses.set(message.id, message);
    } catch {
      // Not a JSON-RPC frame; ignore.
    }
  }
});

for (const request of REQUESTS) child.stdin.write(`${JSON.stringify(request)}\n`);

const deadline = Date.now() + 30_000;
while (responses.size < 4 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
child.kill();

const failures = [];
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok    ${label}`);
  else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
};

console.log('MCP server smoke test');

const init = responses.get(1);
check('initialize responds', init?.result?.serverInfo?.name === 'framescript', JSON.stringify(init?.result?.serverInfo));

const list = responses.get(2);
const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
check('tools/list returns every tool', EXPECTED_TOOLS.every((n) => names.includes(n)), names.join(', '));
check(
  'every tool declares a description and schema',
  (list?.result?.tools ?? []).every((t) => t.description && t.inputSchema?.type === 'object'),
);

const inspect = responses.get(3);
let inspectPayload = null;
try {
  inspectPayload = JSON.parse(inspect?.result?.content?.[0]?.text ?? '{}');
} catch {
  /* handled below */
}
check('inspect returns structured JSON', inspectPayload !== null && typeof inspectPayload.scenes === 'number');
check('inspect reports speakers', Array.isArray(inspectPayload?.characters) && inspectPayload.characters.length > 0);
check('inspect reports coverage', Array.isArray(inspectPayload?.coverage));

const escape = responses.get(4);
check(
  'refuses to read outside the working directory',
  escape?.result?.isError === true && /Refusing to read outside/.test(escape?.result?.content?.[0]?.text ?? ''),
  escape?.result?.content?.[0]?.text,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} MCP check(s) failed.`);
  process.exit(1);
}
console.log('\nAll MCP checks passed.');
