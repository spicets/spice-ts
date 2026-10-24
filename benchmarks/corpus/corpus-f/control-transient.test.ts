import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { compareExecutions } from '../../aggregate-report.js';
import type { ClassicCircuit } from '../classic/report.js';
import type { CorpusFCircuit } from './ingest.js';
import { MATCH_THRESHOLD, normalizedSignalErrors, pairedReferenceSeries } from './lib.js';
import { runNgspicePacked, unpackExecution } from './outcomes.js';
import { runCorpusFSpiceTs } from './plot-adapter.js';

const HAS_ENGINES = existsSync('packages/core/dist/index.js')
  && spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).status === 0;

describe('corpus-f control-only transient reference (#1221)', () => {
  it('leaves the ordinary dot-card reference on the existing batch path', { skip: !HAS_ENGINES }, async () => {
    const bytes = Buffer.from('dot-card RC\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 100u uic\n.end\n');
    const circuit = { localPath: 'toy.cir', analyses: ['tran'], unmappedAnalyses: [] } as unknown as CorpusFCircuit;
    const raw = await runNgspicePacked(bytes, circuit);
    assert.equal(raw.status, 'success');
    const reference = unpackExecution(raw.execution);
    assert.equal(reference.analyses.length, 1);
    assert.equal(reference.analyses[0].plotId, undefined, 'dot-card raw output must not be replaced by control exports');
    assert.ok(reference.analyses[0].series.signals['v(out)'].length > 0);
  });

  it('pairs common vectors from an unchanged original control-only RC deck', { skip: !HAS_ENGINES }, async () => {
    const text = 'control-only RC\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.control\ntran 10u 100u uic\nquit\n.endc\n.end\n';
    const bytes = Buffer.from(text);
    const circuit = { id: 'control-rc', localPath: 'toy.cir', analyses: ['tran'], unmappedAnalyses: [] } as unknown as CorpusFCircuit;
    const raw = await runNgspicePacked(bytes, circuit, (_type, signal) => signal === 'v(out)');
    assert.equal(raw.status, 'success');
    const reference = unpackExecution(raw.execution);
    assert.equal(reference.analyses.length, 1, 'control-only transient must export a reference plot');
    assert.equal(reference.analyses[0].plotId, 'tran1');
    assert.deepEqual(Object.keys(reference.analyses[0].series.signals), ['v(out)']);
    const candidate = await runCorpusFSpiceTs(bytes, circuit as unknown as ClassicCircuit);
    assert.equal(candidate.status, 'success');
    const comparison = compareExecutions(candidate, reference);
    const errors = normalizedSignalErrors(comparison, pairedReferenceSeries(candidate, reference));
    const output = errors.errors.find(error => error.signal === 'v(out)');
    assert.ok(output, 'both engines must pair v(out)');
    assert.ok(Number.isFinite(output.normalized));
    assert.ok(output.normalized <= MATCH_THRESHOLD, JSON.stringify(output));
    assert.equal(bytes.toString(), text, 'wrapper must not modify the deck');
  });
});
