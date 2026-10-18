import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
const directory = new URL('.', import.meta.url);
const serverArgument = process.argv.indexOf('--server');
if (serverArgument < 0 || !process.argv[serverArgument + 1]) {
  throw new Error('Usage: node workflow.mjs --server /absolute/path/to/@spice-ts/mcp/dist/stdio.js');
}

const client = new StdioClient(resolve(process.argv[serverArgument + 1]));
const floatingRequest = JSON.parse(await readFile(new URL('./floating-request.json', directory), 'utf8'));
const singularRequest = JSON.parse(await readFile(new URL('./singular-request.json', directory), 'utf8'));
const suggestion = 'Add a resistor from sense to ground to provide a DC reference path.';

try {
  await client.connect();

  const listed = await client.call('tools/list', {});
  const toolNames = listed.tools.map(({ name }) => name);
  assert.deepEqual(toolNames, [
    'spice_capabilities',
    'spice_validate',
    'spice_convert',
    'spice_simulate',
    'spice_sweep',
    'spice_ac_metrics',
    'spice_measure',
    'spice_compare',
    'spice_simulation_start',
    'spice_simulation_read',
    'spice_simulation_cancel',
  ]);

  const validation = structured(await client.call('tools/call', {
    name: 'spice_validate',
    arguments: { request: floatingRequest },
  }));
  assert.equal(validation.status, 'valid');
  assert.equal(validation.diagnostics.length, 1);
  const invalid = validation.diagnostics[0];
  assert.deepEqual(invalid, {
    code: 'NO_DC_PATH_TO_GROUND',
    severity: 'warning',
    nodes: ['sense'],
    elements: ['C1', 'I1'],
    hint: 'Add a DC conductive path to node 0, for example a bias resistor.',
  });

  const repairedRequest = structuredClone(floatingRequest);
  repairedRequest.input.source = repairedRequest.input.source.replace(
    '\n.op',
    '\nRbleed sense 0 1Meg\n.op',
  );
  const repairedValidation = structured(await client.call('tools/call', {
    name: 'spice_validate',
    arguments: { request: repairedRequest },
  }));
  assert.deepEqual(repairedValidation, {
    status: 'valid', nodeCount: 2, branchCount: 1, analysisCount: 1,
  });

  const start = structured(await client.call('tools/call', {
    name: 'spice_simulation_start',
    arguments: { request: repairedRequest },
  }));
  assert.equal(start.status, 'running');
  const completed = await readToTerminal(client, start);
  const terminal = completed.terminal;
  assert.equal(terminal.ok, true);
  assert.equal(terminal.requestId, start.jobId);
  assert.deepEqual(terminal.data, {
    status: 'complete',
    analyses: [{
      type: 'op',
      analysisIndex: 0,
      voltagesV: { in: 1, sense: 1 },
      currentsA: { V1: 0 },
    }],
  });
  assert.equal(terminal.metadata.inputSha256, canonicalHash(repairedRequest.input));
  assert.equal(terminal.metadata.resultSha256, canonicalHash(terminal.data));
  assert.deepEqual({
    protocolVersion: terminal.metadata.protocolVersion,
    spiceTsVersion: terminal.metadata.spiceTsVersion,
    engineBuildId: terminal.metadata.engineBuildId,
    backend: terminal.metadata.backend,
    backendVersion: terminal.metadata.backendVersion,
    determinism: terminal.metadata.determinism,
  }, {
    protocolVersion: '1',
    spiceTsVersion: '0.3.0',
    engineBuildId: 'mcp-node-v1',
    backend: 'spice-ts-js',
    backendVersion: '0.3.0',
    determinism: 'strict',
  });

  const singularValidation = structured(await client.call('tools/call', {
    name: 'spice_validate',
    arguments: { request: singularRequest },
  }));
  assert.deepEqual(singularValidation, {
    status: 'valid', nodeCount: 2, branchCount: 3, analysisCount: 1,
  });
  const singular = publicFailure(await client.call('tools/call', {
    name: 'spice_simulate',
    arguments: { request: singularRequest },
  }), 'SINGULAR_MATRIX');
  assert.deepEqual(singular, {
    code: 'SINGULAR_MATRIX',
    message: 'Singular matrix: zero pivot at matrix column 4 (nodes: ; branches: Rshort2)',
    retryable: false,
    phase: 'solve',
    details: { involvedNodes: [], involvedBranches: ['Rshort2'], pivotIndex: 4 },
  });

  const internalBackendRequest = structuredClone(repairedRequest);
  internalBackendRequest.options.backend = 'spice-ts';
  const backendRejection = publicFailure(await client.call('tools/call', {
    name: 'spice_validate',
    arguments: { request: internalBackendRequest },
  }), 'BACKEND_UNAVAILABLE');
  assert.deepEqual(backendRejection, {
    code: 'BACKEND_UNAVAILABLE',
    message: 'The requested simulation backend is unavailable',
    retryable: false,
    phase: 'validation',
    details: {},
  });

  const report = {
    transport: 'stdio',
    callOrder: [
      'tools/list',
      'spice_validate:floating',
      'spice_validate:repaired',
      'spice_simulation_start:repaired',
      'spice_validate:solve-only-singular',
      'spice_simulate:solve-only-singular',
      'spice_validate:internal-backend',
    ],
    tools: toolNames,
    floatingNode: {
      requestSha256: canonicalHash(floatingRequest),
      diagnosis: invalid,
      suggestion,
      solvedBeforeRepair: false,
    },
    repair: {
      action: 'insert-resistor-to-ground-before-op',
      sourceLine: 'Rbleed sense 0 1Meg',
      repairedRequestSha256: canonicalHash(repairedRequest),
      validation: repairedValidation,
    },
    operatingPoint: {
      result: terminal.data,
      metadata: {
        protocolVersion: terminal.metadata.protocolVersion,
        spiceTsVersion: terminal.metadata.spiceTsVersion,
        engineBuildId: terminal.metadata.engineBuildId,
        backend: terminal.metadata.backend,
        backendVersion: terminal.metadata.backendVersion,
        determinism: terminal.metadata.determinism,
        inputSha256: terminal.metadata.inputSha256,
        resultSha256: terminal.metadata.resultSha256,
      },
    },
    solveOnlySingularity: {
      requestSha256: canonicalHash(singularRequest),
      validation: singularValidation,
      error: singular,
    },
    internalBackendRejection: backendRejection,
  };
  assert.equal(containsExactString(report, 'spice-ts'), false);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await client.close();
}
}

async function readToTerminal(clientInstance, start) {
  let cursor = start.cursor;
  for (;;) {
    const response = structured(await clientInstance.call('tools/call', {
      name: 'spice_simulation_read',
      arguments: { jobId: start.jobId, cursor, maxPoints: 1 },
    }));
    if (response.status === 'complete') return response;
    assert.equal(response.status, 'running');
    cursor = response.nextCursor;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
  }
}

function structured(response) {
  const value = record(response.structuredContent, 'structuredContent');
  const text = response.content?.[0];
  assert.equal(text?.type, 'text', 'tool response must include text content');
  assert.equal(text.text, JSON.stringify(value), 'text and structured tool content disagree');
  return value;
}

function publicFailure(response, code) {
  assert.equal(response.isError, true, `${code} response must fail`);
  const value = structured(response);
  assert.deepEqual(Object.keys(value), ['error']);
  const error = record(value.error, 'error');
  assert.equal(error.code, code);
  assert.deepEqual(Object.keys(error), ['code', 'message', 'retryable', 'phase', 'details']);
  return error;
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return Object.is(value, -0) ? 0 : value;
}

function containsExactString(value, needle) {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some(item => containsExactString(item, needle));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(item => containsExactString(item, needle));
  }
  return false;
}

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${name} to be an object`);
  }
  return value;
}

class StdioClient {
  constructor(serverPath) {
    this.serverPath = serverPath;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
  }

  async connect() {
    this.child = spawn(process.execPath, [this.serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    this.child.once('error', error => this.rejectAll(error));
    this.child.once('exit', (code, signal) => {
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`MCP server exited early (${code ?? signal}): ${this.stderr}`));
      }
    });
    await this.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'spice-ts-floating-node-repair-example', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  call(method, params) {
    const id = this.nextId++;
    // No per-request wall-clock deadline (#411): a loaded machine makes the
    // workflow slower, never wrong. A server that exits early rejects at once,
    // and the caller's process-level hang guard bounds a genuinely stuck server.
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const boundary = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, boundary).replace(/\r$/, '');
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) throw new Error(`Unexpected JSON-RPC response id: ${message.id}`);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`JSON-RPC ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise(resolvePromise => this.child.once('exit', resolvePromise));
    const forced = new Promise(resolvePromise => setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill();
      resolvePromise();
    }, 1_000));
    await Promise.race([exited, forced]);
  }
}

await main();
