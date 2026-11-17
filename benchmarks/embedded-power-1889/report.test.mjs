import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { validateEvidence, renderPowerSummary } from '../embedded-report-1889.mjs';

const root = 'benchmarks/embedded-power-1889';
const ids = ['pwm-rc-dac', 'pwm-rlc', 'mos-half-bridge', 'diode-inductive', 'bjt-high-side', 'switch-buck', 'switch-boost'];
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
      validateEvidence(row);
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

test('GPIO, sensor and power buckets contain 20 distinct decks', () => {
  const dirs = ['benchmarks/embedded-gpio-1889', 'benchmarks/embedded-sensors-1889', root];
  const decks = dirs.flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.cir')).map(name => readFileSync(`${dir}/${name}`)));
  assert.equal(decks.length, 20);
  assert.equal(new Set(decks.map(bytes => createHash('sha256').update(bytes).digest('hex'))).size, 20);
});

test('missing signal evidence is rejected', () => {
  const report = readReport();
  const comparison = report.fixtures[0].comparisons[0];
  delete comparison.metrics.signals[comparison.signals[0]];
  assert.throws(() => validate(report));
});
test('missing sample evidence is rejected', () => {
  const report = readReport();
  const comparison = report.fixtures[0].comparisons[0];
  comparison.metrics.signals[comparison.signals[0]].sampleCount = 0;
  assert.throws(() => validate(report));
});
test('false normalized headline is rejected', () => {
  const report = readReport();
  report.fixtures[0].worstNormalizedError = 0;
  assert.throws(() => validate(report));
});

test('stale published summary rejects a recorded loss', () => {
  const report = readReport();
  report.fixtures[0].outcome = 'spice-ts-loss';
  assert.throws(() => validateSummary(report, readFileSync(`${root}/README.md`, 'utf8')));
});
function validateSummary(report, readme) { assert.ok(readme.includes(renderPowerSummary(report))); }
test('published summary matches the receipt', () => validateSummary(readReport(), readFileSync(`${root}/README.md`, 'utf8')));

test('tampered normalized evidence is rejected', () => {
  const report = readReport();
  report.fixtures[0].normalizedErrors[0].normalized = 0.02;
  assert.throws(() => validate(report));
});

test('generated summary includes failures rather than claiming all matched', () => {
  const report = readReport();
  report.fixtures[0].outcome = 'spice-ts-loss';
  const summary = renderPowerSummary(report);
  assert.match(summary, /pwm-rc-dac \| spice-ts-loss/);
  assert.match(summary, /Matched: 6 of 7/);
});
