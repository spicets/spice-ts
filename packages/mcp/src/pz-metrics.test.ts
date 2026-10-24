import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { pzMetrics } from './pz-metrics.js';
import { PoleZeroResult } from '@spice-ts/core';

const request = (source: string) => ({ apiVersion: '1', input: { format: 'spice', source } });
const rlc = readFileSync(new URL('../fixtures/pz-rlc.cir', import.meta.url), 'utf8');
const rc = 'R1 in 0 1k\nC1 in 0 1u\n.pz in 0 in 0 cur pz\n.end';
const validator = new AjvJsonSchemaValidator();
async function run(source: string) {
  const response = await executeTool('spice_pz_metrics', { request: request(source) });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(validator.getValidator(MCP_TOOLS.find(t => t.name === 'spice_pz_metrics')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as {
    poles: { re: number; im: number; frequencyHz: number }[];
    zeros: { re: number; im: number; frequencyHz: number }[];
    conjugatePairs: { kind: string; naturalFrequencyRadPerSec: number; naturalFrequencyHz: number; dampingRatio: number; q: number | null }[];
    dominantPole: { re: number; im: number } | null;
    rightHalfPlaneCount: number; stable: boolean;
  };
}

describe('spice_pz_metrics', () => {
  it('matches analytic second-order RLC poles, natural frequency, damping and Q within 1e-6 relative', async () => {
    const m = await run(rlc);
    expect(m.poles).toHaveLength(2);
    expect(m.zeros).toHaveLength(0);
    const pair = m.conjugatePairs.find(p => p.kind === 'pole')!;
    for (const [actual, expected] of [[m.poles[0].re, -500], [Math.abs(m.poles[0].im), Math.sqrt(750000)], [pair.naturalFrequencyRadPerSec, 1000], [pair.dampingRatio, 0.5], [pair.q!, 1], [pair.naturalFrequencyHz, 1000 / (2 * Math.PI)]]) {
      expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-6);
    }
    expect(m).toMatchObject({ stable: true, rightHalfPlaneCount: 0, dominantPole: m.poles[0] });
  });
  it('returns a real RC pole without inventing a conjugate pair', async () => {
    const m = await run(rc);
    expect(Math.abs(m.poles[0].re / -1000 - 1)).toBeLessThan(1e-6);
    expect(m.poles[0].im).toBe(0);
    expect(m.poles[0].frequencyHz).toBeCloseTo(1000 / (2 * Math.PI), 8);
    expect(m.conjugatePairs).toEqual([]);
    expect(m.stable).toBe(true);
  });
  it('reports a right-half-plane pole as unstable', async () => {
    const m = await run(rc.replace('1k', '-1k'));
    expect(m.poles[0].re).toBeCloseTo(1000, 6);
    expect(m).toMatchObject({ stable: false, rightHalfPlaneCount: 1 });
  });
  it.each([
    ['missing .pz', 'R1 in 0 1k', 'INVALID_REQUEST'],
    ['multiple .pz', rc.replace('.end', '.pz in 0 in 0 cur pol\n.end'), 'INVALID_REQUEST'],
    ['stepped .pz', rc.replace('.end', '.step param r LIST 1 2\n.end'), 'PARSE_ERROR'],
    ['zeros-only cannot establish stability', rc.replace('cur pz', 'cur zer'), 'INVALID_REQUEST'],
    ['singular', 'C1 in 0 1u\nR1 a b 1k\n.pz in 0 in 0 cur pz', 'INVALID_CIRCUIT'],
    ['unsupported', rc.replace('cur pz', 'invalid pz'), 'PARSE_ERROR'],
  ])('returns structured errors for %s', async (_name, source, code) => {
    const response = await executeTool('spice_pz_metrics', { request: request(source) });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code, retryable: false } } });
    expect(validator.getValidator(MCP_TOOLS.find(t => t.name === 'spice_pz_metrics')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  });
  it('advertises the tool and enforces resource bounds', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent?.tools).toContain('spice_pz_metrics');
    expect(await executeTool('spice_pz_metrics', { request: { ...request(rc), options: { limits: { maxResultPoints: 0 } } } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });
  it('supports poles-only mode and skips unrelated analyses', async () => {
    const m = await run(rc.replace('cur pz', 'cur pol').replace('.end', '.op\n.end'));
    expect(m.poles).toHaveLength(1);
    expect(m.zeros).toEqual([]);
  });
  const poleZeroAnalyses = [{ type: 'pz', inputPositive: 'in', inputNegative: '0', outputPositive: 'in', outputNegative: '0', inputType: 'cur', mode: 'pz' }];
  const lowpass = rc;
  const components = [
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
    { type: 'C', id: 'C1', name: 'C1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { capacitance: 1e-6 } },
  ];
  const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in'] }, analyses: [], models: [], subcircuits: [], poleZeroAnalyses };
  const circuit = [
    { type: 'source_net', source_net_id: 'in', name: 'in' },
    { type: 'source_net', source_net_id: '0', name: '0' },
    ...components.flatMap((component, i) => [
      { type: 'source_component', source_component_id: component.id, name: component.name,
        ftype: ['simple_resistor', 'simple_capacitor'][i],
        ...[{ resistance: 1000 }, { capacitance: 1e-6 }][i] },
      ...component.ports.flatMap((port, j) => [
        { type: 'source_port', source_port_id: `${component.id}-${j}`, source_component_id: component.id, name: port.name, pin_number: j + 1 },
        { type: 'source_trace', source_trace_id: `${component.id}-${j}`, connected_source_port_ids: [`${component.id}-${j}`], connected_source_net_ids: [port.net] },
      ]),
    ]),
  ];
  const jsonInputs = [
    { format: 'spice-ts', document },
    { format: 'circuit-json', circuit, analyses: [], poleZeroAnalyses },
  ];
  it.each(jsonInputs)('matches all SPICE RC lowpass metrics for $format', async input => {
    const expected = await run(lowpass);
    const response = await executeTool('spice_pz_metrics', { request: { apiVersion: '1', input } });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(expected);
  });
  it.each(jsonInputs)('accepts $format in the tool input schema', input => {
    const schema = MCP_TOOLS.find(t => t.name === 'spice_pz_metrics')!.inputSchema;
    expect(validator.getValidator(schema)({ request: { apiVersion: '1', input } }).valid).toBe(true);
  });
  it('advertises all accepted input formats', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent?.inputFormats).toEqual(['spice', 'spice-ts', 'circuit-json']);
  });
  it('returns conversion diagnostics for unsupported circuit-json', async () => {
    const response = await executeTool('spice_pz_metrics', { request: { apiVersion: '1', input: {
      format: 'circuit-json', circuit: [{ type: 'source_component', source_component_id: 'U1', name: 'U1', ftype: 'simple_chip' }], analyses: [], poleZeroAnalyses,
    } } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'UNSUPPORTED_ELEMENT', retryable: false, details: { diagnostics: expect.any(Array) } } } });
  });
  it.each([{}, { ...document, poleZeroAnalyses: [{ ...poleZeroAnalyses[0], inputType: 'invalid' }] }, { ...document, poleZeroAnalyses: {} }])('rejects malformed JSON IR as INVALID_REQUEST', document => {
    return expect(executeTool('spice_pz_metrics', { request: { apiVersion: '1', input: { format: 'spice-ts', document } } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });
  it('handles marginal poles, signed Q, repeated conjugate roots and zero pairs without claiming stability', () => {
    const roots = [{ real: 0, imaginary: 2 }, { real: 0, imaginary: -2 }];
    const m = pzMetrics(new PoleZeroResult('in', '0', 'out', '0', [...roots, ...roots], [{ real: 1, imaginary: 2 }, { real: 1, imaginary: -2 }]));
    expect(m.stable).toBe(false);
    expect(m.rightHalfPlaneCount).toBe(0);
    expect(m.conjugatePairs.map(p => [p.kind, p.indices, p.q])).toEqual([
      ['pole', [0, 1], null], ['pole', [2, 3], null], ['zero', [0, 1], -Math.sqrt(5) / 2],
    ]);
    expect(pzMetrics(new PoleZeroResult('in', '0', 'out', '0', [], [])).dominantPole).toBeNull();
  });
});
