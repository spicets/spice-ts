import { expect, it } from 'vitest';
import { SParameterResult } from '@spice-ts/core';
import { sparamsReport } from './sparams.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';

it('reports backward sampled delay for wrapped nonuniform phases', () => {
  const frequencies = [100, 550, 1100, 1600];
  const delay = 0.0004;
  const values = frequencies.map(f => ({ real: Math.cos(-2 * Math.PI * f * delay), imaginary: Math.sin(-2 * Math.PI * f * delay) }));
  const raw = new SParameterResult(frequencies, ['p1', 'p2'], new Map([['S_2_1', values]]));
  const report = sparamsReport([raw], { netlist: '', portPair: [2, 1], includeGroupDelay: true });
  expect(report.points[0].parameters.S21).toHaveProperty('groupDelaySeconds', null);
  for (const point of report.points.slice(1)) {
    expect(Math.abs(point.parameters.S21.groupDelaySeconds! / delay - 1)).toBeLessThan(1e-10);
  }
  process.stdout.write(`synthetic max relative error: ${Math.max(...report.points.slice(1).map(p => Math.abs(p.parameters.S21.groupDelaySeconds! / delay - 1)))}\n`);
});

function sample(frequencies: number[], values: { real: number; imaginary: number }[]) {
  return new SParameterResult(frequencies, ['p1'], new Map([['S_1_1', values]]));
}

it('handles zeros, ambiguous pi, invalid spacing and segment boundaries', () => {
  const one = { real: 1, imaginary: 0 };
  const zero = { real: 0, imaginary: 0 };
  const minus = { real: -1, imaginary: 0 };
  const raw = sample([1, 2, 3, 4, 5, 5, 4, 6, 7], [one, one, zero, one, minus, one, one, one, one]);
  const report = sparamsReport([raw, sample([8], [one])], { netlist: '', includeGroupDelay: true });
  expect(report.points.map(p => p.parameters.S11.groupDelaySeconds)).toEqual([null, -0, null, null, null, null, null, -0, -0, null]);
  expect(sparamsReport([sample([1], [one])], { netlist: '', includeGroupDelay: true }).points[0].parameters.S11.groupDelaySeconds).toBeNull();
});

it('handles finite extreme amplitudes and rejects nonrepresentable delay', () => {
  const max = Number.MAX_VALUE;
  const min = Number.MIN_VALUE;
  const raw = sample([0, 1, 2], [{ real: max, imaginary: 0 }, { real: 0, imaginary: min }, { real: min, imaginary: 0 }]);
  const points = sparamsReport([raw], { netlist: '', includeGroupDelay: true }).points;
  expect(points.map(p => p.parameters.S11.groupDelaySeconds)).toEqual([null, -0.25, 0.25]);
  const tiny = sample([0, min], [{ real: 1, imaginary: 0 }, { real: 0, imaginary: 1 }]);
  expect(sparamsReport([tiny], { netlist: '', includeGroupDelay: true }).points[1].parameters.S11.groupDelaySeconds).toBeNull();
});

it('runs the public MCP tool and schemas on a passive series capacitor', async () => {
  const netlist = 'V1 in 0 portnum 1 z0 50\nV2 out 0 portnum 2 z0 50\nC1 in out 1u\n.sp lin 3 100 10000 0';
  const frequenciesHz = [123, 1234, 9876];
  const tool = MCP_TOOLS.find(t => t.name === 'spice_sparams')!;
  const validator = new AjvJsonSchemaValidator();
  const input = validator.getValidator(tool.inputSchema);
  const output = validator.getValidator(tool.outputSchema!);
  const args = { netlist, includeGroupDelay: true, portPair: [2, 1] };
  expect(input(args).valid).toBe(true);
  expect(input({ ...args, includeGroupDelay: 'yes' }).valid).toBe(false);
  const response = await executeTool('spice_sparams', args);
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(output(response.structuredContent).valid).toBe(true);
  const report = response.structuredContent as unknown as { points: { frequencyHz: number; parameters: Record<string, { groupDelaySeconds: number | null }> }[] };
  expect(report.points).toHaveLength(3);
  expect(report.points[0].parameters.S21.groupDelaySeconds).toBeNull();
  const phase = (f: number) => Math.atan(1 / (2 * Math.PI * f * 1e-6 * 100));
  const errors = report.points.slice(1).map((p, i) => {
    expect(Object.keys(p.parameters)).toEqual(['S21']);
    const previousFrequency = report.points[i].frequencyHz;
    const expected = -(phase(p.frequencyHz) - phase(previousFrequency)) / (2 * Math.PI * (p.frequencyHz - previousFrequency));
    return Math.abs(p.parameters.S21.groupDelaySeconds! / expected - 1);
  });
  process.stdout.write(`RC max relative error: ${Math.max(...errors)}\n`);
  expect(Math.max(...errors)).toBeLessThan(1e-8);
  const selected = await executeTool('spice_sparams', { ...args, frequenciesHz });
  const selectedPoints = (selected.structuredContent as unknown as typeof report).points;
  expect(selectedPoints.map(p => p.frequencyHz)).toEqual(frequenciesHz);
  expect(selectedPoints.map(p => p.parameters.S21.groupDelaySeconds)).toEqual([null, null, null]);
  const legacy = await executeTool('spice_sparams', { netlist });
  const disabled = await executeTool('spice_sparams', { netlist, includeGroupDelay: false });
  const enabled = await executeTool('spice_sparams', { netlist, includeGroupDelay: true });
  expect(disabled.structuredContent).toEqual(legacy.structuredContent);
  const stripped = structuredClone(enabled.structuredContent) as unknown as { points: { parameters: Record<string, { groupDelaySeconds?: number | null }> }[] };
  for (const point of stripped.points) for (const value of Object.values(point.parameters)) delete value.groupDelaySeconds;
  expect(stripped).toEqual(legacy.structuredContent);
  expect((await executeTool('spice_sparams', { ...args, includeGroupDelay: 'yes' })).structuredContent).toMatchObject({ error: { code: 'INVALID_REQUEST', phase: 'validation' } });
  expect((await executeTool('spice_sparams', args, { limits: { ...DEFAULT_MCP_LIMITS, maxResultPoints: 1 } })).structuredContent).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
});
