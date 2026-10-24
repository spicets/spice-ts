import { describe, expect, it } from 'vitest';
import { parseTitleless, simulate } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';

// Original fixtures, MIT (spice-ts contributors). No third-party circuit content.
const rc = 'V1 in 0 dc 0 ac 1\nR1 in out 1k\nC1 out 0 1u\n.end';
const rlc = 'V1 in 0 dc 0 ac 1\nR1 in mid 100\nL1 mid out 10m\nC1 out 0 1u\n.end';
interface Complex { real: number; imaginary: number }
interface Entry { device: string; parameter: string; value: number; absolute: Complex; normalised: Complex; parameterUnit: string; absoluteUnit: string }
interface Result { schemaVersion: string; analysis: string; output: string; outputUnit: string; points: { frequency: number; entries: Entry[] }[] }
const sweep = { type: 'dec', points: 1, fstart: 10, fstop: 1000 };
async function run(netlist = rc, extra = {}) {
  const response = await executeTool('spice_sensitivity', { netlist, output: 'v(out)', analysis: 'ac', sweep, ...extra });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  const schema = MCP_TOOLS.find(t => t.name === 'spice_sensitivity')!.outputSchema!;
  expect(new AjvJsonSchemaValidator().getValidator(schema)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as Result;
}
function relative(actual: number, expected: number, tolerance = 1e-12) {
  if (expected === 0) expect(actual).toBe(0);
  else expect(Math.abs(actual / expected - 1)).toBeLessThan(tolerance);
}
describe('spice_sensitivity AC', () => {
  it.each([['RC', rc], ['RLC', rlc]])('matches core complex derivatives on %s at 1e-12 relative', async (_name, netlist) => {
    const result = await run(netlist, { top: 100 });
    expect(result).toMatchObject({ schemaVersion: '1', analysis: 'ac', output: 'v(out)', outputUnit: 'V' });
    const core = (await simulate(parseTitleless(netlist.replace('.end', '.sens v(out) ac dec 1 10 1000\n.end')))).sensitivity!;
    expect(result.points.map(p => p.frequency)).toEqual(core.frequencies);
    for (const [i, point] of result.points.entries()) {
      expect(point.entries).toHaveLength(core.entries.length);
      for (const entry of point.entries) {
        const native = core.entries.find(e => e.device === entry.device && e.parameter === entry.parameter)!;
        expect(entry.value).toBe(native.value);
        for (const component of ['real', 'imaginary'] as const) {
          relative(entry.absolute[component], native.ac![i]![component]);
          expect(entry.normalised[component]).toBe(entry.value * entry.absolute[component]);
        }
      }
    }
  });
  it('matches analytic RC magnitude derivatives at three frequencies within 1e-6 relative', async () => {
    const result = await run();
    expect(result.points).toHaveLength(3);
    for (const point of result.points) {
      const w = 2 * Math.PI * point.frequency;
      const x = w * 1000 * 1e-6;
      const h = { real: 1 / (1 + x * x), imaginary: -x / (1 + x * x) };
      for (const [device, parameter, value, unit] of [['R1', 'resistance', 1000, 'ohm'], ['C1', 'capacitance', 1e-6, 'F']] as const) {
        const entry = point.entries.find(e => e.device === device && e.parameter === parameter)!;
        const derivative = (h.real * entry.absolute.real + h.imaginary * entry.absolute.imaginary) / Math.hypot(h.real, h.imaginary);
        const analytic = -x * x / (value * (1 + x * x) ** 1.5);
        relative(derivative, analytic, 1e-6);
        expect(entry).toMatchObject({ parameterUnit: unit, absoluteUnit: `V/${unit}` });
      }
    }
  });
  it('ranks independently per frequency and applies top deterministically', async () => {
    const all = await run(rlc);
    const top = await run(rlc, { top: 2 });
    for (const [i, point] of all.points.entries()) {
      expect(top.points[i]!.entries).toEqual(point.entries.slice(0, 2));
      expect(point.entries).toEqual([...point.entries].sort((a, b) => Math.hypot(b.normalised.real, b.normalised.imaginary) - Math.hypot(a.normalised.real, a.normalised.imaginary)
        || (a.device < b.device ? -1 : a.device > b.device ? 1 : a.parameter < b.parameter ? -1 : a.parameter > b.parameter ? 1 : 0)));
    }
    expect(await run(rlc)).toEqual(all);
  });
  it.each(['lin', 'oct'])('supports %s sweep and current output', async type => {
    const result = await run(rc, { output: 'i(v1)', sweep: { type, points: 2, fstart: 10, fstop: 20 } });
    expect(result.outputUnit).toBe('A');
    const core = (await simulate(parseTitleless(rc.replace('.end', `.sens i(v1) ac ${type} 2 10 20\n.end`)))).sensitivity!;
    expect(result.points.map(p => p.frequency)).toEqual(core.frequencies);
    expect(result.points[0]!.entries.every(e => e.absoluteUnit.startsWith('A/'))).toBe(true);
  });
  it.each([undefined, null, [], {}, { ...sweep, type: 'bad' }, { ...sweep, points: 0 }, { ...sweep, points: 1.5 }, { ...sweep, points: 10001 }, { ...sweep, fstart: 0 }, { ...sweep, fstart: -1 }, { ...sweep, fstop: 1 }, { ...sweep, fstop: Infinity }, { ...sweep, fstart: NaN }, { ...sweep, extra: true }, { ...sweep, fstop: '1000' }])('rejects malformed sweep %j with INVALID_REQUEST', async invalidSweep => {
    const response = await executeTool('spice_sensitivity', { netlist: rc, output: 'v(out)', analysis: 'ac', sweep: invalidSweep });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } });
  });
  it('rejects sweeps for DC and counts every AC entry against result limits', async () => {
    expect((await executeTool('spice_sensitivity', { netlist: rc, output: 'v(out)', sweep })).structuredContent)
      .toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    const response = await executeTool('spice_sensitivity', { netlist: rc, output: 'v(out)', analysis: 'ac', sweep }, { limits: { ...DEFAULT_MCP_LIMITS, maxResultPoints: 10 } });
    expect(response.structuredContent).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
  });
});
