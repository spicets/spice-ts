import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

// Smoke test for issue #410: the differential-noise comparison script must run end to end
// against ngspice and emit its JSON receipt instead of crashing silently.
const hasNgspice = (() => {
  try {
    execFileSync('ngspice', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('differential-noise compare.ts smoke', () => {
  it('runs against ngspice and reports every explicitly rejected form', { skip: !hasNgspice && 'ngspice not installed' }, () => {
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('benchmarks/differential-noise/compare.ts')],
      { encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(run.status, 0, `compare.ts exited ${run.status}\n${run.stderr}`);
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    assert.equal(report.identicalNetlistForBothEngines, true);
    assert.ok(report.matchedPointCount > 0);
    for (const key of ['outputDensity', 'inputDensity', 'integratedOutput', 'integratedInput']) {
      assert.ok(Number.isFinite(report.errors[key].maximumRelativeError), key);
    }
    assert.ok(report.unsupported.length > 0);
    for (const entry of report.unsupported) assert.equal(entry.status, 'explicitly rejected');
    assert.ok(!report.unsupported.some((entry: { form: string }) => entry.form === 'differential diode noise'));
    for (const form of ['BJT', 'MOS1', 'JFET', 'BSIM3']) {
      assert.ok(report.unsupported.some((entry: { form: string }) => entry.form === `differential ${form} noise`));
    }
    assert.equal(report.diode.identicalNetlistForBothEngines, true);
    assert.equal(report.diode.sha256, 'af7403a45b6e408d0af26123931e28e5d6fc78bec5848656d796ca47c11faa0d');
    assert.ok(report.diode.matchedPointCount > 0);
    for (const key of ['outputDensity', 'inputDensity', 'integratedOutput', 'integratedInput']) {
      assert.ok(report.diode.errors[key].normalizedMaximumError < 0.01, key);
    }
  });
});
