import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';

const deck = readFileSync(new URL('../../../../benchmarks/diode-rsw/sidewall.cir', import.meta.url), 'utf8');

describe('diode independent sidewall series resistance (#1515)', () => {
  it.each(['sidewall', 'default-ns'])('runs OP, DC, AC and transient with JSW/CJSW and positive RSW (%s)', async fixtureName => {
    const fixture = readFileSync(new URL(`../../../../benchmarks/diode-rsw/${fixtureName}.cir`, import.meta.url), 'utf8');
    const referenceName = fixtureName === 'sidewall' ? 'reference' : `${fixtureName}-reference`;
    const oracle = JSON.parse(readFileSync(new URL(`../../../../benchmarks/diode-rsw/${referenceName}.json`, import.meta.url), 'utf8')) as {
      sha256: string;
      reference: Record<string, { names: string[]; rows: number[][][] }>;
    };
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(oracle.sha256);
    const result = await simulate(fixture);
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

  it.each([true, false])('keeps absent and zero RSW bit-identical (explicit NS: %s)', async explicitNS => {
    const fixture = explicitNS ? deck : deck.replace(' NS=1.4', '');
    const absent = await simulate(fixture.replace(' RSW=200', ''));
    const zero = await simulate(fixture.replace('RSW=200', 'RSW=0'));
    expect(zero.dc!.voltage('out')).toBe(absent.dc!.voltage('out'));
    expect(zero.dc!.current('V1')).toBe(absent.dc!.current('V1'));
    expect(zero.dcSweep!.voltage('out')).toEqual(absent.dcSweep!.voltage('out'));
    expect(zero.transient!.voltage('out')).toEqual(absent.transient!.voltage('out'));
    expect(zero.ac!.voltage('out')).toEqual(absent.ac!.voltage('out'));
    const absentNodes = parse(fixture.replace(' RSW=200', '')).compile().nodeNames;
    expect(parse(fixture.replace('RSW=200', 'RSW=0')).compile().nodeNames).toEqual(absentNodes);
    expect(parse(fixture).compile().nodeNames.length).toBe(absentNodes.length + 1);
  });

  it.each([0, 5])('uses the bottom voltage without junction charge (RS=%s)', async rs => {
    const fixture = deck.replace(' NS=1.4', '').replace('RS=5', `RS=${rs}`);
    const charged = await simulate(fixture);
    const chargeFree = fixture.replace(' CJO=20p', '').replace(' CJSW=30p', '').replace(' TT=1n', '');
    const result = await simulate(chargeFree);
    expect(result.dc!.voltage('out')).toBeCloseTo(charged.dc!.voltage('out'), 9);
    expect(result.dc!.current('V1')).toBeCloseTo(charged.dc!.current('V1'), 11);
    expect(parse(chargeFree).compile().nodeNames.length).toBe(rs > 0 ? 4 : 3);
  });

  it('rejects unimplemented self-heating combinations explicitly', async () => {
    await expect(simulate(deck.replace('area=2', 'thermal area=2'))).rejects.toThrow('Self-heating diode RSW');
  });
});
