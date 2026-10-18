import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse, parseControlOptions } from '../parser/index.js';
import { ParseError } from '../errors.js';
import { simulate } from '../simulate.js';
import { resolveOptions } from '../types.js';
import { TransientChargeState } from '../devices/charge-state.js';
import { MNAAssembler } from '../mna/assembler.js';
import { buildCompanionSystem } from '../mna/companion.js';

const RC = `XMU RC regression
V1 in 0 1
R1 in out 1k
C1 out 0 1u IC=0
.tran 100u 2m uic
`;

// ngspice-47 src/spicelib/analysis/cktsopt.c:120-122 assigns XMU without
// a range check. Do not invent a [0, 0.5] clamp. nicomcof.c:43-44 gives
// a0 = 1 / dt / (1 - xmu), a1 = xmu / (1 - xmu).
describe('XMU trapezoidal coefficient (#1274)', () => {
  it('normalizes spaced control option assignments', () => {
    expect(parseControlOptions(['xmu', '=', '0.49'], 1, 'option xmu = 0.49')).toEqual({ xmu: 0.49 });
  });
  it.each(['oops', '1e999'])('rejects invalid netlist XMU %s', value => {
    expect(() => parse(`${RC}.options xmu=${value}`)).toThrow(ParseError);
  });

  it.each([false, true])('weights matrix history with fastPath=%s', fast => {
    for (const staticHistory of [false, true]) {
      const compiled = parse('RC discharge\nR1 out 0 1k\nC1 out 0 1u\n.op').compile();
      const assembler = new MNAAssembler(compiled.nodeCount, compiled.branchCount);
      if (fast) {
        buildCompanionSystem(assembler, compiled.devices, 1e-4, 'euler', new Float64Array([1]), undefined, 0);
        assembler.lockTopology();
      }
      expect(assembler.isFastPath).toBe(fast);
      const history = new Float64Array([staticHistory ? 1e-3 : 0]);
      buildCompanionSystem(assembler, compiled.devices, 1e-4, 'trapezoidal',
        new Float64Array([1]), history, 0, undefined, undefined, staticHistory, 0.49);
      const factor = 1 / 1e-4 / 0.51;
      const weight = 0.49 / 0.51;
      const conductance = fast ? assembler.gValues[assembler.diagIdx[0]] : assembler.G.get(0, 0);
      expect(conductance).toBeCloseTo(1e-3 + factor * 1e-6, 14);
      expect(assembler.b[0]).toBeCloseTo(factor * 1e-6 - weight * 1e-3, 14);
    }
  });
  it.each([-0.1, 0, 0.49, 0.5, 0.75, 1, 1.1])('parses and round-trips finite xmu=%s without clamping', xmu => {
    const circuit = parse(`${RC}.options xmu=${xmu}`);
    expect(circuit.simulationOptions.xmu).toBe(xmu);
    expect(parse(circuit.toNetlist()).simulationOptions.xmu).toBe(xmu);
    expect(resolveOptions({ xmu }).xmu).toBe(xmu);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite API XMU %s', xmu => {
    expect(() => resolveOptions({ xmu })).toThrow('xmu must be finite');
  });

  it('keeps unrelated recognized unsupported options typed', () => {
    expect(() => parse(`${RC}.options xmu=0.49 noinit=1`)).toThrow(ParseError);
    expect(() => parse(`${RC}.options xmu=0.49 noinit=1`)).toThrow("Unsupported .options field: 'noinit'");
  });

  it('retains the exact pre-change main waveform for xmu=0.5', async () => {
    // Measured on main 3a3d0a68 before implementation: all 61 times + voltages.
    for (const options of ['', '.options xmu=0.5']) {
      const result = (await simulate(`${RC}${options}`)).transient!;
      const hash = createHash('sha256').update(JSON.stringify([
        Array.from(result.time), Array.from(result.voltage('out')),
      ])).digest('hex');
      expect(hash).toBe('d5882c15af6aca1a57da9664337ae4f2d45a3b976a319acf0718b8d5f34555d1');
    }
  });

  it('satisfies the weighted RC recurrence at xmu=0.49 within 1e-12 V', async () => {
    const result = (await simulate(`${RC}.options xmu=0.49`)).transient!;
    const v = result.voltage('out');
    // C dv/dt = (1-v)/R. After BE bootstrap, the weighted trap step is
    // v(n+1) = [v(n) + h*(1-xmu*v(n))] / [1+(1-xmu)*h], h=dt/RC.
    for (let i = 3; i < v.length; i++) {
      const h = (result.time[i] - result.time[i - 1]) / 1e-3;
      // The source startup breakpoint at TSTEP resets one step to BE.
      const expected = Math.abs(result.time[i - 1] - 100e-6) < 1e-15
        ? (v[i - 1] + h) / (1 + h)
        : (v[i - 1] + h * (1 - 0.49 * v[i - 1])) / (1 + 0.51 * h);
      expect(Math.abs(v[i] - expected)).toBeLessThan(1e-12);
    }
    const standard = (await simulate(RC)).transient!;
    expect(Math.abs(v[v.length - 1] - standard.voltage('out').at(-1)!)).toBeGreaterThan(1e-5);
  });

  it('weights accepted nonlinear charge currents, including commit history', () => {
    const state = new TransientChargeState(1);
    state.accept(0, 0); state.commit();
    state.begin({ method: 'euler', dt: 0.1 });
    state.accept(0, 0.2); state.commit(); // accepted current = 2
    state.begin({ method: 'trapezoidal', dt: 0.1, xmu: 0.49 });
    const factor = 1 / 0.1 / 0.51;
    expect(state.factor).toBe(factor);
    expect(state.current(0, 0.5)).toBeCloseTo(factor * 0.3 - 0.49 / 0.51 * 2, 14);
    state.accept(0, 0.5); state.commit();
    expect(state.acceptedChargeCurrent(0)).toBeCloseTo(factor * 0.3 - 0.49 / 0.51 * 2, 14);
  });
});
