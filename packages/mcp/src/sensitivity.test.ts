import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';

// Original MIT-licensed analytic divider; also used verbatim by the ngspice cross-check.
const divider = readFileSync(new URL('../fixtures/sensitivity-divider.cir', import.meta.url), 'utf8');
interface Entry { device: string; parameter: string; value: number; absolute: number; normalised: number; parameterUnit: string; absoluteUnit: string }
interface Result { output: string; analysis: string; outputUnit: string; entries: Entry[] }
async function run(extra = {}) {
  const response = await executeTool('spice_sensitivity', { netlist: divider, output: 'v(out)', ...extra });
  expect(response.isError).not.toBe(true);
  const tool = MCP_TOOLS.find(t => t.name === 'spice_sensitivity')!;
  expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as Result;
}

describe('spice_sensitivity', () => {
  it('returns analytic divider sensitivities within 1e-9 relative', async () => {
    const result = await run();
    expect(result).toMatchObject({ analysis: 'dc', output: 'v(out)', outputUnit: 'V' });
    for (const [device, parameter, expected, value, unit] of [
      ['R1', 'resistance', -2 / 9000, 1000, 'ohm'],
      ['R2', 'resistance', 1 / 9000, 2000, 'ohm'],
      ['V1', 'dc', 2 / 3, 1, 'V'],
    ] as const) {
      const entry = result.entries.find(e => e.device === device && e.parameter === parameter)!;
      expect(Math.abs(entry.absolute / expected - 1)).toBeLessThan(1e-9);
      expect(entry.normalised).toBe(entry.value * entry.absolute);
      expect(entry).toMatchObject({ value, parameterUnit: unit, absoluteUnit: `V/${unit}` });
    }
  });

  it('ranks by absolute normalised sensitivity and applies top deterministically', async () => {
    const all = await run();
    const top = await run({ top: 2 });
    expect(all.entries).toHaveLength(7);
    expect(top.entries).toEqual(all.entries.slice(0, 2));
    expect(all.entries[0]).toMatchObject({ device: 'V1', parameter: 'dc' });
    for (let i = 1; i < all.entries.length; i++) {
      expect(Math.abs(all.entries[i - 1]!.normalised)).toBeGreaterThanOrEqual(Math.abs(all.entries[i]!.normalised));
    }
    expect(await run()).toEqual(all);
  });

  it('supports differential voltage and voltage-source branch current outputs', async () => {
    const differential = await run({ output: 'v(in,out)' });
    const current = await run({ output: 'i(v1)' });
    expect(differential.entries.find(e => e.device === 'V1')!.absolute).toBeCloseTo(1 / 3, 9);
    expect(current.outputUnit).toBe('A');
    expect(current.entries.find(e => e.device === 'V1')!.absolute).toBeCloseTo(-1 / 3000, 12);
  });

  it.each([
    { output: 'v(missing)' }, { output: 'v(out)\n.tran 1 2' }, { output: 'i(R1)' },
    { output: 'garbage' }, { netlist: 'not a circuit\nR1 out 0 invalid\n.end' },
    { top: 0 }, { top: 1.5 }, { top: 10001 }, { analysis: 'tran' }, { surprise: true },
  ])('returns the standard structured error for invalid input %j', async extra => {
    const response = await executeTool('spice_sensitivity', { netlist: divider, output: 'v(out)', ...extra });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: expect.any(String), message: expect.any(String), phase: expect.any(String) } });
    expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual(response.structuredContent);
  });

  it('advertises the tool and its DC/AC analyses in capabilities', async () => {
    const response = await executeTool('spice_capabilities', {});
    expect(response.structuredContent).toMatchObject({ sensitivity: { tool: 'spice_sensitivity', analyses: ['dc', 'ac'] } });
  });

  it('rejects stepped/control decks and replaces other deck analyses without executing them', async () => {
    for (const source of [
      divider.replace('.sens V(out)', '.step R1 list 1k 2k'),
      divider.replace('.sens V(out)', '.control\nop\n.endc'),
      divider.replace('.sens V(out)', '.pz out 0 in 0 vol pol'),
    ]) {
      const response = await executeTool('spice_sensitivity', { netlist: source, output: 'v(out)' });
      expect(response.isError).toBe(true);
    }
    expect(await run({ netlist: divider.replace('.sens V(out)', '.tran 1p 1000') })).toEqual(await run());
  });

  it('enforces document/result limits and cancellation through the bounded worker', async () => {
    const args = { netlist: divider, output: 'v(out)' };
    for (const limits of [{ maxDocumentBytes: 1 }, { maxResultPoints: 1 }, { maxSerializedResultBytes: 1 }]) {
      const response = await executeTool('spice_sensitivity', args, { limits: { ...DEFAULT_MCP_LIMITS, ...limits } });
      expect(response.structuredContent).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    }
    const controller = new AbortController(); controller.abort();
    expect((await executeTool('spice_sensitivity', args, { signal: controller.signal })).structuredContent)
      .toMatchObject({ error: { code: 'CANCELLED' } });
  });
});
