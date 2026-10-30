import assert from 'node:assert/strict';

// Retain the full-scale peak and unrounded errors, not just the rounded headline.
export function validateEvidence(row) {
  assert.equal(row.comparedAnalyses, row.comparisons.length);
  const evidence = row.normalizedErrors;
  assert.ok(Array.isArray(evidence));
  let count = 0;
  for (const comparison of row.comparisons) {
    assert.ok(!comparison.unmatched && comparison.signals.length > 0);
    assert.deepEqual([...comparison.signals].sort(), Object.keys(comparison.metrics.signals).sort());
    assert.ok(comparison.metrics.grid.alignedPoints > 0);
    for (const signal of comparison.signals) {
      const metric = comparison.metrics.signals[signal];
      assert.equal(metric.status, 'compared');
      assert.equal(metric.sampleCount, comparison.metrics.grid.alignedPoints);
      const entries = evidence.filter(e => e.analysis === comparison.analysis && e.signal === signal);
      assert.equal(entries.length, 1);
      const e = entries[0];
      assert.ok(Number.isFinite(e.ngspicePeak) && e.ngspicePeak >= 0);
      assert.ok(Number.isFinite(e.absoluteMax) && e.absoluteMax >= 0);
      assert.equal(e.absoluteMax, metric.absoluteError.max);
      const floor = /^v\(/i.test(signal) ? 1e-4 : /^i\(/i.test(signal) ? 1e-10 : 1e-12;
      assert.equal(e.normalized, e.absoluteMax / Math.max(e.ngspicePeak, floor));
      assert.ok(e.normalized <= 0.01);
      count++;
    }
  }
  assert.equal(count, row.comparedSignals);
  assert.equal(count, evidence.length);
  const worst = Math.max(...evidence.map(e => e.normalized));
  assert.equal(row.worstNormalizedError, Number(worst.toPrecision(3)));
}

export function renderPowerSummary(report) {
  const lines = ['<!-- BEGIN GENERATED RESULTS -->', '## Observed results', '',
    `${report.ngspice}; spice-ts ${report.spiceTsVersion}; Node ${report.node}; ${report.machine.platform} ${report.machine.release} ${report.machine.arch}, ${report.machine.cpu}.`, '',
    '| Deck | Outcome | Worst normalized | ngspice / spice-ts median (ms) |',
    '|---|---|---:|---:|'];
  for (const row of report.fixtures) {
    lines.push(`| ${row.id} | ${row.outcome} | ${row.worstNormalizedError ?? '—'} | ${row.runtime.ngspice.medianMs.toFixed(2)} / ${row.runtime.spiceTs.medianMs.toFixed(2)} |`);
  }
  lines.push('', `Matched: ${report.fixtures.filter(row => row.outcome === 'matched').length} of ${report.fixtures.length}. All outcomes, including failures, are shown above.`,
    'Times include process startup and adapter overhead; they are not solver-only timings.', '<!-- END GENERATED RESULTS -->');
  return lines.join('\n');
}
