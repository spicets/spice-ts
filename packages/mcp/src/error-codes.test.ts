import { CycleError, SingularMatrixError, UnsupportedModelLevelError } from '@spice-ts/core';
import { describe, expect, it } from 'vitest';
import { executeTool } from './server.js';

const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });

function expectCode(result: Awaited<ReturnType<typeof executeTool>>, code: string): void {
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code } } });
  expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
}

describe('MCP SpiceError codes', () => {
  it.each([
    ['parse error', 'V1 out 0 1\n.bad_directive\n.op\n.end', 'PARSE_ERROR'],
    // A unity-gain self-controlled source leaves its output voltage unconstrained.
    ['singular matrix', 'E1 out 0 out 0 1\n.op\n.end', 'SINGULAR_MATRIX'],
    ['unsupported model', 'V1 d 0 1\nM1 d d 0 0 n\n.model n NMOS (LEVEL=7)\n.op\n.end', 'UNSUPPORTED_MODEL_LEVEL'],
  ])('spice_simulate preserves the %s code across its worker', async (_name, source, code) => {
    expectCode(await executeTool('spice_simulate', { request: request(source) }), code);
  });

  it.each([
    [new CycleError(['a', 'a']), 'CYCLE'],
    [new SingularMatrixError('zero pivot', ['out']), 'SINGULAR_MATRIX'],
    [new UnsupportedModelLevelError('M1', 'n', 7, [1]), 'UNSUPPORTED_MODEL_LEVEL'],
  ] as const)('preserves injected %s without a worker', async (error, code) => {
    expectCode(await executeTool('spice_simulate', {
      request: request('V1 out 0 1\nR1 out 0 1k\n.op\n.end'),
    }, { simulate: async () => { throw error; } }), code);
  });
});
