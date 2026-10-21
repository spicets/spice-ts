import { describe, expect, it } from 'vitest';
import { executeTool } from './server.js';

const source = `* B3SOI diagnostic regression #1646
.subckt inv d g s
M1 d g s s s CMOSN W=2u L=1u
.model CMOSN NMOS (LEVEL=10)
.ends inv
XINV1 d g 0 inv
.op
.end`;

describe('B3SOI MCP JSON diagnostics (#1646)', () => {
  it('returns the existing compile error code with the unsupported level and scoped model', async () => {
    const result = await executeTool('spice_validate', {
      request: { apiVersion: '1', input: { format: 'spice', source } },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: {
        code: 'UNSUPPORTED_MODEL_LEVEL', phase: 'compile',
        message: expect.stringContaining("MOSFET 'XINV1.M1' (model 'XINV1:CMOSN') uses unsupported model LEVEL=10"),
      } },
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });
});
