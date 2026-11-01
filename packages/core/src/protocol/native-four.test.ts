import { describe, expect, it, vi } from 'vitest';
import * as fourierCore from '../parser/control/fourier.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { simulateProtocolV1, validateProtocolV1 } from './adapter.js';
import { executeProtocolV1 } from './envelopes.js';
import { protocolSchemasV1 } from './wire/schemas.js';
import type { SimulationRequestV1, SpiceTsCircuitDocumentV1 } from './types.js';

const deck = 'V1 in 0 PULSE(0 1 0 1u 1u 0.3m 1m)\nR1 in out 1000\nR2 out 0 1000';
function request(): SimulationRequestV1 {
  const component = (type: string, name: string, nets: string[], params: Record<string, string | number>) => ({ type, name, id: name, ports: nets.map((net, i) => ({ name: String(i), net })), params });
  return { apiVersion: '1', input: { format: 'spice-ts', document: {
    format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [],
    circuit: { nets: ['in', 'out'], components: [
      component('V', 'V1', ['in', '0'], { waveform: 'pulse', v1: 0, v2: 1, delay: 0, rise: 1e-6, fall: 1e-6, width: 0.0003, period: 0.001 }),
      component('R', 'R1', ['in', 'out'], { resistance: 1000 }),
      component('R', 'R2', ['out', '0'], { resistance: 1000 }),
    ] }, analyses: [{ type: 'tran', timestep: 1e-5, stopTime: 0.003, fourier: { fundamentalHz: 1000, outputs: ['v(out)', 'v(in,out)', 'i(V1)'] } }],
  } as SpiceTsCircuitDocumentV1 } };
}

describe('native protocol Fourier', () => {
  it.each(['cancellation', 'deadline'] as const)('stops between Fourier outputs on %s', async mode => {
    const input = request();
    input.options = { limits: { maxWallTimeMs: 5 } };
    let outputsStarted = 0;
    let expired = false;
    const signal = { aborted: false };
    const transform = vi.spyOn(fourierCore, 'ngspiceFourier');
    try {
      await expect(simulateProtocolV1(input, {
        signal,
        now: () => expired ? 6 : 0,
        onSafePoint(point) {
          // String comparison also lets this regression run against the old safe-point union.
          if (String(point) === 'solve:fourier-output' && ++outputsStarted === 2) {
            if (mode === 'cancellation') signal.aborted = true;
            else expired = true;
          }
        },
      })).rejects.toMatchObject({ apiError: {
        code: mode === 'cancellation' ? 'CANCELLED' : 'RESOURCE_LIMIT',
        phase: 'solve', details: { safePoint: 'solve:fourier-output', ...(mode === 'deadline' ? { limit: 'maxWallTimeMs', configured: 5, observed: 6 } : {}) },
      } });
      expect(outputsStarted).toBe(2);
      expect(transform).toHaveBeenCalledTimes(1);
    } finally {
      transform.mockRestore();
    }
  });
  it.each([16, 17])('bounds Fourier outputs consistently at 16 (requested %i)', async count => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    const analysis = input.input.document.analyses[0];
    if (analysis.type !== 'tran' || !analysis.fourier) throw new Error('fourier');
    analysis.fourier.outputs = Array<string>(count).fill('v(out)');
    analysis.fourier.harmonics = 199;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', input)).toBe(count === 16);
    if (count === 16) {
      expect((await executeProtocolV1(input)).ok).toBe(true);
    } else {
      expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: {
        code: 'INVALID_REQUEST', phase: 'validation', details: { path: '/input/document/analyses/0/fourier/outputs' },
      } });
      await expect(validateProtocolV1(input)).rejects.toMatchObject({ apiError: {
        code: 'INVALID_REQUEST', details: { path: '/input/document/analyses/0/fourier/outputs' },
      } });
    }
  });
  it('validates request/result schemas including JSON-safe zero-signal tables', async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const schema of Object.values(protocolSchemasV1)) ajv.addSchema(schema);
    const input = request();
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', input)).toBe(true);
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', await simulateProtocolV1(input))).toBe(true);
    for (const fourier of [null, { fundamentalHz: 0, outputs: ['v(out)'] }, { fundamentalHz: 1000, outputs: [] }, { fundamentalHz: 1000, outputs: ['v(out)+1'] }, { fundamentalHz: 1000, outputs: ['v(out)'], harmonics: 200 }]) {
      const invalid = structuredClone(input);
      if (invalid.input.format !== 'spice-ts') throw new Error('native');
      Object.assign(invalid.input.document.analyses[0], { fourier });
      expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-request.schema.json', invalid)).toBe(false);
    }
    if (input.input.format !== 'spice-ts') throw new Error('native');
    input.input.document.circuit.components[0].params.v2 = 0;
    const result = await simulateProtocolV1(input);
    const transient = result.analyses[0];
    if (transient.type !== 'tran') throw new Error('transient');
    expect(transient.fourier![0].thd).toBeNull();
    expect(transient.fourier![0].harmonics[0].magnitude).toBe(0);
    expect(transient.fourier![0].harmonics[1].normalizedMagnitude).toBeNull();
    expect(ajv.validate('https://spice-ts.dev/schemas/v1/simulation-result.schema.json', result)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('keeps custom harmonics isolated to their transient and leaves defaults unchanged', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    input.input.document.analyses.push({ type: 'tran', timestep: 1e-5, stopTime: 0.003 }, { type: 'tran', timestep: 1e-5, stopTime: 0.003, fourier: { fundamentalHz: 1000, outputs: ['v(out)'], harmonics: 3 } });
    const result = await simulateProtocolV1(input);
    expect(result.analyses[0]).toMatchObject({ fourier: [{ harmonics: expect.any(Array) }, {}, {}] });
    expect(result.analyses[1]).not.toHaveProperty('fourier');
    const third = result.analyses[2];
    if (third.type !== 'tran') throw new Error('transient');
    expect(third.fourier![0].harmonics).toHaveLength(4);
    expect(third.fourier![0].harmonics[3].frequency).toBe(3000);
  });
  it.each([
    [{ fundamentalHz: 0, outputs: ['v(out)'] }, 'fundamentalHz'],
    [{ fundamentalHz: NaN, outputs: ['v(out)'] }, 'fundamentalHz'],
    [{ fundamentalHz: Infinity, outputs: ['v(out)'] }, 'fundamentalHz'],
    [{ fundamentalHz: 1000, outputs: [] }, 'outputs'],
    [{ fundamentalHz: 1000, outputs: ['v(missing)'] }, 'outputs/0'],
    [{ fundamentalHz: 1000, outputs: ['v(in,missing)'] }, 'outputs/0'],
    [{ fundamentalHz: 1000, outputs: ['i(R1)'] }, 'outputs/0'],
    [{ fundamentalHz: 1000, outputs: ['i(Vmissing)'] }, 'outputs/0'],
    [{ fundamentalHz: 1000, outputs: ['v(out)+1'] }, 'outputs/0'],
    [{ fundamentalHz: 1000, outputs: ['v(out)'], harmonics: 0 }, 'harmonics'],
    [{ fundamentalHz: 1000, outputs: ['v(out)'], harmonics: 200 }, 'harmonics'],
    [{ fundamentalHz: 1000, outputs: ['v(out)'], harmonics: 1.5 }, 'harmonics'],
    [null, ''],
  ])('rejects invalid Fourier %j at an exact pointer', async (fourier, field) => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    Object.assign(input.input.document.analyses[0], { fourier });
    const path = `/input/document/analyses/0/fourier${field ? `/${field}` : ''}`;
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', phase: 'validation', details: { path } } });
    await expect(validateProtocolV1(input)).rejects.toMatchObject({ apiError: { code: 'INVALID_REQUEST', details: { path } } });
  });
  it('rejects Fourier on non-transient analyses', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    Object.assign(input.input.document.analyses[0], { type: 'op' });
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: '/input/document/analyses/0/fourier' } } });
  });
  it('maps insufficient waveform span to structured validation failure', async () => {
    const input = request();
    if (input.input.format !== 'spice-ts') throw new Error('native');
    Object.assign(input.input.document.analyses[0], { stopTime: 0.0001 });
    expect(await executeProtocolV1(input)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST', details: { path: '/input/document/analyses/0/fourier/fundamentalHz' } } });
  });
  it('matches actual netlist .four tables within 1e-12 relative with nonzero signal and THD', async () => {
    const actual = await simulateProtocolV1(request());
    const text = await simulateProtocolV1({ apiVersion: '1', input: { format: 'spice', source: `${deck}\n.tran 10u 3m\n.four 1000 v(out) v(in,out) i(V1)` } });
    const result = actual.analyses[0];
    expect((text.analyses[0] as typeof result)).toHaveProperty('fourier');
    expect(result.type).toBe('tran');
    if (result.type !== 'tran') throw new Error('expected transient');
    expect(result.fourier).toHaveLength(3);
    expect(result.fourier![0].harmonics).toHaveLength(10);
    expect(result.fourier![0].harmonics[1].magnitude).toBeGreaterThan(0);
    expect(result.fourier![0].thd).toBeGreaterThan(0);
    const compare = (actual: unknown, expected: unknown): void => {
      if (typeof expected === 'number') {
        expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-12);
      } else if (expected && typeof expected === 'object') {
        for (const [key, value] of Object.entries(expected)) compare((actual as Record<string, unknown>)[key], value);
      } else expect(actual).toEqual(expected);
    };
    compare(result.fourier, (text.analyses[0] as typeof result).fourier);
  });
});
