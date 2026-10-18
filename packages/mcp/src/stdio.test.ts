import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { SimulationRequestV1, SimulationResultV1 } from '@spice-ts/core/protocol';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

let transport: StdioClientTransport | undefined;

// Hang guard only (same policy as the examples, #411/#424): this test cold-starts
// `node --import tsx src/stdio.ts`, which already took 4.7-5.0 s of vitest's 5 s
// default on loaded CI runners under coverage. Loaded runners make it slower,
// never wrong; assertions are unchanged.
const STDIO_HANG_GUARD_MS = 60_000;

afterEach(async () => {
  await transport?.close();
  transport = undefined;
});

describe('stdio transport', () => {
  it('lists and invokes the deterministic tool surface', async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/stdio.ts'],
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'spice-ts-mcp-test', version: '1.0.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual([
      'spice_capabilities', 'spice_validate', 'spice_convert', 'spice_simulate', 'spice_sweep', 'spice_ac_metrics', 'spice_measure',
      'spice_compare', 'spice_simulation_start', 'spice_simulation_read', 'spice_simulation_cancel',
    ]);
    expect(listed.tools.every(tool => tool.inputSchema.type === 'object')).toBe(true);

    expect(await client.callTool({ name: 'spice_compare', arguments: {
      reference: { x: [0, 1], signals: { out: [0, 1] } },
      actual: { x: [0, 1], signals: { out: [0, 1] } }, signals: ['out'],
    } })).toMatchObject({ structuredContent: { pass: true, comparisons: [{ maxAbsError: 0 }] } });

    const response = await client.callTool({ name: 'spice_capabilities', arguments: {} });
    expect(response).toMatchObject({
      structuredContent: {
        protocolVersion: '1',
        streaming: {
          maxConcurrentJobs: 2,
          runningJobTtlMs: 30_000,
          terminalJobTtlMs: 300_000,
          maxUnreadEvents: 256,
          maxUnreadBytes: 1024 * 1024,
        },
      },
    });

    const request = JSON.parse(await readFile(
      fileURLToPath(new URL('../fixtures/simulate-request.json', import.meta.url)),
      'utf8',
    )) as SimulationRequestV1;
    const expected = JSON.parse(await readFile(
      fileURLToPath(new URL('../fixtures/simulate-response.json', import.meta.url)),
      'utf8',
    )) as SimulationResultV1;
    const simulation = await client.callTool({
      name: 'spice_simulate',
      arguments: { request },
    });
    expect(simulation.structuredContent).toEqual(expected);
    const measured = await client.callTool({
      name: 'spice_measure',
      arguments: { request, measurements: [{ kind: 'max', signal: 'v(b)', analysis: 0 }] },
    });
    expect(measured.isError).not.toBe(true);
    expect(measured.structuredContent).toEqual({ measurements: [{ value: 2, unit: 'V' }] });

    const started = await client.callTool({
      name: 'spice_simulation_start',
      arguments: { request },
    });
    const { jobId, cursor } = started.structuredContent as { jobId: string; cursor: string };
    let streamed = await client.callTool({
      name: 'spice_simulation_read',
      arguments: { jobId, cursor, maxPoints: 1 },
    });
    while ((streamed.structuredContent as { status?: string }).status === 'running'
      && (streamed.structuredContent as { events: unknown[] }).events.length === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      streamed = await client.callTool({
        name: 'spice_simulation_read',
        arguments: { jobId, cursor, maxPoints: 1 },
      });
    }
    expect(streamed.structuredContent).toMatchObject({
      status: 'complete',
      events: [
        { type: 'analysis-start', analysis: 'op', analysisIndex: 0 },
        { type: 'analysis-end', analysis: 'op', analysisIndex: 0, pointCount: 0 },
      ],
      nextCursor: null,
      terminal: { ok: true, requestId: jobId, data: expected },
    });

    const transientRequest: SimulationRequestV1 = {
      apiVersion: '1',
      input: {
        format: 'spice',
        source: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 3u',
      },
    };
    const transientStart = await client.callTool({
      name: 'spice_simulation_start', arguments: { request: transientRequest },
    });
    const transientJob = transientStart.structuredContent as { jobId: string; cursor: string };
    let first = await client.callTool({
      name: 'spice_simulation_read',
      arguments: { ...transientJob, maxPoints: 2 },
    });
    while ((first.structuredContent as { status?: string }).status === 'running'
      && (first.structuredContent as { events: unknown[] }).events.length === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
      first = await client.callTool({
        name: 'spice_simulation_read',
        arguments: { ...transientJob, maxPoints: 2 },
      });
    }
    const cancelled = await client.callTool({
      name: 'spice_simulation_cancel', arguments: { jobId: transientJob.jobId },
    });
    expect(first.structuredContent).toMatchObject({
      status: 'running',
      events: [
        { type: 'analysis-start', analysis: 'tran', analysisIndex: 0 },
        { type: 'point', analysisIndex: 0, pointIndex: 0 },
        { type: 'point', analysisIndex: 0, pointIndex: 1 },
      ],
    });
    expect(cancelled.structuredContent).toMatchObject({
      status: 'cancelled', nextCursor: null,
      terminal: {
        ok: false, requestId: transientJob.jobId,
        error: { code: 'CANCELLED' },
        partial: { status: 'partial', analyses: [{ emittedPointCount: 2, complete: false }] },
      },
    });

    const bounded = await client.callTool({
      name: 'spice_simulation_read',
      arguments: { ...transientJob, maxPoints: 1025 },
    });
    const malformed = await client.callTool({
      name: 'spice_simulation_read', arguments: { jobId: transientJob.jobId },
    });
    const rejectedStart = await client.callTool({
      name: 'spice_simulation_start',
      arguments: {
        request: { ...request, options: { limits: { maxResultPoints: 0 } } },
      },
    });
    expect(bounded).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxStreamChunkPoints' } } },
    });
    expect(malformed).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
    expect(rejectedStart).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } } },
    });
    expect(containsExactString([streamed, first, cancelled, bounded, malformed, rejectedStart], 'spice-ts')).toBe(false);
  }, STDIO_HANG_GUARD_MS);
});

function containsExactString(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some(entry => containsExactString(entry, target));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(entry => containsExactString(entry, target));
  }
  return false;
}
