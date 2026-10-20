import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { executeTool, MCP_TOOLS, DEFAULT_MCP_LIMITS } from './server.js';
import { sparamsReport } from './sparams.js';
import { SParameterResult } from '@spice-ts/core';

// Original MIT analytic T pad: Z0=50 ohm, voltage ratio 1/2.
const pad = '* Matched T pad\nV1 in 0 dc 0 ac 1 portnum 1 z0 50\nV2 out 0 dc 0 ac 0 portnum 2 z0 50\nR1 in mid 16.666666666666668\nR2 mid out 16.666666666666668\nR3 mid 0 66.66666666666667\n.sp lin 3 100 1000 0\n.end';
async function run(extra = {}) {
  const response = await executeTool('spice_sparams', { netlist: pad, ...extra });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
  expect(new AjvJsonSchemaValidator().getValidator(MCP_TOOLS.find(t => t.name === 'spice_sparams')!.outputSchema!)(response.structuredContent).valid).toBe(true);
  return response.structuredContent as unknown as {
    ports: string[]; points: { frequencyHz: number; parameters: Record<string, {
      magnitude: number; magnitudeDb: number | null; phaseDeg: number | null;
      returnLossDb?: number | null; insertionLossDb?: number | null; vswr?: number | null;
    }> }[];
  };
}
describe('spice_sparams', () => {
  it('returns matched-pad S11=0 and S21=-6.020599913279624 dB within 1e-9', async () => {
    const result = await run();
    expect(result.ports).toEqual(['V1', 'V2']);
    expect(result.points.map(p => p.frequencyHz)).toEqual([100, 550, 1000]);
    for (const { parameters: s } of result.points) {
      expect(Object.keys(s)).toEqual(['S11', 'S12', 'S21', 'S22']);
      for (const key of ['S11', 'S22']) {
        expect(s[key].magnitude).toBeLessThan(1e-9);
        expect(Math.abs(s[key].vswr! - 1)).toBeLessThan(1e-9);
      }
      for (const key of ['S21', 'S12']) {
        expect(Math.abs(s[key].magnitude - 0.5)).toBeLessThan(1e-9);
        expect(Math.abs(s[key].magnitudeDb! + 6.020599913279624)).toBeLessThan(1e-9);
        expect(Math.abs(s[key].insertionLossDb! - 6.020599913279624)).toBeLessThan(1e-9);
        expect(Math.abs(s[key].phaseDeg!)).toBeLessThan(1e-9);
      }
    }
  });
  it('returns closed-form mismatch reflection=1/3, return loss and VSWR=2', async () => {
    const netlist = 'V1 in 0 portnum 1 z0 50\nR1 in 0 100\nV2 out 0 portnum 2 z0 50\nR2 out 0 50\n.sp lin 1 100 100 0';
    const s = (await run({ netlist })).points[0].parameters.S11;
    expect(Math.abs(s.magnitude - 1 / 3)).toBeLessThan(1e-9);
    expect(Math.abs(s.returnLossDb! - 9.54242509439325)).toBeLessThan(1e-9);
    expect(Math.abs(s.vswr! - 2)).toBeLessThan(1e-9);
  });
  it('evaluates requested frequencies and selects S(output,input)', async () => {
    const result = await run({ portPair: [2, 1], frequenciesHz: [123, 9876] });
    expect(result.points.map(p => p.frequencyHz)).toEqual([123, 9876]);
    expect(Object.keys(result.points[0].parameters)).toEqual(['S21']);
  });
  it.each(Array.from({ length: 11 }, (_, i) => i + 1))('preserves all 121 ordered pairs and output %i selectors for eleven nonreciprocal ports', async output => {
    const netlist = [
      ...Array.from({ length: 11 }, (_, i) => {
        const k = i + 1;
        return `V${k} n${k} 0 portnum ${k} z0 50\nR${k} n${k} 0 50`;
      }),
      'Gforward n11 0 n1 0 0.02',
      '.sp lin 1 100 100 0',
    ].join('\n');
    const result = await run({ netlist });
    expect(result.ports).toHaveLength(11);
    const full = result.points[0].parameters;
    expect(Object.keys(full)).toHaveLength(121);
    for (let input = 1; input <= 11; input++) {
      const key = output >= 10 || input >= 10 ? `S_${output}_${input}` : `S${output}${input}`;
      expect(full[key], key).toBeDefined();
      const expectedMagnitude = output === 11 && input === 1 ? 0.5 : 0;
      expect(Math.abs(full[key].magnitude - expectedMagnitude), key).toBeLessThan(1e-9);
      const selected = await run({ netlist, portPair: [output, input] });
      expect(selected.points[0].parameters).toEqual({ [key]: full[key] });
    }
    expect(Math.abs(full.S_11_1.phaseDeg!)).toBeCloseTo(180, 9);
    expect(full.S_1_11.magnitude).toBe(0);
  });
  it('evaluates frequency-dependent phase and magnitude without interpolation', async () => {
    const netlist = 'V1 in 0 portnum 1 z0 50\nV2 out 0 portnum 2 z0 50\nC1 in out 1u\n.sp lin 1 100 100 0';
    const result = await run({ netlist, portPair: [2, 1], frequenciesHz: [123, 9876] });
    for (const { frequencyHz, parameters: { S21: s } } of result.points) {
      const reactance = 1 / (2 * Math.PI * frequencyHz * 1e-6);
      expect(Math.abs(s.magnitude - 100 / Math.hypot(100, reactance))).toBeLessThan(1e-9);
      expect(Math.abs(s.phaseDeg! - Math.atan2(reactance, 100) * 180 / Math.PI)).toBeLessThan(1e-9);
    }
  });
  it('uses null for exact zero dB/phase without clamping near-unity reflection', async () => {
    const result = await run({ netlist: 'V1 in 0 portnum 1 z0 50\nV2 out 0 portnum 2 z0 50\nR1 in 0 100\n.sp lin 1 100 100 0' });
    expect(result.points[0].parameters.S21).toMatchObject({ magnitude: 0, magnitudeDb: null, phaseDeg: null, insertionLossDb: null });
    expect(Math.abs(result.points[0].parameters.S22.magnitude - 1)).toBeLessThan(1e-15);
    expect(result.points[0].parameters.S22.vswr).toBeGreaterThan(1e15);
  });
  it('represents exact unity and active reflection VSWR as null', () => {
    for (const magnitude of [1, 2]) {
      const raw = new SParameterResult([100], ['V1'], new Map([['S_1_1', [{ real: magnitude, imaginary: 0 }]]]));
      expect(sparamsReport([raw], { netlist: '' }).points[0].parameters.S11).toMatchObject({ vswr: null });
    }
  });
  it.each([
    { netlist: pad.replace('.sp lin 3 100 1000 0', '.op') },
    { portPair: [0, 1] }, { portPair: [3, 1] }, { portPair: [1.5, 1] },
    { portPair: [1] }, { frequenciesHz: [] }, { frequenciesHz: [0] },
    { frequenciesHz: [Infinity] }, { surprise: true },
    { netlist: pad.replace('.sp', '.ac lin 1 1 1\n.sp') },
    { netlist: pad.replace('.end', '.control\nsp lin 1 1 1\n.endc\n.end') },
  ])('returns structured validation errors for %j', async extra => {
    const response = await executeTool('spice_sparams', { netlist: pad, ...extra });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', message: expect.any(String), phase: 'validation' } } });
    expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual(response.structuredContent);
  });
  it('advertises the tool and enforces resource bounds and cancellation', async () => {
    expect((await executeTool('spice_capabilities', {})).structuredContent?.tools).toContain('spice_sparams');
    for (const limits of [{ maxDocumentBytes: 1 }, { maxResultPoints: 1 }, { maxSerializedResultBytes: 1 }, { maxAnalyses: 0 }]) {
      expect((await executeTool('spice_sparams', { netlist: pad }, { limits: { ...DEFAULT_MCP_LIMITS, ...limits } })).structuredContent).toMatchObject({ error: { code: 'RESOURCE_LIMIT' } });
    }
    for (const extra of [{ netlist: pad.replace('lin 3 100 1000', 'dec 100000000 1 1e12') }, { frequenciesHz: [1, 2] }]) {
      expect((await executeTool('spice_sparams', { netlist: pad, ...extra }, { limits: { ...DEFAULT_MCP_LIMITS, maxResultPoints: 4 } })).structuredContent).toMatchObject({ error: { code: 'RESOURCE_LIMIT', phase: 'validation' } });
    }
    const controller = new AbortController(); controller.abort();
    expect((await executeTool('spice_sparams', { netlist: pad }, { signal: controller.signal })).structuredContent).toMatchObject({ error: { code: 'CANCELLED' } });
  });
});
