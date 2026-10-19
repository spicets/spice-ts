import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';

const netlist = '* Original MIT series RC\nR1 in mid 1k\nC1 mid 0 1u\n.ac dec 1 10 1000\n.end';
const args = { request: { apiVersion: '1', input: { format: 'spice', source: netlist } }, port: { positive: 'in', negative: '0' } };
type Report = { points: { frequencyHz: number; magnitudeOhm: number; phaseDeg: number; resistanceOhm: number; reactanceOhm: number }[]; summary: { min: { magnitudeOhm: number; frequencyHz: number }; max: { magnitudeOhm: number; frequencyHz: number }; resonanceHz: number[] } };
async function run(extra = {}) {
  const response = await executeTool('spice_impedance', { ...args, ...extra });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_impedance')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as Report;
}
describe('spice_impedance', () => {
  it('matches analytic series RC within 1e-6 relative at three frequencies', async () => {
    const result = await run();
    expect(result.points.map(p => p.frequencyHz)).toEqual([expect.closeTo(10, 10), expect.closeTo(100, 10), expect.closeTo(1000, 10)]);
    for (const p of result.points) {
      const x = -1 / (2 * Math.PI * p.frequencyHz * 1e-6);
      for (const [actual, expected] of [[p.resistanceOhm, 1000], [p.reactanceOhm, x], [p.magnitudeOhm, Math.hypot(1000, x)], [p.phaseDeg, Math.atan2(x, 1000) * 180 / Math.PI]]) {
        expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-6);
      }
    }
    expect(result.summary.min.frequencyHz).toBeCloseTo(1000, 10);
    expect(result.summary.max.frequencyHz).toBe(10);
    expect(result.summary.resonanceHz).toEqual([]);
  });
  it('locates parallel RLC resonance within 0.1 percent', async () => {
    const result = await run({ request: { apiVersion: '1', input: { format: 'spice', source: 'R1 in 0 1k\nL1 in 0 10m\nC1 in 0 1u\n.ac dec 1000 100 10k' } } });
    expect(result.summary.resonanceHz).toHaveLength(1);
    expect(Math.abs(result.summary.resonanceHz[0] / (1 / (2 * Math.PI * Math.sqrt(0.01 * 1e-6))) - 1)).toBeLessThan(0.001);
  });
  it('measures differential ports and suppresses AC sources without changing DC bias or the caller input', async () => {
    const request = { apiVersion: '1', input: { format: 'spice', source: 'Vbias neg 0 DC 3 AC 7\nIold in neg DC 0 AC 5 45\nR1 in neg 2k' } };
    const before = structuredClone(request);
    const result = await run({ request, port: { positive: 'IN', negative: 'NEG' }, sweep: { variation: 'lin', points: 3, startFreq: 10, stopFreq: 100 } });
    for (const p of result.points) expect(p.resistanceOhm).toBeCloseTo(2000, 6);
    expect(result.summary.resonanceHz).toEqual([]);
    expect(request).toEqual(before);
  });
  it('applies top-level parameter overrides', async () => {
    const request = { apiVersion: '1', input: { format: 'spice', source: '.param r=1k\nR1 in 0 {r}\n.ac lin 1 10 10' } };
    expect((await run({ request, params: { R: 3000 } })).points[0].resistanceOhm).toBeCloseTo(3000, 8);
  });
  it('accepts circuit-json without mutating the document', async () => {
    const circuit = [
      { type: 'source_component', source_component_id: 'r', name: 'R1', ftype: 'simple_resistor', resistance: 2000 },
      ...['in', '0'].map(name => ({ type: 'source_net', source_net_id: name, name })),
      ...[['p', 'in'], ['n', '0']].flatMap(([name, net]) => [
        { type: 'source_port', source_port_id: name, source_component_id: 'r', name },
        { type: 'source_trace', source_trace_id: `t${name}`, connected_source_port_ids: [name], connected_source_net_ids: [net] },
      ]),
    ];
    const request = { apiVersion: '1', input: { format: 'circuit-json', circuit, analyses: [] } };
    const before = structuredClone(request);
    const result = await run({ request, sweep: { variation: 'lin', points: 1, startFreq: 10, stopFreq: 10 } });
    expect(result.points[0].resistanceOhm).toBeCloseTo(2000, 8);
    expect(request).toEqual(before);
  });
  it('suppresses subcircuit sources, avoids source-name collisions, and retains dependent sources', async () => {
    const source = '.subckt load a b\nIold b a AC 5\nR1 a b 2k\n.ends\nX1 in 0 load\nI__spice_impedance in 0 AC 4\nG1 in 0 in 0 0.0005\n.ac lin 1 10 10';
    const result = await run({ request: { apiVersion: '1', input: { format: 'spice', source } } });
    expect(result.points[0].resistanceOhm).toBeCloseTo(1000, 7);
  });
  it('preserves nonlinear operating-point bias when suppressing AC', async () => {
    const source = 'V1 bias 0 DC 0.6 AC 7\nR1 bias in 1k\nD1 in 0 diode\n.model diode D (IS=1e-12 N=1)\n.ac lin 1 10 10';
    const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
    const biased = (await run({ request: request(source) })).points[0].resistanceOhm;
    const zeroAc = (await run({ request: request(source.replace('AC 7', 'AC 0')) })).points[0].resistanceOhm;
    const unbiased = (await run({ request: request(source.replace('DC 0.6', 'DC 0')) })).points[0].resistanceOhm;
    expect(biased).toBeCloseTo(zeroAc, 8);
    expect(unbiased).toBeGreaterThan(2 * biased);
  });
  it.each([
    [{ port: { positive: 'missing', negative: '0' } }, 'UNKNOWN_NODE'],
    [{ port: { positive: 'in', negative: 'IN' } }, 'SHORTED_PORT'],
    [{ port: { positive: '0', negative: 'gnd' } }, 'SHORTED_PORT'],
    [{ request: { ...args.request, input: { format: 'spice', source: 'R1 in 0 1k' } } }, 'MISSING_AC_SWEEP'],
    [{ sweep: { variation: 'lin', points: 0, startFreq: 10, stopFreq: 100 } }, 'INVALID_REQUEST'],
    [{ params: { missing: 1 } }, 'UNKNOWN_PARAMETER'],
  ])('returns stable errors for %j', async (extra, code) => {
    expect(await executeTool('spice_impedance', { ...args, ...extra })).toMatchObject({ isError: true, structuredContent: { error: { code } } });
  });
  it('enforces resource limits and cancellation', async () => {
    for (const limits of [{ maxDocumentBytes: 1 }, { maxResultPoints: 1 }, { maxAnalyses: 0 }, { maxSerializedResultBytes: 1 }]) {
      expect((await executeTool('spice_impedance', args, { limits: { ...DEFAULT_MCP_LIMITS, ...limits } })).structuredContent).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    }
    const controller = new AbortController(); controller.abort();
    expect((await executeTool('spice_impedance', args, { signal: controller.signal })).structuredContent).toMatchObject({ error: { code: 'CANCELLED' } });
  });
});
