import { expect, it } from 'vitest';
import { simulate } from '../simulate.js';

it('does not apply node-voltage LTE to CSW hysteresis state (#1628)', async () => {
  // Reduced switches-manual-p92: S and W share the rising/falling threshold.
  // ngspice-47 -n -b -r reference.raw on these identical cards gives the
  // adjacent v(10) transition samples below (seconds, volts).
  const tran = (await simulate(`S/W truncation
v1 1 0 DC 0 PWL(0 0 2m 2 4m 0)
i3 3 0 DC 0 PWL(0 0 2m 2m 4m 0)
r3 3 33 10k
vm3 0 33 0
v4 4 0 2
r10 4 10 10k
r40 4 40 10k
s1 10 0 1 0 switch1 OFF
w1 40 0 vm3 wswitch1 OFF
.model switch1 sw vt=1 vh=0.2 ron=1 roff=10k
.model wswitch1 csw it=1m ih=0.2m ron=1k roff=10k
.tran 2u 5m
.end
`)).transient!;
  const values = tran.voltage('10');
  const edges = values.flatMap((v, i) => i > 0 && Math.abs(v - values[i - 1]) > 0.5
    ? [[tran.time[i - 1], tran.time[i], values[i - 1], v]] : []);
  const reference = [
    [0.001198560000000016, 0.001200560000000016, 1, 0.00019998000199980003],
    [0.0031989999999998994, 0.0032009999999998992, 0.00019998000199980003, 1],
  ];
  expect(edges).toHaveLength(reference.length);
  edges.forEach((edge, i) => edge.forEach((value, j) => expect(value).toBeCloseTo(reference[i][j], 12)));
});
