import { describe, expect, it } from 'vitest';
import { parse } from '../index.js';
import { simulate } from '../../simulate.js';

const deck = `Hierarchical alter
.subckt divider out
V1 in 0 DC 1
R1 in out 1k
R2 out 0 1k
.ends
.subckt wrapper out
Xinner out divider
.ends
X1 a divider
X2 b divider
X3 c wrapper
`;

async function voltages(commands: string) {
  const result = await simulate(`${deck}.control\n${commands}\n.endc\n.end`);
  return result.control!.runs.map(run => ['a', 'b', 'c'].map(node => run.result.dc!.voltage(node)));
}

describe('hierarchical alter (#1266)', () => {
  it('alters resistor and DC source independently using case-insensitive ngspice names', async () => {
    const values = await voltages('op\nalter r.x1.r1=2k\nop\nalter V.X1.V1 DC=2\nop');
    for (const [index, expected] of [0.5, 1 / 3, 2 / 3].entries()) {
      expect(values[index][0]).toBeCloseTo(expected, 12);
      expect(values[index][1]).toBeCloseTo(0.5, 12);
    }
  });

  it('resolves nested paths and retains earlier changes across recompilation', async () => {
    const values = await voltages('alter R.X3.Xinner.R1=3k\nop\nalter v.x3.xinner.v1 dc=2\nop');
    expect(values[0][2]).toBeCloseTo(0.25, 12);
    expect(values[1][2]).toBeCloseTo(0.5, 12);
    expect(values[1][0]).toBeCloseTo(0.5, 12);
  });

  it('restores overrides on reset and repeated simulation of a parsed circuit', async () => {
    const circuit = parse(`${deck}.control\nop\nalter R.X1.R1=2k\nop\nreset\nop\n.endc\n.end`);
    for (let i = 0; i < 2; i++) {
      const result = await simulate(circuit);
      const values = result.control!.runs.map(run => run.result.dc!.voltage('a'));
      for (const [index, expected] of [0.5, 1 / 3, 0.5].entries()) expect(values[index]).toBeCloseTo(expected, 12);
    }
  });

  it('restores preexisting overrides even when control execution throws', async () => {
    const circuit = parse(`${deck}.control\nalter R.X1.R1=3k\nalter R.X1.missing=2k\n.endc\n.end`);
    expect(circuit.alterInstance('R.X1.R1', undefined, [2000])).toBeUndefined();
    const restore = circuit.snapshotControlState();
    await expect(simulate(circuit)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL_COMMAND' });
    // Remove the failing script and verify the saved 2k, not the script's 3k.
    circuit.setControlScript(undefined);
    circuit.analyses.push({ type: 'op' });
    expect((await simulate(circuit)).dc!.voltage('a')).toBeCloseTo(1 / 3, 12);
    expect(circuit.alterInstance('R.X1.R1', undefined, [4000])).toBeUndefined();
    restore();
    expect((await simulate(circuit)).dc!.voltage('a')).toBeCloseTo(1 / 3, 12);
  });

  it.each(['R.Xmissing.R1', 'V.X1.R1', 'R.X1.missing'])('keeps a typed unknown-device error for %s', async name => {
    await expect(voltages(`alter ${name}=2k`)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTROL_COMMAND', command: 'alter',
    });
  });
});
