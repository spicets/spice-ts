import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = 'benchmarks/embedded-gpio-1889';
function validateReport(report) {
  assert.equal(report.fixtures.length, 6);
  assert.match(report.ngspice, /ngspice-47/);
  assert.match(report.coreTree, /^[0-9a-f]{40}$/);
  assert.match(report.coreBundleSha256, /^[0-9a-f]{64}$/);
  assert.match(report.coreBuildCommand, /packages\/core build/);
  for (const row of report.fixtures) {
    const bytes = readFileSync(`${root}/${row.id}.cir`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
    assert.ok(['matched', 'mismatch', 'spice-ts-loss', 'ngspice-failed', 'both-failed', 'not-compared'].includes(row.outcome), row.outcome);
    assert.ok(row.ngspice.status);
    assert.ok(row.spiceTs.status);
    assert.ok(row.runtime.ngspiceWallMs >= 0 && row.runtime.spiceTsWallMs >= 0);
    if (row.outcome === 'matched') assert.ok(row.comparedSignals > 0 && row.worstNormalizedError <= 0.01);
  }
}

test('every selected original GPIO deck has an honest, reproducible outcome', () => {
  validateReport(JSON.parse(readFileSync(`${root}/report.json`, 'utf8')));
});

test('honestly reported engine failures and uncomparable results pass the gate', () => {
  const report = JSON.parse(readFileSync(`${root}/report.json`, 'utf8'));
  for (const outcome of ['spice-ts-loss', 'ngspice-failed', 'both-failed', 'not-compared']) {
    report.fixtures[0].outcome = outcome;
    report.fixtures[0].spiceTs.status = 'failed';
    validateReport(report);
  }
});

test('README directs readers to the live report without a stale static result table', () => {
  const readme = readFileSync(`${root}/README.md`, 'utf8');
  assert.match(readme, /report\.json.*authoritative/i);
  assert.doesNotMatch(readme, /all six completed|\| gpio-led \|/i);
});

test('engine timings are captured before comparison', () => {
  const source = readFileSync(`${root}/run.ts`, 'utf8');
  assert.match(source, /const spiceTsWallMs = performance\.now\(\) - startTs;[\s\S]*?reduceRow\(/);
});

test('runner rejects untracked core inputs before benchmarking', () => {
  const dir = mkdtempSync('packages/core/src/__gpio_provenance_test__');
  try {
    writeFileSync(`${dir}/input.ts`, '// untracked core input\n');
    const result = spawnSync('pnpm', ['exec', 'tsx', `${root}/run.ts`], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dirty.*core/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
