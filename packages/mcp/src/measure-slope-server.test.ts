import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 PWL(0 0 1 2 3 0)\nR1 out 0 1k\n.tran 0.01 3\n.end' } };
const item = { kind: 'slope', signal: 'v(out)', analysis: 0, at: 0.5 };

describe('spice_measure slope MCP interface', () => {
  it('advertises and executes a real PWL measurement', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_measure')!;
    const validator = new AjvJsonSchemaValidator();
    const input = validator.getValidator(tool.inputSchema);
    const output = validator.getValidator(tool.outputSchema!);
    const args = { request, measurements: [item, { ...item, at: 2 }] };
    expect(input(args).valid).toBe(true);
    for (const invalid of [{ ...item, at: undefined }, { ...item, at: '1' }, { ...item, value: 2 }, { ...item, edge: 'rising' }, { ...item, occurrence: 1 }, { ...item, referenceSignal: 'v(out)' }]) {
      expect(input({ request, measurements: [invalid] }).valid).toBe(false);
    }
    const response = await executeTool('spice_measure', args);
    expect(response.isError).not.toBe(true);
    expect(output(response.structuredContent).valid).toBe(true);
    const data = response.structuredContent as { measurements: { value: number; unit: string }[] };
    expect(data.measurements[0].unit).toBe('V/s');
    expect(Math.abs(data.measurements[0].value - 2)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(data.measurements[1].value - (-1))).toBeLessThanOrEqual(1e-12);
  });

  it('rejects AC measurements with schema-valid structured errors', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'spice_measure')!;
    const ac = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 DC 0 AC 1\nR1 out 0 1k\n.ac dec 2 1 10\n.end' } };
    const response = await executeTool('spice_measure', { request: ac, measurements: [item] });
    expect(response.isError).not.toBe(true);
    expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
    expect(response.structuredContent).toMatchObject({ measurements: [{ error: { code: 'INVALID_MEASUREMENT' } }] });
  });
});
