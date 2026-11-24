import { describe, expect, it } from 'vitest';
import { impedanceArgs, impedanceReport } from './impedance.js';
import { executeTool, MCP_TOOLS } from './server.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const port = { positive: 'in', negative: '0' };
const run = (phases: number[], levels: number[], direction = 'either') => impedanceReport({
  frequencyHz: [10, 20, 30].slice(0, phases.length),
  positive: phases.map(phaseDegrees => ({ magnitude: 1, phaseDegrees })),
  negative: phases.map(() => ({ magnitude: 0, phaseDegrees: 0 })),
}, impedanceArgs({ port, sweep: { variation: 'lin', points: 3, startFreq: 10, stopFreq: 30 }, phaseLevelsDeg: levels, phaseCrossingDirection: direction }));

describe('sampled phase crossings', () => {
  it('unwraps across the phase boundary and returns the first interpolated level', () => {
    expect(run([170, -170, -150], [180, 0, 190]).phaseCrossings).toEqual([
      { phaseDeg: 180, frequencyHz: 15 }, { phaseDeg: 0, frequencyHz: null }, { phaseDeg: 190, frequencyHz: 20 },
    ]);
  });
});

const synthetic = (frequencies: number[], phases: (number | null)[], levels: number[], direction = 'either', variation = 'lin') => impedanceReport({
  frequencyHz: frequencies,
  positive: phases.map(phase => ({ magnitude: phase === null ? 0 : 1, phaseDegrees: phase ?? 0 })),
  negative: phases.map(() => ({ magnitude: 0, phaseDegrees: 0 })),
}, impedanceArgs({ port, sweep: { variation, points: 3, startFreq: 1, stopFreq: 100 }, phaseLevelsDeg: levels, phaseCrossingDirection: direction }));

describe('direction, coordinates and validation', () => {
  it('filters direction in traversal order including descending grids', () => {
    for (const f of [[10, 20, 30], [30, 20, 10]]) {
      expect(synthetic(f, [-30, 30, -30], [0], 'rising').phaseCrossings![0].frequencyHz).toBeCloseTo((f[0] + f[1]) / 2, 10);
      expect(synthetic(f, [-30, 30, -30], [0], 'falling').phaseCrossings![0].frequencyHz).toBeCloseTo((f[1] + f[2]) / 2, 10);
      expect(synthetic(f, [-30, 30, -30], [0]).phaseCrossings![0].frequencyHz).toBeCloseTo((f[0] + f[1]) / 2, 10);
    }
  });
  it('unwraps falling through the negative boundary', () => {
    const result = synthetic([30, 20, 10], [-170, 170, 150], [-180, 0], 'falling').phaseCrossings!;
    expect(result[0].frequencyHz).toBeCloseTo(25, 10);
    expect(result[1].frequencyHz).toBeNull();
  });
  it('accepts 128 levels while preserving order', () => {
    const levels = Array.from({ length: 128 }, (_, i) => i - 64);
    expect(synthetic([10, 20], [-90, 90], levels).phaseCrossings!.map(v => v.phaseDeg)).toEqual(levels);
  });
  it('interpolates log coordinate without extrapolation', () => {
    const r = synthetic([10, 100], [-30, 30], [0, 80], 'either', 'dec').phaseCrossings!;
    expect(r[0].frequencyHz).toBeCloseTo(Math.sqrt(1000), 10);
    expect(r[1].frequencyHz).toBeNull();
    expect(synthetic([10, 100], [-30, 30], [0], 'either', 'oct').phaseCrossings![0].frequencyHz).toBeCloseTo(Math.sqrt(1000), 10);
  });
  it('handles exact endpoints, plateaus and directional starts', () => {
    expect(synthetic([10, 20, 30], [0, 0, 30], [0]).phaseCrossings![0].frequencyHz).toBe(10);
    expect(synthetic([10, 20, 30], [0, 0, 30], [0], 'rising').phaseCrossings![0].frequencyHz).toBe(10);
    expect(synthetic([10, 20, 30], [-30, 0, 0], [0], 'rising').phaseCrossings![0].frequencyHz).toBe(20);
    expect(synthetic([10, 20, 30], [0, 0, 0], [0], 'falling').phaseCrossings![0].frequencyHz).toBeNull();
  });
  it('does not bridge undefined zero impedance', () => {
    expect(synthetic([10, 20, 30], [-30, null, 30], [0]).phaseCrossings).toEqual([{ phaseDeg: 0, frequencyHz: null, reason: 'undefined_phase' }]);
  });
  it.each([null, [], [NaN], [Infinity], [-Infinity], ['0'], Array(129).fill(0)])('rejects invalid phase levels %s', levels => {
    expect(() => impedanceArgs({ port, phaseLevelsDeg: levels })).toThrowError();
  });
  it('rejects invalid directions', () => {
    expect(() => impedanceArgs({ port, phaseLevelsDeg: [0], phaseCrossingDirection: 'up' })).toThrowError();
  });
});

const tool = MCP_TOOLS.find(t => t.name === 'spice_impedance')!;
const valid = (schema: object, value: unknown) => new AjvJsonSchemaValidator().getValidator(schema)(value).valid;
const circuit = (device: string) => ({ apiVersion: '1', input: { format: 'spice', source: `* impedance
R1 in a 100
${device}
.ac dec 20 100 10000
.end` } });

describe('spice_impedance phase API', () => {
  it.each([{ device: 'C1 a 0 1u', level: -45 }, { device: 'L1 a 0 100m', level: 45 }])('finds analytic 45-degree crossing for $device', async ({ device, level }) => {
    const args = { request: circuit(device), port, phaseLevelsDeg: [level, 999, level] };
    expect(valid(tool.inputSchema, args)).toBe(true);
    const response = await executeTool('spice_impedance', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(valid(tool.outputSchema!, response.structuredContent)).toBe(true);
    const r = response.structuredContent as { phaseCrossings: { phaseDeg: number; frequencyHz: number | null }[] };
    expect(r.phaseCrossings[0].frequencyHz).toBeCloseTo((device.startsWith('C') ? 1 / (2 * Math.PI * 100 * 1e-6) : 100 / (2 * Math.PI * 0.1)), 0);
    expect(r.phaseCrossings[1].frequencyHz).toBeNull();
    expect(r.phaseCrossings[2]).toEqual(r.phaseCrossings[0]);
  });
  it('keeps existing output unchanged when omitted', async () => {
    const args = { request: circuit('C1 a 0 1u'), port };
    const base = await executeTool('spice_impedance', args);
    const added = await executeTool('spice_impedance', { ...args, phaseLevelsDeg: [-45] });
    expect(base.isError).not.toBe(true);
    const { phaseCrossings, ...rest } = added.structuredContent as Record<string, unknown>;
    expect(phaseCrossings).toBeDefined();
    expect(rest).toEqual(base.structuredContent);
  });
  it('returns structured errors for non-finite levels', async () => {
    const response = await executeTool('spice_impedance', { request: circuit('C1 a 0 1u'), port, phaseLevelsDeg: [Infinity] });
    expect(response.structuredContent).toMatchObject({ error: { code: 'INVALID_REQUEST', phase: 'validation' } });
    expect(valid(tool.outputSchema!, response.structuredContent)).toBe(true);
  });
});
