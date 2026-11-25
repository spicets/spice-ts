import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it } from 'vitest';

const request = { apiVersion: '1', input: { format: 'spice', source: '* RC high pass\nV1 in 0 AC 1\nC1 in out 1u\nR1 out 0 1k\n.ac dec 20 1 100k\n.end' } };

describe('directional gain crossings over MCP stdio', () => {
  it('discovers and validates the schema and simulates the analytic RC edge', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/stdio.ts'], cwd: process.cwd(), stderr: 'pipe' });
    const client = new Client({ name: 'ac-direction-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find(t => t.name === 'spice_ac_metrics')!;
      expect(tool.inputSchema.properties!.gainCrossingDirection).toMatchObject({ type: 'string', enum: ['ascending', 'descending', 'either'] });
      expect(tool.inputSchema.properties!.gainCrossingsDb).toMatchObject({ minItems: 1, maxItems: 32 });
      const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
      const base = { request, output: 'out', input: 'in', gainCrossingsDb: [-10] };
      expect(validate({ ...base, gainCrossingDirection: 'ascending' }).valid).toBe(true);
      expect(validate({ ...base, gainCrossingDirection: 'up' }).valid).toBe(false);
      expect(validate({ ...base, gainCrossingsDb: Array(33).fill(-10) }).valid).toBe(false);
      const invalid = await client.callTool({ name: tool.name, arguments: { ...base, gainCrossingDirection: 'up' } });
      expect(invalid).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_REQUEST' } } });
      const result = await client.callTool({ name: tool.name, arguments: { ...base, gainCrossingDirection: 'ascending' } });
      expect(result.isError).not.toBe(true);
      const actual = (result.structuredContent as { gainCrossings: { frequencyHz: number }[] }).gainCrossings[0].frequencyHz;
      const gain = (f: number) => { const x = 2 * Math.PI * f * 1000 * 1e-6; return 20 * Math.log10(x / Math.sqrt(1 + x * x)); };
      const i = Array.from({ length: 101 }, (_, n) => n).find(n => gain(10 ** (n / 20)) >= -10)!;
      const lo = 10 ** ((i - 1) / 20); const hi = 10 ** (i / 20);
      const fraction = (-10 - gain(lo)) / (gain(hi) - gain(lo));
      const expected = 10 ** (Math.log10(lo) + fraction * (Math.log10(hi) - Math.log10(lo)));
      expect(actual).toBeGreaterThanOrEqual(lo);
      expect(actual).toBeLessThanOrEqual(hi);
      expect(Math.abs(actual / expected - 1)).toBeLessThan(1e-12);
      console.log(`RC high-pass -10 dB: bracket=[${lo}, ${hi}] Hz, analytic interpolated=${expected} Hz, MCP=${actual} Hz`);
    } finally {
      await client.close();
    }
  }, 60000);
});
