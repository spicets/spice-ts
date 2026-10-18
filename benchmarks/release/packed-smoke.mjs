#!/usr/bin/env node
// Build first with pnpm -r build. Install tarballs outside the workspace; never publish.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const consumer = mkdtempSync(join(tmpdir(), 'release-packed-smoke-'));
const packs = join(consumer, 'packs');
mkdirSync(packs);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000 });
  if (result.status !== 0 || result.error) throw new Error(`${command}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
}
for (const name of ['core', 'mcp', 'wasm', 'ui', 'circuit-json']) {
  run('pnpm', ['pack', '--pack-destination', packs], join(root, 'packages', name));
}
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...readdirSync(packs).map(name => join(packs, name)), '@modelcontextprotocol/sdk@^1.32.1'], consumer);
writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { simulate } from '@spice-ts/core';
import { createRequire } from 'node:module';
import { canonicalJson, sha256, protocolSchemasV1 } from '@spice-ts/core/protocol';
assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
const bytes = new TextEncoder().encode('abc');
assert.equal(sha256(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
const require = createRequire(import.meta.url);
const protocolCjs = require('@spice-ts/core/protocol');
assert.equal(protocolCjs.sha256(bytes), sha256(bytes));
assert.deepEqual(require('@spice-ts/core/protocol/schemas/simulation-request.schema.json'), protocolSchemasV1['simulation-request']);
assert.ok(require('@spice-ts/core/protocol/fixtures/positive-v1.json').requests.spice);
assert.throws(() => require.resolve('@spice-ts/protocol'), { code: 'MODULE_NOT_FOUND' });
console.log('PASS packed core/protocol ESM, CommonJS, schemas and fixtures without standalone protocol');
import * as ui from '@spice-ts/ui';
import * as circuitJson from '@spice-ts/circuit-json';
import { createSpiceEngine } from '@spice-ts/wasm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const op = await simulate('* packaged divider\\nV1 in 0 1\\nR1 in out 1k\\nR2 out 0 1k\\n.op\\n.end');
assert.ok(Math.abs(op.dc.voltage('out') - 0.5) < 1e-9);
const tran = await simulate('* packaged RC\\nV1 in 0 PULSE(0 1 0 1n 1n 10m 20m)\\nR1 in out 1k\\nC1 out 0 1u\\n.tran 10u 5m\\n.end');
assert.ok(tran.transient.time.length > 100);
assert.ok(Math.abs(tran.transient.voltage('out').at(-1) - (1 - Math.exp(-5))) < 0.002);
assert.ok(Object.keys(ui).length > 0 && Object.keys(circuitJson).length > 0);
console.log('PASS packed core .op, RC .tran, UI and circuit-json imports');
const transport = new StdioClientTransport({ command: process.execPath, args: ['node_modules/@spice-ts/mcp/dist/stdio.js'] });
const client = new Client({ name: 'release-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('spice_simulate') && tools.includes('spice_convert') && tools.includes('spice_measure'));
  console.log('PASS packed MCP stdio tools/list:', tools.join(', '));
} finally { await client.close(); }
const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
const wasm = await engine.simulate({ apiVersion: '1', input: { format: 'spice', source: 'V1 in 0 AC 1\\nR1 in out 1k\\nC1 out 0 1u\\n.ac lin 1 100 100' } }, { requestId: 'release-smoke' });
assert.equal(wasm.ok, true);
assert.equal(wasm.metadata.backend, 'spice-ts-wasm');
const output = wasm.data.analyses[0].voltagePhasors.out[0];
assert.ok(Math.abs(output.magnitude - 0.8467330159648304) < 1e-12);
console.log('PASS packed WASM numeric kernel RC .ac');
`);
console.log(run(process.execPath, ['smoke.mjs'], consumer));
console.log(`Packed consumer retained at ${consumer}`);
