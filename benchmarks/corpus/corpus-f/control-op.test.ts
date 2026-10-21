import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { compareExecutions } from '../../aggregate-report.js';
import type { CorpusFCircuit, CorpusFManifest } from './ingest.js';
import { MATCH_THRESHOLD, normalizedSignalErrors, pairedReferenceSeries } from './lib.js';
import { runFixture, runNgspicePacked, unpackExecution } from './outcomes.js';

const HAS_ENGINES = existsSync('packages/core/dist/index.js')
  && spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).status === 0;

describe('corpus-f headline control OP (#1652)', () => {
  it('pairs OP vectors by name, not raw order or scale, using the standard floors', { skip: !HAS_ENGINES }, async () => {
    const bytes = Buffer.from('control OP\nV1 in 0 1\nR1 in out 1k\nR2 out 0 1k\n.control\nop\nquit\n.endc\n.end\n');
    const circuit = { localPath: 'toy.cir', analyses: ['op'], unmappedAnalyses: [] } as unknown as CorpusFCircuit;
    const raw = await runNgspicePacked(bytes, circuit);
    assert.equal(raw.status, 'success');
    const reference = unpackExecution(raw.execution);
    assert.equal(reference.analyses.length, 1);
    assert.equal(reference.analyses[0].plotId, 'op1');
    const candidate = structuredClone(reference);
    const signals = candidate.analyses[0].series.signals;
    assert.equal(signals['v(out)'][0].re, 0.5);
    assert.equal(signals['i(v1)'][0].re, -0.0005);
    candidate.analyses[0].series.signals = Object.fromEntries(Object.entries(signals).reverse());
    const errors = () => normalizedSignalErrors(compareExecutions(candidate, reference), pairedReferenceSeries(candidate, reference));
    assert.equal(errors().missing, 0);
    assert.ok(errors().errors.length >= 3);
    assert.ok(errors().errors.every(error => error.normalized === 0));
    // A real discrepancy remains a mismatch; no OP-specific tolerance is introduced.
    signals['v(out)'][0].re = 0.6;
    assert.ok(errors().errors.some(error => error.signal === 'v(out)' && error.normalized > MATCH_THRESHOLD));
    assert.equal(bytes.toString(), 'control OP\nV1 in 0 1\nR1 in out 1k\nR2 out 0 1k\n.control\nop\nquit\n.endc\n.end\n');
  });

  it('scores an unchanged op-only corpus fixture through the default headline runner', { skip: !HAS_ENGINES }, async () => {
    const manifest = JSON.parse(await readFile('benchmarks/corpus/corpus-f/manifest.json', 'utf8')) as CorpusFManifest;
    const circuit = manifest.circuits.find(c => c.id === 'tests-regression-func-func-1-cir')!;
    const bytes = await readFile(circuit.localPath);
    const result = await runFixture(circuit);
    assert.equal(result.ngspice.status, 'success');
    assert.equal(result.spiceTs.status, 'success');
    assert.ok(result.comparedSignals > 0);
    assert.ok(result.comparedAnalyses > 0);
    assert.equal(result.outcome, result.worstNormalizedError! <= MATCH_THRESHOLD ? 'matched' : 'mismatch');
    assert.deepEqual(await readFile(circuit.localPath), bytes);
  });
});
