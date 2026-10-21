import { describe, expect, it } from 'vitest';
import { InvalidCircuitError, ParseError } from '../errors.js';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';

/**
 * PSpice `.model <name> ISWITCH(...)` current-controlled switches (#848).
 * ngspice-47 has no ISWITCH device: its PSpice compatibility mode
 * (frontend/inpcompat.c pspice_compat) turns an ION/IOFF model into the XSPICE
 * aswitch code model (`log=TRUE limit=TRUE`) and each W instance into
 * `a<name> %vnam(<vcontrol>) %gd(n+ n-) a<model>`, and an IT/IH model into the
 * native CSW switch.
 *
 * Every expected value is `ngspice -b` (ngspice-47) output on the same deck,
 * run with `set ngbehavior=psa` in .spiceinit, except the plain aswitch A-card
 * test (default ngspice mode).
 */
function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe('PSpice ISWITCH switch model (#848)', () => {
  it('matches ngspice-47 over a DC sweep of the control current through off, log and on regions', async () => {
    // IMOD1: ion > ioff; IMOD2: ion < ioff and parenthesised parameters.
    const result = await simulate(`iswitch dc sweep
V1 in 0 DC 1
Ic 0 c DC 0
Vs c 0 DC 0
R1 in out 1k
W1 out 0 Vs IMOD1
R2 in out2 1k
W2 out2 0 Vs IMOD2
.MODEL IMOD1 ISWITCH RON=1 ROFF=1MEG ION=1m IOFF=-1m
.MODEL IMOD2 ISWITCH(RON=10 ROFF=1e4 ION=-2m IOFF=3m)
.dc Ic -4m 4m 0.5m
.end
`);
    // ngspice-47 .print dc v(out) v(out2), Ic = -4m .. 4m step 0.5m.
    const ngspice = [
      [9.990010e-01, 9.900990e-03], [9.990010e-01, 9.900990e-03], [9.990010e-01, 9.900990e-03],
      [9.990010e-01, 9.900990e-03], [9.990010e-01, 9.900990e-03], [9.990010e-01, 1.956230e-02],
      [9.990010e-01, 3.828650e-02], [9.693466e-01, 7.358756e-02], [5.000000e-01, 1.368069e-01],
      [3.065343e-02, 2.402531e-01], [9.990010e-04, 3.868632e-01], [9.990010e-04, 5.573116e-01],
      [9.990010e-04, 7.152528e-01], [9.990010e-04, 8.336625e-01], [9.990010e-04, 9.090909e-01],
      [9.990010e-04, 9.090909e-01], [9.990010e-04, 9.090909e-01],
    ];
    const out = result.dcSweep!.voltage('out');
    const out2 = result.dcSweep!.voltage('out2');
    expect(out).toHaveLength(ngspice.length);
    ngspice.forEach(([v1, v2], index) => {
      expect(relativeError(out[index], v1)).toBeLessThan(1e-6);
      expect(relativeError(out2[index], v2)).toBeLessThan(1e-6);
    });
  });

  it('turns an IT/IH model into the native CSW switch, ignores TD and defaults RON/ROFF like ngspice-47', async () => {
    // ngspice-47: v(out) = 5.935094e-02, v(out2) = 4.975124e-03, v(out3) = 7.992400e-01;
    // MIF warns "unrecognized parameter (td) - ignored" on the aswitch model.
    const result = await simulate(`iswitch it ih td defaults
V1 in 0 DC 1
Ic 0 c DC 0.4m
Vs c 0 DC 0
R1 in out 1k
W1 out 0 Vs IMOD1
R2 in out2 1k
W2 out2 0 Vs IMOD2
R3 in out3 1k
W3 out3 0 Vs IMOD3
.MODEL IMOD1 ISWITCH RON=1 ROFF=1MEG ION=1m IOFF=-1m TD=1n
.MODEL IMOD2 ISWITCH RON=5 ROFF=1e5 IT=0.1m IH=0.05m
.MODEL IMOD3 ISWITCH ION=1m IOFF=0
.op
.end
`);
    expect(relativeError(result.dc!.voltage('out'), 5.935094e-2)).toBeLessThan(1e-6);
    expect(relativeError(result.dc!.voltage('out2'), 4.975124e-3)).toBeLessThan(1e-6);
    expect(relativeError(result.dc!.voltage('out3'), 7.992400e-1)).toBeLessThan(1e-6);

    const circuit = parse('it\nVs 2 0 0\nW1 1 0 Vs IMOD2\n.MODEL IMOD2 ISWITCH RON=5 ROFF=1e5 IT=0.1m IH=0.05m\n.op');
    expect(circuit.compile().models.get('imod2')).toMatchObject({
      type: 'CSW', params: { RON: 5, ROFF: 1e5, IT: 1e-4, IH: 5e-5 },
    });
  });

  it('translates ISWITCH models and W instances inside a subcircuit in transient', async () => {
    // ngspice-47 rewrites W1 to `aw1 %vnam(vs) %gd(a b) aimodx` and resolves vs to v.x1.vs.
    // Keep the 2 ns ngspice references below; a 4 ns max step still meets every
    // 0.05 % assertion while halving transient work under CI coverage. A 10 ns
    // max step is too coarse: ngspice-47's v(out) at 6 us is 5.498615e-02,
    // 0.3 % off its converged 5.514434e-02 (1 ns max step).
    const result = await simulate(`iswitch tran in subckt
.subckt isw a b cp cn
Vs cp cn DC 0
W1 a b Vs IMODX
.MODEL IMODX ISWITCH RON=0.01 ROFF=1e4
+ ION=1.5m IOFF=-1.5m
.ends
V1 in 0 DC 5
Vc c 0 PULSE(-3 3 0 10u 10u 40u 100u)
Rc c cp 1k
R1 in out 100
C1 out 0 100n
X1 out 0 cp 0 isw
.tran 0.5u 200u 0 4n
.end
`);
    const time = result.transient!.time;
    const out = result.transient!.voltage('out');
    const at = (t: number): number => {
      const index = time.findIndex(value => value >= t - 1e-15);
      if (Math.abs(time[index] - t) < 1e-15) return out[index];
      const fraction = (t - time[index - 1]) / (time[index] - time[index - 1]);
      return out[index - 1] + fraction * (out[index] - out[index - 1]);
    };
    // ngspice-47 wrdata v(out), linearly interpolated at these times.
    const ngspice: Array<[number, number]> = [
      [3e-6, 4.947614], [5e-6, 3.504198], [5.5e-6, 1.266189], [6e-6, 5.513955e-2],
      [12e-6, 4.999500e-4], [30e-6, 4.999500e-4], [55e-6, 1.950221e-1], [62e-6, 2.546771],
      [80e-6, 4.560250], [105e-6, 3.482381], [150e-6, 4.999500e-4], [200e-6, 4.898727],
    ];
    expect(out[0]).toBeCloseTo(4.950495, 6);
    for (const [t, expected] of ngspice) expect(relativeError(at(t), expected)).toBeLessThan(5e-4);
  });

  it('linearises the switch resistance in AC (ngspice-47 loads a negative conductance there)', async () => {
    // Operating point (ngspice-47): v(out) = 5.935094e-02, so r = 1k * v / (1 - v).
    // ngspice-47's aswitch AC_GAIN(out,out) = -1/r gives vr(out) = -6.73449e-02 here;
    // spice-ts loads the small-signal model of the operating point, +1/r plus the
    // control transconductance (zero here: the control current has no AC part).
    const result = await simulate(`iswitch ac
V1 in 0 DC 1 AC 1
Ic 0 c DC 0.4m
Vs c 0 DC 0
R1 in out 1k
W1 out 0 Vs IMOD1
.MODEL IMOD1 ISWITCH RON=1 ROFF=1MEG ION=1m IOFF=-1m
.op
.ac lin 1 1k 1k
.end
`);
    const v = result.dc!.voltage('out');
    expect(relativeError(v, 5.935094e-2)).toBeLessThan(1e-6);
    const r = 1000 * v / (1 - v);
    expect(relativeError(result.ac!.voltage('out')[0].magnitude, r / (1000 + r))).toBeLessThan(1e-6);
  });

  it('runs the aswitch code model directly on A cards: log/linear, with and without limit', async () => {
    // ngspice-47 default mode, .print dc v(out) v(out2) v(out3) for Vc = -1.5 .. 1.5 step 0.25.
    const result = await simulate(`aswitch a cards
V1 in 0 DC 1
Vc c 0 DC 0
R1 in out 1k
a1 %v(c) %gd(out 0) lin1
R2 in out2 1k
a2 c (out2 0) lin2
R3 in out3 1k
a3 %vd(c 0) %gd(out3 0) log3
.model lin1 aswitch(cntl_on=0.5 cntl_off=-0.5 r_on=10 r_off=1e4 log=false limit=true)
.model lin2 aswitch(cntl_on=-1 cntl_off=1 r_on=100 r_off=1e5 log=false)
.model log3 aswitch(cntl_on=0.5 cntl_off=-0.5 r_on=10 r_off=1e4)
.dc Vc -1.5 1.5 0.25
.end
`);
    const ngspice = [
      [9.090909e-01, 3.010383e-11, 9.999000e-01], [9.090909e-01, 1.000000e-12, 9.994380e-01],
      [9.090909e-01, 9.090909e-02, 9.968477e-01], [9.090909e-01, 9.264029e-01, 9.825279e-01],
      [9.090909e-01, 9.616491e-01, 9.090909e-01], [8.823875e-01, 9.740681e-01, 6.400650e-01],
      [8.334721e-01, 9.804114e-01, 2.402531e-01], [7.148967e-01, 9.842613e-01, 5.324022e-02],
      [9.900990e-03, 9.868464e-01, 9.900990e-03], [9.900990e-03, 9.887022e-01, 1.775123e-03],
      [9.900990e-03, 9.900990e-01, 3.161278e-04], [9.900990e-03, 9.911885e-01, 5.623097e-05],
      [9.900990e-03, 9.920619e-01, 9.999900e-06],
    ];
    const outs = ['out', 'out2', 'out3'].map(node => result.dcSweep!.voltage(node));
    expect(outs[0]).toHaveLength(ngspice.length);
    ngspice.forEach((row, index) => row.forEach((expected, column) => {
      const actual = outs[column][index];
      // Without limit the linear switch clamps r to 1e-9 ohm below cntl_on = -1:
      // v(out2) ~ 1e-12 V, far below vntol (ngspice prints the pre-converged iterate).
      if (expected < 1e-9) expect(Math.abs(actual)).toBeLessThan(1e-10);
      else expect(relativeError(actual, expected)).toBeLessThan(1e-6);
    }));
  });

  it('rejects ISWITCH models ngspice-47 cannot translate with a structured error', () => {
    // Neither ION/IOFF nor IT/IH: ngspice-47 inpcompat.c prints "Bad switch model".
    const badSwitch = /bad PSpice ISWITCH switch model, expected ION\/IOFF or IT\/IH/;
    for (const deck of [
      'bad\nVs 2 0 0\nW1 1 0 Vs IBAD\n.MODEL IBAD ISWITCH RON=1 ROFF=1e6\n.op',
      'bad\n.subckt s a b\nVs b 0 0\nW1 a b Vs IBAD\n.MODEL IBAD ISWITCH(RON=1)\n.ends\n.op',
    ]) {
      expect(() => parse(deck)).toThrow(ParseError);
      expect(() => parse(deck)).toThrow(badSwitch);
    }
    // Only one of ION/IOFF: ngspice-47 aborts (inpcompat.c frees the translated card twice).
    for (const deck of [
      'one\nVs 2 0 0\nW1 1 0 Vs IONE\n.MODEL IONE ISWITCH ION=1m\n.op',
      'one\nVs 2 0 0\nW1 1 0 Vs IONE\n.MODEL IONE ISWITCH(IOFF=0 RON=1)\n.op',
    ]) {
      expect(() => parse(deck)).toThrow(ParseError);
      expect(() => parse(deck)).toThrow(/needs both ION and IOFF/);
    }
  });

  it('keeps the ISWITCH card through toNetlist() and refuses it on S and A instances', async () => {
    const circuit = parse('rt\nV1 1 0 1\nIc 0 3 DC 2m\nVs 3 0 0\nR1 1 2 1k\nW1 2 0 Vs IMOD1\n.MODEL IMOD1 ISWITCH RON=1 ROFF=1MEG ION=1m IOFF=-1m\n.op');
    const reparsed = await simulate(circuit.toNetlist());
    expect(relativeError(reparsed.dc!.voltage('2'), 1 / 1001)).toBeLessThan(1e-9);

    // ngspice-47 rewrites only W lines and renames the model to a<name>.
    const sCard = parse('s\nV1 1 0 1\nS1 1 0 1 0 IMOD1\n.MODEL IMOD1 ISWITCH RON=1 ROFF=1MEG ION=1m IOFF=-1m\n.op');
    expect(() => sCard.compile()).toThrow(InvalidCircuitError);
    const aCard = parse('a\nV1 1 0 1\nA1 %vnam(V1) %gd(1 0) IMOD1\n.MODEL IMOD1 ISWITCH RON=1 ROFF=1MEG ION=1m IOFF=-1m\n.op');
    expect(() => aCard.compile()).toThrow(InvalidCircuitError);
  });

  it('rejects an aswitch model with coincident thresholds (ngspice-47 ASWITCH error)', async () => {
    await expect(simulate('eq\nV1 1 0 1\nR1 1 2 1k\na1 %v(1) %gd(2 0) eq\n.model eq aswitch(cntl_on=1 cntl_off=1)\n.op'))
      .rejects.toThrow(/cntl_on and cntl_off/);
  });
});
