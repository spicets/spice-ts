import { describe, expect, it } from 'vitest';
import { parseTitleless } from '@spice-ts/core';
import { toCircuitJSON } from '@spice-ts/circuit-json';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS } from './server.js';

// Original RC two-port: unequal reference impedances and frequency-dependent phase.
const pad = '* RC two-port\nV1 in 0 dc 0 portnum 1 z0 50\nV2 out 0 dc 0 portnum 2 z0 75\nR1 in mid 16\nR2 mid out 27\nR3 mid 0 68\nC1 mid 0 1u\n.sp lin 3 100 10000 0\n.end';
const document = {
  format: 'spice-ts', schemaVersion: '1.0',
  circuit: (() => {
    const ir = parseTitleless(pad).toIR();
    return { ...ir, components: ir.components.map(({ type, id, name, ports, params }) => ({ type, id, name, ports,
      params: { ...params, ...(name === 'V1' ? { portnum: 1, z0: 50 } : name === 'V2' ? { portnum: 2, z0: 75 } : {}) },
    })) };
  })(),
  analyses: [{ type: 'sp', variation: 'lin', points: 3, startFreq: 100, stopFreq: 10000 }], models: [], subcircuits: [],
};
// The shared adapter remains strict and RF-agnostic; only spice_sparams maps RF metadata.
const converted = toCircuitJSON({ ...document.circuit, components: document.circuit.components.map(c => {
  const { portnum: _portnum, z0: _z0, ...params } = c.params;
  return { ...c, params };
}) });
const rfCircuit = converted.value!.map(element => {
  const source = document.circuit.components.find(c => c.id === ('source_component_id' in element ? element.source_component_id : undefined));
  return element.type === 'source_component' && source?.params.portnum !== undefined
    ? { ...element, portnum: source.params.portnum, z0: source.params.z0 } : element;
});
const inputs = [
  { format: 'spice', source: pad },
  { format: 'spice-ts', document },
  { format: 'circuit-json', circuit: rfCircuit, analyses: document.analyses },
];
const request = (input: unknown) => ({ apiVersion: '1', input });

describe('spice_sparams protocol-v1 requests', () => {
  it('matches every magnitude and phase across legacy, SPICE, native and circuit-json', async () => {
    expect(converted.value, JSON.stringify(converted.diagnostics)).toBeDefined();
    const legacy = await executeTool('spice_sparams', { netlist: pad });
    expect(legacy.isError, JSON.stringify(legacy.structuredContent)).not.toBe(true);
    type Report = { referenceImpedancesOhm: number[]; points: { frequencyHz: number; parameters: Record<string, { magnitude: number; phaseDeg: number }> }[] };
    const baseline = legacy.structuredContent as unknown as Report;
    expect(baseline.referenceImpedancesOhm).toEqual([50, 75]);
    expect(baseline.points.length).toBeGreaterThan(1);
    expect(baseline.points.some(p => Math.abs(p.parameters.S21.phaseDeg) > 1)).toBe(true);
    let maxDeviation = 0;
    for (const input of inputs) {
      const response = await executeTool('spice_sparams', { request: request(input) });
      expect(response.isError, `${input.format}: ${JSON.stringify(response.structuredContent)}`).not.toBe(true);
      const actual = response.structuredContent as unknown as Report;
      expect(actual.referenceImpedancesOhm).toEqual(baseline.referenceImpedancesOhm);
      expect(actual.points.map(p => p.frequencyHz)).toEqual(baseline.points.map(p => p.frequencyHz));
      baseline.points.forEach((point, i) => {
        expect(Object.keys(actual.points[i].parameters)).toEqual(Object.keys(point.parameters));
        for (const [key, metrics] of Object.entries(point.parameters)) {
          for (const field of ['magnitude', 'phaseDeg'] as const) {
            const expected = metrics[field];
            expect(Math.abs(expected)).toBeGreaterThan(0);
            const deviation = Math.abs((actual.points[i].parameters[key][field] - expected) / expected);
            maxDeviation = Math.max(maxDeviation, deviation);
            expect(deviation, `${input.format} ${key} ${field} @ ${point.frequencyHz}`).toBeLessThanOrEqual(1e-12);
          }
        }
      });
    }
    process.stdout.write(`S-parameter JSON parity max relative magnitude/phase deviation: ${maxDeviation}\n`);
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
    const opInput = 'document' in input
      ? { ...input, document: { ...input.document, analyses: [{ type: 'op' }] } }
      : { ...input, analyses: [{ type: 'op' }] };
    expect(await executeTool('spice_sparams', { request: request(opInput) })).toMatchObject({
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

  describe.each(['spice-ts', 'circuit-json'])('%s RF validation', format => {
    const sources = (): Record<string, unknown>[] => format === 'spice-ts'
      ? document.circuit.components.filter(c => c.type === 'V').map(c => ({ ...c.params }))
      : rfCircuit.filter(e => e.type === 'source_component' && e.ftype === 'simple_voltage_source').map(e => ({ ...e }));
    const path = (index: number, field?: string) => format === 'spice-ts'
      ? `/input/document/circuit/components/${document.circuit.components.findIndex(c => c.name === `V${index + 1}`)}/params${field ? `/${field}` : ''}`
      : `/input/circuit/${rfCircuit.findIndex(e => e.type === 'source_component' && e.name === `V${index + 1}`)}${field ? `/${field}` : ''}`;
    const inputWith = (metadata: Record<string, unknown>[]) => format === 'spice-ts'
      ? { format, document: { ...document, circuit: { ...document.circuit, components: document.circuit.components.map(c => c.type === 'V'
        ? { ...c, params: metadata[c.name === 'V1' ? 0 : 1] } : c) } } }
      : { format, analyses: document.analyses, circuit: rfCircuit.map(e => e.type === 'source_component' && e.ftype === 'simple_voltage_source'
        ? metadata[e.name === 'V1' ? 0 : 1] : e) };
    it.each([
      ...[0, -1, 1.5, '1', null, NaN, Infinity].map(value => ({ field: 'portnum', value })),
      ...[0, -50, '50', null, NaN, Infinity].map(value => ({ field: 'z0', value })),
    ])('rejects invalid $field=$value at its input path', async ({ field, value }) => {
      const metadata = sources();
      Object.assign(metadata[0], { [field]: value });
      expect(await executeTool('spice_sparams', { request: request(inputWith(metadata)) })).toMatchObject({
        isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false, details: { path: path(0, field) } } },
      });
    });
    it.each(['orphan-z0', 'duplicate', 'gap', 'one-port', 'no-ports'])('rejects %s with an actionable path', async kind => {
      const metadata = sources();
      let expectedPath = path(1, 'portnum');
      if (kind === 'orphan-z0') { delete metadata[0].portnum; expectedPath = path(0, 'z0'); }
      if (kind === 'duplicate') metadata[1].portnum = 1;
      if (kind === 'gap') metadata[1].portnum = 3;
      if (kind === 'one-port' || kind === 'no-ports') {
        for (const source of kind === 'no-ports' ? metadata : metadata.slice(1)) { delete source.portnum; delete source.z0; }
        expectedPath = format === 'spice-ts' ? '/input/document/circuit/components' : '/input/circuit';
      }
      expect(await executeTool('spice_sparams', { request: request(inputWith(metadata)) })).toMatchObject({
        isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false, details: { path: expectedPath } } },
      });
    });
  });

  it('keeps unrelated circuit-json source fields strictly validated', async () => {
    const circuit = rfCircuit.map(e => e.type === 'source_component' && e.ftype === 'simple_voltage_source' ? { ...e, frequency: 123 } : e);
    expect(await executeTool('spice_sparams', { request: request({ ...inputs[2], circuit }) })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_CIRCUIT', details: { diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER', path: expect.stringMatching(/\/frequency$/) }),
      ]) } } },
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
