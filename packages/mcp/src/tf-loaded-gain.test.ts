import { describe, expect, it } from 'vitest';
import { parseTitleless, simulate } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';
import { tfArgs, tfReport } from './tf.js';

const deck = 'V1 in 0 1\nR1 in out 1k\nR2 out 0 3k\n.end';
const args = { netlist: deck, output: 'v(out)', input_source: 'V1' };
const tool = MCP_TOOLS.find(t => t.name === 'spice_tf')!;
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 + 1e-10 * Math.abs(expected));

describe('loaded voltage transfer gain', () => {
  it('matches an analytic divider and an independently loaded core deck', async () => {
    const response = await executeTool('spice_tf', { ...args, loadResistanceOhm: 1500 });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const result = response.structuredContent!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(result).valid).toBe(true);
    expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)({ ...args, loadResistanceOhm: 1500 }).valid).toBe(true);
    const core = (await simulate(parseTitleless('V1 in 0 1\nR1 in out 1k\nR2 out 0 3k\nRL out 0 1.5k\n.tf v(out) V1\n.end'))).transferFunction!;
    close(result.loaded_transfer_function as number, 0.5);
    close(result.loaded_transfer_function as number, core.transfer);
    expect(result).toMatchObject({ transfer_function: 0.75, output_resistance: 750, units: { transfer_function: 'V/V', loaded_transfer_function: 'V/V' } });
    console.log('oracle errors', Math.abs((result.loaded_transfer_function as number) - 0.5), Math.abs((result.loaded_transfer_function as number) - core.transfer));
  });

  it('loads a differential output across its two terminals', async () => {
    const netlist = 'V1 in 0 1\nR1 in a 1k\nR2 a 0 3k\nR3 in b 2k\nR4 b 0 2k\n.end';
    const response = await executeTool('spice_tf', { netlist, output: 'v(a,b)', input_source: 'V1', loadResistanceOhm: 1000 });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const core = (await simulate(parseTitleless(netlist.replace('.end', 'RL a b 1k\n.tf v(a,b) V1\n.end')))).transferFunction!;
    close(response.structuredContent!.loaded_transfer_function as number, core.transfer);
    console.log('differential oracle error', Math.abs((response.structuredContent!.loaded_transfer_function as number) - core.transfer));
  });

  it('accepts a protocol-v1 request with the same loaded result', async () => {
    const legacy = await executeTool('spice_tf', { ...args, loadResistanceOhm: 1500 });
    const response = await executeTool('spice_tf', { request: { apiVersion: '1', input: { format: 'spice', source: deck } }, output: 'v(out)', input_source: 'V1', loadResistanceOhm: 1500 });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(legacy.structuredContent);
  });

  it('uses transresistance units for current inputs', async () => {
    const response = await executeTool('spice_tf', { netlist: 'I1 0 out 1m\nR1 out 0 2k\n.end', output: 'v(out)', input_source: 'I1', loadResistanceOhm: 2000 });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ loaded_transfer_function: 1000, units: { loaded_transfer_function: 'V/A' } });
  });

  it('keeps the default output exactly unchanged when no load is supplied', async () => {
    const response = await executeTool('spice_tf', args);
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).not.toHaveProperty('loaded_transfer_function');
    expect(response.structuredContent!.units).not.toHaveProperty('loaded_transfer_function');
  });

  it.each([0, -1, Infinity, -Infinity, NaN, '100'])('rejects invalid load %s', async loadResistanceOhm => {
    const response = await executeTool('spice_tf', { ...args, loadResistanceOhm });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });

  it('rejects loading a current output', async () => {
    expect(await executeTool('spice_tf', { ...args, output: 'i(V1)', loadResistanceOhm: 1 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
  });

  const report = (transfer: number, outputResistance: number, load: number) => tfReport(
    { transfer, outputResistance, inputResistance: 1, inputSource: 'V1' } as Parameters<typeof tfReport>[0],
    tfArgs({ ...args, loadResistanceOhm: load }),
  ).loaded_transfer_function!;

  it('handles zero output resistance and large finite sums', () => {
    expect(report(3, 0, 1)).toBe(3);
    close(report(1, 1e308, 1e308), 0.5);
  });

  it('preserves representable gains even when an intermediate ratio underflows', () => {
    expect(report(1e300, 1e300, 1e-100) / 1e-100).toBeCloseTo(1, 10);
    expect(report(1e300, 1e300, 1e-23) / 1e-23).toBeCloseTo(1, 10);
    expect(report(1e-300, -1 + Number.EPSILON, 1) / (1e-300 / Number.EPSILON)).toBeCloseTo(1, 10);
  });

  it('rejects singular and unrepresentable results with structured errors', () => {
    for (const values of [[1, -1, 1], [1e308, -1 + Number.EPSILON, 1], [1e-300, 1e300, 1e-300]]) {
      expect(() => report(values[0]!, values[1]!, values[2]!)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', phase: 'validation' }));
    }
  });
});
