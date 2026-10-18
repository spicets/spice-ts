import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { outcomeDigest } from '../corpus-f/outcomes.js';
import { staticVerdict, stripTerminalNewline } from '../corpus-h/lib.js';
import { parityGaps } from '../corpus-l/parity.js';
import { ROOT, REVISION, hash, selectedFamily } from './ingest.js';
import { classification, renderMarkdown, report } from './parity.js';

test('23 pinned GPL decks have byte/hash provenance, no dependencies or duplicate padding', async () => {
  const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`, 'utf8'));
  assert.equal(manifest.circuits.length, 23);
  assert.equal(manifest.mechanicalAdaptation, 'none');
  const existing = new Set<string>();
  for (const corpus of await readdir('benchmarks/corpus')) {
    if (corpus === 'corpus-o') continue;
    let files;
    try { files = await readdir(`benchmarks/corpus/${corpus}`, { recursive: true, withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') continue; throw error; }
    for (const file of files.filter(f => f.isFile() && !f.parentPath.includes('/.upstream'))) {
      const bytes = await readFile(resolve(file.parentPath, file.name));
      existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
    }
  }
  const sources = await readFile(`${ROOT}/SOURCES.md`, 'utf8');
  const global = await readFile('benchmarks/SOURCES.md', 'utf8');
  const survey = JSON.parse(await readFile(`${ROOT}/survey.json`, 'utf8'));
  const probe = JSON.parse(await readFile(`${ROOT}/probe.json`, 'utf8'));
  assert.deepEqual(probe.probes.map((p: { sourcePath: string }) => p.sourcePath), survey.candidates.filter((c: { reason: string | null }) => c.reason === null).map((c: { path: string }) => c.path));
  assert.deepEqual(manifest.circuits.map((c: { upstreamPath: string }) => c.upstreamPath), probe.probes.filter((p: { status: string }) => p.status === 'success').map((p: { sourcePath: string }) => p.sourcePath));
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
    assert(selectedFamily(c.upstreamPath));
    assert.equal(c.licence, 'GPL-3.0-or-later'); assert.equal(c.revision, REVISION);
    assert.equal(c.sourceUrl, `https://github.com/Xyce/Xyce_Regression/blob/${REVISION}/${c.upstreamPath}`);
    assert(sources.includes(c.sourceUrl) && sources.includes(c.sha256) && global.includes(c.sourceUrl) && global.includes(c.sha256));
    assert(probe.probes.some((p: { status: string; sha256: string }) => p.status === 'success' && p.sha256 === c.sha256));
  }
  assert.equal((await readdir(`${ROOT}/fixtures`, { recursive: true, withFileTypes: true })).filter(f => f.isFile()).length, 23);
  for (const s of manifest.sources) {
    assert.equal(hash(await readFile(s.licensePath)), s.licenseSha256);
    assert.equal(hash(await readFile(s.licenseTextPath)), s.licenseTextSha256);
  }
});

test('outcomes cover every fixture and publish all losses with unchanged corpus-f metrics', async () => {
  const bytes = await readFile(`${ROOT}/manifest.json`);
  const manifest = JSON.parse(bytes.toString());
  const result = JSON.parse(await readFile(`${ROOT}/outcomes.json`, 'utf8'));
  assert.equal(result.fixtures.length, 23);
  assert.equal(result.manifestSha256, hash(bytes));
  assert.equal(result.outcomeSha256, outcomeDigest(result));
  assert.deepEqual(result.fixtures.map((r: { sha256: string }) => r.sha256), manifest.circuits.map((c: { sha256: string }) => c.sha256));
  assert.deepEqual(result.totals, report.summarize(result.fixtures).totals);
  assert.deepEqual(result.parityGaps, parityGaps(result.fixtures));
  assert.equal(result.tools.ngspice, 'ngspice-47');
  assert.equal(result.policy.fixtureAdaptation, 'none'); assert.equal(result.policy.perCircuitToleranceTuning, false);
  assert.equal(result.policy.matchThreshold, 0.01);
  assert.equal(await readFile(`${ROOT}/README.md`, 'utf8'), renderMarkdown(result));
  const counts: Record<string, number> = { matched: 0, mismatch: 0, unsupported: 0, failed: 0, 'not-compared': 0 };
  for (const row of result.fixtures) {
    assert.equal(row.ngspice.status, 'success');
    assert.equal(row.classification, classification(row));
    assert(Object.hasOwn(counts, row.classification)); counts[row.classification]++;
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
  assert.deepEqual(result.classCounts, counts);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 23);
});
