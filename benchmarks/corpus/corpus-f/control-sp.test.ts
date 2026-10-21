import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import type { CorpusFManifest } from './ingest.js';
import { declaredAnalyses, MATCH_THRESHOLD, scoredPlotTypes, normalizedSignalErrors, pairedReferenceSeries } from './lib.js';
import { runFixture } from './outcomes.js';
import { runCorpusFSpiceTs } from './plot-adapter.js';
import { runControlReference } from './control-vectors.js';
import { compareExecutions } from '../../aggregate-report.js';
import type { ClassicCircuit } from '../classic/report.js';

const ROOT = 'benchmarks/corpus/corpus-f';
const HAS_ENGINES = existsSync('packages/core/dist/index.js')
  && spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).status === 0;

describe('corpus-f headline control SP (#1627)', () => {
  for (const name of ['cpline_ac', 'cpmline_ac']) {
    it(`scores unchanged ${name} S-parameter vectors`, { skip: !HAS_ENGINES }, async () => {
      const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`, 'utf8')) as CorpusFManifest;
      const circuit = manifest.circuits.find(c => c.sourcePath === `examples/xspice/transmission_lines/${name}.cir`)!;
      const bytes = await readFile(circuit.localPath);
      const detected = declaredAnalyses(bytes.toString('utf8'));
      assert.deepEqual(scoredPlotTypes({ analyses: detected.mapped, unmappedAnalyses: detected.unmapped }), ['sp']);
      // Exercise the default headline runner, not a manually promoted circuit or custom reference.
      const result = await runFixture(circuit);
      assert.equal(result.spiceTs.status, 'success', JSON.stringify(result));
      assert.equal(result.ngspice.status, 'success', JSON.stringify(result));
      assert.deepEqual(result.analyses, ['sp']);
      assert.deepEqual(result.unmappedAnalyses, []);
      assert.equal(result.comparedAnalyses, 1);
      assert.ok(result.comparedSignals >= 16, JSON.stringify(result));
      assert.ok(Number.isFinite(result.worstNormalizedError), JSON.stringify(result));
      assert.equal(result.outcome, result.worstNormalizedError! <= MATCH_THRESHOLD ? 'matched' : 'mismatch');
      const promoted = { ...circuit, analyses: ['sp'], unmappedAnalyses: [] };
      const candidate = await runCorpusFSpiceTs(bytes, promoted as unknown as ClassicCircuit);
      const reference = await runControlReference(bytes, promoted);
      const errors = normalizedSignalErrors(compareExecutions(candidate, reference.execution), pairedReferenceSeries(candidate, reference.execution));
      assert.equal(errors.missing, 0);
      for (const signal of ['s_1_1', 's_2_1', 's_3_1', 's_4_1']) {
        const own = candidate.analyses[0].series.signals[signal];
        const raw = reference.execution.analyses[0].series.signals[signal];
        assert.equal(own.length, 100);
        assert.equal(raw.length, 100);
        assert.ok(own.some(value => value.im !== 0));
        assert.ok(raw.some(value => value.im !== 0));
        assert.ok(errors.errors.some(error => error.signal === signal && Number.isFinite(error.normalized)));
      }
      assert.deepEqual(await readFile(circuit.localPath), bytes);
    });
  }

  it('preserves analysis detection for other control commands and ignores title/comments', () => {
    const text = 'sp lin 100 1 2 in title\n* sp lin 100 1 2\n.op\n.control\nac lin 2 1 2\ntran 1n 2n\ndc v1 0 1 .1\nnoise v(out) v1 lin 2 1 2\nsens v(out)\ntf v(out) v1\n.endc\n.end\n';
    assert.deepEqual(declaredAnalyses(text), {
      mapped: ['op', 'ac', 'tran', 'dc', 'noise', 'sens'], unmapped: ['tf'],
    });
    assert.deepEqual(declaredAnalyses('title\nsp lin 2 1 2\n.control\n* sp lin 2 1 2\n.endc\n'), { mapped: [], unmapped: [] });
  });
});
