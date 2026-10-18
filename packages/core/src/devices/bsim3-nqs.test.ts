import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const reference = JSON.parse(readFileSync(new URL('../../../../benchmarks/bsim3-nqs-692/ngspice-47.json', import.meta.url), 'utf8')) as {
  engine: string;
  cases: { version: string; nqs: number; deck: string; samples: { time: number; voltage: number[] }[] }[];
};
const nodes = ['n1', 'n2', 'out'];
function interpolate(time: readonly number[], voltage: readonly number[], t: number): number {
  const i = time.findIndex(x => x >= t);
  if (i <= 0) return voltage[Math.max(i, 0)];
  return voltage[i - 1] + (voltage[i] - voltage[i - 1]) * (t - time[i - 1]) / (time[i] - time[i - 1]);
}

describe('BSIM3 transient NQS (#692)', () => {
  it.each(reference.cases.filter(c => c.nqs === 1))('$version matches ngspice-47 NQS rather than silently running QS', async nqs => {
    expect(reference.engine).toBe('ngspice-47');
    const qs = reference.cases.find(c => c.version === nqs.version && c.nqs === 0)!;
    const delta = Math.max(...nqs.samples.map((sample, i) => Math.abs(sample.voltage[0] - qs.samples[i].voltage[0])));
    expect(delta).toBeGreaterThan(0.1);
    const tran = (await simulate(nqs.deck)).transient!;
    const errors = nodes.map((node, col) => Math.max(...nqs.samples.map(sample =>
      Math.abs(interpolate(tran.time, tran.voltage(node), sample.time) - sample.voltage[col]))));
    console.log(nqs.version, 'NQS max absolute voltage errors', errors);
    expect(Math.max(...errors) / 2.5).toBeLessThan(0.01);
  });

  it('leaves explicit NQSMOD=0 bit-identical to the default QS path', async () => {
    const deck = reference.cases[0].deck;
    const a = (await simulate(deck)).transient!;
    const b = (await simulate(deck.replace(/ NQSMOD=0/g, ''))).transient!;
    expect(a.time).toEqual(b.time);
    for (const node of nodes) expect(a.voltage(node)).toEqual(b.voltage(node));
  });
});
