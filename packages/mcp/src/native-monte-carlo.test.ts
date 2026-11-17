import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';
import { runMonteCarlo } from './monte-carlo.js';

const ports = (a: string, b: string) => [{ name: 'p', net: a }, { name: 'n', net: b }];
const components = [
  { type: 'V', id: 'V1', name: 'V1', ports: ports('in', '0'), params: { waveform: 'dc', dc: 10 } },
  { type: 'R', id: 'R1', name: 'R1', ports: ports('in', 'out'), params: { resistance: 1000 } },
  { type: 'R', id: 'R2', name: 'R2', ports: ports('out', '0'), params: { resistance: 1000 } },
];
const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in', 'out'] }, analyses: [{ type: 'op' }], models: [], subcircuits: [] };
const native = { apiVersion: '1', input: { format: 'spice-ts', document } } as unknown as SimulationRequestV1;
const text = { apiVersion: '1', input: { format: 'spice', source: '* divider\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op\n.end' } } as SimulationRequestV1;
const args = { runs: 4, seed: 12345, tolerances: [{ element: 'r1', sigma: 0.01, distribution: 'gaussian' }, { element: 'R2', sigma: 0.02, distribution: 'uniform' }], measurements: [{ kind: 'at', signal: 'v(out)', analysis: 0, at: 0 }] };

describe('native Monte Carlo', () => {
  it('matches text divider statistics, determinism and immutability', async () => {
    const before = structuredClone(native);
    const run = (request: SimulationRequestV1, seed = args.seed) => executeTool('spice_monte_carlo', { ...args, request, seed });
    const a = await run(native); const b = await run(text); const repeat = await run(native);
    expect(a.isError, JSON.stringify(a.structuredContent)).not.toBe(true);
    expect(b.isError, JSON.stringify(b.structuredContent)).not.toBe(true);
    const as = (a.structuredContent as { statistics: Record<string, number | string>[] }).statistics[0];
    const bs = (b.structuredContent as { statistics: Record<string, number | string>[] }).statistics[0];
    for (const key of Object.keys(as)) {
      if (typeof as[key] === 'number' && typeof bs[key] === 'number') {
        const delta = Math.abs((as[key] as number) - (bs[key] as number));
        expect(delta, key).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(bs[key] as number)));
      } else expect(as[key]).toEqual(bs[key]);
    }
    expect(repeat).toEqual(a);
    expect((await run(native, 5)).structuredContent).not.toEqual(a.structuredContent);
    expect(native).toEqual(before);
  }, 120000);

  it('matches RC transient measurement statistics', async () => {
    const cap = { type: 'C', id: 'C1', name: 'C1', ports: ports('out', '0'), params: { capacitance: 0.000001 } };
    const pulse = { ...components[0], params: { waveform: 'pulse', v1: 0, v2: 10, delay: 0, rise: 1e-6, fall: 1e-6, width: 0.0003, period: 0.001 } };
    const n = { ...native, input: { format: 'spice-ts', document: { ...document, circuit: { ...document.circuit, components: [pulse, components[1], cap] }, analyses: [{ type: 'tran', timestep: 0.0001, stopTime: 0.001 }] } } };
    const t = { apiVersion: '1', input: { format: 'spice', source: '* RC\nV1 in 0 PULSE(0 10 0 1u 1u 0.3m 1m)\nR1 in out 1k\nC1 out 0 1u\n.tran 0.1m 1m\n.end' } };
    const options = { ...args, tolerances: [{ element: 'C1', sigma: 0.01, distribution: 'uniform' }], measurements: [{ kind: 'avg', signal: 'v(out)', analysis: 0 }] };
    const a = await executeTool('spice_monte_carlo', { ...options, request: n });
    const b = await executeTool('spice_monte_carlo', { ...options, request: t });
    expect(a.isError, JSON.stringify(a.structuredContent)).not.toBe(true);
    expect(b.isError, JSON.stringify(b.structuredContent)).not.toBe(true);
    const x = (a.structuredContent as { statistics: Record<string, number>[] }).statistics[0];
    const y = (b.structuredContent as { statistics: Record<string, number>[] }).statistics[0];
    expect(x.std).toBeGreaterThan(0);
    for (const k of ['mean', 'std', 'min', 'max', 'p5', 'p95']) expect(Math.abs(x[k] - y[k]), k).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(y[k])));
  }, 120000);

  it('rejects invalid native targets before execution', async () => {
    const cases = [
      { parts: components, targets: ['Rmissing'], message: 'Unknown or ambiguous' },
      { parts: [...components, { ...components[1], name: 'r1' }], targets: ['R1'], message: 'Unknown or ambiguous' },
      { parts: components, targets: ['R1', 'r1'], message: 'Duplicate' },
      { parts: [components[0], { ...components[1], type: 'C' }], targets: ['R1'], message: 'component type' },
      ...[0, -1, Infinity, NaN, '1k', '{x}'].map(value => ({ parts: [components[0], { ...components[1], params: { resistance: value } }], targets: ['R1'], message: typeof value === 'number' ? 'finite and positive' : 'literal numeric' })),
    ];
    const unsupported = { apiVersion: '1', input: { format: 'circuit-json', circuit: [] } } as unknown as SimulationRequestV1;
    await expect(runMonteCarlo(args, unsupported, async () => { throw Error('unexpected worker'); }, () => {}))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('native spice-ts JSON IR') });
    for (const item of cases) {
      const request = { ...native, input: { format: 'spice-ts', document: { ...document, circuit: { ...document.circuit, components: item.parts } } } } as unknown as SimulationRequestV1;
      let executed = false;
      try {
        await runMonteCarlo({ ...args, tolerances: item.targets.map(element => ({ element, sigma: 0.1, distribution: 'uniform' })) }, request, async () => { executed = true; throw Error('unexpected worker'); }, () => {});
        throw Error('expected rejection');
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining(item.message) });
        expect(executed).toBe(false);
      }
    }
  });

  it('draws equal R/C/L samples from original nominal values', async () => {
    const parts = [
      { type: 'R', name: 'R1', id: 'R1', ports: ports('in', 'out'), params: { resistance: 1000 } },
      { type: 'C', name: 'C1', id: 'C1', ports: ports('out', '0'), params: { capacitance: 0.000001 } },
      { type: 'L', name: 'L1', id: 'L1', ports: ports('in', '0'), params: { inductance: 0.001 } },
    ];
    const n = { ...native, input: { format: 'spice-ts', document: { ...document, circuit: { ...document.circuit, components: parts } } } } as unknown as SimulationRequestV1;
    const t = { apiVersion: '1', input: { format: 'spice', source: '* RCL\nR1 in out 1k\nC1 out 0 1u\nL1 in 0 1m\n.end' } } as SimulationRequestV1;
    const tolerances = parts.map((p, i) => ({ element: p.name, sigma: 0.1, distribution: i === 1 ? 'uniform' : 'gaussian' }));
    const collect = async (request: SimulationRequestV1) => {
      const samples: number[][] = [];
      await runMonteCarlo({ ...args, tolerances }, request, async changed => {
        if (changed.input.format === 'spice-ts') samples.push(changed.input.document.circuit.components.map(c => Number(Object.values(c.params)[0])));
        else if (changed.input.format === 'spice') samples.push(changed.input.source.split('\n').slice(1, 4).map(line => Number(line.split(' ')[3])));
        return { content: [], structuredContent: { measurements: [{ value: 1, unit: 'V' }] } };
      }, () => {});
      return samples;
    };
    expect(await collect(n)).toEqual(await collect(t));
  });
});
