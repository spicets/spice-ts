import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = 'benchmarks/embedded-gpio-1889';
test('every selected original GPIO deck has an honest, reproducible outcome', () => {
  const report = JSON.parse(readFileSync(`${root}/report.json`, 'utf8'));
  assert.equal(report.fixtures.length, 6);
  assert.match(report.ngspice, /ngspice-47/);
  for (const row of report.fixtures) {
    const bytes = readFileSync(`${root}/${row.id}.cir`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
    assert.ok(['matched', 'mismatch', 'unsupported', 'failed', 'uncompared'].includes(row.outcome), row.outcome);
    assert.ok(row.ngspice.status);
    assert.ok(row.spiceTs.status);
    assert.ok(row.runtime.ngspiceWallMs >= 0 && row.runtime.spiceTsWallMs >= 0);
    if (row.outcome === 'matched') assert.ok(row.comparedSignals > 0 && row.worstNormalizedError <= 0.01);
  }
});
