import { describe, expect, it } from 'vitest';
import { parseTitleless, simulate } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

// Two unloaded dividers: Va/Vin = 3/4, Vb/Vin = 1/2.
const deck = 'V1 in 0 1\nR1 in a 1k\nR2 a 0 3k\nR3 in b 2k\nR4 b 0 2k';
const components = [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 1 } },
  ...[['R1', 'in', 'a', 1000], ['R2', 'a', '0', 3000], ['R3', 'in', 'b', 2000], ['R4', 'b', '0', 2000]].map(([name, p, n, resistance]) => ({
    type: 'R', id: name, name, ports: [{ name: 'p', net: p }, { name: 'n', net: n }], params: { resistance },
  })),
];
const document = { format: 'spice-ts', schemaVersion: '1.0', models: [], subcircuits: [], circuit: { nets: ['in', 'a', 'b'], components }, analyses: [] };
const forms = [
  { netlist: deck },
  { request: { apiVersion: '1', input: { format: 'spice-ts', document } } },
];
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, Math.abs(expected) * 1e-9));

describe('differential spice_tf', () => {
  it.each(['v({0},a)', 'v(a,{0})'])('rejects expressions in either terminal for all request forms: %s', async output => {
    const numericDeck = deck.replaceAll(' b ', ' 0.000000000000000e+0 ');
    const numericDocument = JSON.parse(JSON.stringify(document).replaceAll('"b"', '"0.000000000000000e+0"'));
    const inputs = [
      { netlist: numericDeck },
      { request: { apiVersion: '1', input: { format: 'spice', source: numericDeck } } },
      { request: { apiVersion: '1', input: { format: 'spice-ts', document: numericDocument } } },
    ];
    for (const form of inputs) {
      const response = await executeTool('spice_tf', { ...form, output, input_source: 'V1' });
      expect(response.structuredContent, JSON.stringify(response)).toMatchObject({ error: { code: 'INVALID_REQUEST', phase: 'validation' } });
    }
  });
  it('preserves numeric and punctuation-containing literal node names', async () => {
    const netlist = deck.replaceAll(' b ', ' 0.000000000000000e+0 ').replaceAll(' a ', ' node+1 ');
    const response = await executeTool('spice_tf', { netlist, output: 'v(node+1,0.000000000000000e+0)', input_source: 'V1' });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    close(response.structuredContent!.transfer_function as number, 0.25);
  });

  it.each(forms)('matches core and analytic bridge for %j', async form => {
    const args = { ...form, output: 'v(a,b)', input_source: 'V1' };
    const tool = MCP_TOOLS.find(t => t.name === 'spice_tf')!;
    expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid).toBe(true);
    const response = await executeTool('spice_tf', args);
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    const result = response.structuredContent!;
    const core = (await simulate(parseTitleless(`${deck}\n.tf v(a,b) V1`))).transferFunction!;
    // Rin=(R1+R2)||(R3+R4); Rout=(R1||R2)+(R3||R4).
    const expected = { transfer_function: 3 / 4 - 1 / 2, input_resistance: 2000, output_resistance: 1750 };
    for (const [key, value] of Object.entries(expected)) close(result[key] as number, value);
    close(result.transfer_function as number, core.transfer);
    close(result.input_resistance as number, core.inputResistance);
    close(result.output_resistance as number, core.outputResistance);
    expect(result.units).toMatchObject({ transfer_function: 'V/V' });
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(result).valid).toBe(true);
  });

  it.each(forms)('preserves sign, ground and coincident-node semantics for %j', async form => {
    const run = async (output: string) => {
      const response = await executeTool('spice_tf', { ...form, output, input_source: 'V1' });
      expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
      return response.structuredContent!;
    };
    const forward = await run('v(a,b)');
    const reverse = await run('v(b,a)');
    close(reverse.transfer_function as number, -(forward.transfer_function as number));
    close(reverse.output_resistance as number, forward.output_resistance as number);
    const grounded = await run('v(a,0)');
    const single = await run('v(a)');
    for (const key of ['transfer_function', 'input_resistance', 'output_resistance']) close(grounded[key] as number, single[key] as number);
    const coincident = await run('v(a,a)');
    const core = (await simulate(parseTitleless(`${deck}\n.tf v(a,a) V1`))).transferFunction!;
    close(coincident.transfer_function as number, core.transfer);
    close(coincident.input_resistance as number, core.inputResistance);
    close(coincident.output_resistance as number, core.outputResistance);
  });

  it.each(forms.flatMap(form => [
    ['v(a,b,c)', 'INVALID_REQUEST'], ['v(,b)', 'INVALID_REQUEST'], ['v(a,)', 'INVALID_REQUEST'],
    ['v(a,b)\n.op', 'INVALID_REQUEST'], ['v(a+b,b)', 'INVALID_CIRCUIT'],
    ['v(missing,b)', 'INVALID_CIRCUIT'], ['v(a,missing)', 'INVALID_CIRCUIT'],
  ].map(([output, code]) => ({ form, output, code }))))('returns $code for $output', async ({ form, output, code }) => {
    const response = await executeTool('spice_tf', { ...form, output, input_source: 'V1' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code, phase: expect.any(String), message: expect.any(String) } } });
  });

  it('preserves V/A and A/V units', async () => {
    const currentInput = await executeTool('spice_tf', { netlist: deck.replace('V1 in 0 1', 'I1 0 in 1'), output: 'v(a,b)', input_source: 'I1' });
    expect(currentInput.isError, JSON.stringify(currentInput.structuredContent)).not.toBe(true);
    expect(currentInput.structuredContent).toMatchObject({ units: { transfer_function: 'V/A' } });
    const currentOutput = await executeTool('spice_tf', { netlist: `${deck}\nVx a x 0\nR5 x 0 1k`, output: 'i(Vx)', input_source: 'V1' });
    expect(currentOutput.isError, JSON.stringify(currentOutput.structuredContent)).not.toBe(true);
    expect(currentOutput.structuredContent).toMatchObject({ units: { transfer_function: 'A/V' } });
  });
});
