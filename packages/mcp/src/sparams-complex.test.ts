import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { SParameterResult } from '@spice-ts/core';
import { sparamsReport } from './sparams.js';

const pad = 'V1 in 0 portnum 1 z0 50\nV2 out 0 portnum 2 z0 50\nR1 in mid 16.666666666666668\nR2 mid out 16.666666666666668\nR3 mid 0 66.66666666666667\n.sp lin 3 100 1000 0';
type Metric = { real: number; imaginary: number; magnitude: number; phaseDeg: number | null };
type Report = { points: { frequencyHz: number; parameters: Record<string, Metric> }[] };

async function run(args: object): Promise<Report> {
  const response = await executeTool('spice_sparams', args);
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_sparams')!.outputSchema!);
  expect(validate(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as Report;
}

describe('rectangular S-parameters', () => {
  it('returns analytic matched-pad coefficients on both request routes', async () => {
    for (const args of [{ netlist: pad }, { request: { apiVersion: '1', input: { format: 'spice', source: pad } } }]) {
      const report = await run(args);
      for (const { parameters } of report.points) {
        for (const [key, expected] of Object.entries({ S11: 0, S12: 0.5, S21: 0.5, S22: 0 })) {
          const s = parameters[key];
          expect(s.real).toBeCloseTo(expected, 6);
          expect(s.imaginary).toBeCloseTo(0, 6);
          expect(s.magnitude).toBeCloseTo(Math.hypot(s.real, s.imaginary), 12);
          if (s.magnitude !== 0) expect(s.phaseDeg).toBeCloseTo(Math.atan2(s.imaginary, s.real) * 180 / Math.PI, 12);
        }
      }
    }
  });

  it('matches independent complex series-capacitor coefficients and filters exact frequencies and pairs', async () => {
    const netlist = 'V1 in 0 portnum 1 z0 50\nV2 out 0 portnum 2 z0 50\nC1 in out 1u\n.sp lin 3 100 10000 0';
    for (const input of [{ netlist }, { request: { apiVersion: '1', input: { format: 'spice', source: netlist } } }]) {
      const full = await run({ ...input, frequenciesHz: [123, 9876] });
      const selected = await run({ ...input, frequenciesHz: [123, 9876], portPair: [2, 1] });
      expect(full.points.map(p => p.frequencyHz)).toEqual([123, 9876]);
      for (let i = 0; i < full.points.length; i++) {
        const { frequencyHz, parameters } = full.points[i];
        expect(Object.keys(parameters)).toEqual(['S11', 'S12', 'S21', 'S22']);
        expect(selected.points[i].parameters).toEqual({ S21: parameters.S21 });
        const x = 1 / (2 * Math.PI * frequencyHz * 1e-6);
        const denominator = 10000 + x * x;
        for (const [key, real, imaginary] of [
          ['S11', x * x / denominator, -100 * x / denominator],
          ['S12', 10000 / denominator, 100 * x / denominator],
          ['S21', 10000 / denominator, 100 * x / denominator],
          ['S22', x * x / denominator, -100 * x / denominator],
        ] as const) {
          const actual = parameters[key];
          expect(Math.abs(actual.real - real)).toBeLessThan(1e-6);
          expect(Math.abs(actual.imaginary - imaginary)).toBeLessThan(1e-6);
          expect(actual.magnitude).toBeCloseTo(Math.hypot(actual.real, actual.imaginary), 12);
          expect(actual.phaseDeg).toBeCloseTo(Math.atan2(actual.imaginary, actual.real) * 180 / Math.PI, 12);
        }
      }
    }
  });

  it('preserves synthetic exact zero and unambiguous multi-digit pair mapping', () => {
    const ports = Array.from({ length: 11 }, (_, i) => `V${i + 1}`);
    const vectors = new Map<string, { real: number; imaginary: number }[]>(ports.flatMap((_, i) => ports.map((__, j) => [
      `S_${i + 1}_${j + 1}`, [{ real: i === 10 && j === 0 ? -0.25 : 0, imaginary: i === 10 && j === 0 ? 0.5 : 0 }],
    ])));
    const raw = new SParameterResult([100], ports, vectors);
    const full = sparamsReport([raw], { netlist: '' });
    expect(Object.keys(full.points[0].parameters)).toHaveLength(121);
    expect(full.points[0].parameters.S11).toMatchObject({ real: 0, imaginary: 0, magnitude: 0, magnitudeDb: null, phaseDeg: null });
    expect(full.points[0].parameters.S_11_1).toMatchObject({ real: -0.25, imaginary: 0.5 });
    expect(sparamsReport([raw], { netlist: '', portPair: [11, 1] }).points[0].parameters)
      .toEqual({ S_11_1: full.points[0].parameters.S_11_1 });
  });

  it('rejects missing, nonfinite and overflowing internal vectors rather than serializing them', () => {
    for (const vector of [undefined, { real: NaN, imaginary: 0 }, { real: 0, imaginary: Infinity },
      { real: Number.MAX_VALUE, imaginary: Number.MAX_VALUE }]) {
      const vectors = vector ? new Map([['S_1_1', [vector]]]) : new Map();
      const raw = new SParameterResult([100], ['V1'], vectors);
      expect(() => sparamsReport([raw], { netlist: '' })).toThrow(/Invalid S-parameter/);
    }
  });

  it('requires both coefficients and forbids unknown fields in the strict output schema', async () => {
    const report = await run({ netlist: pad });
    const validate = new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_sparams')!.outputSchema!);
    const broken = structuredClone(report) as Report & { extra?: number };
    delete (broken.points[0].parameters.S21 as Partial<Metric>).real;
    expect(validate(broken).valid).toBe(false);
    broken.points[0].parameters.S21.real = 0.5;
    broken.extra = 1;
    expect(validate(broken).valid).toBe(false);
  });
});
