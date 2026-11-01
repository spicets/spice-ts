import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { parseTitleless, simulate } from '@spice-ts/core';
import { executeTool, MCP_TOOLS } from './server.js';

const diode = `* Single-tone diode distortion with reactive load
V1 in 0 DC 0.6 DISTOF1 0.01
D1 in out DM
R1 out 0 100
C1 out 0 1n
.model DM D IS=1e-14 TT=1n CJO=5p
.disto dec 5 1k 100k
.end`;
const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
const validator = new AjvJsonSchemaValidator();
async function run(source = diode, output = 'v(out)') {
  const response = await executeTool('spice_disto_metrics', { request: request(source), output });
  const tool = MCP_TOOLS.find(t => t.name === 'spice_disto_metrics');
  expect(tool).toBeDefined();
  expect(validator.getValidator(tool!.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response;
}

describe('spice_disto_metrics', () => {
  const analysis = { type: 'disto', variation: 'dec', points: 5, startFreq: 1e3, stopFreq: 1e5 };
  const ir = parseTitleless(diode).toIR();
  const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { ...ir, components: ir.components.map(({ displayValue: _displayValue, ...component }) => component) }, models: [{ name: 'DM', type: 'D', params: { IS: 1e-14, TT: 1e-9, CJO: 5e-12 } }], subcircuits: [], analyses: [analysis] };
  const jsonInputs = [
    { format: 'spice-ts', document },
    { format: 'circuit-json', circuit: [], analyses: [analysis] },
  ];
  it.each(jsonInputs)('recognizes a single disto in the $format input schema for actionable errors', input => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_disto_metrics')!;
    expect(validator.getValidator(tool.inputSchema)({ request: { apiVersion: '1', input }, output: 'v(out)' }).valid).toBe(true);
  });
  it.each([false, true])('matches SPICE-text metrics exactly for native JSON (two-tone=%s)', async twoTone => {
    const source = twoTone ? diode.replace('DISTOF1 0.01', 'DISTOF1 0.01 30 DISTOF2 0.005 -20').replace('100k\n', '100k 0.9\n') : diode;
    const native = structuredClone(document);
    Object.assign(native.circuit.components[0].params, {
      distortionF1: { magnitude: 0.01, phase: twoTone ? 30 : 0 },
      ...(twoTone ? { distortionF2: { magnitude: 0.005, phase: -20 } } : {}),
    });
    if (twoTone) Object.assign(native.analyses[0], { f2OverF1: 0.9 });
    const response = await executeTool('spice_disto_metrics', { request: { apiVersion: '1', input: { format: 'spice-ts', document: native } }, output: 'v(out)' });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual((await run(source)).structuredContent);
  });
  it.each([
    ['distortionF1', null, 'distortionF1'],
    ['distortionF2', [], 'distortionF2'],
    ['distortionF1', {}, 'distortionF1/magnitude'],
    ['distortionF2', { magnitude: '0.01' }, 'distortionF2/magnitude'],
    ['distortionF1', { magnitude: Infinity }, 'distortionF1/magnitude'],
    ['distortionF2', { magnitude: 0.01, phase: '30' }, 'distortionF2/phase'],
    ['distortionF1', { magnitude: 0.01, typo: 1 }, 'distortionF1/typo'],
  ])('rejects invalid native %s excitation %j naming %s', async (field, value, path) => {
    const native = structuredClone(document);
    Object.assign(native.circuit.components[0].params, { [field as string]: value });
    const response = await executeTool('spice_disto_metrics', { request: { apiVersion: '1', input: { format: 'spice-ts', document: native } }, output: 'v(out)' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT', phase: 'validation', retryable: false } } });
    expect(JSON.stringify(response.structuredContent)).toContain(path);
    expect(validator.getValidator(MCP_TOOLS.find(t => t.name === 'spice_disto_metrics')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  });
  it.each([
    ['variation', 'lin'], ['points', 0], ['points', 1.5], ['startFreq', -1],
    ['stopFreq', 0], ['f2OverF1', 1], ['f2OverF1', 0], ['f2OverF1', '0.9'],
  ])('rejects invalid native disto analysis %s=%s', async (field, value) => {
    const native = structuredClone(document);
    Object.assign(native.analyses[0], { [field]: value });
    const response = await executeTool('spice_disto_metrics', { request: { apiVersion: '1', input: { format: 'spice-ts', document: native } }, output: 'v(out)' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT', details: { path: `/input/document/analyses/0/${field}` } } } });
  });
  it.each([
    [{ type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 5, startFreq: 1e3, stopFreq: 1e5 }],
    [{ type: 'noise', outputNode: 'out', inputSource: 'V1', variation: 'dec', points: 1e9, startFreq: 1, stopFreq: 1e12 }],
    {}, null, 'noise',
  ].map(noiseAnalyses => [noiseAnalyses]))('rejects supplemental or malformed noiseAnalyses %j before execution', async noiseAnalyses => {
    const response = await executeTool('spice_disto_metrics', {
      request: { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, noiseAnalyses } } }, output: 'v(out)',
    });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: {
      code: 'UNSUPPORTED_ANALYSIS', phase: 'validation', retryable: false,
    } } });
  });
  it.each([
    ['models', undefined], ['models', null], ['subcircuits', undefined],
    ['circuit', null], ['circuit', { components: [null], nets: [] }],
    ['circuit', { components: [{}], nets: [] }],
    ['circuit', { components: [{ type: 42, params: {} }], nets: [] }],
  ])('rejects malformed native document %s=%j during validation', async (field, value) => {
    const response = await executeTool('spice_disto_metrics', {
      request: { apiVersion: '1', input: { format: 'spice-ts', document: { ...document, [field]: value } } }, output: 'v(out)',
    });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: {
      code: 'INVALID_INPUT', phase: 'validation', retryable: false,
    } } });
    expect(JSON.stringify(response.structuredContent)).toContain(field);
  });
  it.each(jsonInputs.filter(input => input.format === 'circuit-json'))('names unavailable DISTOF source fields for $format instead of rejecting the analysis', async input => {
    const spice = await run();
    expect(spice.isError).not.toBe(true);
    const response = await executeTool('spice_disto_metrics', { request: { apiVersion: '1', input }, output: 'v(out)' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: {
      code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false,
      details: { missingFields: ['DISTOF1', 'DISTOF2'] },
    } } });
    expect(JSON.stringify(response.structuredContent)).toContain('DISTOF1');
    expect(validator.getValidator(MCP_TOOLS.find(t => t.name === 'spice_disto_metrics')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  });
  it.each(jsonInputs)('preserves structured analysis errors for stepped or multiple $format analyses', async input => {
    for (const invalid of [
      { analyses: [analysis, { type: 'op' }] },
      { analyses: [analysis], steps: [{ parameter: 'R1', values: [100, 200] }] },
      { analyses: [] },
      { analyses: [{ type: 'op' }] },
      { analyses: [analysis], poleZeroAnalyses: [{}] },
    ]) {
      const changed = input.format === 'spice-ts' ? { ...input, document: { ...document, ...invalid } } : { ...input, ...invalid };
      expect(await executeTool('spice_disto_metrics', { request: { apiVersion: '1', input: changed }, output: 'v(out)' }))
        .toMatchObject({ isError: true, structuredContent: { error: { code: 'UNSUPPORTED_ANALYSIS', retryable: false } } });
    }
  });
  it('matches ngspice-47 on identical bytes at all 22 HD2/HD3 points within core distortion tolerance', async () => {
    const reference = JSON.parse(readFileSync(new URL('../fixtures/disto-ngspice47.json', import.meta.url), 'utf8')) as Record<string, number[][]>;
    const response = await run();
    expect(response.isError).not.toBe(true);
    const metrics = response.structuredContent as unknown as { products: { product: string; points: { frequencyHz: number; real: number; imaginary: number }[] }[] };
    for (const { product, points } of metrics.products) {
      expect(points).toHaveLength(reference[product].length);
      points.forEach((point, i) => {
        const [frequency, real, imaginary] = reference[product][i];
        expect(Math.abs(point.frequencyHz / frequency - 1)).toBeLessThan(1e-12);
        // Existing core expectComplexParity tolerance, never adjusted for this circuit.
        expect(Math.hypot(point.real - real, point.imaginary - imaginary) / Math.max(Math.hypot(real, imaginary), 1e-15)).toBeLessThan(0.005);
      });
    }
  });
  it.each([false, true])('matches core solveDistortion bit-for-bit (two-tone=%s)', async twoTone => {
    const source = twoTone ? diode.replace('DISTOF1 0.01', 'DISTOF1 0.01 DISTOF2 0.005').replace('100k\n', '100k 0.9\n') : diode;
    const result = (await simulate(parseTitleless(source))).distortion!;
    const response = await run(source, 'v(OUT)');
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({
      output: 'v(OUT)', magnitudeUnit: 'V', decibelReference: '1 V',
      f2Hz: twoTone ? 900 : null,
      products: result.products.map((product, j) => ({
        product: (twoTone ? ['SIM2', 'DIM2', 'DIM3'] : ['HD2', 'HD3'])[j],
        points: result.voltage('out', product).map((value, i) => {
          const magnitude = Math.hypot(value.real, value.imaginary);
          return { frequencyHz: result.frequencies[i], real: value.real, imaginary: value.imaginary,
            magnitude, magnitudeDb: magnitude === 0 ? null : 20 * Math.log10(magnitude),
            phaseDeg: magnitude === 0 ? null : Math.atan2(value.imaginary, value.real) * 180 / Math.PI };
        }),
      })),
    });
  });
  it('represents exact linear zero as null dBV/phase, never non-JSON infinity', async () => {
    const response = await run('V1 out 0 DISTOF1 1\nR1 out 0 1k\n.disto dec 5 1k 100k');
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.structuredContent)).toContain('"magnitudeDb":null,"phaseDeg":null');
  });
  it.each([
    ['missing analysis', 'R1 out 0 1k', 'v(out)', 'UNSUPPORTED_ANALYSIS'],
    ['wrong analysis', 'R1 out 0 1k\n.op', 'v(out)', 'UNSUPPORTED_ANALYSIS'],
    ['missing node', diode, 'v(missing)', 'INVALID_REQUEST'],
    ['bad selector', diode, 'v(out,)', 'INVALID_REQUEST'],
    ['invalid F2OVERF1', diode.replace('100k\n', '100k 1\n'), 'v(out)', 'PARSE_ERROR'],
    ['unsupported model', diode.replace('CJO=5p', 'CJO=5p N=2'), 'v(out)', 'INVALID_CIRCUIT'],
    ['multiple analyses', diode.replace('.end', '.op\n.end'), 'v(out)', 'UNSUPPORTED_ANALYSIS'],
    ['control block', diode.replace('.end', '.control\nop\n.endc\n.end'), 'v(out)', 'UNSUPPORTED_ANALYSIS'],
    ['stepped analysis', diode.replace('.end', '.step param x list 1 2\n.end'), 'v(out)', 'PARSE_ERROR'],
    ['invalid F2 zero', diode.replace('100k\n', '100k 0\n'), 'v(out)', 'PARSE_ERROR'],
    ['invalid F2 negative', diode.replace('100k\n', '100k -0.9\n'), 'v(out)', 'PARSE_ERROR'],
  ])('returns structured errors: %s', async (_name, source, output, code) => {
    expect(await run(source, output)).toMatchObject({ isError: true, structuredContent: { error: { code, retryable: false } } });
  });
  it('advertises the tool and enforces point limits before solving', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent?.tools).toContain('spice_disto_metrics');
    expect(await executeTool('spice_disto_metrics', { request: { ...request(diode), options: { limits: { maxResultPoints: 2 } } }, output: 'v(out)' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });
  it('enforces serialized result limits and cancellation', async () => {
    expect(await executeTool('spice_disto_metrics', { request: { ...request(diode), options: { limits: { maxSerializedResultBytes: 100 } } }, output: 'v(out)' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    const abort = new AbortController();
    abort.abort();
    expect(await executeTool('spice_disto_metrics', { request: request(diode), output: 'v(out)' }, { signal: abort.signal })).toMatchObject({ isError: true, structuredContent: { error: { code: 'CANCELLED' } } });
  });
});
