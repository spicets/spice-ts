import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { DEFAULT_MCP_LIMITS, executeTool, MCP_TOOLS } from './server.js';

const document = {
  format: 'spice-ts', schemaVersion: '1.0',
  circuit: { nets: ['in', 'out'], components: [
    { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { dc: 10 } },
    { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: 'out' }], params: { resistance: 1000 } },
    { type: 'R', id: 'R-load', name: 'R-load', ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
  ] }, analyses: [{ type: 'op' }], models: [], subcircuits: [],
};
const measurement = { kind: 'max', signal: 'v(out)', analysis: 0 };
const corners = [1000, 2000, 4000].map(value => ({ name: String(value), components: { 'R-load': value } }));

describe('component corners', () => {
  it('evaluates native and text divider corners without mutation', async () => {
    const native = { request: { apiVersion: '1', input: { format: 'spice-ts', document } }, corners, measurement };
    const text = { ...native, request: { apiVersion: '1', input: { format: 'spice', source: '* divider\nV1 in 0 10\nR1 in out 1k\nR-load out 0 1k\n.op\n.end' } } };
    const before = structuredClone(native);
    expect(new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_corners')!.inputSchema)(native).valid).toBe(true);
    const a = await executeTool('spice_corners', native);
    const b = await executeTool('spice_corners', text);
    expect(a.isError, JSON.stringify(a.structuredContent)).not.toBe(true);
    expect(b.isError, JSON.stringify(b.structuredContent)).not.toBe(true);
    const av = a.structuredContent as { corners: { value: number }[]; summary: { min: { value: number }; max: { value: number }; spread: number } };
    const bv = b.structuredContent as typeof av;
    for (const [i, expected] of [5, 20 / 3, 8].entries()) {
      expect(Math.abs(av.corners[i].value - expected)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(av.corners[i].value - bv.corners[i].value)).toBeLessThanOrEqual(1e-12);
    }

    expect(av.summary).toMatchObject({ min: { value: 5 }, max: { value: 8 }, spread: 3 });
    expect(native).toEqual(before);
    expect(await executeTool('spice_corners', native)).toEqual(a);
  });

  it.each(['C', 'L'])('applies %s to transient output like an explicit-value request', async type => {
    const field = type === 'C' ? 'capacitance' : 'inductance';
    const nominal = type === 'C' ? 1e-6 : 1;
    const pulse = { ...document.circuit.components[0], params: { waveform: 'pulse', v1: 0, v2: 10, delay: 0, rise: 1e-6, fall: 1e-6, width: 0.0003, period: 0.001 } };
    const device = { type, id: `${type}1`, name: `${type}1`, ports: [{ name: 'p', net: 'out' }, { name: 'n', net: '0' }], params: { [field]: nominal } };
    const doc = { ...document, circuit: { ...document.circuit, components: [pulse, document.circuit.components[1], device] }, analyses: [{ type: 'tran', timestep: 0.0001, stopTime: 0.001 }] };
    const makeRequest = (d: typeof doc) => ({ apiVersion: '1', input: { format: 'spice-ts', document: d } });
    const meas = { kind: 'avg', signal: 'v(out)', analysis: 0 };
    const result = await executeTool('spice_corners', { request: makeRequest(doc), measurement: meas, corners: [{ name: 'nominal' }, { name: 'changed', components: { [`${type}1`]: nominal * 2 } }] });
    const explicit = { ...doc, circuit: { ...doc.circuit, components: [pulse, document.circuit.components[1], { ...device, params: { [field]: nominal * 2 } }] } };
    const reference = await executeTool('spice_corners', { request: makeRequest(explicit), measurement: meas, corners: [{ name: 'direct' }] });
    const a = result.structuredContent as { corners: { status: string; value: number }[] };
    const b = reference.structuredContent as typeof a;
    expect(a.corners, JSON.stringify(result.structuredContent)).toMatchObject([{ status: 'complete' }, { status: 'complete' }]);
    expect(b.corners, JSON.stringify(reference.structuredContent)).toMatchObject([{ status: 'complete' }]);
    expect(Math.abs(a.corners[1].value - b.corners[0].value)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(a.corners[1].value - a.corners[0].value)).toBeGreaterThan(1e-6);

  });

  it('isolates invalid targets, names, values, and component maps', async () => {
    const bad = [{ Rmissing: 1000 }, { 'R-load': 1000, 'r-LOAD': 2000 }, { V1: 1 }, { 'R-load': 0 }, { 'R-load': -1 }, { 'R-load': Infinity }, { 'R-load': NaN }, null, []];
    const args = { request: { apiVersion: '1', input: { format: 'spice-ts', document } }, measurement, corners: [...bad.map((components, i) => ({ name: `bad${i}`, components })), { name: 'good', components: { 'r-load': 2000 } }] };
    const result = await executeTool('spice_corners', args);
    const data = result.structuredContent as { corners: unknown[] };
    for (let i = 0; i < bad.length; i++) expect(data.corners[i], JSON.stringify(data.corners[i])).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } });
    expect(data.corners[bad.length]).toMatchObject({ status: 'complete', value: expect.closeTo(20 / 3, 12) });
  });

  it('composes parameters, temperature and components in text corners', async () => {
    const request = { apiVersion: '1', input: { format: 'spice', source: '* divider\n.param rval=1k\nV1 in 0 10\nR1 in out {rval}\nR-load out 0 1k\n.op\n.end' } };
    const args = { request, measurement, corners: [{ name: 'mixed', params: { rval: 2000 }, temp: 80, components: { 'R-load': 4000 } }, { name: 'nominal' }] };
    const before = structuredClone(args);
    const result = await executeTool('spice_corners', args);
    expect(result).toMatchObject({ structuredContent: { corners: [{ status: 'complete', value: expect.closeTo(20 / 3, 12) }, { status: 'complete', value: 5 }] } });
    expect(args).toEqual(before);
    expect(await executeTool('spice_corners', args, { limits: { ...DEFAULT_MCP_LIMITS, maxSerializedResultBytes: 50 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
  });

  it('rejects ambiguous component names and text targets within each corner', async () => {
    const duplicate = { ...document, circuit: { ...document.circuit, components: [...document.circuit.components, { ...document.circuit.components[2], id: 'other', name: 'r-LOAD' }] } };
    const native = await executeTool('spice_corners', { request: { apiVersion: '1', input: { format: 'spice-ts', document: duplicate } }, measurement, corners: [{ name: 'ambiguous', components: { 'R-load': 2000 } }] });
    expect(native).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: 'INVALID_REQUEST' } }], summary: null } });
    const text = await executeTool('spice_corners', { request: { apiVersion: '1', input: { format: 'spice', source: '* divider\nV1 in 0 10\nR1 in out 1k\nR-load out 0 1k\n.op\n.end' } }, measurement, corners: [{ name: 'bad', components: { V1: 1 } }, { name: 'good', components: { 'R-load': 4000 } }] });
    expect(text).toMatchObject({ structuredContent: { corners: [{ status: 'failed', error: { code: 'INVALID_REQUEST' } }, { status: 'complete', value: 8 }] } });
  });
});
