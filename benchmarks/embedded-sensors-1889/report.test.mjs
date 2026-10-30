import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateEvidence } from '../embedded-report-1889.mjs';

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
    assert.equal(row.comparedAnalyses, row.comparisons.length);
    const measured = [];
    for (const comparison of row.comparisons) {
      const metrics = comparison.metrics.signals;
      assert.deepEqual([...comparison.signals].sort(), Object.keys(metrics).sort());
      for (const [signal, metric] of Object.entries(metrics)) {
        assert.ok(['compared', 'missing'].includes(metric.status));
        if (metric.status === 'compared' && metric.sampleCount > 0) measured.push({ analysis: comparison.analysis, signal, metric });
        if (row.outcome === 'matched') assert.ok(metric.status === 'compared' && metric.sampleCount > 0);
      }
      if (row.outcome === 'matched') {
        assert.ok(!comparison.unmatched && Object.keys(metrics).length > 0);
        assert.ok(!(comparison.metrics.sweepGroups ?? []).some(group => group.unmatched));
      }
    }
    assert.equal(row.comparedSignals, measured.length);
    assert.equal(row.normalizedErrors.length, measured.length);
    for (let i = 0; i < measured.length; i++) {
      const { analysis, signal, metric } = measured[i], error = row.normalizedErrors[i];
      assert.equal(error.analysis, analysis);
      assert.equal(error.signal, signal);
      assert.equal(error.absoluteMax, metric.absoluteError.max);
      assert.ok(Number.isFinite(error.ngspicePeak) && error.ngspicePeak >= 0);
      const floor = signal.startsWith('v(') ? 1e-4 : signal.startsWith('i(') ? 1e-10 : 1e-12;
      assert.equal(error.normalized, error.absoluteMax / Math.max(error.ngspicePeak, floor));
      assert.ok(Number.isFinite(error.normalized) && error.normalized >= 0);
    }
    const worst = row.normalizedErrors.reduce((a, b) => !a || b.normalized > a.normalized ? b : a, null);
    assert.equal(row.worstNormalizedError, worst ? Number(worst.normalized.toPrecision(3)) : null);
    assert.equal(row.worstSignal, worst ? `${worst.analysis} ${worst.signal}` : null);
    if (row.outcome === 'matched') {
      validateEvidence(row);
      assert.ok(row.comparedSignals > 0 && row.worstNormalizedError !== null && row.worstNormalizedError <= 0.01);
      assert.ok(row.comparisons.length > 0 && worst.normalized <= 0.01);
      assert.equal(row.comparedAnalyses, new Set(row.spiceTs.analyses.map(analysis => analysis.split(':')[0])).size);
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

test('missing signal coverage cannot be reported as matched', () => {
  const report = readReport();
  const signals = report.fixtures[0].comparisons[0].metrics.signals;
  signals[Object.keys(signals)[0]].status = 'missing';
  assert.throws(() => validate(report));
});
test('summary coverage cannot disagree with comparison metrics', () => {
  const report = readReport();
  report.fixtures[0].comparedSignals++;
  assert.throws(() => validate(report));
});
test('summary error cannot hide a detailed signal error', () => {
  const report = readReport();
  report.fixtures[0].worstNormalizedError = 0;
  assert.throws(() => validate(report));
});
test('detailed absolute error cannot disagree with normalized evidence', () => {
  const report = readReport();
  report.fixtures[0].comparisons[0].metrics.signals[Object.keys(report.fixtures[0].comparisons[0].metrics.signals)[0]].absoluteError.max = 1;
  assert.throws(() => validate(report));
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

test('tampered normalized evidence is rejected', () => {
  const report = readReport();
  report.fixtures[0].normalizedErrors[0].normalized = 0.02;
  assert.throws(() => validate(report));
});
