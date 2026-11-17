import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { powerMetrics, powerPlan } from './power-metrics.js';
import { executeTool, MCP_TOOLS } from './server.js';

const deck = 'V1 in 0 10\nR1 in 0 1k\n.tran 0.00001 0.001\n.end';
const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-12, Math.abs(expected) * 1e-8));

function synthetic(times: number[], v: number[], i: number[], window?: [number, number]) {
  const plan = powerPlan({ netlist: deck, elements: ['V1'], includeEnergyFlow: true, window });
  if ('error' in plan) throw new Error('Expected a plan');
  return powerMetrics({ status: 'complete', analyses: [{
    type: 'tran', analysisIndex: 0, timeS: times,
    voltagesV: { in: v }, currentsA: { V1: i },
  }] }, plan).elements[0];
}
async function run(netlist: string, extra: Record<string, unknown> = {}) {
  const response = await executeTool('spice_power_metrics', { netlist, ...extra });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  const schema = MCP_TOOLS.find(t => t.name === 'spice_power_metrics')!.outputSchema!;
  expect(new AjvJsonSchemaValidator().getValidator(schema)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as ReturnType<typeof powerMetrics>;
}

describe('transient energy flow', () => {
  it('separates a linear zero crossing into equal flows', () => {
    const m = synthetic([0, 1], [-0.5, 0.5], [1, 1]);
    expect(Math.abs(m.absorbedEnergyJ! - 0.125)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(m.returnedEnergyJ! - 0.125)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(m.energyJ)).toBeLessThanOrEqual(1e-12);
  });
  it('splits both roots with positive endpoint powers and clips irregular segments', () => {
    const times = [0, 0.0625, 0.9375, 1];
    const m = synthetic(times, times.map(t => t - 0.25), times.map(t => t - 0.75), [0.125, 0.875]);
    expect(Math.abs(m.absorbedEnergyJ! - 7 / 768)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(m.returnedEnergyJ! - 1 / 48)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(m.energyJ - (m.absorbedEnergyJ! - m.returnedEnergyJ!))).toBeLessThanOrEqual(1e-12);
  });
  it('handles large finite and small finite magnitudes without non-finite output', () => {
    for (const scale of [1e155, 1e-155]) {
      const m = synthetic([0, 1], [-scale, scale], [1 / scale, 1 / scale]);
      close(m.absorbedEnergyJ!, 0.25); close(m.returnedEnergyJ!, 0.25);
      expect(JSON.stringify(m)).not.toMatch(/null|NaN|Infinity/);
    }
    expect(() => synthetic([0, 1], [1e200, 1e200], [1e200, 1e200])).toThrow();
  });
  it('keeps legacy results identical for omitted and false and preserves other metrics', async () => {
    const args = { elements: ['V1', 'R1'], input: ['V1'], output: ['R1'], includeCurrentCrestFactor: true, includePowerFactor: true };
    const omitted = await run(deck, args);
    const disabled = await run(deck, { ...args, includeEnergyFlow: false });
    const enabled = await run(deck, { ...args, includeEnergyFlow: true });
    expect(disabled).toEqual(omitted);
    expect(enabled.efficiency).toBe(omitted.efficiency);
    enabled.elements.forEach((m, index) => {
      const { absorbedEnergyJ, returnedEnergyJ, ...legacy } = m;
      expect(legacy).toEqual(omitted.elements[index]);
      expect(absorbedEnergyJ).toBeGreaterThanOrEqual(0); expect(returnedEnergyJ).toBeGreaterThanOrEqual(0);
      close(m.energyJ, absorbedEnergyJ! - returnedEnergyJ!);
    });
    const load = enabled.elements.find(e => e.name === 'R1')!;
    const source = enabled.elements.find(e => e.name === 'V1')!;
    expect(Math.abs(load.absorbedEnergyJ! - load.energyJ) / Math.abs(load.energyJ)).toBeLessThanOrEqual(1e-8);
    close(load.returnedEnergyJ!, 0);
    close(source.returnedEnergyJ!, load.absorbedEnergyJ!); close(source.absorbedEnergyJ!, 0);
  });
  it('rejects nonboolean options', async () => {
    for (const includeEnergyFlow of ['true', 1, null]) {
      expect(await executeTool('spice_power_metrics', { netlist: deck, includeEnergyFlow })).toMatchObject({ isError: true });
    }
  });
  it('respects the passive sign convention when source terminals are reversed', async () => {
    const reverse = deck.replace('V1 in 0 10', 'V1 0 in -10');
    const normal = await run(deck, { elements: ['V1'], includeEnergyFlow: true });
    const reversed = await run(reverse, { elements: ['V1'], includeEnergyFlow: true });
    close(reversed.elements[0].returnedEnergyJ!, normal.elements[0].returnedEnergyJ!);
    close(reversed.elements[0].absorbedEnergyJ!, 0);
    close(reversed.elements[0].energyJ, normal.elements[0].energyJ);
  });
  it('measures both capacitor charging and discharging', async () => {
    const netlist = 'V1 in 0 PWL(0 0 1u 0 1.001u 1 5m 1 5.001m 0 10m 0)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 10m';
    const result = await run(netlist, { elements: ['C1'], includeEnergyFlow: true });
    const m = result.elements[0];
    expect(m.absorbedEnergyJ!).toBeGreaterThan(1e-7); expect(m.returnedEnergyJ!).toBeGreaterThan(1e-7);
    close(m.energyJ, m.absorbedEnergyJ! - m.returnedEnergyJ!);
  });
});
