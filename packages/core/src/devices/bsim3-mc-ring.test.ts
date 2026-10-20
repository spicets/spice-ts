import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { simulate } from '../simulate.js';

const fixture = new URL('../../../../benchmarks/corpus/corpus-f/fixtures/examples/Monte_Carlo/mc_ring.sp', import.meta.url);

it('converges the nominal mc_ring BSIM3 oscillator (#1600)', async () => {
  const deck = readFileSync(fixture, 'utf8')
    .replace(/^\.control[\s\S]*?^\.endc\s*$/m, '.tran 15p 100n 0');
  const result = await simulate(deck);
  const transient = result.transient!;
  expect(transient.time.at(-1)).toBeCloseTo(100e-9, 15);
  const voltage = transient.voltage('out15');
  const rising: number[] = [];
  for (let i = 1; i < voltage.length; i++) {
    if (voltage[i - 1]! < 1.65 && voltage[i]! >= 1.65) {
      const fraction = (1.65 - voltage[i - 1]!) / (voltage[i]! - voltage[i - 1]!);
      rising.push(transient.time[i - 1]! + fraction * (transient.time[i]! - transient.time[i - 1]!));
    }
  }
  expect(rising.length).toBeGreaterThanOrEqual(30);
  const period = (rising[29]! - rising[9]!) / 20;
  // ngspice-47 -b, identical derived deck, default tolerances:
  // .meas tran t10 when v(out15)=1.65 rise=10
  // .meas tran t30 when v(out15)=1.65 rise=30
  // .meas tran period param='(t30-t10)/20'
  // t10=2.00918e-8 s; t30=6.48188e-8 s; period=2.23635e-9 s.
  expect(Math.abs(period / 2.23635e-9 - 1)).toBeLessThan(0.01);
}, 120_000);
