import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from '../parser/index.js';
import { MNAAssembler } from '../mna/assembler.js';
import { BSIM3v3 } from './bsim3v3.js';
import * as dc from './bsim3v3-dc.js';

afterEach(() => vi.restoreAllMocks());

describe('BSIM3 exact-bias DC reuse (#1648)', () => {
  it.each([1, -1])('reuses only identical limited biases, polarity %s', polarity => {
    const compiled = parse(`cache test
M1 d g s b MOD W=10u L=1u
.model MOD ${polarity === 1 ? 'NMOS' : 'PMOS'} level=49
.op
.end`).compile();
    const device = compiled.devices.find(d => d instanceof BSIM3v3) as BSIM3v3;
    const asm = new MNAAssembler(compiled.nodeCount, compiled.branchCount);
    const load = (drain: number, gate = 1.2) => {
      asm.clear();
      for (const [name, value] of Object.entries({ d: drain, g: gate, s: 0, b: 0 })) {
        asm.solution[compiled.nodeNames.indexOf(name)] = polarity * value;
      }
      device.stamp(asm.getStampContext());
      return { rhs: Array.from(asm.b), matrix: Array.from({ length: compiled.nodeCount }, (_, r) =>
        Array.from({ length: compiled.nodeCount }, (_, c) => asm.G.get(r, c))) };
    };
    const evaluate = vi.spyOn(dc, 'evaluateDC');
    const first = load(0.8);
    expect(load(0.8)).toEqual(first);
    expect(evaluate).toHaveBeenCalledTimes(1);
    // An interleaved device must not overwrite the cached result.
    const other = parse(`other instance
M2 d g s b MOD W=20u L=1u
.model MOD NMOS level=49
.op
.end`).compile().devices.find(d => d instanceof BSIM3v3) as BSIM3v3;
    other.stamp(asm.getStampContext());
    expect(load(0.8)).toEqual(first);
    expect(evaluate).toHaveBeenCalledTimes(2);
    load(0.8, 1.200000000001);
    expect(evaluate).toHaveBeenCalledTimes(3);
    const reversed = load(-0.1);
    expect(load(-0.1)).toEqual(reversed);
    expect(evaluate).toHaveBeenCalledTimes(4);
    device.setTemperature(70);
    expect(load(-0.1)).not.toEqual(reversed);
    expect(evaluate).toHaveBeenCalledTimes(5);
  });
});
