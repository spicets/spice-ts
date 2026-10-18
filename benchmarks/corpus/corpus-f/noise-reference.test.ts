import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import type { CorpusFCircuit } from './ingest.js';
import { runNgspicePacked, unpackExecution } from './outcomes.js';
import { runCorpusFSpiceTs } from './plot-adapter.js';
import { compareExecutions } from '../../aggregate-report.js';
import type { ClassicCircuit } from '../classic/report.js';
import { normalizedSignalErrors, pairedReferenceSeries } from './lib.js';

const HAS_NGSPICE = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).status === 0;

describe('control-only noise reference export (#1317)', () => {
  it('recovers noise when .save leaves an AC plot unwritable (#1356)', { skip: !HAS_NGSPICE }, async () => {
    const input = Buffer.from('empty AC export\nV1 in 0 dc 1 ac 1\nR1 in out 1k\nR2 out 0 1k\n.save @r1[i] v(out) inoise_spectrum\n.control\nop\nac dec 2 1 10\nnoise v(out) V1 dec 2 1 10\n.endc\n.end\n');
    const before = Buffer.from(input);
    const reference = await runNgspicePacked(input, { localPath: 'noise.cir', analyses: ['op', 'ac', 'noise'] } as CorpusFCircuit);
    assert.equal(reference.status, 'success');
    assert.ok(reference.execution.analyses.some(a => a.plotId === 'noise1'));
    assert.match(reference.note ?? '', /ac1.*unavailable or zero-length vector/);
    assert.deepEqual(input, before);
  });
  for (const stop of ['', 'quit\n']) {
    it(`compares spectra and integrated totals after wrdata${stop ? ' and quit' : ''}`, { skip: !HAS_NGSPICE }, async () => {
      const input = Buffer.from(`control noise\nV1 in 0 AC 1\nR1 in out 1k\nR2 out 0 1k\n.control\nnoise v(out) V1 dec 2 1 100\nsetplot noise1\nwrdata noise.txt sqrt(inoise_spectrum) sqrt(onoise_spectrum)\n${stop}.endc\n.end\n`);
      const before = Buffer.from(input);
      const circuit = { localPath: 'noise.cir', analyses: ['noise'], unmappedAnalyses: [] } as unknown as CorpusFCircuit;
      const reference = await runNgspicePacked(input, circuit);
      assert.equal(reference.status, 'success');
      assert.deepEqual(reference.execution.analyses.map(a => a.plotName), ['Noise Spectral Density Curves', 'Integrated Noise']);
      const candidate = await runCorpusFSpiceTs(input, circuit as unknown as ClassicCircuit);
      assert.equal(candidate.status, 'success');
      const referenceView = unpackExecution(reference.execution);
      const comparisons = compareExecutions(candidate, referenceView);
      assert.equal(comparisons.length, 2);
      const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(candidate, referenceView));
      assert.equal(missing, 0);
      assert.equal(errors.length, 4);
      for (const error of errors) assert.ok(error.normalized < 0.01, JSON.stringify(error));
      assert.deepEqual(input, before);
      const selected = await runNgspicePacked(input, circuit, (_type, signal) => signal === 'onoise_spectrum');
      assert.deepEqual(Object.keys(selected.execution.analyses[0].signals), ['onoise_spectrum']);
    });
  }
});
