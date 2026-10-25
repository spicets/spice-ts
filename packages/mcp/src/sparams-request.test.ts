import { describe, expect, it } from 'vitest';
import { parseTitleless } from '@spice-ts/core';
import { toCircuitJSON } from '@spice-ts/circuit-json';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

// Same original MIT matched T pad as sparams.test.ts.
const pad = '* Matched T pad\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\nR1 in mid 16.666666666666668\nR2 mid out 16.666666666666668\nR3 mid 0 66.66666666666667\n.sp lin 3 100 1000 0\n.end';
// Native fixtures exercise boundary validation only: protocol-v1 cannot yet encode
// .sp analyses or preserve RF port metadata through circuit-json conversion.
const document = {
  format: 'spice-ts', schemaVersion: '1.0',
  circuit: (() => {
    const ir = parseTitleless(pad.replace(' ac 1', '').replace(' ac 0', '')).toIR();
    return { ...ir, components: ir.components.map(({ type, id, name, ports, params }) => ({ type, id, name, ports, params })) };
  })(),
  analyses: [{ type: 'op' }], models: [], subcircuits: [],
};
const converted = toCircuitJSON(document.circuit);
const inputs = [
  { format: 'spice', source: pad },
  { format: 'spice-ts', document },
  { format: 'circuit-json', circuit: converted.value!, analyses: document.analyses },
];
const request = (input: unknown) => ({ apiVersion: '1', input });

describe('spice_sparams protocol-v1 requests', () => {
  it('matches legacy frequencies and all S metrics for a SPICE request', async () => {
    expect(converted.value, JSON.stringify(converted.diagnostics)).toBeDefined();
    const legacy = await executeTool('spice_sparams', { netlist: pad });
    expect(legacy.isError, JSON.stringify(legacy.structuredContent)).not.toBe(true);
    const response = await executeTool('spice_sparams', { request: request(inputs[0]) });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(legacy.structuredContent);
  });

  it('advertises exactly one legacy netlist or protocol request', () => {
    const schema = MCP_TOOLS.find(tool => tool.name === 'spice_sparams')!.inputSchema;
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    for (const args of [{ netlist: pad }, ...inputs.map(input => ({ request: request(input) }))]) {
      expect(validate(args).valid, JSON.stringify(validate(args))).toBe(true);
    }
    for (const args of [{}, { netlist: pad, request: request(inputs[0]) },
      { request: request(inputs[0]), surprise: true }]) {
      expect(validate(args).valid).toBe(false);
    }
  });

  it.each(inputs.slice(1))('rejects a non-SP native analysis for $format', async input => {
    expect(await executeTool('spice_sparams', { request: request(input) })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } },
    });
  });

  it.each([
    {}, { request: {} }, { request: null }, { request: undefined },
    { netlist: pad, request: request(inputs[0]) }, { netlist: undefined, request: request(inputs[0]) },
    { request: request({ format: 'spice-ts', document: {} }) },
    { request: request({ format: 'spice-ts', document: JSON.stringify(document) }) },
    { request: request({ format: 'circuit-json', circuit: {} }) },
    { request: request(inputs[0]), frequenciesHz: [0] },
    { request: request(inputs[0]), surprise: true },
  ])('returns structured INVALID_REQUEST for malformed or ambiguous arguments %#', async args => {
    expect(await executeTool('spice_sparams', args)).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } },
    });
  });

  it('honors selectors, request limits and cancellation', async () => {
    const selectors = { portPair: [2, 1], frequenciesHz: [123, 9876] };
    const legacy = await executeTool('spice_sparams', { netlist: pad, ...selectors });
    expect(legacy.isError).not.toBe(true);
    expect((await executeTool('spice_sparams', { request: request(inputs[0]), ...selectors })).structuredContent).toEqual(legacy.structuredContent);
    for (const limits of [{ maxSourceBytes: 1 }, { maxComponents: 1 }, { maxResultPoints: 1 }, { maxSerializedResultBytes: 1 }]) {
      expect(await executeTool('spice_sparams', { request: { ...request(inputs[0]), options: { limits } } })).toMatchObject({
        isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } },
      });
    }
    expect(await executeTool('spice_sparams', { request: request(inputs[0]) }, { signal: AbortSignal.abort() })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'CANCELLED' } },
    });
  });
});
