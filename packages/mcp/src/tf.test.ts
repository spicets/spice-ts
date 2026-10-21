import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTitleless, simulate } from '@spice-ts/core';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';

// Original analytic divider (MIT), passed verbatim to ngspice-47 for the PR cross-check.
const divider = '* Transfer function divider\nV1 in 0 1\nR1 in out 1k\nR2 out 0 3k\n.tf v(out) V1\n.end\n';
const args = { netlist: divider, output: 'v(out)', input_source: 'V1' };
async function run(extra = {}) {
  const response = await executeTool('spice_tf', { ...args, ...extra });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  const tool = MCP_TOOLS.find(t => t.name === 'spice_tf')!;
  expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent!;
}

describe('spice_tf', () => {
  it('returns divider gain and port resistances within 1e-9 relative', async () => {
    const result = await run();
    expect(result).toMatchObject({ output: 'v(out)', input_source: 'V1', units: {
      transfer_function: 'V/V', input_resistance: 'ohm', output_resistance: 'ohm',
    } });
    for (const [key, expected] of [['transfer_function', 0.75], ['input_resistance', 4000], ['output_resistance', 750]] as const) {
      expect(Math.abs((result[key] as number) / expected - 1)).toBeLessThan(1e-9);
    }
  });

  it.each([
    ['V1 in 0 1\nE1 out 0 in 0 3\nR1 in 0 1k\nR2 out 0 2k', 'v(out)', 'V1', 'V/V'],
    ['I1 0 in 1m\nR1 in 0 2k\nG1 0 out in 0 0.001\nR2 out 0 1k', 'v(out)', 'I1', 'V/A'],
    [readFileSync(new URL('../../../benchmarks/transfer-function/current-output.cir', import.meta.url), 'utf8'), 'i(Vsense)', 'V1', 'A/V'],
    ['I1 0 in 1m\nR1 in 0 2k\nG1 0 out in 0 0.001\nVx out 0 0', 'i(Vx)', 'I1', 'A/A'],
    [divider.replace('.tf v(out) V1', ''), 'V(out)', 'v1', 'V/V'],
  ])('matches core exactly for %s', async (netlist, output, input_source, unit) => {
    const deck = netlist.includes('.tf') ? netlist : netlist.replace(/\.end\b/i, '') + `\n.tf ${output} ${input_source}\n`;
    const core = (await simulate(parseTitleless(deck))).transferFunction!;
    const result = await run({ netlist, output, input_source });
    expect(result).toMatchObject({ output, input_source, transfer_function: core.transfer,
      input_resistance: core.inputResistance, output_resistance: core.outputResistance,
      units: { transfer_function: unit } });
  });

  it.each([
    [{ output: undefined }, 'INVALID_REQUEST'],
    [{ input_source: undefined }, 'INVALID_REQUEST'],
    [{ output: 'garbage' }, 'INVALID_REQUEST'],
    [{ netlist: 'V1 in 0 1\nR1 in out 1k invalid=1\nR2 out 0 3k\n.end' }, 'UNSUPPORTED_RESISTOR_PARAMETER'],
    [{ input_source: 'Vmissing' }, 'INVALID_CIRCUIT'],
    [{ output: 'v(missing)' }, 'INVALID_CIRCUIT'],
    [{ output: 'i(Vmissing)' }, 'INVALID_CIRCUIT'],
    [{ output: 'v(out)\n.tran 1 2' }, 'INVALID_REQUEST'],
    [{ input_source: 'V1\n.op' }, 'INVALID_REQUEST'],
    [{ output: 'i(R1)' }, 'INVALID_REQUEST'],
    [{ output: 'v(in,out)' }, 'INVALID_REQUEST'],
    [{ surprise: true }, 'INVALID_REQUEST'],
    [{ params: { missing: 1 } }, 'UNKNOWN_PARAMETER'],
    [{ netlist: 'V1 in 0 1\nR1 in 0 1k\nR2 a 0 1\nB1 a 0 I=V(a)^2+1', output: 'v(in)' }, 'CONVERGENCE_FAILED'],
    ...['.op', '.tran 1p 1000', '.tf v(in) V1', '.step R1 list 1k 2k', '.control\nop\n.endc', '.pz out 0 in 0 vol pol'].map(directive => [
      { netlist: divider.replace('.tf v(out) V1', directive) }, 'INVALID_CIRCUIT',
    ] as const),
  ] as [Record<string, unknown>, string][])('returns typed errors for %j', async (extra, code) => {
    const response = await executeTool('spice_tf', { ...args, ...extra });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code, message: expect.any(String), phase: expect.any(String) } } });
    expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual(response.structuredContent);
  });

  it('applies case-insensitive top-level parameter overrides before elaboration', async () => {
    const netlist = divider.replace('R1 in out 1k', '.param rval=1k\nR1 in out {rval}');
    expect(await run({ netlist, params: { RVAL: 3000 } })).toMatchObject({ transfer_function: 0.5, input_resistance: 6000, output_resistance: 1500 });
  });

  it('advertises TF and bounds work and cancellation', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({ tf: { tool: 'spice_tf', analyses: ['tf'] } });
    for (const limits of [{ maxDocumentBytes: 1 }, { maxResultPoints: 1 }, { maxSerializedResultBytes: 1 }, { maxAnalyses: 0 }]) {
      expect((await executeTool('spice_tf', args, { limits: { ...DEFAULT_MCP_LIMITS, ...limits } })).structuredContent)
        .toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    }
    const controller = new AbortController(); controller.abort();
    expect((await executeTool('spice_tf', args, { signal: controller.signal })).structuredContent).toMatchObject({ error: { code: 'CANCELLED' } });
  });
});
