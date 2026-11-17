import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { SimulationResultV1, SpiceTsCircuitDocumentV1 } from '@spice-ts/core/protocol';
import { executeTool, MCP_TOOLS } from './server.js';

const deck = (resistance: string, step = '') => `* stepped sine\nV1 a 0 SIN(0 1 1k)\nV2 b a SIN(0 0.1 2k)\nV3 in b SIN(0 0.05 3k)\nR1 in out 1k\nR2 out 0 ${resistance}\n.tran 1u 5m 0 1u\n${step}\n.end`;
const spice = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
const stepped = spice(deck('1k', '.step R2 list 1k 3k'));
const base = { signal: 'v(out)', fundamentalHz: 1000, analysis: 0, harmonicCount: 3, windowStartS: 0.00123 };
const tool = MCP_TOOLS.find(t => t.name === 'spice_fourier')!;
const validator = new AjvJsonSchemaValidator();
type Metrics = { dc: number; unit: string; thdPercent: number; harmonics: Record<string, number>[] };

const document: SpiceTsCircuitDocumentV1 = {
  format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
  circuit: { nets: ['a', 'b', 'in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'a' }, { name: 'n', net: '0' }], params: { waveform: 'sin', offset: 0, amplitude: 1, frequency: 1000 } },
    { type: 'V', id: 'V2', name: 'V2', ports: [{ name: 'p', net: 'b' }, { name: 'n', net: 'a' }], params: { waveform: 'sin', offset: 0, amplitude: 0.1, frequency: 2000 } },
    { type: 'V', id: 'V3', name: 'V3', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'b' }], params: { waveform: 'sin', offset: 0, amplitude: 0.05, frequency: 3000 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'R', id: 'R2', name: 'R2', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
  ] }, analyses: [{ type: 'tran', timestep: 1e-6, stopTime: 0.005 }],
  componentSweep: { component: 'R2', values: [1000, 3000] },
};
const native = (doc: SpiceTsCircuitDocumentV1) => ({ apiVersion: '1', input: { format: 'spice-ts', document: doc } });

async function metrics(request: unknown, step?: number): Promise<Metrics> {
  const response = await executeTool('spice_fourier', { request, ...base, ...(step === undefined ? {} : { step }) });
  expect(response, JSON.stringify(response)).not.toHaveProperty('isError', true);
  expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as Metrics;
}
function compare(a: Metrics, b: Metrics) {
  expect(a.unit).toBe(b.unit);
  expect(a.dc).toBeCloseTo(b.dc, 8);
  expect(a.thdPercent).toBeCloseTo(b.thdPercent, 8);
  expect(a.harmonics).toHaveLength(b.harmonics.length);
  for (let i = 0; i < a.harmonics.length; i++) {
    expect(Object.keys(a.harmonics[i]).sort()).toEqual(Object.keys(b.harmonics[i]).sort());
    for (const key of Object.keys(a.harmonics[i])) expect(a.harmonics[i][key]).toBeCloseTo(b.harmonics[i][key], 8);
  }
}

describe('spice_fourier step selection', () => {
  it.each(['spice', 'native'])('matches each %s stepped trace to its standalone simulation', async format => {
    for (const [step, resistance, amplitude] of [[0, 1000, 0.5], [1, 3000, 0.75]]) {
      const standalone = structuredClone(document);
      delete standalone.componentSweep;
      standalone.circuit.components[4].params = { resistance };
      const selected = await metrics(format === 'spice' ? stepped : native(document), step);
      const reference = await metrics(format === 'spice' ? spice(deck(`${resistance}`)) : native(standalone));
      compare(selected, reference);
      expect(selected.harmonics[0].magnitude).toBeCloseTo(amplitude, 4);
      console.log(`${format} step ${step}: amplitude delta ${selected.harmonics[0].magnitude - reference.harmonics[0].magnitude}, THD delta ${selected.thdPercent - reference.thdPercent}`);
    }
  });

  it('reports ambiguity, nonexistent analysis and unknown step', async () => {
    for (const [extra, code] of [[{}, 'AMBIGUOUS_ANALYSIS'], [{ step: 2 }, 'UNKNOWN_STEP'], [{ analysis: 1, step: 0 }, 'NO_TRANSIENT']] as const) {
      const response = await executeTool('spice_fourier', { request: stepped, ...base, ...extra });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code } } });
      expect(validator.getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    }
    const response = await executeTool('spice_fourier', { request: spice('* op\nV1 out 0 1\n.op\n.end'), ...base, step: 0 });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'NO_TRANSIENT' } } });
  });

  it('accepts zero for unstepped results and keeps selected period bounds', async () => {
    const request = spice(deck('1k'));
    compare(await metrics(request, 0), await metrics(request));
    const short = await executeTool('spice_fourier', { request: stepped, ...base, step: 1, windowStartS: 0.0045 });
    expect(short).toMatchObject({ isError: true, structuredContent: { error: { code: 'INSUFFICIENT_PERIOD' } } });
    const unknown = await executeTool('spice_fourier', { request, ...base, step: 1 });
    expect(unknown).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNKNOWN_STEP' } } });
  });

  it.each([{ step: -1 }, { step: 0.5 }, { step: Infinity }, { step: NaN }, { unknown: true }])('rejects invalid inputs at runtime and in discovery %#', async extra => {
    const args = { request: stepped, ...base, ...extra };
    expect(validator.getValidator(tool.inputSchema)(args).valid).toBe(false);
    const response = await executeTool('spice_fourier', args, { simulate: async () => { throw new Error('must not simulate'); } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  it('does not combine selected traces to manufacture a complete period', async () => {
    const trace = (index: number, timeS: number[]) => ({ type: 'tran' as const, analysisIndex: 0, step: { index, parameter: 'R2', value: index }, timeS, voltagesV: { out: timeS.map(t => Math.sin(2 * Math.PI * 1000 * t)) }, currentsA: {} });
    const result: SimulationResultV1 = { status: 'complete', analyses: [trace(0, [0, 0.0005]), trace(1, [0.0005, 0.001])] };
    for (const step of [0, 1]) {
      const response = await executeTool('spice_fourier', { request: stepped, ...base, windowStartS: 0, step }, { simulate: async () => result });
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INSUFFICIENT_PERIOD' } } });
    }
  });
});
