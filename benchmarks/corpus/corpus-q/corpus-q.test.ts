import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { renderMarkdown } from './parity.js';
import { PATHS } from './ingest.js';
import { outcomeDigest } from '../corpus-f/outcomes.js';

const ROOT = 'benchmarks/corpus/corpus-q';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
interface Circuit {
  id: string; source: string; revision: string; localPath: string; sourcePath: string;
  sha256: string; upstreamSha256: string; bytes: number; licence: string;
  adaptation: 'none'; upstreamPath: string; analyses: string[];
}
interface Source { key: string; revision: string; license: string; licensePath: string; licenseSha256: string; licenseTextPath: string; licenseTextSha256: string }
const manifest = () => readFile(`${ROOT}/manifest.json`, 'utf8').then(JSON.parse) as Promise<{ sources: Source[]; circuits: Circuit[] }>;

test('corpus-q pins 15 novel GPL decks and retains licences and reconstructible upstream hashes', async () => {
  const m = await manifest();
  assert.equal(m.circuits.length, 15);
  assert.equal(new Set(m.circuits.map(c => c.sha256)).size, 15);
  assert.equal(m.sources.length, 1);
  assert.deepEqual(m.circuits.map(c => c.upstreamPath), [...PATHS]);
  assert.deepEqual(['ac', 'dc', 'tran'].map(a => m.circuits.filter(c => c.analyses.includes(a)).length), [6, 6, 3]);
  for (const source of m.sources) {
    assert.match(source.revision, /^[a-f0-9]{40}$/);
    assert.equal(source.license, 'GPL-3.0-or-later');
    assert.equal(hash(await readFile(source.licensePath)), source.licenseSha256);
    assert.equal(hash(await readFile(source.licenseTextPath)), source.licenseTextSha256);
    assert.match(await readFile(source.licensePath, 'utf8'), /either version 3 of the License/);
  }
  for (const c of m.circuits) {
    const bytes = await readFile(c.localPath);
    const sources = await readFile(`${ROOT}/SOURCES.md`, 'utf8');
    assert.ok(sources.includes(c.sha256));
    assert.ok(sources.includes(c.upstreamSha256));
    assert.equal(hash(bytes), c.sha256);
    assert.equal(bytes.length, c.bytes);
    assert.equal(c.licence, 'GPL-3.0-or-later');
    assert.equal(c.revision, m.sources.find(s => s.key === c.source)?.revision);
    assert.equal(c.adaptation, 'none');
    assert.equal(hash(bytes), c.upstreamSha256);
  }
});

test('corpus-q receipt covers every fixture with unchanged comparison policy and explicit losses', async () => {
  const m = await manifest();
  const bytes = await readFile(`${ROOT}/manifest.json`);
  const r = JSON.parse(await readFile(`${ROOT}/outcomes.json`, 'utf8'));
  assert.equal(r.manifestSha256, hash(bytes));
  assert.equal(r.tools.ngspice, 'ngspice-47');
  assert.equal(r.policy.perCircuitToleranceTuning, false);
  assert.equal(r.policy.matchThreshold, 0.01);
  assert.equal(r.outcomeSha256, outcomeDigest(r));
  assert.deepEqual(r.fixtures.map((f: { id: string }) => f.id), m.circuits.map(c => c.id));
  const counts: Record<string, number> = {};
  for (const [i, f] of r.fixtures.entries()) {
    assert.equal(f.sha256, m.circuits[i].sha256);
    assert.ok(r.environment.perFixtureRuntimeMs[f.id].ngspice >= 0);
    assert.ok(r.environment.perFixtureRuntimeMs[f.id].spiceTs >= 0);
    if (f.outcome === 'matched') assert.ok(f.comparisons.length > 0);
    counts[f.outcome] = (counts[f.outcome] ?? 0) + 1;
    if (f.ngspice.status === 'success' && f.outcome !== 'matched') {
      assert.match(r.gapLinks[f.id] ?? '', /^https:\/\/github.com\/spicets\/spice-ts\/issues\/\d+$/);
    }
  }
  for (const [key, count] of Object.entries(r.totals.outcomes)) assert.equal(count, counts[key] ?? 0);
  const classified: Record<string, number> = {};
  for (const f of r.fixtures) {
    const key = f.spiceTs.status === 'unsupported' ? 'unsupported' : f.spiceTs.status === 'failed' ? 'failed' : f.outcome;
    classified[key] = (classified[key] ?? 0) + 1;
  }
  assert.deepEqual(r.classCounts, classified);
  for (const f of r.fixtures) {
    if (f.comparisons.some((c: { analysis: string }) => c.analysis === 'tran')) {
      assert.ok(f.fineReference);
      assert.ok(['compared', 'unavailable'].includes(f.fineReference.status));
      if (f.fineReference.status === 'unavailable') assert.ok(f.fineReference.reason);
    }
  }
});

test('corpus-q has no URL or content duplicates in earlier manifests', async () => {
  const m = await manifest();
  const urls = new Set<string>();
  const hashes = new Set<string>();
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory() && path !== ROOT) await visit(path);
      else if (entry.name === 'manifest.json') {
        const old = JSON.parse(await readFile(path, 'utf8'));
        for (const c of old.circuits ?? []) {
          if (c.sourceUrl) urls.add(c.sourceUrl.replace(/\/blob\/[a-f0-9]{40}\//, '/blob/REV/'));
          for (const key of ['sha256', 'upstreamSha256']) if (c[key]) hashes.add(c[key]);
          if (c.localPath) {
            const bytes = await readFile(c.localPath);
            hashes.add(hash(bytes));
            hashes.add(hash(bytes.toString().replace(/\r?\n$/, '')));
          }
        }
      }
    }
  }
  await visit('benchmarks/corpus');
  for (const c of m.circuits) {
    const full = c as Circuit & { sourceUrl: string };
    assert.ok(!urls.has(full.sourceUrl.replace(/\/blob\/[a-f0-9]{40}\//, '/blob/REV/')), c.id);
    assert.ok(!hashes.has(c.sha256), c.id);
    assert.ok(!hashes.has(hash((await readFile(c.localPath, 'utf8')).replace(/\r?\n$/, ''))), c.id);
  }
});

test('corpus-q renders reproducible fine-reference rows with fixture labels', async () => {
  const receipt = JSON.parse(await readFile(`${ROOT}/outcomes.json`, 'utf8'));
  const markdown = renderMarkdown(receipt);
  assert.equal(markdown, await readFile(`${ROOT}/README.md`, 'utf8'));
  const fine = markdown.slice(markdown.indexOf('## Transient fine-step reference'));
  assert.ok(fine.includes('\n| q-14 |'), 'fine-reference rows have fixture labels and real newlines');
  assert.ok(!fine.includes('undefined'));
});

test('corpus-q gap summary reflects a changed receipt instead of fixed claims', async () => {
  const receipt = JSON.parse(await readFile(`${ROOT}/outcomes.json`, 'utf8'));
  receipt.fixtures.find((f: { id: string }) => f.id === 'q-10').outcome = 'mismatch';
  const markdown = renderMarkdown(receipt);
  assert.ok(markdown.includes('ngspice-success rows: 3; matched: 2; gaps requiring issues: 1.'));
  assert.ok(!markdown.includes('no ngspice-success gaps'));
});
