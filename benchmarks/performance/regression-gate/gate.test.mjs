import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, median, order } from './gate.mjs';

const sample = (n = 100) => ({ cold: n, warm: n, output: 'b'.repeat(64) });
const receipt = () => ({ engine: 'spice-ts', version: '0.4.0', runtime: 'node', environment: 'host', cases: Object.fromEntries(['rc-10', 'rc-100', 'rc-ladder-tran-1000'].map(id => [id, { deck: 'a'.repeat(64), samples: Array.from({length: 5}, () => sample()) }])) });
test('median and alternating interleaving', () => {
  assert.equal(median([9, 1, 5, 2, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.deepEqual([0, 1, 2, 3, 4].map(order), [['base','candidate'], ['candidate','base'], ['base','candidate'], ['candidate','base'], ['base','candidate']]);
});
test('exactly ten percent passes, 10.01 percent fails', () => {
  const base = receipt(), candidate = receipt();
  candidate.cases['rc-10'].samples.forEach(s => { s.warm = 110; });
  assert.equal(compare(base, candidate).ok, true);
  candidate.cases['rc-10'].samples.forEach(s => { s.warm = 110.01; });
  assert.equal(compare(base, candidate).ok, false);
});
test('missing and invalid baselines fail', () => {
  assert.throws(() => compare(null, receipt()));
  const base = receipt(); base.cases['rc-100'].samples[0].cold = 0;
  assert.throws(() => compare(base, receipt()));
  const short = receipt(); short.cases['rc-10'].samples.pop();
  assert.throws(() => compare(short, receipt()));
});
test('mismatched output, deck, runtime and environment fail', () => {
  for (const change of [r => r.cases['rc-10'].deck = 'c'.repeat(64), r => r.cases['rc-10'].samples[0].output = 'c'.repeat(64), r => r.runtime = 'other', r => r.environment = 'other']) {
    const r = receipt(); change(r); assert.throws(() => compare(receipt(), r));
  }
});
