import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const deck = `Saved thermal diode current
V1 in 0 0.7
D1 in 0 tj DM thermal
R1 in 0 100
.model DM D (RS=0.2 RTH0=100 TNOM=25 PD_MAX=1 ID_MAX=1.5 FV_MAX=1.5 TE_MAX=175)
.options reltol=1e-10 abstol=1e-14 vntol=1e-12
.control
save @d1[id] @r1[i] @v1[i] all
dc v1 0.6 0.8 0.1
let count = length(@d1[id])
let residual = vecmax(abs(@d1[id] + @r1[i] + @v1[i]))
echo count $&count
echo residual $&residual
let p = @dm[pd_max]
let t = @dm[tnom]
echo model $&p $&t
.endc
.end`;

describe('saved DC device currents (#1265)', () => {
  it('samples each thermal operating state, retains KCL and model scalar reads', async () => {
    const result = await simulate(deck);
    expect(result.control!.output[0]).toBe('count 3');
    expect(Number(result.control!.output[1].split(' ')[1])).toBeLessThan(1e-10);
    expect(result.control!.output[2]).toBe('model 1 25');
    const currents = result.dcSweep!.deviceVectors.get('@d1[id]')!;
    expect(currents).toHaveLength(3);
    // ngspice-47, identical deck: print @d1[id] v(tj), numdgt=15.
    const reference = [1.614480527260613e-4, 7.524257089518347e-3, 1.888349660465262e-1];
    const temperatures = [9.686883163563691e-3, 5.266979962662877e-1, 1.510679728372210e1];
    for (let i = 0; i < currents.length; i++) {
      expect(Math.abs(currents[i] / reference[i] - 1)).toBeLessThan(1e-6);
      expect(Math.abs(result.dcSweep!.voltage('tj')[i] / temperatures[i] - 1)).toBeLessThan(1e-6);
      expect(Math.abs(currents[i] / (-result.dcSweep!.current('v1')[i] - (0.6 + i * 0.1) / 100) - 1)).toBeLessThan(1e-6);
    }
  });

  it('keeps saved plots immutable across run, alter and a nested source sweep', async () => {
    const result = await simulate(`Saved load state
V1 n 0 0
I1 0 n 0
B1 n 0 I=v(n)*0.001
R1 n 0 1k
.dc v1 1 2 1 i1 0 0.002 0.002
.control
save @i1[current] @b1[i] @r1[i] all
run
alter r1 2k
dc v1 3 4 1
setplot dc1
let err = vecmax(abs(@r1[i] - v(n)*0.001))
echo old $&err
let err = vecmax(abs(@i1[current] - i(v1) - @r1[i] - @b1[i]))
echo source $&err
let err = vecmax(abs(@b1[i] - @r1[i]))
echo behavioral $&err
.endc
.end`);
    expect(result.control!.output).toEqual(['old 0', 'source 0', 'behavioral 0']);
  });

  it('runs the original SOA deck through the public API without changing its bytes', async () => {
    const bytes = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/soa/diode-soa-sh.cir', import.meta.url));
    const result = await simulate(bytes.toString());
    expect(result.dcSweep!.deviceVectors.get('@d1[id]')).toHaveLength(100);
    expect(result.control!.runs).toHaveLength(1);
  });
});
