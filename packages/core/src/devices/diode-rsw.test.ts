import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';

const deck = readFileSync(new URL('../../../../benchmarks/diode-rsw/sidewall.cir', import.meta.url), 'utf8');

describe('diode independent sidewall series resistance (#1515)', () => {
  it('runs OP, DC, AC and transient with JSW/CJSW and positive RSW', async () => {
    const oracle = JSON.parse(readFileSync(new URL('../../../../benchmarks/diode-rsw/reference.json', import.meta.url), 'utf8')) as {
      sha256: string;
      reference: Record<string, { names: string[]; rows: number[][][] }>;
    };
    expect(createHash('sha256').update(deck).digest('hex')).toBe(oracle.sha256);
    const result = await simulate(deck);
    for (const [analysis, { names, rows }] of Object.entries(oracle.reference)) {
      for (const signal of ['v(in)', 'v(out)', 'i(v1)']) {
        const column = names.indexOf(signal);
        expect(column).toBeGreaterThanOrEqual(0);
        const node = signal.slice(2, -1);
        const voltage = signal.startsWith('v');
        let actual: number[][];
        if (analysis === 'op') actual = [[voltage ? result.dc!.voltage(node) : result.dc!.current(node), 0]];
        else if (analysis === 'dc') actual = Array.from(voltage ? result.dcSweep!.voltage(node) : result.dcSweep!.current(node), v => [v, 0]);
        else if (analysis === 'ac') actual = (voltage ? result.ac!.voltage(node) : result.ac!.current(node))
          .map(({ magnitude, phase }) => [magnitude * Math.cos(phase * Math.PI / 180), magnitude * Math.sin(phase * Math.PI / 180)]);
        else {
          const times = result.transient!.time;
          const values = voltage ? result.transient!.voltage(node) : result.transient!.current(node);
          actual = rows.map(row => {
            const t = row[0][0];
            let i = 0;
            while (i < times.length - 2 && times[i + 1] < t) i++;
            const f = (t - times[i]) / (times[i + 1] - times[i]);
            return [values[i] + f * (values[i + 1] - values[i]), 0];
          });
        }
        expect(actual.length).toBe(rows.length);
        const peak = Math.max(...rows.map(row => Math.hypot(...row[column])));
        const error = Math.max(...rows.map((row, i) => Math.hypot(row[column][0] - actual[i][0], row[column][1] - actual[i][1])));
        expect(error, `${analysis}:${signal}`).toBeLessThanOrEqual(0.01 * peak);
      }
    }
  });

  it('keeps absent and zero RSW bit-identical', async () => {
    const absent = await simulate(deck.replace(' RSW=200', ''));
    const zero = await simulate(deck.replace('RSW=200', 'RSW=0'));
    expect(zero.dc!.voltage('out')).toBe(absent.dc!.voltage('out'));
    expect(zero.dc!.current('V1')).toBe(absent.dc!.current('V1'));
    expect(zero.dcSweep!.voltage('out')).toEqual(absent.dcSweep!.voltage('out'));
    expect(zero.transient!.voltage('out')).toEqual(absent.transient!.voltage('out'));
    const absentNodes = parse(deck.replace(' RSW=200', '')).compile().nodeNames;
    expect(parse(deck.replace('RSW=200', 'RSW=0')).compile().nodeNames).toEqual(absentNodes);
    expect(parse(deck).compile().nodeNames.length).toBe(absentNodes.length + 1);
  });

  it('rejects unimplemented NS-absent and self-heating combinations explicitly', async () => {
    await expect(simulate(deck.replace(' NS=1.4', ''))).rejects.toThrow('requires explicit NS');
    await expect(simulate(deck.replace('area=2', 'thermal area=2'))).rejects.toThrow('Self-heating diode RSW');
  });
});
