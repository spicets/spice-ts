import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { outcomeDigest } from '../corpus-f/outcomes.js';
import { staticVerdict, stripTerminalNewline } from '../corpus-h/lib.js';
import { gapBucket, parityGaps } from '../corpus-l/parity.js';
import { ROOT, REVISION, hash, selectedFamily } from './survey.js';
import { XYCE_REVISION, selectedXyceFamily } from './survey-xyce.js';
import { renderMarkdown, report } from './parity.js';
import { renderIntegration } from './integration.js';

test('24 original standalone BSD/GPL decks have pinned provenance without duplicate padding', async () => {
  const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`, 'utf8'));
  assert.equal(manifest.circuits.length, 24);
  assert.equal(manifest.mechanicalAdaptation, 'none');
  const existing = new Set<string>();
  for (const corpus of await readdir('benchmarks/corpus')) {
    if (corpus === 'corpus-n') continue;
    let files;
    try { files = await readdir(`benchmarks/corpus/${corpus}`, { recursive: true, withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') continue; throw error; }
    for (const file of files.filter(f => f.isFile() && !f.parentPath.includes('/.upstream'))) {
      const bytes = await readFile(resolve(file.parentPath, file.name));
      existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
    }
  }
  const sources = await readFile(`${ROOT}/SOURCES.md`, 'utf8');
  const globalSources = await readFile('benchmarks/SOURCES.md', 'utf8');
  for (const receipt of manifest.exclusions) {
    const probeBytes = await readFile(receipt.probe);
    const surveyBytes = await readFile(receipt.receipt);
    const probe = JSON.parse(probeBytes.toString());
    const survey = JSON.parse(surveyBytes.toString());
    assert.equal(hash(probeBytes), receipt.probeSha256);
    assert.equal(hash(surveyBytes), receipt.receiptSha256);
    const selectedPaths = survey.candidates.filter((c: { path: string; reason: string | null; sha256: string }) => c.reason === null && probe.probes.some((p: { sourcePath: string; status: string; sha256: string }) => p.sourcePath === c.path && p.status === 'success' && p.sha256 === c.sha256)).map((c: { path: string }) => c.path);
    assert.deepEqual(receipt.selectedPaths, selectedPaths);
    assert.deepEqual(manifest.circuits.filter((c: { source: string }) => c.source === receipt.source).map((c: { upstreamPath: string }) => c.upstreamPath), selectedPaths);
    if (receipt.source === 'ngspice') {
      assert.equal(probe.probes.length, 100);
      assert.equal(probe.probes.filter((p: { status: string }) => p.status === 'success').length, 13);
      assert.equal(probe.probes.filter((p: { status: string }) => p.status === 'failed').length, 85);
      assert.equal(probe.probes.filter((p: { status: string }) => p.status === 'unsupported').length, 2);
      assert.deepEqual(probe.probes.map((p: { sourcePath: string }) => p.sourcePath), survey.candidates.filter((c: { reason: string | null }) => c.reason === null).map((c: { path: string }) => c.path));
    } else {
      assert.equal(selectedPaths.length, 11);
      const eligible = survey.candidates.filter((c: { reason: string | null }) => c.reason === null);
      assert.deepEqual(probe.probes.map((p: { sourcePath: string }) => p.sourcePath), eligible.slice(0, probe.probes.length).map((c: { path: string }) => c.path));
      assert.equal(probe.probes.at(-1).status, 'success');
    }
  }
  for (const c of manifest.circuits) {
    const bytes = await readFile(c.localPath);
    assert.equal(hash(bytes), c.sha256); assert.equal(bytes.length, c.bytes);
    assert(!existing.has(hash(bytes)) && !existing.has(hash(stripTerminalNewline(bytes))), c.sourcePath);
    existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
    const verdict = staticVerdict(bytes, c.upstreamPath, new Set<string>());
    assert.equal(verdict.reason, null);
    if (verdict.reason !== null) throw new Error('static rejection');
    assert.deepEqual(c.analyses, verdict.analyses);
    assert.deepEqual(c.unmappedAnalyses, verdict.unmappedAnalyses);
    assert.deepEqual(c.includeClosure, []);
    const isNg = c.source === 'ngspice';
    assert(isNg ? selectedFamily(c.upstreamPath) : selectedXyceFamily(c.upstreamPath));
    assert.equal(c.licence, isNg ? 'BSD-3-Clause' : 'GPL-3.0-or-later');
    assert.equal(c.revision, isNg ? REVISION : XYCE_REVISION);
    assert.equal(c.sourceUrl, `https://github.com/${isNg ? 'imr/ngspice' : 'Xyce/Xyce_Regression'}/blob/${c.revision}/${c.upstreamPath}`);
    assert(sources.includes(c.sourceUrl) && sources.includes(c.sha256) && sources.includes(c.licence));
    assert(globalSources.includes(c.sourceUrl) && globalSources.includes(c.sha256));
  }
  assert.equal((await readdir(`${ROOT}/fixtures`, { recursive: true, withFileTypes: true })).filter(f => f.isFile()).length, 24);
  for (const s of manifest.sources) {
    assert.equal(hash(await readFile(s.licensePath)), s.licenseSha256);
    assert.equal(hash(await readFile(s.licenseTextPath)), s.licenseTextSha256);
    assert(s.basis.includes(s.key === 'ngspice' ? 'Modified BSD' : 'GPL'));
  }
});

test('all outcomes and losses retained, hashed, uniformly compared and rendered', async () => {
  const bytes = await readFile(`${ROOT}/manifest.json`);
  const manifest = JSON.parse(bytes.toString());
  const result = JSON.parse(await readFile(`${ROOT}/outcomes.json`, 'utf8'));
  assert.equal(result.fixtures.length, 24);
  assert.equal(result.manifestSha256, hash(bytes));
  assert.equal(result.outcomeSha256, outcomeDigest(result));
  assert.deepEqual(result.fixtures.map((r: { sha256: string }) => r.sha256), manifest.circuits.map((c: { sha256: string }) => c.sha256));
  assert.deepEqual(result.totals, report.summarize(result.fixtures).totals);
  assert.deepEqual(result.gapBuckets, report.summarize(result.fixtures).gapBuckets);
  assert.deepEqual(result.parityGaps, parityGaps(result.fixtures));
  const gaps = result.fixtures.filter((r: { ngspice: { status: string }; outcome: string }) => r.ngspice.status === 'success' && r.outcome !== 'matched');
  assert.deepEqual(result.parityGaps.flatMap((b: { ids: string[] }) => b.ids).sort(), gaps.map((r: { id: string }) => r.id).sort());
  assert.equal(result.tools.ngspice, 'ngspice-47');
  assert.equal(result.policy.fixtureAdaptation, 'none');
  assert.equal(result.policy.perCircuitToleranceTuning, false);
  assert.equal(result.policy.matchThreshold, 0.01);
  assert.equal(await readFile(`${ROOT}/README.md`, 'utf8'), renderMarkdown(result));
  for (const row of result.fixtures) {
    assert.equal(row.gapBucket, gapBucket(row.spiceTs.firstErrorLine, row.spiceTs.status) ?? null);
    assert(row.runtime.ngspiceChildWallMs >= 0 && row.runtime.spiceTsChildWallMs >= 0);
    if (row.comparedSignals === 0) { assert.equal(row.worstNormalizedError, null); assert.notEqual(row.outcome, 'matched'); }
    for (const comparison of row.comparisons) {
      for (const metric of Object.values(comparison.metrics.signals) as Array<{ status: string; absoluteError: { max: number; rms: number }; relativeError: object }>) {
        if (metric.status !== 'compared') continue;
        assert(Number.isFinite(metric.absoluteError.max)); assert(Number.isFinite(metric.absoluteError.rms));
        assert(Object.hasOwn(metric.relativeError, 'max')); assert(Object.hasOwn(metric.relativeError, 'rms'));
      }
    }
  }
});

test('pre-rebase evidence remains intact and integrated results use the identical fixtures and policy', async () => {
  const before = JSON.parse(await readFile(`${ROOT}/outcomes-before-rebase.json`, 'utf8'));
  const after = JSON.parse(gunzipSync(await readFile(`${ROOT}/outcomes-after-rebase.json.gz`)).toString());
  assert.equal(before.coreTree, '926efe53f0ee2f2813987a1a66d9fc19bf4a20df');
  assert.equal(after.coreTree, '29064e078f962f00f680e3626b82f9b59a665df9');
  assert.equal(after.outcomeSha256, outcomeDigest(after));
  assert.equal(before.outcomeSha256, '48c1f28e40bcc5638cda4aaff942ffb7f800b85e68a5df65c4effbc550d1332a');
  assert.equal(before.outcomeSha256, outcomeDigest(before));
  assert.equal(before.manifestSha256, after.manifestSha256);
  assert.deepEqual(before.policy, after.policy);
  assert.deepEqual(before.fixtures.map((r: { sha256: string }) => r.sha256), after.fixtures.map((r: { sha256: string }) => r.sha256));
  assert.equal(await readFile(`${ROOT}/README-before-rebase.md`, 'utf8'), renderMarkdown(before));
  assert.equal(await readFile(`${ROOT}/INTEGRATION.md`, 'utf8'), renderIntegration(before, after));
});

test('n-5 now pairs on main with #1115 and #1118 without changing fixtures or tolerances', async () => {
  const before = JSON.parse(gunzipSync(await readFile('benchmarks/control-pre-set-1097/corpus-n-outcomes.json.gz')).toString());
  const after = JSON.parse(await readFile(`${ROOT}/outcomes.json`, 'utf8'));
  assert.equal(before.outcomeSha256, outcomeDigest(before));
  assert.equal(before.manifestSha256, after.manifestSha256);
  assert.deepEqual(before.policy, after.policy);
  assert.deepEqual(before.fixtures.map((r: { sha256: string }) => r.sha256), after.fixtures.map((r: { sha256: string }) => r.sha256));
  const old = before.fixtures.find((r: { id: string }) => r.id === 'n-5');
  const row = after.fixtures.find((r: { id: string }) => r.id === 'n-5');
  assert.equal(old.outcome, 'not-compared');
  assert.equal(old.comparedSignals, 0);
  assert.equal(row.sha256, '837642247b44a0c70ac952e4d24a6fa52a4132ed50c1f5c6a4cbd35bd1747f7e');
  assert.equal(row.ngspice.status, 'success');
  assert.equal(row.spiceTs.status, 'success');
  assert.equal(row.outcome, 'matched');
  assert.equal(row.comparedAnalyses, 1);
  assert.equal(row.comparedSignals, 14);
  assert(row.worstNormalizedError <= after.policy.matchThreshold);
  const comparison = row.comparisons[0];
  assert.deepEqual(comparison.plot, { spiceTs: 'tran1', ngspice: 'Transient Analysis', ngspiceIndex: 0 });
  assert.equal(comparison.metrics.grid.alignedPoints, 1826);
  assert.equal(comparison.metrics.grid.excludedOutOfRange, 1);
  assert.equal(Object.keys(comparison.metrics.signals).length, 14);
  for (const metric of Object.values(comparison.metrics.signals) as Array<{ status: string; sampleCount: number }>) {
    assert.equal(metric.status, 'compared');
    assert.equal(metric.sampleCount, 1826);
  }
});
