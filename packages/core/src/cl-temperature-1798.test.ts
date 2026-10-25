import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from './parser/index.js';
import { simulate } from './simulate.js';

const deck = (name: string): string => readFileSync(new URL(`./fixtures/cl-temperature-1798/${name}.cir`, import.meta.url), 'utf8');
const relative = (actual: number, expected: number): void => {
  expect(Math.abs((actual - expected) / expected)).toBeLessThan(1e-6);
};

// ngspice-47, identical committed decks. From the repository root:
// SPICE_ASCIIRAWFILE=1 ngspice -b -r "$TMPDIR/rc.raw" packages/core/src/fixtures/cl-temperature-1798/rc-hot.cir
// SPICE_ASCIIRAWFILE=1 ngspice -b -r "$TMPDIR/rl.raw" packages/core/src/fixtures/cl-temperature-1798/rl-cold.cir
// AC references are v(out) from the complex raw vectors; TRAN is linearly
// interpolated at 1 ms, identically to the spice-ts waveform below.
describe('C/L circuit temperature, ngspice-47 #1798', () => {
  it('matches hot RC AC near -3 dB and its transient step response', async () => {
    const result = await simulate(deck('rc-hot'));
    relative(result.ac!.voltage('out')[0].magnitude, 0.7071150253756583);
    const tran = result.transient!;
    const i = tran.time.findIndex(t => t >= 0.001);
    const f = (0.001 - tran.time[i - 1]) / (tran.time[i] - tran.time[i - 1]);
    const v = tran.voltage('out');
    relative(v[i - 1] + f * (v[i] - v[i - 1]), 0.5884687472111162);
  });

  it('matches cold RL AC near -3 dB', async () => {
    const result = await simulate(deck('rl-cold'));
    relative(result.ac!.voltage('out')[0].magnitude, 0.7071060621612979);
    relative(result.ac!.voltage('out')[0].phase, 45.00005826148514);
  });

  it.each(['C', 'L'])('%s uses circuit TNOM defaults without compounding on recompile', (kind) => {
    const base = kind === 'C' ? 1e-6 : 0.1;
    const value = kind === 'C' ? '1u' : '100m';
    const circuit = parse(`defaults\nV1 in 0 AC 1\nR1 in out 1k\n${kind}1 out 0 ${value} TC1=1e-3 TC2=1e-5 M=2 SCALE=3\n.options TEMP=100 TNOM=40\n.ac lin 1 100 100\n.end`);
    const get = (): number => circuit.compile().devices.find(d => d.name === `${kind}1`)!.getParameter!();
    const multiplicity = kind === 'C' ? 2 : 0.5;
    relative(get(), base * 1.096 * 3 * multiplicity);
    circuit.setTemperature(40);
    relative(get(), base * 3 * multiplicity);
    circuit.setTemperature(100);
    relative(get(), base * 1.096 * 3 * multiplicity);
  });

  it.each(['C', 'L'])('%s honors model TNOM, per-coefficient overrides and instance TEMP/DTEMP', (kind) => {
    const value = kind === 'C' ? '1u' : '100m';
    const base = kind === 'C' ? 1e-6 : 0.1;
    const parameter = (extra: string, options = 'TEMP=100 TNOM=40'): number => {
      const circuit = parse(`precedence\nV1 in 0 AC 1\nR1 in out 1k\n${kind}1 out 0 ${value} MOD ${extra}\n.model MOD ${kind} TC1=1e-3 TC2=1e-5 TNOM=50\n.options ${options}\n.ac lin 1 100 100\n.end`);
      return circuit.compile().devices.find(d => d.name === `${kind}1`)!.getParameter!();
    };
    relative(parameter('TC1=0 DTEMP=10'), base * 1.036);
    relative(parameter('TEMP=80 DTEMP=100'), base * 1.039);
    relative(parameter('', 'TEMP=50'), base);
  });
});
