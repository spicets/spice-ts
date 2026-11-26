import { expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

it('validates schemas and evaluates a real PWL source through MCP', async () => {
  const tool = MCP_TOOLS.find(t => t.name === 'spice_tran_metrics')!;
  const validator = new AjvJsonSchemaValidator();
  const input = validator.getValidator(tool.inputSchema);
  const output = validator.getValidator(tool.outputSchema!);
  const request = { apiVersion: '1', input: { format: 'spice', source: 'V1 out 0 PWL(0 0 1m 1 2m 1)\nR1 out 0 1k\n.tran 0.01m 2m\n.end' } };
  const args = { request, signal: 'v(out)', referenceSignal: 'v(out)' };
  expect(input(args).valid).toBe(true);
  expect(input({ ...args, referenceSignal: 5 }).valid).toBe(false);
  const result = await executeTool('spice_tran_metrics', args);
  expect(result.isError).not.toBe(true);
  expect(output(result.structuredContent).valid).toBe(true);
  expect(result.structuredContent).toMatchObject({ correlation: { referenceSignal: 'v(out)', covarianceUnit: 'V*V', coefficient: expect.any(Number) } });
  const correlation = (result.structuredContent as { correlation: { coefficient: number; covariance: number } }).correlation;
  expect(correlation.coefficient).toBeCloseTo(1, 12);
  expect(correlation.covariance).toBeCloseTo(5 / 48, 5);
  expect(output({ ...result.structuredContent, correlation: { referenceSignal: 'v(out)', covariance: 1, coefficient: 1 } }).valid).toBe(false);
  const legacy = await executeTool('spice_tran_metrics', { request, signal: 'v(out)' });
  expect(legacy.structuredContent).not.toHaveProperty('correlation');
  expect(output(legacy.structuredContent).valid).toBe(true);
});
