import { describe, expect, it } from 'vitest';
import type { SimulationResultV1 } from '@spice-ts/core/protocol';
import { acMetrics } from './ac-metrics.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const sweep = (gains: number[]): SimulationResultV1 => ({ status: 'complete', analyses: [{
  type: 'ac', analysisIndex: 0, frequencyHz: gains.map((_, i) => 10 ** (i + 1)), currentPhasors: {},
  voltagePhasors: { out: gains.map(db => ({ magnitude: 10 ** (db / 20), phaseDegrees: 0 })) },
}] });
const deck = (r = '1k', step = '') => `* RC low pass\nV1 in 0 DC 0 AC 2\nR1 in out ${r}\nC1 out 0 1u\n.ac dec 20 1 100k\n${step}\n.end`;
const request = (source = deck()) => ({ apiVersion: '1', input: { format: 'spice', source } });
const base = { request: request(), output: 'out', input: 'in' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_ac_metrics')!;
const validator = new AjvJsonSchemaValidator();

describe('requested AC gain crossings', () => {
  it('interpolates analytic dB gains in logarithmic frequency', () => {
    const result = acMetrics(sweep([0, -20, -40]), { output: 'out', gainCrossingsDb: [-10, -30] });
    expect(Math.abs(result.gainCrossings![0].frequencyHz! / 10 ** 1.5 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(result.gainCrossings![1].frequencyHz! / 10 ** 2.5 - 1)).toBeLessThan(1e-12);
  });

  it('finds a crossing when finite phasor ratios overflow and underflow', () => {
    const trace: SimulationResultV1 = { status: 'complete', analyses: [{
      type: 'ac', analysisIndex: 0, frequencyHz: [10, 100], currentPhasors: {},
      voltagePhasors: {
        out: [1e300, 1e-300].map(magnitude => ({ magnitude, phaseDegrees: 0 })),
        in: [1e-100, 1e-100].map(magnitude => ({ magnitude, phaseDegrees: 0 })),
      },
    }] };
    const args = { output: 'out', input: 'in' };
    const legacy = acMetrics(trace, args);
    const result = acMetrics(trace, { ...args, gainCrossingsDb: [0] });
    const { gainCrossings, ...rest } = result;
    expect(rest).toEqual(legacy);
    expect(gainCrossings![0].frequencyHz).not.toBeNull();
    expect(Math.abs(gainCrossings![0].frequencyHz! / 10 ** (1 + 2 / 3) - 1)).toBeLessThan(1e-12);
  });

  it('accurately locates crossings when finite transfer ratios are subnormal', () => {
    const trace: SimulationResultV1 = { status: 'complete', analyses: [{
      type: 'ac', analysisIndex: 0, frequencyHz: [10, 100], currentPhasors: {},
      voltagePhasors: {
        out: [1e-300, 3e-304].map(magnitude => ({ magnitude, phaseDegrees: 0 })),
        in: [1e20, 1e20].map(magnitude => ({ magnitude, phaseDegrees: 0 })),
      },
    }] };
    const args = { output: 'out', input: 'in' };
    const { gainCrossings, ...legacy } = acMetrics(trace, { ...args, gainCrossingsDb: [-6460] });
    expect(legacy).toEqual(acMetrics(trace, args));
    // Analytic endpoint gains are -6400 and 20*log10(3)-6480 dB.
    const expectedHz = 10 ** (1 + 60 / (80 - 20 * Math.log10(3)));
    expect(gainCrossings![0].frequencyHz).not.toBeNull();
    expect(Math.abs(gainCrossings![0].frequencyHz! / expectedHz - 1)).toBeLessThan(1e-12);
  });

  it('interpolates a finite crossing across a very wide frequency range', () => {
    const result = sweep([0, -20]);
    const trace = result.analyses[0];
    if (trace.type !== 'ac') throw new Error('expected AC trace');
    trace.frequencyHz = [1e-300, 1e300];
    const hz = acMetrics(result, { output: 'out', gainCrossingsDb: [-10] }).gainCrossings![0].frequencyHz!;
    expect(Math.abs(hz - 1)).toBeLessThan(1e-12);
  });

  it('keeps order and duplicates, finds first descent, counts endpoints and rejects plateaus', () => {
    const m = acMetrics(sweep([0, -20, 0, -20, -20]), { output: 'out', gainCrossingsDb: [-10, 0, -20, -10, 5, -40] });
    expect(m.gainCrossings!.map(c => c.targetDb)).toEqual([-10, 0, -20, -10, 5, -40]);
    for (const i of [0, 3]) expect(Math.abs(m.gainCrossings![i].frequencyHz! / 10 ** 1.5 - 1)).toBeLessThan(1e-12);
    expect(m.gainCrossings![1].frequencyHz).toBeCloseTo(10, 12);
    expect(m.gainCrossings![2].frequencyHz).toBeCloseTo(100, 10);
    expect(m.gainCrossings!.slice(4).map(c => c.frequencyHz)).toEqual([null, null]);
    expect(acMetrics(sweep([-20, -20]), { output: 'out', gainCrossingsDb: [-20] }).gainCrossings![0].frequencyHz).toBeNull();
    expect(acMetrics(sweep([-20, 0]), { output: 'out', gainCrossingsDb: [-20, 0] }).gainCrossings!.map(c => c.frequencyHz)).toEqual([null, null]);
  });

  it('advertises schemas, rejects invalid targets, and keeps legacy output unchanged', async () => {
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    expect((tool.inputSchema.properties as Record<string, unknown>).gainCrossingsDb).toMatchObject({ type: 'array', minItems: 1, maxItems: 32, items: { type: 'number' } });
    const valid = { ...base, gainCrossingsDb: [-10, -10, -100] };
    expect(input(valid).valid).toBe(true);
    const response = await executeTool(tool.name, valid);
    expect(response.isError).not.toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    for (const targets of [[], Array(33).fill(0), [NaN], [Infinity], [-Infinity], ['-10'], null]) {
      expect(await executeTool(tool.name, { ...base, gainCrossingsDb: targets })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
    }
    for (const targets of [[], Array(33).fill(0), ['-10'], null]) expect(input({ ...base, gainCrossingsDb: targets }).valid).toBe(false);
    expect(input({ ...base, gainCrossingsDb: Array(32).fill(-10) }).valid).toBe(true);
    const legacy = await executeTool(tool.name, base);
    const { gainCrossings: _gainCrossings, ...rest } = response.structuredContent as Record<string, unknown>;
    expect(rest).toEqual(legacy.structuredContent);
    expect(legacy.structuredContent).not.toHaveProperty('gainCrossings');
  });

  it('matches independently interpolated real RC simulated samples through MCP', async () => {
    const raw = await executeTool('spice_simulate', { request: base.request });
    expect(raw.isError).not.toBe(true);
    const a = (raw.structuredContent as unknown as SimulationResultV1).analyses[0];
    if (a.type !== 'ac') throw new Error('expected AC trace');
    const gains = a.frequencyHz.map((_, i) => 20 * Math.log10(a.voltagePhasors.out[i].magnitude / a.voltagePhasors.in[i].magnitude));
    const target = -10;
    const i = gains.findIndex((value, i) => i > 0 && gains[i - 1] >= target && value <= target && gains[i - 1] > value);
    expect(i).toBeGreaterThan(0);
    const fraction = (target - gains[i - 1]) / (gains[i] - gains[i - 1]);
    const expected = 10 ** (Math.log10(a.frequencyHz[i - 1]) + fraction * (Math.log10(a.frequencyHz[i]) - Math.log10(a.frequencyHz[i - 1])));
    const response = await executeTool(tool.name, { ...base, gainCrossingsDb: [target] });
    expect(response.isError).not.toBe(true);
    const actual = (response.structuredContent as { gainCrossings: { frequencyHz: number }[] }).gainCrossings[0].frequencyHz;
    expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-12);
  });

  it('uses selected stepped traces through MCP', async () => {
    const stepped = request(deck('1k', '.step param R1 list 1k 2k'));
    const crossing = async (source: typeof stepped, step?: number) => {
      const r = await executeTool(tool.name, { ...base, request: source, ...(step === undefined ? {} : { step }), gainCrossingsDb: [-10] });
      expect(r.isError).not.toBe(true);
      return (r.structuredContent as { gainCrossings: { frequencyHz: number }[] }).gainCrossings[0].frequencyHz;
    };
    const a = await crossing(stepped, 0);
    const b = await crossing(stepped, 1);
    // Independently interpolate the analytic RC response on the .ac dec 20 grid.
    const expected = (resistance: number) => {
      const gains = Array.from({ length: 101 }, (_, i) => {
        const f = 10 ** (i / 20);
        return -10 * Math.log10(1 + (2 * Math.PI * f * resistance * 1e-6) ** 2);
      });
      const i = gains.findIndex(gain => gain <= -10);
      const fraction = (-10 - gains[i - 1]) / (gains[i] - gains[i - 1]);
      return 10 ** ((i - 1 + fraction) / 20);
    };
    expect(Math.abs(a / expected(1000) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(b / expected(2000) - 1)).toBeLessThan(1e-12);
    expect(b).toBeLessThan(a);
  });

  it('uses complex differential input and output, not raw voltage magnitude', async () => {
    const phasors = (values: number[]) => values.map(real => ({ magnitude: Math.hypot(real, 1), phaseDegrees: Math.atan2(1, real) * 180 / Math.PI }));
    const imaginary = Array.from({ length: 3 }, () => ({ magnitude: 1, phaseDegrees: 90 }));
    const trace: SimulationResultV1 = { status: 'complete', analyses: [{ type: 'ac', analysisIndex: 0,
      frequencyHz: [10, 100, 1000], currentPhasors: {}, voltagePhasors: {
        op: phasors([2, 0.2, 0.02]), om: imaginary, ip: phasors([2, 2, 2]), im: imaginary,
      },
    }] };
    const response = await executeTool(tool.name, { ...base, output: 'v(op,om)', input: 'v(ip,im)', gainCrossingsDb: [-10, -30] }, { simulate: async () => trace });
    expect(response.isError).not.toBe(true);
    const crossings = (response.structuredContent as { gainCrossings: { frequencyHz: number }[] }).gainCrossings;
    expect(Math.abs(crossings[0].frequencyHz / 10 ** 1.5 - 1)).toBeLessThan(1e-12);
    expect(Math.abs(crossings[1].frequencyHz / 10 ** 2.5 - 1)).toBeLessThan(1e-12);
  });
});
