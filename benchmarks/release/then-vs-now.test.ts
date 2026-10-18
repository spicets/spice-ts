import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { median, summarize, renderHeadline, POLICY } from './then-vs-now.js';
import type { EngineExecution } from '../corpus/classic/report.js';

// Use the CLI's read-only planner, not `status`: status also checks changed files
// against the base branch and rejects a valid empty post-release plan.
const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve('@changesets/cli/package.json'));
const getReleasePlan = cliRequire('@changesets/get-release-plan').default;

function assertNoUiMajor(plan: { releases: { name: string; type: string }[] }) {
  const ui = plan.releases.find(entry => entry.name === '@spice-ts/ui');
  if (ui) assert.ok(['none', 'patch', 'minor'].includes(ui.type), JSON.stringify(ui));
}

test('release plan avoids a peer-only UI major without running changeset version', async () => {
  const plan = await getReleasePlan(process.cwd());
  for (const name of ['@spice-ts/core', '@spice-ts/mcp']) {
    const current = JSON.parse(readFileSync(`packages/${name.split('/')[1]}/package.json`, 'utf8'));
    const release = plan.releases.find((entry: { name: string }) => entry.name === name);
    if (current.version === '0.3.0' && release) assert.equal(release.newVersion, '0.4.0');
  }
  assertNoUiMajor(plan);
});

test('release policy handles empty plans and guards a pending in-range peer update', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-plan-'));
  try {
    mkdirSync(join(directory, '.changeset'));
    const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8'));
    config.ignore = [];
    writeFileSync(join(directory, '.changeset/config.json'), JSON.stringify(config));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    for (const name of ['core', 'ui']) {
      mkdirSync(join(directory, 'packages', name), { recursive: true });
      const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8'));
      // Recreate the pre-release peer relationship without changing repository manifests.
      manifest.version = '0.3.0';
      writeFileSync(join(directory, 'packages', name, 'package.json'), JSON.stringify(manifest));
    }
    const empty = await getReleasePlan(directory);
    assert.deepEqual(empty.changesets, []);
    assert.deepEqual(empty.releases, []);
    assertNoUiMajor(empty);

    writeFileSync(join(directory, '.changeset/core-minor.md'), '---\n"@spice-ts/core": minor\n---\nTest peer-only release policy.\n');
    const pending = await getReleasePlan(directory);
    assert.equal(pending.changesets.length, 1);
    assert.equal(pending.releases.find((entry: { name: string }) => entry.name === '@spice-ts/core').newVersion, '0.4.0');
    assertNoUiMajor(pending);

    // Prove the guard rejects the peer-only major produced without this policy.
    config.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange = false;
    writeFileSync(join(directory, '.changeset/config.json'), JSON.stringify(config));
    const unsafe = await getReleasePlan(directory);
    assert.equal(unsafe.releases.find((entry: { name: string }) => entry.name === '@spice-ts/ui').type, 'major');
    assert.throws(() => assertNoUiMajor(unsafe));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function execution(value: number): EngineExecution {
  return { status: 'success', convergence: 'converged', analyses: [{ type: 'op', plotName: 'Operating Point',
    series: { grid: [0], signals: { 'v(out)': [{ re: value, im: 0 }] } } }] };
}

test('medians keep empty samples unavailable', () => {
  assert.equal(median([]), null);
  assert.equal(median([90, 10, 20]), 20);
  assert.equal(median([2, 4]), 3);
});

test('one global matching policy rejects missing plots, failures and large errors', () => {
  assert.equal(summarize(execution(1), execution(1)).matched, true);
  assert.equal(summarize(execution(1 + POLICY.relativeMax / 2), execution(1)).matched, true);
  assert.equal(summarize(execution(1.1), execution(1)).matched, false);
  assert.equal(summarize(execution(0.5e-6), execution(0)).matched, true);
  assert.equal(summarize(execution(2e-6), execution(0)).matched, false);
  const missing: EngineExecution = { status: 'unsupported', convergence: 'not-run', analyses: [] };
  assert.equal(summarize(missing, execution(1)).matched, false);
  assert.equal(summarize(execution(1), missing).matched, false);
  assert.equal(summarize(execution(Number.NaN), execution(1)).matched, false);
});

test('voltage headline does not label pole frequencies or noise densities as volts', () => {
  const summary = summarize(execution(3), execution(1));
  const signals = [...summary.signals, ...summary.signals.map(signal => ({ ...signal, key: 'pz:1:v(zero(1))',
    ...(signal.status === 'compared' ? { absoluteError: { max: 9000, rms: 9000 } } : {}) }))];
  const run = { ...summary, signals, runtimeMs: 1 };
  const text = renderHeadline({ environment: {}, rows: [{ name: 'test', sha256: '', baseline: run, candidate: run,
    ngspice: { status: 'success', runtimeMs: 1 } }], scaling: [] });
  assert.match(text, /absolute max \(V\) \| 2\.000000e\+0/);
});
