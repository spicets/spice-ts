import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { staticVerdict, stripTerminalNewline } from '../corpus-h/lib.js';
import { outcomeDigest } from '../corpus-f/outcomes.js';
import { ROOT, CHILD_BOUND_MS, WALL_BUDGET_MS, consumedWall, summarize } from './parity.js';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test('part2 no longer publishes resolved TEMP and title failures', async () => {
  const report = JSON.parse(await readFile(`${ROOT}/part2-outcomes.json`, 'utf8'));
  for (const id of ['j-14', 'j-16']) {
    const row = report.fixtures.find((row: any) => row.id === id);
    assert(row, `missing ${id}`);
    assert.doesNotMatch(row.spiceTs.firstErrorLine ?? '', /DC sweep source 'temp' not found|Unsupported dot command: '\.title'/);
    assert.equal(row.outcome, 'matched');
    assert(row.comparedSignals > 0);
    assert(Number.isFinite(row.worstNormalizedError));
  }
});

test('append delivers exactly nine novel original hashes and preserves historical manifest', async () => {
  const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`, 'utf8'));
  assert.equal(manifest.deliveredFixtures, 20);
  assert.equal(manifest.partial, false);
  assert.equal(manifest.circuits.length, 20);
  const { historicalManifestSha256, part2Selection, ...historical } = manifest;
  assert(part2Selection.includes('No spice-ts-success filter'));
  historical.deliveredFixtures = 11; historical.partial = true;
  historical.sources = historical.sources.slice(0, 2); historical.circuits = historical.circuits.slice(0, 11);
  assert.equal(hash(JSON.stringify(historical, null, 2) + '\n'), historicalManifestSha256);
  const existing = new Set<string>();
  const existingPaths: string[] = [];
  for (const directory of await readdir('benchmarks/corpus')) {
    if (directory === 'corpus-j') continue;
    let files;
    try { files = await readdir(resolve('benchmarks/corpus', directory, 'fixtures'), { recursive: true, withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const file of files) {
      if (!file.isFile()) continue;
      existingPaths.push(resolve(file.parentPath, file.name));
      const bytes = await readFile(resolve(file.parentPath, file.name));
      existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
    }
  }
  const seen = new Set<string>();
  for (const circuit of manifest.circuits) {
    const bytes = await readFile(circuit.localPath);
    assert.equal(hash(bytes), circuit.sha256);
    assert.equal(bytes.length, circuit.bytes);
    const identity = hash(stripTerminalNewline(bytes));
    assert(!existing.has(hash(bytes)) && !existing.has(identity), circuit.sourcePath);
    assert(!seen.has(identity), circuit.sourcePath); seen.add(identity);
    if (Number(circuit.id.slice(2)) >= 12) assert(!existingPaths.some(path => path.endsWith(`/${circuit.upstreamPath}`)), `source-path duplicate: ${circuit.sourcePath}`);
    assert.equal(staticVerdict(bytes, circuit.upstreamPath, new Set<string>()).reason, null);
    assert.deepEqual(circuit.includeClosure, []);
    assert.match(circuit.revision, /^[a-f0-9]{40}$/);
    assert(circuit.sourceUrl.includes(circuit.revision)); assert(circuit.sourceUrl.includes(circuit.upstreamPath));
    assert.equal(circuit.licence, manifest.sources.find((s: any) => s.key === circuit.source).license);
  }
  for (const source of manifest.sources) assert.equal(hash(await readFile(source.licensePath)), source.licenseSha256);
  assert.equal(hash(await readFile(`${ROOT}/outcomes.json`)), '24685f5f773ac553e80ea4a94180517fa0bf52bf5067de50c23106bb45915027');
  assert.equal(hash(await readFile(`${ROOT}/wall.jsonl`)), '5b4e048bfa773520c60f0ee700a944f898b0ae59bb5dd50ea3b391ff4ab61165');
});

test('part2 receipt includes every outcome, real reference vectors, fixed metrics and combined wall budget', async () => {
  const bytes = await readFile(`${ROOT}/manifest.json`);
  const manifest = JSON.parse(bytes.toString());
  const report = JSON.parse(await readFile(`${ROOT}/part2-outcomes.json`, 'utf8'));
  assert.equal(report.manifestSha256, hash(bytes));
  assert.equal(report.outcomeSha256, outcomeDigest(report));
  assert.deepEqual(report.fixtures.map((r: any) => r.sha256), manifest.circuits.slice(11).map((c: any) => c.sha256));
  assert.deepEqual(report.totals, summarize(report.fixtures).totals);
  assert.equal(report.totals.ngspice.success, 6);
  assert.equal(report.totals.outcomes.matched, 6);
  assert.equal(report.totals.outcomes['spice-ts-loss'], 0);
  assert.equal(report.totals.outcomes['both-failed'], 3);
  assert.equal(report.policy.fixtureAdaptation, 'none'); assert.equal(report.policy.perCircuitToleranceTuning, false);
  assert.equal(report.policy.matchThreshold, 0.01); assert.equal(report.tools.ngspice, 'ngspice-47');
  const docs = await readFile(`${ROOT}/PART2.md`, 'utf8');
  assert(docs.includes('https://github.com/spicets/spice-ts/issues/956'));
  assert(docs.includes('https://github.com/spicets/spice-ts/issues/957'));
  assert(docs.includes('https://github.com/spicets/spice-ts/issues/1633'));
  assert(docs.includes('6 matched, 0 spice-ts-only losses and 14 both-failed'));
  assert(!docs.includes('j-14 fails spice-ts'));
  const tempSweep = report.fixtures.find((row: any) => row.id === 'j-14');
  assert.equal(tempSweep.comparisons.length, 6, 'retain all six control DC plots');
  const sensitivity = report.fixtures.find((row: any) => row.id === 'j-19');
  assert.equal(sensitivity.outcome, 'matched');
  assert.equal(sensitivity.comparedSignals, 7);
  assert.equal(sensitivity.comparisons[0].metrics.grid.alignedPoints, 31);
  assert(sensitivity.worstNormalizedError < report.policy.matchThreshold);
  for (const row of report.fixtures) assert(docs.includes(row.sourcePath));
  const entries = (await Promise.all(['wall.jsonl', 'part2-wall.jsonl'].map(async file => (await readFile(`${ROOT}/${file}`, 'utf8')).trim().split('\n').map(line => JSON.parse(line))))).flat();
  assert.equal(entries.filter(e => e.event === 'start').length, entries.filter(e => e.event === 'end').length);
  assert.equal(report.actualCumulativeChildWallMs, consumedWall(entries));
  assert(consumedWall(entries) <= WALL_BUDGET_MS);
  for (const entry of entries.filter(e => e.event === 'end')) assert(entry.wallMs <= CHILD_BOUND_MS);
  for (const row of report.fixtures) {
    if (row.ngspice.status === 'success') assert(row.ngspice.analyses.length > 0, 'no success without raw data');
    if (row.comparedSignals === 0) { assert.equal(row.worstNormalizedError, null); assert.notEqual(row.outcome, 'matched'); }
    for (const comparison of row.comparisons) for (const metric of Object.values(comparison.metrics.signals) as any[]) {
      if (metric.status !== 'compared') continue;
      assert(Number.isFinite(metric.absoluteError.max)); assert(Number.isFinite(metric.absoluteError.rms));
      assert(Object.hasOwn(metric.relativeError, 'max')); assert(Object.hasOwn(metric.relativeError, 'rms'));
    }
  }
});
