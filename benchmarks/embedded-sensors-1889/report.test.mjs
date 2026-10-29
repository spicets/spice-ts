import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = 'benchmarks/embedded-sensors-1889';
const ids = ['anti-alias', 'two-stage', 'loaded-divider', 'thermistor', 'differential', 'rlc-input', 'shunt-sense'];
const readReport = () => JSON.parse(readFileSync(`${root}/report.json`, 'utf8'));
function validate(report, readDeck = id => readFileSync(`${root}/${id}.cir`)) {
  assert.deepEqual(report.fixtures.map(row => row.id).sort(), [...ids].sort());
  assert.match(report.ngspice, /ngspice-47\b/);
  assert.match(report.coreTree, /^[a-f0-9]{40}$/);
  assert.match(report.coreBundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(new Set(report.fixtures.map(row => row.sha256)).size, 7);
  for (const row of report.fixtures) {
    assert.equal(createHash('sha256').update(readDeck(row.id)).digest('hex'), row.sha256);
    const ng = row.ngspice.status, ts = row.spiceTs.status;
    assert.ok(['success', 'failed', 'unsupported'].includes(ng));
    assert.ok(['success', 'failed', 'unsupported'].includes(ts));
    const allowed = ng !== 'success' ? [ts !== 'success' ? 'both-failed' : 'ngspice-failed']
      : ts !== 'success' ? ['spice-ts-loss'] : ['matched', 'mismatch', 'not-compared'];
    assert.ok(allowed.includes(row.outcome));
    if (row.outcome === 'matched') {
      assert.ok(row.comparedSignals > 0 && row.worstNormalizedError !== null && row.worstNormalizedError <= 0.01);
      assert.ok(row.comparisons.length > 0);
    }
    for (const engine of ['ngspice', 'spiceTs']) {
      assert.equal(row.runtime[engine].samplesMs.length, 3);
      assert.ok(row.runtime[engine].samplesMs.every(n => Number.isFinite(n) && n >= 0));
      const sorted = [...row.runtime[engine].samplesMs].sort((a, b) => a - b);
      assert.equal(row.runtime[engine].medianMs, sorted[1]);
    }
  }
}

test('checked-in report covers all seven original hashed decks', () => validate(readReport()));
test('missing deck is rejected', () => {
  assert.throws(() => validate(readReport(), () => { throw new Error('missing deck'); }), /missing deck/);
});
test('altered bytes are rejected', () => {
  assert.throws(() => validate(readReport(), id => Buffer.concat([readFileSync(`${root}/${id}.cir`), Buffer.from('altered')])));
});
test('a falsely reported match is rejected', () => {
  const report = readReport();
  Object.assign(report.fixtures[0], { outcome: 'matched', worstNormalizedError: 0.02 });
  report.fixtures[0].ngspice.status = report.fixtures[0].spiceTs.status = 'success';
  assert.throws(() => validate(report));
});
test('missing or duplicated rows are rejected', () => {
  const report = readReport();
  report.fixtures[0] = report.fixtures[1];
  assert.throws(() => validate(report));
});
