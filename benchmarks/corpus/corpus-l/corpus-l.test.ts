import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { outcomeDigest } from '../corpus-f/outcomes.js';
import { staticVerdict, stripTerminalNewline } from '../corpus-h/lib.js';
import { ROOT, REVISION, hash, selectedFamily } from './survey.js';
import { gapBucket, parityGaps, renderMarkdown, report } from './parity.js';

test('20 original standalone decks have pinned licence and byte provenance without duplicate padding', async () => {
  const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`, 'utf8'));
  assert.equal(manifest.circuits.length, 20);
  assert.equal(manifest.mechanicalAdaptation, 'none');
  const existing = new Set<string>();
  for (const corpus of await readdir('benchmarks/corpus')) {
    if (corpus === 'corpus-l') continue;
    let files;
    try { files = await readdir(`benchmarks/corpus/${corpus}/fixtures`, { recursive: true, withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const file of files.filter(f => f.isFile())) {
      const bytes = await readFile(resolve(file.parentPath, file.name));
      existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
    }
  }
  const rootSources = await readFile('benchmarks/SOURCES.md', 'utf8');
  const sources = await readFile(`${ROOT}/SOURCES.md`, 'utf8');
  for (const c of manifest.circuits) {
    const bytes = await readFile(c.localPath);
    assert.equal(hash(bytes), c.sha256); assert.equal(bytes.length, c.bytes);
    assert(!existing.has(hash(bytes)) && !existing.has(hash(stripTerminalNewline(bytes))), c.sourcePath);
    existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
    const verdict = staticVerdict(bytes, c.upstreamPath, new Set<string>());
    assert.equal(verdict.reason, null);
    assert.deepEqual(c.analyses, verdict.analyses);
    assert.deepEqual(c.unmappedAnalyses, verdict.unmappedAnalyses);
    assert(selectedFamily(c.upstreamPath));
    assert.deepEqual(c.includeClosure, []);
    assert.equal(c.licence, 'GPL-3.0-or-later');
    assert.equal(c.revision, REVISION);
    assert.equal(c.sourceUrl, `https://github.com/Xyce/Xyce_Regression/blob/${REVISION}/${c.upstreamPath}`);
    for (const doc of [rootSources, sources]) {
      assert(doc.includes(c.sourceUrl)); assert(doc.includes(c.sha256)); assert(doc.includes(c.licence));
    }
  }
  assert.equal((await readdir(`${ROOT}/fixtures`, { recursive: true, withFileTypes: true })).filter(f => f.isFile()).length, 20);
  for (const s of manifest.sources) {
    assert.equal(hash(await readFile(s.licensePath)), s.licenseSha256);
    assert.equal(hash(await readFile(s.licenseTextPath)), s.licenseTextSha256);
    assert(s.basis.includes('GPL'));
  }
  assert.equal(hash(await readFile(manifest.exclusions.receipt)), manifest.exclusions.receiptSha256);
  const survey = JSON.parse(await readFile(manifest.exclusions.receipt, 'utf8'));
  assert.equal(survey.candidates.length, 20);
  assert(survey.candidates.every((c: { reason: string | null }) => c.reason === null));
  assert.deepEqual(manifest.exclusions.selectedPaths, manifest.circuits.map((c: { upstreamPath: string }) => c.upstreamPath));
});

test('error buckets use classes, not fixture identities', () => {
  const error = "Device 'any-name' has no ngspice temperature model in spice-ts and cannot be simulated at TEMP=100 C";
  assert.equal(gapBucket(error, 'failed'), 'device: non-nominal temperature unsupported');
  assert.equal(gapBucket(error, 'success'), undefined);
});

test('all outcomes and losses are retained, hashed, uniformly compared and rendered', async () => {
  const manifestBytes = await readFile(`${ROOT}/manifest.json`);
  const manifest = JSON.parse(manifestBytes.toString());
  const result = JSON.parse(await readFile(`${ROOT}/outcomes.json`, 'utf8'));
  assert.equal(result.fixtures.length, 20);
  assert.equal(result.manifestSha256, hash(manifestBytes));
  assert.equal(result.outcomeSha256, outcomeDigest(result));
  assert.deepEqual(result.fixtures.map((r: { sha256: string }) => r.sha256), manifest.circuits.map((c: { sha256: string }) => c.sha256));
  assert.deepEqual(result.totals, report.summarize(result.fixtures).totals);
  assert.deepEqual(result.gapBuckets, report.summarize(result.fixtures).gapBuckets);
  assert.deepEqual(result.parityGaps, parityGaps(result.fixtures));
  const gaps = result.fixtures.filter((r: { ngspice: { status: string }; outcome: string }) => r.ngspice.status === 'success' && r.outcome !== 'matched');
  assert.deepEqual(result.parityGaps.flatMap((b: { ids: string[] }) => b.ids).sort(), gaps.map((r: { id: string }) => r.id).sort());
  assert.deepEqual(result.parityGaps.map((b: { count: number }) => b.count), [1, 6]);
  assert.equal(result.tools.ngspice, 'ngspice-47');
  assert.equal(result.policy.fixtureAdaptation, 'none');
  assert.equal(result.policy.perCircuitToleranceTuning, false);
  assert.equal(result.policy.matchThreshold, 0.01);
  const readme = await readFile(`${ROOT}/README.md`, 'utf8');
  assert.equal(readme, renderMarkdown(result));
  for (const row of result.fixtures) {
    assert(readme.includes(row.sourcePath));
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
