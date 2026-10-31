import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';
import { powerMetrics, powerPlan } from './power-metrics.js';

const dc = 'V1 in 0 10\nR1 in 0 1k\n.tran 0.00001 0.001\n.end';
interface Report {
  elements: { name: string; averagePowerW: number; rmsCurrentA: number; peakPowerW: number; peakTimeS: number }[];
  efficiency: number | null;
  window: [number, number];
}
async function run(netlist: string, extra = {}) {
  const response = await executeTool('spice_power_metrics', { netlist, ...extra });
  expect(response.isError).not.toBe(true);
  const schema = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!.outputSchema!;
  expect(new AjvJsonSchemaValidator().getValidator(schema)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as Report;
}

const components = [
  { type: 'V', id: 'V1', name: 'V1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { waveform: 'dc', dc: 10 } },
  { type: 'R', id: 'R1', name: 'R1', ports: [{ name: 'p', net: 'in' }, { name: 'n', net: '0' }], params: { resistance: 1000 } },
];
const analyses = [{ type: 'tran', timestep: 1e-5, stopTime: 0.001 }];
const document = { format: 'spice-ts', schemaVersion: '1.0', circuit: { components, nets: ['in'] }, analyses, models: [], subcircuits: [] };
const circuit = [
  ...['in', '0'].map(name => ({ type: 'source_net', source_net_id: name, name })),
  ...components.flatMap((component, i) => [
    { type: 'source_component', source_component_id: component.id, name: component.name,
      ...[{ ftype: 'simple_voltage_source', voltage: 10 }, { ftype: 'simple_resistor', resistance: 1000 }][i] },
    ...component.ports.flatMap((port, j) => [
      { type: 'source_port', source_port_id: `${component.id}-${j}`, source_component_id: component.id, name: port.name },
      { type: 'source_trace', source_trace_id: `${component.id}-${j}`, connected_source_port_ids: [`${component.id}-${j}`], connected_source_net_ids: [port.net] },
    ]),
  ]),
];
const protocolInputs = [
  { format: 'spice', source: dc },
  { format: 'spice-ts', document },
  { format: 'circuit-json', circuit, analyses },
];
const request = (input: unknown) => ({ apiVersion: '1', input });

describe('spice_power_metrics', () => {
  it.each(protocolInputs)('deep-equals every legacy metric for $format requests', async input => {
    const selectors = { elements: ['v1', 'r1'], input: ['V1'], output: ['R1'], window: [0.000123, 0.000789] };
    const expected = await run(dc, selectors);
    const response = await executeTool('spice_power_metrics', { request: request(input), ...selectors });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(expected);
  });

  it('advertises exactly one legacy or protocol input in the tool listing', () => {
    const tools = MCP_TOOLS.filter(tool => tool.name === 'spice_power_metrics');
    expect(tools).toHaveLength(1);
    const validate = new AjvJsonSchemaValidator().getValidator(tools[0].inputSchema);
    for (const args of [{ netlist: dc }, ...protocolInputs.map(input => ({ request: request(input) }))]) {
      expect(validate(args).valid, JSON.stringify(validate(args))).toBe(true);
    }
    for (const args of [{}, { netlist: dc, request: request(protocolInputs[0]) }, { circuitJson: circuit },
      { request: request(protocolInputs[0]), surprise: true }]) expect(validate(args).valid).toBe(false);
  });

  it.each([
    { request: request({ format: 'spice-ts', document: {} }) },
    { request: request({ format: 'spice-ts', document: '{invalid json' }) },
    { request: request({ format: 'spice-ts', document: JSON.stringify(document) }) },
    { request: request({ format: 'circuit-json', circuit: {}, analyses }) },
    { netlist: dc, request: request(protocolInputs[0]) },
    { circuitJson: circuit },
  ])('rejects malformed or ambiguous structured input %#', async args => {
    expect(await executeTool('spice_power_metrics', args)).toMatchObject({ isError: true,
      structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation', retryable: false } } });
  });

  it.each(protocolInputs)('honors original request limits and cancellation for $format', async input => {
    for (const limits of [{ maxSourceBytes: 10 }, { maxResultPoints: 1 }, { maxComponents: 1 }]) {
      expect(await executeTool('spice_power_metrics', { request: { ...request(input), options: { limits } } })).toMatchObject({
        isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } },
      });
    }
    expect(await executeTool('spice_power_metrics', { request: request(input) }, { signal: AbortSignal.abort() })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'CANCELLED' } },
    });
  });

  it('bounds original layout bytes before lossy conversion shrinks them', async () => {
    const input = { format: 'circuit-json', analyses, circuit: [...circuit,
      { type: 'pcb_component', pcb_component_id: 'layout-only', source_component_id: 'R1', notes: 'x'.repeat(8000) }] };
    for (const serverLimit of [false, true]) {
      const args = { request: { ...request(input), ...(serverLimit ? {} : { options: { limits: { maxSourceBytes: 4000 } } }) } };
      const response = await executeTool('spice_power_metrics', args,
        serverLimit ? { limits: { ...DEFAULT_MCP_LIMITS, maxDocumentBytes: 4000 } } : {});
      expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'RESOURCE_LIMIT' } } });
    }
  });

  it('retains nonfatal lossy conversion diagnostics outside the metrics', async () => {
    const response = await executeTool('spice_power_metrics', { request: request({ format: 'circuit-json', analyses,
      circuit: [...circuit, { type: 'pcb_component', pcb_component_id: 'layout-only', source_component_id: 'R1' }] }) });
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
    expect(response.structuredContent).toEqual(await run(dc));
    expect(response._meta).toMatchObject({ conversionDiagnostics: expect.arrayContaining([
      expect.objectContaining({ severity: 'info', code: 'LAYOUT_ONLY', simulationRelevant: false }),
    ]) });
  });

  it('preserves fatal conversion diagnostics', async () => {
    expect(await executeTool('spice_power_metrics', { request: request({ format: 'circuit-json', analyses,
      circuit: [{ type: 'source_component', source_component_id: 'U1', name: 'U1', ftype: 'simple_chip' }] }) })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'UNSUPPORTED_ELEMENT', phase: 'validation', details: { diagnostics: expect.any(Array) } } },
    });
  });

  it('reports 0.1 W absorption and negative source delivery from a DC transient', async () => {
    const result = await run(dc);
    const load = result.elements.find(e => e.name === 'R1')!;
    expect(Math.abs(load.averagePowerW / 0.1 - 1)).toBeLessThan(1e-9);
    expect(load.rmsCurrentA).toBeCloseTo(0.01, 12);
    expect(load.peakPowerW).toBeCloseTo(0.1, 12);
    expect(result.elements.find(e => e.name === 'V1')!.averagePowerW).toBeCloseTo(-0.1, 12);
    expect(result.efficiency).toBeNull();
  });

  it('integrates sinusoidal power and squared current over integer periods', async () => {
    const result = await run('V1 in 0 SIN(0 1 1k)\nR1 in 0 1k\n.tran 1u 2m', { elements: ['r1'], window: [0, 0.002] });
    const load = result.elements[0];
    expect(Math.abs(load.averagePowerW / 0.0005 - 1)).toBeLessThan(1e-3);
    expect(Math.abs(load.rmsCurrentA / (Math.SQRT1_2 * 0.001) - 1)).toBeLessThan(1e-3);
    expect(load.peakPowerW).toBeCloseTo(0.001, 7);
  });

  it('computes divider efficiency from signed input delivery and output absorption', async () => {
    const result = await run('V1 in 0 10\nRs in out 1k\nRload out 0 3k\n.tran 10u 1m', {
      elements: ['V1', 'Rload'], input: ['v1'], output: ['rload'], window: [0.000123, 0.000789],
    });
    expect(Math.abs(result.efficiency! / 0.75 - 1)).toBeLessThan(1e-6);
    expect(result.window).toEqual([0.000123, 0.000789]);
  });

  it.each([
    { elements: ['missing'] }, { window: [1, 0] }, { window: [-1, 1] },
    { window: [0, Infinity] }, { elements: [] }, { input: ['V1'] },
    { input: ['V1'], output: ['missing'] }, { surprise: true },
    { window: [0, 2] }, { elements: ['R1', 'r1'] },
  ])('returns structured invalid arguments: %j', async extra => {
    expect(await executeTool('spice_power_metrics', { netlist: dc, ...extra })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });

  it('returns NOT_TRANSIENT when no transient is present', async () => {
    expect(await executeTool('spice_power_metrics', { netlist: 'V1 in 0 10\nR1 in 0 1k\n.op' })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'NOT_TRANSIENT' } },
    });
  });

  it('advertises the tool in capabilities', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent).toMatchObject({
      tools: expect.arrayContaining(['spice_power_metrics']),
    });
  });

  it('integrates quadratic power and current squared for a linear ramp', () => {
    const plan = powerPlan({ netlist: dc, elements: ['V1'] });
    if ('error' in plan) throw new Error('Expected a plan');
    const report = powerMetrics({ status: 'complete', analyses: [{
      type: 'tran', analysisIndex: 0, timeS: [0, 1],
      voltagesV: { in: [0, 1] }, currentsA: { V1: [0, 1] },
    }] }, plan);
    const metric = report.elements[0];
    expect(Math.abs(metric.averagePowerW - 1 / 3)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(metric.rmsCurrentA - Math.sqrt(1 / 3))).toBeLessThanOrEqual(1e-12);
    expect(metric).toMatchObject({ peakPowerW: 1, peakTimeS: 1 });
  });

  it('clips nonuniform segments and trapezoidally integrates power and squared current', () => {
    const plan = powerPlan({ netlist: dc, elements: ['V1'], window: [0.5, 2] });
    if ('error' in plan) throw new Error('Expected a plan');
    const report = powerMetrics({ status: 'complete', analyses: [{
      type: 'tran', analysisIndex: 0, timeS: [0, 1, 3],
      voltagesV: { in: [2, 2, 2] }, currentsA: { V1: [0, 1, 3] },
    }] }, plan);
    // p(t)=2t; i^2 is interpolated between accepted samples, not re-squared at clipped edges.
    expect(report.elements[0].averagePowerW).toBeCloseTo(2.5, 12);
    expect(report.elements[0].rmsCurrentA).toBeCloseTo(Math.sqrt(2.25), 12);
    expect(report.elements[0]).toMatchObject({ peakPowerW: 4, peakTimeS: 2 });
  });

  it('handles floating terminal voltages and probe-name collisions', async () => {
    const result = await run('V1 a 0 12\nV2 b 0 2\nR1 a b 1k\nV__power_0 __power_0 0 0\n.tran 10u 1m', { elements: ['R1'] });
    expect(result.elements[0].averagePowerW).toBeCloseTo(0.1, 12);
  });

  it('uses simulated capacitor current during a charging transient', async () => {
    const result = await run('V1 in 0 PWL(0 0 1u 0 1.001u 1)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 10m', { elements: ['C1'] });
    // Average capacitor absorption is the stored 0.5*C*V^2 divided by duration.
    expect(Math.abs(result.elements[0].averagePowerW / 0.00005 - 1)).toBeLessThan(0.002);
  });

  it('returns null efficiency for zero or absorbing designated input', async () => {
    const result = await run(dc, { input: ['R1'], output: ['V1'] });
    expect(result.efficiency).toBeNull();
  });

  it.each([
    `${dc}\n.step param r 1 2 1`,
    '.subckt sub a b\nR1 a b 1k\n.ends\nX1 in 0 sub\nV1 in 0 10\n.tran 1u 1m',
    'V1 in 0 10\nR1 in 0 1k\n.op\n.tran 10u 1m',
    'V1 in 0 10\nM1 in in 0 0 model\n.model model NMOS\n.tran 10u 1m',
  ])('rejects unsupported decks rather than emitting incomplete metrics', async netlist => {
    expect(await executeTool('spice_power_metrics', { netlist })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } },
    });
  });

  it('preserves solver failures and resource limits', async () => {
    expect(await executeTool('spice_power_metrics', { netlist: 'V1 a 0 1\nV2 a 0 2\nR1 a 0 1k\n.tran 1u 1m' })).toMatchObject({ isError: true });
    expect(await executeTool('spice_power_metrics', { netlist: dc }, { limits: { ...DEFAULT_MCP_LIMITS, maxDocumentBytes: 10 } })).toMatchObject({ isError: true });
  });
});
