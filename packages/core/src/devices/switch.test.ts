import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';
import { InvalidCircuitError, ParseError } from '../errors.js';
import type { StampContext } from './device.js';
import {
  CurrentSwitch, HYST_OFF, HYST_ON, REALLY_OFF, REALLY_ON, resolveSwitchModel, VoltageSwitch,
} from './switch.js';

// Issue #507: ngspice-47 S (voltage-controlled, .model SW) and W
// (current-controlled, .model CSW) switches with hysteresis, the instance
// ON/OFF initial state and SWtrunc timestep limiting (swload.c, cswload.c,
// swtrunc.c).

/**
 * Hysteresis unit deck. References are `ngspice -b` (ngspice-47) on the
 * identical circuit cards with `wrdata v(c) v(o1) v(o2) v(o3)`.
 */
const HYSTERESIS_DECK = `switch hysteresis unit deck
v1 c 0 PWL(0 0 1m 2 2m 0)
vdd vdd 0 DC 2
r1 vdd o1 10k
s1 o1 0 c 0 swp OFF
r2 vdd o2 10k
s2 o2 0 c 0 swn ON
i3 0 ic PWL(0 0 1m 2m 2m 0)
vm ic 0 0
r3 vdd o3 10k
w3 o3 0 vm cswp OFF
c3 o3 0 1n
.model swp sw vt=1 vh=0.2 ron=1 roff=10k
.model swn sw vt=1 vh=-0.2 ron=10 roff=1meg
.model cswp csw it=1m ih=0.2m ron=1k roff=10k
.tran 2u 2m
.end
`;

function crossings(time: number[], values: number[], level: number): number[] {
  const result: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if ((values[i - 1] - level) * (values[i] - level) < 0) result.push(time[i]);
  }
  return result;
}

function at(time: number[], values: number[], target: number): number {
  const index = time.findIndex(t => t >= target);
  return values[index];
}

function fakeContext(voltages: Record<number, number>, extra: Partial<StampContext> = {}): StampContext {
  return {
    stampG: () => {},
    stampB: () => {},
    stampC: () => {},
    getVoltage: node => voltages[node] ?? 0,
    getCurrent: () => 0,
    time: 0,
    dt: 0,
    numNodes: 2,
    sourceScale: 1,
    useDcSourceValue: false,
    ...extra,
  };
}

describe('S/W switches (#507)', () => {
  it('closes an S switch whose control is above VT+VH at the operating point', async () => {
    const result = await simulate(`s on
vc c 0 2
vdd vdd 0 2
r1 vdd o 10k
s1 o 0 c 0 sw1
.model sw1 sw vt=1 vh=0.2 ron=1 roff=10k
.op
.end
`);
    expect(result.dc!.voltage('o')).toBeCloseTo(2 / 10001, 12);
  });

  it('follows the instance ON/OFF flag inside the hysteresis window (switches-manual-p92)', async () => {
    const result = await simulate(`window
v2 c 0 0.9
v4 vdd 0 2
r20 vdd 20 10k
r30 vdd 30 10k
s2 20 0 c 0 sw1 OFF
s3 30 0 c 0 sw1 ON
.model sw1 sw vt=1 vh=0.2 ron=1 roff=10k
.op
.end
`);
    // ngspice-47: v(20) = 1.0 (open), v(30) = 1.9998e-4 (closed).
    expect(result.dc!.voltage('20')).toBeCloseTo(1, 9);
    expect(result.dc!.voltage('30')).toBeCloseTo(2 / 10001, 12);
  });

  it('leaves the ON/OFF flag once the control is outside the window, as MODEINITFLOAT does', async () => {
    const result = await simulate(`outside
vc c 0 0
v4 vdd 0 2
r1 vdd o 10k
s1 o 0 c 0 sw1 ON
.model sw1 sw vt=1 vh=0.2 ron=1 roff=10k
.op
.end
`);
    // ON flag gives HYST_ON in MODEINITFIX; the float load sees 0 < VT-VH and opens it.
    expect(result.dc!.voltage('o')).toBeCloseTo(1, 9);
  });

  it('matches ngspice-47 switching instants and levels on the hysteresis deck', async () => {
    const tran = (await simulate(HYSTERESIS_DECK)).transient!;
    const time = tran.time;
    const o1 = tran.voltage('o1');
    const o2 = tran.voltage('o2');
    const o3 = tran.voltage('o3');

    // Initial levels: ngspice v(o1)=1, v(o2)=1.980198 (ON flag left at 0 V), v(o3)=1.
    expect(o1[0]).toBeCloseTo(1, 9);
    expect(o2[0]).toBeCloseTo(2e6 / 1.01e6, 6);
    expect(o3[0]).toBeCloseTo(1, 9);

    // s1 (VH=+0.2) closes above 1.2 V and opens below 0.8 V; ngspice-47 brackets
    // the edges between its samples (5.9856e-4, 6.0056e-4] and (1.599e-3, 1.601e-3].
    const [o1Close, o1Open] = crossings(time, o1, 0.5);
    expect(o1Close).toBeGreaterThan(5.9856e-4);
    // Allow floating-point rounding of the ngspice-aligned sample (#1628).
    expect(o1Close).toBeLessThanOrEqual(6.0056e-4 * (1 + 1e-12));
    expect(o1Open).toBeGreaterThan(1.599e-3);
    expect(o1Open).toBeLessThanOrEqual(1.601e-3 * (1 + 1e-12));

    // s2 (VH=-0.2) toggles whenever the control enters the window: it closes
    // at 0.8 V rising, (3.9856e-4, 4.0056e-4], and opens at 1.2 V falling,
    // (1.399e-3, 1.401e-3], as in ngspice-47.
    const [o2Close, o2Open] = crossings(time, o2, 1);
    expect(o2Close).toBeGreaterThan(3.9856e-4);
    expect(o2Close).toBeLessThanOrEqual(4.0056e-4 * (1 + 1e-12));
    expect(o2Open).toBeGreaterThan(1.399e-3);
    // Since #621 (CKTtrunc step control) spice-ts samples 1.401e-3 as ngspice
    // does and the interpolated crossing lands on it to within rounding.
    expect(o2Open).toBeLessThanOrEqual(1.401e-3 * (1 + 1e-12));

    // w3 closes at 1.2 mA (ngspice: between 5.9856e-4 and 6.0056e-4) and,
    // with the control falling back to 0 A at 2 ms, stays closed above 0.8 mA.
    const [o3Close] = crossings(time, o3, 0.6);
    expect(o3Close).toBeGreaterThan(5.9856e-4);
    expect(o3Close).toBeLessThanOrEqual(6.0256e-4 * (1 + 1e-12));

    // Settled levels at 1 ms.
    expect(at(time, o1, 1e-3)).toBeCloseTo(2 / 10001, 9);
    expect(at(time, o2, 1e-3)).toBeCloseTo(20 / 10010, 9);
    expect(at(time, o3, 1e-3)).toBeCloseTo(2 / 11, 6);
  });

  it('carries the switch state along a DC sweep like ngspice-47 dctrcurv', async () => {
    const sweep = (await simulate(`dc sweep switch
vc c 0 0
vdd vdd 0 2
r1 vdd o1 10k
s1 o1 0 c 0 swp OFF
r3 vdd o3 10k
s3 o3 0 c 0 swn OFF
.model swp sw vt=1 vh=0.2 ron=1 roff=10k
.model swn sw vt=1 vh=-0.2 ron=1 roff=10k
.dc vc 0 2 0.05
.end
`)).dcSweep!;
    const closed = 2 / 10001;
    const expected = (index: number, from: number) => (index >= from ? closed : 1);
    // ngspice-47: s1 closes from the 1.2 V point (index 24), s3 from 0.8 V (index 16).
    sweep.voltage('o1').forEach((v, i) => expect(v).toBeCloseTo(expected(i, 24), 9));
    sweep.voltage('o3').forEach((v, i) => expect(v).toBeCloseTo(expected(i, 16), 9));
  });

  it('binds a W switch to a controlling source declared after it, also inside a subcircuit', async () => {
    const result = await simulate(`late control
.subckt cell out ctl
w1 out 0 vs wmod ON
vs ctl 0 0
.ends
.model wmod csw it=1m ih=0.5m ron=1 roff=1meg
i1 0 c 2m
x1 o c cell
vdd vdd 0 2
r1 vdd o 10k
.op
.end
`);
    expect(result.dc!.voltage('o')).toBeCloseTo(2 / 10001, 9);
  });

  // Small-signal analyses: ngspice loads once in MODEINITSMSIG, which copies
  // CKTstate1 into state0. CKTstate1 is REALLY_OFF after an operating point,
  // so ngspice-47 stamps ROFF in AC and noise (and pole-zero) even for a switch
  // that is closed at the operating point. References are `ngspice -b`
  // (ngspice-47) on the identical cards; see benchmarks/switches-507.
  it('stamps ROFF in AC after an operating point that closed the switch (MODEINITSMSIG)', async () => {
    const result = await simulate(`ac
vc c 0 2
vin in 0 dc 0 ac 1
r1 in o 1k
s1 o 0 c 0 sw1
.model sw1 sw vt=1 ron=1k roff=1meg
.ac lin 1 1k 1k
.end
`);
    // The operating point closes s1 (2 V > VT); ngspice-47 vm(o) = 9.990010e-01.
    expect(result.ac!.voltage('o')[0].magnitude).toBeCloseTo(1e6 / 1.001e6, 9);
  });

  it('stamps ROFF in AC for ON-flag and hysteresis-window switches (MODEINITSMSIG)', async () => {
    const result = await simulate(`window ac
vc c 0 0.9
vin in 0 dc 0 ac 1
r1 in o 1k
s1 o 0 c 0 sw1 ON
s2 o 0 c 0 sw2 OFF
.model sw1 sw vt=1 vh=0.2 ron=1k roff=1meg
.model sw2 sw vt=1 vh=0.2 ron=3k roff=1meg
.op
.ac lin 1 1k 1k
.end
`);
    // The operating point keeps s1 closed (ON flag, HYST_ON): v(o) = 0 V
    // with vin at 0 V DC. AC still sees both open: ngspice-47 vm(o) = 9.980040e-01.
    expect(result.dc!.voltage('o')).toBeCloseTo(0, 12);
    expect(result.ac!.voltage('o')[0].magnitude).toBeCloseTo(5e5 / 5.01e5, 9);
  });

  it('stamps ROFF in AC for a W switch closed at the operating point', async () => {
    const result = await simulate(`csw ac
i1 0 c 2m
vm c 0 0
vin in 0 dc 0 ac 1
r1 in o 1k
w1 o 0 vm wmod
.model wmod csw it=1m ih=0.5m ron=1k roff=1meg
.ac lin 1 1k 1k
.end
`);
    // ngspice-47 vm(o) = 9.990010e-01.
    expect(result.ac!.voltage('o')[0].magnitude).toBeCloseTo(1e6 / 1.001e6, 9);
  });

  it('adds switch thermal noise at the ROFF conductance in .noise (swnoise.c, cswnoise.c)', async () => {
    const deck = (output: string) => `switch noise
vc c 0 2
vin in 0 dc 0 ac 1
r1 in o 1k
s1 o 0 c 0 sw1
.model sw1 sw vt=1 ron=1 roff=1k
i2 0 c2 2m
vm c2 0 0
r2 in o2 1k
w2 o2 0 vm wmod
.model wmod csw it=1m ih=0.5m ron=1 roff=3k
.noise v(${output}) vin lin 2 1k 2k
.end
`;
    const s = (await simulate(deck('o'))).noise!;
    // ngspice-47: onoise_spectrum = 2.878894e-09, inoise_spectrum = 5.757789e-09
    // (1k || ROFF 1k; RON would give 4.07e-12).
    expect(Math.abs(s.outputNoiseDensity[0] / 2.878894e-9 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(s.inputNoiseDensity[0] / 5.757789e-9 - 1)).toBeLessThan(1e-6);
    const w = (await simulate(deck('o2'))).noise!;
    // ngspice-47: onoise_spectrum = 3.525911e-09, inoise_spectrum = 4.701215e-09.
    expect(Math.abs(w.outputNoiseDensity[0] / 3.525911e-9 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(w.inputNoiseDensity[0] / 4.701215e-9 - 1)).toBeLessThan(1e-6);
  });

  it('places the .pz pole with ROFF (MODEINITSMSIG)', async () => {
    const result = await simulate(`switch pz
vc c 0 2
r1 o 0 1k
c1 o 0 1u
s1 o 0 c 0 sw1
.model sw1 sw vt=1 ron=1k roff=1meg
.pz o 0 o 0 cur pol
.end
`);
    // ngspice-47 print all: -1.00100e+03,0.000000e+00 (RON would give -2000).
    expect(result.poleZero!.poles).toHaveLength(1);
    const [pole] = result.poleZero!.poles;
    expect(pole.real).toBeCloseTo(-1001, 6);
    expect(pole.imaginary).toBe(0);
  });

  it('rejects a model of the wrong type and malformed instance flags', () => {
    expect(() => parse(`wrong
.model d1 d is=1e-14
vc c 0 1
s1 o 0 c 0 d1
r1 o 0 1k
.op
.end
`).compile()).toThrow(InvalidCircuitError);
    expect(() => parse(`flags
.model sw1 sw
vc c 0 1
s1 o 0 c 0 sw1 MAYBE
.op
.end
`)).toThrow(ParseError);
  });

  it('round-trips S and W cards through toNetlist', () => {
    const netlist = parse(`rt
.model sw1 sw vt=1
.model w1m csw it=1m
v1 c 0 1
s1 o 0 c 0 sw1 ON
w1 o 0 v1 w1m
r1 o 0 1k
.op
.end
`).toNetlist();
    expect(netlist).toMatch(/^s1 o 0 c 0 sw1 ON$/m);
    expect(netlist).toMatch(/^w1 o 0 v1 w1m OFF$/m);
  });

  it('defaults RON to 1 ohm and ROFF to 1/gmin, and warns on foreign parameters', () => {
    const { model, warnings } = resolveSwitchModel('CSW', { VT: 1, IT: 2e-3 }, 1e-12);
    expect(model).toEqual({ threshold: 2e-3, hysteresis: 0, onConductance: 1, offConductance: 1e-12 });
    expect(warnings).toEqual([".model CSW parameter 'VT' is not a CSW parameter and is ignored"]);
  });

  describe('state machine', () => {
    const model = { threshold: 1, hysteresis: 0.2, onConductance: 1, offConductance: 1e-4 };

    it('keeps state0 inside a positive window and flags a state change as non-converged', () => {
      const sw = new VoltageSwitch('s1', [0, -1, 1, -1], model, false);
      sw.beginOperatingPoint();
      sw.stamp(fakeContext({ 1: 0 }));
      expect(sw.currentState).toBe(REALLY_OFF);
      expect(sw.limitedLastStamp()).toBe(true); // MODEINITFIX -> one MODEINITFLOAT iteration
      sw.stamp(fakeContext({ 1: 1.1 }));
      expect(sw.currentState).toBe(REALLY_OFF);
      expect(sw.limitedLastStamp()).toBe(false);
      sw.stamp(fakeContext({ 1: 1.3 }));
      expect(sw.currentState).toBe(REALLY_ON);
      expect(sw.limitedLastStamp()).toBe(true);
      sw.stamp(fakeContext({ 1: 0.9 }));
      expect(sw.currentState).toBe(REALLY_ON);
    });

    it('stays in the MODEINITFIX init rule during source ramping', () => {
      const sw = new VoltageSwitch('s1', [0, -1, 1, -1], model, true);
      sw.beginOperatingPoint();
      sw.stamp(fakeContext({ 1: 0 }, { sourceScale: 0.5 }));
      expect(sw.currentState).toBe(HYST_ON);
      expect(sw.limitedLastStamp()).toBe(false);
      sw.stamp(fakeContext({ 1: 0.9 }));
      expect(sw.currentState).toBe(HYST_ON);
    });

    it('applies the negative-hysteresis quirks of SW and CSW predictor loads', () => {
      const negative = { ...model, hysteresis: -0.2 };
      const s = new VoltageSwitch('s1', [0, -1, 1, -1], negative, false);
      const w = new CurrentSwitch('w1', [0, -1], 0, negative, false);
      for (const sw of [s, w]) {
        sw.beginOperatingPoint();
        sw.stamp(fakeContext({ 1: 1.5 }, { getCurrent: () => 1.5 }));
        sw.limitedLastStamp();
        sw.stamp(fakeContext({ 1: 1.5 }, { getCurrent: () => 1.5 }));
        expect(sw.currentState).toBe(REALLY_ON);
        sw.acceptTransientStep(fakeContext({ 1: 1.5 }));
        sw.beginTransientNewton();
        sw.stamp(fakeContext({ 1: 1 }, { getCurrent: () => 1 }));
      }
      // swload.c MODEINITPRED: REALLY_ON entering the window becomes REALLY_OFF;
      // cswload.c makes it HYST_OFF.
      expect(s.currentState).toBe(REALLY_OFF);
      expect(w.currentState).toBe(HYST_OFF);
    });

    it('limits the step as the control approaches the threshold (SWtrunc)', () => {
      const sw = new VoltageSwitch('s1', [0, -1, 1, -1], model, false);
      sw.beginOperatingPoint();
      sw.stamp(fakeContext({ 1: 0.5 }));
      sw.acceptTransientStep(fakeContext({ 1: 0.5 }));
      sw.beginTransientNewton();
      sw.stamp(fakeContext({ 1: 0.9 }));
      const truncation = { deltas: [1e-6, 1e-6, 1e-6] as const, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14, trtol: 7 };
      // ((1.2 - 0.9) * 0.75 + 0.05) / (0.9 - 0.5) * 1us
      expect(sw.truncateTransientStep(fakeContext({}), truncation)).toBeCloseTo(0.275 / 0.4 * 1e-6, 18);
      // Moving away from the threshold does not limit.
      sw.acceptTransientStep(fakeContext({}));
      sw.beginTransientNewton();
      sw.stamp(fakeContext({ 1: 0.7 }));
      expect(sw.truncateTransientStep(fakeContext({}), truncation)).toBe(Infinity);
    });
  });
});
