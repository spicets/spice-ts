import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createMcpServer } from './index.js';
import { executeTool } from './server.js';
import { impedanceArgs, impedanceReport } from './impedance.js';

const port = { positive: 'in', negative: '0' };
const spectrum = { frequencyHz: [10, 20, 30], positive: [1, 3, 1].map(magnitude => ({ magnitude, phaseDegrees: 0 })), negative: [1, 3, 1].map(() => ({ magnitude: 0, phaseDegrees: 0 })) };

describe('directional magnitude crossings', () => {
  it('chooses the first crossing in the requested direction', () => {
    const run = (magnitudeCrossingDirection: string) => impedanceReport(spectrum, impedanceArgs({ port, sweep: { variation: 'lin', points: 3, startFreq: 10, stopFreq: 30 }, magnitudeLevelsOhm: [2], magnitudeCrossingDirection })).magnitudeCrossings;
    expect(run('rising')).toEqual([{ magnitudeOhm: 2, frequencyHz: 15 }]);
    expect(run('falling')).toEqual([{ magnitudeOhm: 2, frequencyHz: 25 }]);
  });
});

const runTrace = (magnitudes: number[], levels: number[], direction?: string, variation: 'lin' | 'dec' | 'oct' = 'lin') => {
  const frequencyHz = magnitudes.map((_, i) => variation === 'lin' ? 10 * (i + 1) : 10 ** (i + 1));
  const data = { frequencyHz, positive: magnitudes.map(magnitude => ({ magnitude, phaseDegrees: 0 })), negative: magnitudes.map(() => ({ magnitude: 0, phaseDegrees: 0 })) };
  return impedanceReport(data, impedanceArgs({ port, sweep: { variation, points: 3, startFreq: 10, stopFreq: frequencyHz[frequencyHz.length - 1] }, magnitudeLevelsOhm: levels, ...(direction === undefined ? {} : { magnitudeCrossingDirection: direction }) }));
};

describe('directional magnitude edges', () => {
  it('preserves the complete default result for explicit either and level order', () => {
    const levels = [2, 4, 2, 1, 3];
    expect(JSON.stringify(runTrace([1, 3, 1], levels))).toBe(JSON.stringify(runTrace([1, 3, 1], levels, 'either')));
    expect(runTrace([1, 3, 1], levels, 'falling').magnitudeCrossings).toEqual([
      { magnitudeOhm: 2, frequencyHz: 25 }, { magnitudeOhm: 4, frequencyHz: null }, { magnitudeOhm: 2, frequencyHz: 25 }, { magnitudeOhm: 1, frequencyHz: 30 }, { magnitudeOhm: 3, frequencyHz: 20 },
    ]);
  });
  it.each(['dec', 'oct'] as const)('interpolates %s in logarithmic frequency', variation => {
    expect(runTrace([1, 3, 1], [2], 'rising', variation).magnitudeCrossings![0].frequencyHz).toBeCloseTo(Math.sqrt(1000), 10);
    expect(runTrace([1, 3, 1], [2], 'falling', variation).magnitudeCrossings![0].frequencyHz).toBeCloseTo(Math.sqrt(100000), 10);
  });
  it('handles exact knots, flat segments, and single samples without extrapolation', () => {
    expect(runTrace([1, 2, 3], [2], 'rising').magnitudeCrossings![0].frequencyHz).toBe(20);
    expect(runTrace([1, 2, 3], [2], 'falling').magnitudeCrossings![0].frequencyHz).toBeNull();
    for (const direction of ['rising', 'falling']) {
      expect(runTrace([2, 2, 2], [2], direction).magnitudeCrossings![0].frequencyHz).toBeNull();
      expect(runTrace([2], [2], direction).magnitudeCrossings![0].frequencyHz).toBeNull();
    }
    expect(runTrace([2, 2, 2], [2], 'either').magnitudeCrossings![0].frequencyHz).toBe(10);
    expect(runTrace([2, 2, 3], [2], 'rising').magnitudeCrossings![0].frequencyHz).toBe(20);
    expect(runTrace([3, 2, 2], [2], 'falling').magnitudeCrossings![0].frequencyHz).toBe(20);
  });
  it.each([{ magnitudeCrossingDirection: 'up', magnitudeLevelsOhm: [2] }, { magnitudeCrossingDirection: 'either' }, { magnitudeCrossingDirection: null, magnitudeLevelsOhm: [2] }])('returns structured invalid requests %#', async options => {
    const response = await executeTool('spice_impedance', { request: { apiVersion: '1', input: { format: 'spice', source: '* resistor\nR1 in 0 10\n.ac lin 2 10 20\n.end' } }, port, ...options });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST', phase: 'validation' } } });
  });
});

describe('directional magnitude MCP integration', () => {
  it('advertises the selector and finds distinct sampled RLC crossings', async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: 'magnitude-direction-test', version: '1' });
    try {
      await server.connect(st); await client.connect(ct);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_impedance')!;
      expect(tool.inputSchema.properties?.magnitudeCrossingDirection).toMatchObject({ enum: ['rising', 'falling', 'either'] });
      const base = { request: { apiVersion: '1', input: { format: 'spice', source: '* series RLC\nR1 in a 10\nL1 a b 10m\nC1 b 0 1u\nRleak b 0 1g\n.ac dec 10 100 10000\n.end' } }, port, magnitudeLevelsOhm: [30] };
      const frequencies: number[] = [];
      for (const direction of ['falling', 'rising']) {
        const args = { ...base, magnitudeCrossingDirection: direction };
        expect(new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args).valid).toBe(true);
        const response = await client.callTool({ name: tool.name, arguments: args });
        expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true);
        expect(new AjvJsonSchemaValidator().getValidator(tool.outputSchema!)(response.structuredContent).valid).toBe(true);
        const result = response.structuredContent as { magnitudeCrossings: { frequencyHz: number | null }[] };
        expect(result.magnitudeCrossings[0].frequencyHz).not.toBeNull();
        frequencies.push(result.magnitudeCrossings[0].frequencyHz!);
      }
      expect(frequencies[0]).toBeLessThan(frequencies[1]);
    } finally { await client.close(); await server.close(); }
  });
});
