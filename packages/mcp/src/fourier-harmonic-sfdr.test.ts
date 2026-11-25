import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { createMcpServer } from './index.js';
import { executeTool, MCP_TOOLS } from './server.js';

// Exact edge cases use controlled Fourier rows; real Fourier and transient tests remain unmocked.
const injected = vi.hoisted(() => ({ magnitudes: null as number[] | null }));
vi.mock('@spice-ts/core', async importOriginal => {
  const original = await importOriginal<typeof import('@spice-ts/core')>();
  return { ...original, ngspiceFourier: (...args: Parameters<typeof original.ngspiceFourier>) => {
    const result = original.ngspiceFourier(...args);
    if (injected.magnitudes) result.harmonics.forEach((row, i) => { row.magnitude = injected.magnitudes![i] ?? row.magnitude; });
    return result;
  } };
});

const request = { apiVersion: '1', input: { format: 'spice', source: '* probe\nV1 out 0 SIN(0 1 1k)\nR1 out 0 1k\n.tran 1u 5m\n.end' } };
const args = { request, signal: 'v(out)', fundamentalHz: 1000 };
function samples(): SimulationResultV1 {
  const timeS = Array.from({ length: 5001 }, (_, i) => i * 1e-6);
  const y = timeS.map(t => Math.sin(2 * Math.PI * 1000 * t) + 0.1 * Math.sin(2 * Math.PI * 2000 * t) + 0.01 * Math.sin(2 * Math.PI * 3000 * t));
  return { status: 'complete', analyses: [{ type: 'tran', analysisIndex: 0, timeS, voltagesV: { out: y }, currentsA: { V1: y.map(v => -v) } }] };
}

describe('harmonic-limited SFDR', () => {
  afterEach(() => { injected.magnitudes = null; });
  it('reports the largest harmonic and its ratio to the fundamental', async () => {
    const response = await executeTool('spice_fourier', { ...args, harmonicCount: 3, includeHarmonicSfdr: true }, { simulate: async () => samples() });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ harmonicSfdr: { harmonic: 2, dBc: expect.closeTo(20, 2), reason: null } });
  });

  it('leaves the response unchanged when absent or false', async () => {
    const simulate = async () => samples();
    const absent = await executeTool('spice_fourier', args, { simulate });
    const disabled = await executeTool('spice_fourier', { ...args, includeHarmonicSfdr: false }, { simulate });
    expect(disabled.structuredContent).toEqual(absent.structuredContent);
    expect(absent.structuredContent).not.toHaveProperty('harmonicSfdr');
  });

  it('respects harmonicCount and supports current with dimensionless dBc', async () => {
    const simulate = async () => samples();
    const response = await executeTool('spice_fourier', { ...args, signal: 'i(V1)', harmonicCount: 2, includeHarmonicSfdr: true }, { simulate });
    expect(response.structuredContent).toMatchObject({ unit: 'A', harmonics: [expect.anything(), expect.anything()], harmonicSfdr: { harmonic: 2, dBc: expect.closeTo(20, 2), reason: null } });
    const single = await executeTool('spice_fourier', { ...args, harmonicCount: 1, includeHarmonicSfdr: true }, { simulate });
    expect(single.structuredContent).toMatchObject({ harmonicSfdr: { harmonic: null, dBc: null, reason: 'NO_NONFUNDAMENTAL_HARMONIC' } });
  });

  it('handles zero, nonrepresentable ratios, negative dBc and exact ties', async () => {
    const simulate = async () => samples();
    const run = async (magnitudes: number[]) => {
      injected.magnitudes = magnitudes;
      const response = await executeTool('spice_fourier', { ...args, harmonicCount: 3, includeHarmonicSfdr: true }, { simulate });
      expect(response.isError).not.toBe(true);
      return (response.structuredContent as { harmonicSfdr: unknown }).harmonicSfdr;
    };
    expect(await run([0, 1, 0, 0])).toEqual({ harmonic: null, dBc: null, reason: 'ZERO_SPUR' });
    expect(await run([0, 1e308, 1e-308, 0])).toEqual({ harmonic: 2, dBc: null, reason: 'NONREPRESENTABLE_RATIO' });
    expect(await run([0, 1e-308, 1e308, 0])).toEqual({ harmonic: 2, dBc: null, reason: 'NONREPRESENTABLE_RATIO' });
    expect(await run([0, 1, -2, 2])).toEqual({ harmonic: 2, dBc: expect.closeTo(-6.020599913, 8), reason: null });
  });

  it('excludes a dominant third harmonic when only two harmonics are requested', async () => {
    injected.magnitudes = [0, 1, 0.1, 0.5];
    const simulate = async () => samples();
    const run = (harmonicCount: number) => executeTool('spice_fourier', { ...args, harmonicCount, includeHarmonicSfdr: true }, { simulate });
    expect((await run(3)).structuredContent).toMatchObject({ harmonicSfdr: { harmonic: 3, dBc: expect.closeTo(6.020599913, 8) } });
    expect((await run(2)).structuredContent).toMatchObject({ harmonicSfdr: { harmonic: 2, dBc: expect.closeTo(20, 8) } });
  });

  it('rejects non-booleans with a structured validation error', async () => {
    for (const value of ['true', 1, null]) {
      const response = await executeTool('spice_fourier', { ...args, includeHarmonicSfdr: value });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
    }
  });

  it('advertises and executes the schema over MCP on a real harmonic-mixture transient', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'sfdr-test', version: '1.0.0' });
    const deck = '* harmonic mixture\nV1 a 0 SIN(0 1 1k)\nV2 b a SIN(0 0.1 2k)\nV3 out b SIN(0 0.01 3k)\nR1 out 0 1k\n.tran 1u 5m 0 1u\n.end';
    const selected = { ...args, request: { apiVersion: '1', input: { format: 'spice', source: deck } }, harmonicCount: 3, includeHarmonicSfdr: true };
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_fourier')!;
      expect(tool.inputSchema.properties).toHaveProperty('includeHarmonicSfdr');
      const validator = new AjvJsonSchemaValidator();
      expect(validator.getValidator(tool.inputSchema)(selected).valid).toBe(true);
      const response = await client.callTool({ name: tool.name, arguments: selected });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
      expect(response.structuredContent).toMatchObject({ unit: 'V', harmonicSfdr: { harmonic: 2, dBc: expect.closeTo(20, 2), reason: null } });
      const bad = await client.callTool({ name: tool.name, arguments: { ...selected, includeHarmonicSfdr: 'true' } });
      expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      expect(MCP_TOOLS.find(t => t.name === tool.name)?.outputSchema).toEqual(tool.outputSchema);
    } finally { await client.close(); await server.close(); }
  });
});
