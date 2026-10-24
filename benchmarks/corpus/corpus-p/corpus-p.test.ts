import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { outcomeDigest } from '../corpus-f/outcomes.js';

const ROOT = 'benchmarks/corpus/corpus-p';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
interface Circuit {
  id: string; source: string; revision: string; localPath: string; sourcePath: string;
  sha256: string; upstreamSha256: string; bytes: number; licence: string;
  adaptation: 'op-wrapper' | 'none';
}
interface Source { key: string; revision: string; license: string; licensePath: string; licenseSha256: string }
const manifest = () => readFile(`${ROOT}/manifest.json`, 'utf8').then(JSON.parse) as Promise<{ sources: Source[]; circuits: Circuit[] }>;

test('corpus-p pins 16 novel MIT decks and retains licences and reconstructible upstream hashes', async () => {
  const m = await manifest();
  assert.equal(m.circuits.length, 16);
  assert.equal(new Set(m.circuits.map(c => c.sha256)).size, 16);
  assert.equal(m.sources.length, 2);
  for (const source of m.sources) {
    assert.match(source.revision, /^[a-f0-9]{40}$/);
    assert.equal(source.license, 'MIT');
    assert.equal(hash(await readFile(source.licensePath)), source.licenseSha256);
  }
  for (const c of m.circuits) {
    const bytes = await readFile(c.localPath);
    const sources = await readFile(`${ROOT}/SOURCES.md`, 'utf8');
    assert.ok(sources.includes(c.sha256));
    assert.ok(sources.includes(c.upstreamSha256));
    assert.equal(hash(bytes), c.sha256);
    assert.equal(bytes.length, c.bytes);
    assert.equal(c.licence, 'MIT');
    assert.equal(c.revision, m.sources.find(s => s.key === c.source)?.revision);
    let original = bytes;
    if (c.adaptation === 'op-wrapper') {
      const prefix = c.source === 'mna-mat' ? Buffer.from(`corpus-p ${c.sourcePath}\n`) : Buffer.alloc(0);
      const suffix = Buffer.from('\n.op\n.end\n');
      assert.ok(bytes.subarray(0, prefix.length).equals(prefix));
      assert.ok(bytes.subarray(-suffix.length).equals(suffix));
      original = bytes.subarray(prefix.length, -suffix.length);
    }
    assert.equal(hash(original), c.upstreamSha256);
  }
});

test('corpus-p receipt covers every fixture with unchanged comparison policy and explicit losses', async () => {
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
});
