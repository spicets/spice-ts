import { expect, it } from 'vitest';
import { SParameterResult } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { sparamsReport } from './sparams.js';

type Complex = { real: number; imaginary: number };
const c = (real: number, imaginary: number): Complex => ({ real, imaginary });

it('computes the complex difference using the unselected reverse vector', () => {
  const raw = new SParameterResult([100], ['p1', 'p2'], new Map([
    ['S_2_1', [c(3, 4)]], ['S_1_2', [c(0, 0)]],
  ]));
  const point = sparamsReport([raw], { netlist: '', portPair: [2, 1], includeReciprocity: true });
  expect(point.points[0].parameters.S21).toHaveProperty('reciprocityDifferenceMagnitude', 5);
});

it('handles asymmetric three-port matrices, zero, diagonals, and segments independently', () => {
  const make = (f: number, scale: number) => new SParameterResult([f], ['p1', 'p2', 'p3'], new Map([
    ['S_1_1', [c(1, 2)]], ['S_1_2', [c(3 * scale, 4 * scale)]], ['S_1_3', [c(0, 0)]],
    ['S_2_1', [c(0, 0)]], ['S_2_2', [c(0, 0)]], ['S_2_3', [c(scale, scale)]],
    ['S_3_1', [c(0, 0)]], ['S_3_2', [c(-2 * scale, -3 * scale)]], ['S_3_3', [c(-1, 7)]],
  ]));
  const report = sparamsReport([make(100, 1), make(200, 2)], { netlist: '', includeReciprocity: true, includeGroupDelay: true });
  const expected = [5, 10];
  const errors = report.points.map((point, index) => {
    expect(point.frequencyHz).toBe([100, 200][index]);
    expect(Object.keys(point.parameters)).toEqual(['S11', 'S12', 'S13', 'S21', 'S22', 'S23', 'S31', 'S32', 'S33']);
    for (const key of ['S11', 'S22', 'S33', 'S13', 'S31']) expect(point.parameters[key].reciprocityDifferenceMagnitude).toBe(0);
    expect(point.parameters.S12.reciprocityDifferenceMagnitude).toBe(point.parameters.S21.reciprocityDifferenceMagnitude);
    expect(point.parameters.S23.reciprocityDifferenceMagnitude).toBe(expected[index]);
    expect(point.parameters.S32.reciprocityDifferenceMagnitude).toBe(expected[index]);
    expect(point.parameters.S12.groupDelaySeconds).toBeNull();
    return Math.abs(point.parameters.S12.reciprocityDifferenceMagnitude! / expected[index] - 1);
  });
  process.stdout.write(`synthetic maximum relative error: ${Math.max(...errors)}\n`);
  expect(Math.max(...errors)).toBeLessThanOrEqual(1e-12);
});

it('returns null for missing, nonfinite or unrepresentable reverse differences', () => {
  const max = Number.MAX_VALUE;
  const forward = [c(1, 0), c(1, 0), c(1, 0), c(max, 0), c(max * 0.75, max * 0.5), c(max, 0)];
  const reverse = [c(0, 0), c(NaN, 0), c(0, Infinity), c(-max, 0), c(-max * 0.25, -max * 0.5)];
  const raw = new SParameterResult([1, 2, 3, 4, 5, 6], ['p1', 'p2'], new Map([['S_2_1', forward], ['S_1_2', reverse]]));
  const report = sparamsReport([raw], { netlist: '', portPair: [2, 1], includeReciprocity: true });
  expect(report.points.map(p => p.parameters.S21.reciprocityDifferenceMagnitude)).toEqual([1, null, null, null, null, null]);
  const absent = new SParameterResult([1], ['p1', 'p2'], new Map([['S_2_1', [c(1, 0)]]]));
  expect(sparamsReport([absent], { netlist: '', portPair: [2, 1], includeReciprocity: true }).points[0].parameters.S21.reciprocityDifferenceMagnitude).toBeNull();
});

it('exposes validated reciprocity through the public MCP on an equal-reference passive RC network', async () => {
  const netlist = 'V1 in 0 portnum 1 z0 50\nV2 out 0 portnum 2 z0 50\nR1 in out 100\nC1 out 0 1u\n.sp lin 3 100 10000 0';
  const frequenciesHz = [123, 1234, 9876];
  const tool = MCP_TOOLS.find(t => t.name === 'spice_sparams')!;
  const validator = new AjvJsonSchemaValidator();
  const input = validator.getValidator(tool.inputSchema);
  const output = validator.getValidator(tool.outputSchema!);
  const args = { netlist, includeReciprocity: true, includeGroupDelay: true, frequenciesHz, portPair: [2, 1] };
  expect(input(args).valid).toBe(true);
  expect(input({ ...args, includeReciprocity: 'true' }).valid).toBe(false);
  const response = await executeTool('spice_sparams', args);
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(output(response.structuredContent).valid).toBe(true);
  const report = response.structuredContent as unknown as { points: { frequencyHz: number; parameters: Record<string, { reciprocityDifferenceMagnitude: number; groupDelaySeconds: number | null }> }[] };
  expect(report.points.map(p => p.frequencyHz)).toEqual(frequenciesHz);
  for (const point of report.points) {
    expect(Object.keys(point.parameters)).toEqual(['S21']);
    expect(point.parameters.S21.groupDelaySeconds).toBeNull();
  }
  const maxDifference = Math.max(...report.points.map(p => p.parameters.S21.reciprocityDifferenceMagnitude));
  process.stdout.write(`RC maximum absolute reciprocity difference: ${maxDifference}\n`);
  expect(maxDifference).toBeLessThanOrEqual(1e-10);
  const legacy = await executeTool('spice_sparams', { netlist });
  const disabled = await executeTool('spice_sparams', { netlist, includeReciprocity: false });
  const enabled = await executeTool('spice_sparams', { netlist, includeReciprocity: true });
  expect(disabled.structuredContent).toEqual(legacy.structuredContent);
  const stripped = structuredClone(enabled.structuredContent) as unknown as { points: { parameters: Record<string, { reciprocityDifferenceMagnitude?: number | null }> }[] };
  for (const point of stripped.points) for (const value of Object.values(point.parameters)) delete value.reciprocityDifferenceMagnitude;
  expect(stripped).toEqual(legacy.structuredContent);
  expect((await executeTool('spice_sparams', { netlist, includeReciprocity: 'true' })).structuredContent).toMatchObject({ error: { code: 'INVALID_REQUEST', phase: 'validation' } });
});
