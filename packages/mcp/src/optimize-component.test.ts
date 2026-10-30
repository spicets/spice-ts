import { describe, expect, it } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { executeTool } from './server.js';
import { runOptimize } from './optimize.js';

const ports = (a: string, b: string) => [{ name: 'p', net: a }, { name: 'n', net: b }];
const components = [
  { type: 'V', id: 'V1', name: 'V1', ports: ports('in', '0'), params: { waveform: 'dc', dc: 10 } },
  { type: 'R', id: 'R1', name: 'R1', ports: ports('in', 'out'), params: { resistance: 1000 } },
  { type: 'R', id: 'R2', name: 'R2', ports: ports('out', '0'), params: { resistance: 1000 } },
];
const native = { apiVersion: '1', input: { format: 'spice-ts', document: { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in', 'out'] }, analyses: [{ type: 'op' }], models: [], subcircuits: [] } } } as unknown as SimulationRequestV1;
const text = { apiVersion: '1', input: { format: 'spice', source: '* divider\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op\n.end' } } as SimulationRequestV1;
const args = { parameters: [{ kind: 'component', name: 'R2', min: 1000, max: 9000 }], objective: { kind: 'at', signal: 'v(out)', analysis: 0, at: 0 }, target: 7.5, tolerance: 0.001, maxEvaluations: 40 };
type Result = { bestParams: Record<string, number>; achievedValue: number; evaluations: number; history: { params: Record<string, number>; value: number; error: number }[] };

describe('component optimization', () => {
  it.each(['R-load', 'R.1', 'R:1'])('optimizes native component named %s', async name => {
    const request = structuredClone(native);
    if (request.input.format !== 'spice-ts') throw new Error('Expected native input');
    request.input.document.circuit.components[2].name = name;
    const result = await executeTool('spice_optimize', { ...args, request, parameters: [{ ...args.parameters[0], name }] });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const optimized = result.structuredContent as unknown as Result;
    expect(Math.abs(optimized.achievedValue - 7.5)).toBeLessThanOrEqual(0.001);
    expect(optimized.bestParams[name]).toBeCloseTo(3000, -1);
  }, 120000);
  it('optimizes the native divider identically to text without mutation', async () => {
    const before = structuredClone(native);
    const a = await executeTool('spice_optimize', { ...args, request: native });
    const b = await executeTool('spice_optimize', { ...args, request: text });
    expect(a.isError, JSON.stringify(a.structuredContent)).not.toBe(true);
    expect(b.isError, JSON.stringify(b.structuredContent)).not.toBe(true);
    const x = a.structuredContent as unknown as Result; const y = b.structuredContent as unknown as Result;
    expect(Math.abs(x.achievedValue - 7.5)).toBeLessThanOrEqual(0.001);
    expect(x.evaluations).toBeLessThanOrEqual(40);
    expect(x.history.length).toBe(y.history.length);
    for (let i = 0; i < x.history.length; i++) for (const [v, w] of [[x.history[i].params.R2, y.history[i].params.R2], [x.history[i].value, y.history[i].value], [x.history[i].error, y.history[i].error]]) expect(Math.abs(v - w)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(w)));
    expect(Math.abs(x.bestParams.R2 - y.bestParams.R2)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(y.bestParams.R2)));
    expect(await executeTool('spice_optimize', { ...args, request: native })).toEqual(a);
    expect(native).toEqual(before);
    console.info('component receipt', JSON.stringify({ residual: Math.abs(x.achievedValue - 7.5), evaluations: x.evaluations, best: x.bestParams.R2, historyDelta: Math.max(...x.history.map((h, i) => Math.abs(h.value - y.history[i].value))) }));
  }, 120000);

  it.each(['C', 'L'])('resolves %s values before executing', async type => {
    const field = type === 'C' ? 'capacitance' : 'inductance';
    const component = { type, id: `${type}1`, name: `${type}1`, ports: ports('out', '0'), params: { [field]: 1 } };
    const request = structuredClone(native);
    if (request.input.format !== 'spice-ts') throw new Error('wrong fixture');
    request.input.document.circuit.components.push(component);
    const seen: number[] = [];
    await runOptimize({ ...args, parameters: [{ kind: 'component', name: `${type}1`, min: 1, max: 2 }], maxEvaluations: 1 }, request, async changed => {
      if (changed.input.format !== 'spice-ts') throw new Error('wrong input');
      seen.push(Number(changed.input.document.circuit.components.at(-1)?.params[field]));
      return { isError: true, content: [], structuredContent: { error: { code: 'TEST' } } };
    }, () => {});
    expect(seen).toEqual([1]);
  });

  it('rejects invalid component targets and bounds before simulation', async () => {
    const bad = [
      [{ kind: 'component', name: 'missing', min: 1, max: 2 }],
      [{ kind: 'component', name: 'R/1', min: 1, max: 2 }],
      [{ kind: 'param', name: 'R-load', min: 1, max: 2 }],
      [{ name: 'R-load', min: 1, max: 2 }],
      [{ kind: 'component', name: 'V1', min: 1, max: 2 }],
      [{ kind: 'component', name: 'R2', min: 0, max: 2 }],
      [{ kind: 'component', name: 'R2', min: 1, max: Infinity }],
      [{ kind: 'bad', name: 'R2', min: 1, max: 2 }],
      [{ kind: 'component', name: 'R2', min: 1, max: 2 }, { kind: 'component', name: 'r2', min: 1, max: 2 }],
    ];
    for (const parameters of bad) {
      let executions = 0;
      await expect(runOptimize({ ...args, parameters }, native, async () => { executions++; return { content: [] }; }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(executions).toBe(0);
    }
    const request = structuredClone(native);
    if (request.input.format !== 'spice-ts') throw new Error('wrong fixture');
    request.input.document.circuit.components[2].type = 'C';
    await expect(runOptimize(args, request, async () => { throw new Error('executed'); }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const duplicate = structuredClone(native);
    if (duplicate.input.format !== 'spice-ts') throw new Error('wrong fixture');
    duplicate.input.document.circuit.components.push({ ...duplicate.input.document.circuit.components[2], name: 'r2' });
    await expect(runOptimize(args, duplicate, async () => { throw new Error('executed'); }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const subcircuit = { ...text, input: { format: 'spice', source: '* nested only\n.subckt nested a b\nR2 a b 1k\n.ends\n.end' } } as SimulationRequestV1;
    await expect(runOptimize(args, subcircuit, async () => { throw new Error('executed'); }, () => {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('applies explicit param and component overrides together', async () => {
    const request = { ...text, input: { format: 'spice', source: '* mixed\n.param r=1k\nV1 in 0 10\nR1 in out {r}\nR2 out 0 1k\n.op\n.end' } } as SimulationRequestV1;
    let source = '';
    await runOptimize({ ...args, parameters: [{ kind: 'param', name: 'r', min: 1000, max: 2000 }, args.parameters[0]], maxEvaluations: 1 }, request, async changed => {
      if (changed.input.format !== 'spice') throw new Error('wrong input');
      source = changed.input.source;
      return { isError: true, content: [], structuredContent: { error: { code: 'TEST' } } };
    }, () => {});
    expect(source).toContain('.param r=1500');
    expect(source).toContain('R2 out 0 5000');
  });
});
