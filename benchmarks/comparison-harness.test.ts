import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  INITIAL_STATE_FIXTURES,
  alignAndMeasure,
  compareFixture,
  sharedGridPoints,
  parseNgspiceRaw,
  runNgspice,
  serializeReport,
  type ComparisonFixture,
  type ComparisonMetrics,
  type EngineRun,
} from './comparison-harness.js';
import { compareExecutions } from './aggregate-report.js';
import { runNativeNgspice, runNativeSpiceTs, type ClassicCircuit } from './corpus/classic/report.js';
import './corpus/classic/report.test.js';
import './plot-export.test.js';
import './corpus/corpus-f/raw-interp-1434.test.js';

const real = (values: number[]) => values.map(re => ({ re, im: 0 }));
const hasNgspice = spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).status === 0;

function successfulRun(grid: number[], signals: Record<string, number[]>): EngineRun {
  return {
    status: 'success',
    convergence: 'converged',
    runtimeMs: 1,
    command: ['test-runner'],
    series: {
      grid,
      signals: Object.fromEntries(Object.entries(signals).map(([name, values]) => [name, real(values)])),
    },
  };
}

describe('comparison metrics', () => {
  it('aligns mismatched grids by interpolating the ngspice reference onto spice-ts points', () => {
    const result = alignAndMeasure(
      { grid: [0, 0.5, 1], signals: { 'v(out)': real([0, 1, 2]) } },
      { grid: [0, 1], signals: { 'v(out)': real([0, 2]) } },
      ['v(out)'],
    );

    assert.equal(result.grid.spiceTsPoints, 3);
    assert.equal(result.grid.ngspicePoints, 2);
    assert.equal(result.grid.alignedPoints, 3);
    const signal = result.signals['v(out)'];
    assert.equal(signal?.status, 'compared');
    if (!signal || signal.status !== 'compared') throw new Error('expected compared signal');
    assert.deepEqual(signal.absoluteError, { max: 0, rms: 0 });
  });

  it('measures waveforms with more than 200k points without exceeding the call-stack argument limit (#611)', () => {
    // Math.max(...errors) throws RangeError once the spread is too large for the
    // call stack; the completed adder_bip transient records 106k points.
    const count = 250_001;
    const grid = Array.from({ length: count }, (_, index) => index);
    const reference = Array.from({ length: count }, (_, index) => 1 + (index % 7));
    const actual = reference.map((value, index) => (index === count - 1 ? value + 0.5 : value));
    const result = alignAndMeasure(
      { grid, signals: { 'v(out)': real(actual) } },
      { grid, signals: { 'v(out)': real(reference) } },
      ['v(out)'],
    );

    const signal = result.signals['v(out)'];
    if (!signal || signal.status !== 'compared') throw new Error('expected compared signal');
    assert.equal(signal.sampleCount, count);
    assert.equal(signal.absoluteError.max, 0.5);
    assert.equal(signal.relativeError.max, 0.5 / reference[count - 1]);
  });

  it('aligns a two-source nested DC sweep segment by segment instead of across repeated primary grids', () => {
    // `.dc V1 0 2 1 V2 0 10 10`: the primary grid restarts for every secondary value.
    const result = alignAndMeasure(
      { grid: [0, 1, 2, 0, 1, 2], signals: { 'v(2)': real([0, 0, 0, 10, 10, 10]) } },
      { grid: [0, 1, 2, 0, 1, 2], signals: { 'v(2)': real([0, 0, 0, 10, 10, 10]) } },
      ['v(2)'],
    );

    assert.equal(result.grid.alignedPoints, 6);
    const signal = result.signals['v(2)'];
    if (!signal || signal.status !== 'compared') throw new Error('expected compared signal');
    assert.equal(signal.sampleCount, 6);
    assert.deepEqual(signal.absoluteError, { max: 0, rms: 0 });
  });

  it('interpolates within explicitly identified secondary groups when primary grids differ', () => {
    const result = alignAndMeasure(
      { grid: [0, 0.5, 1, 0, 0.5, 1], secondaryGrid: [0, 0, 0, 10, 10, 10], signals: { 'v(2)': real([0, 0.5, 1, 10, 10.5, 11]) } },
      { grid: [0, 1, 0, 1], secondaryGrid: [0, 0, 10, 10], signals: { 'v(2)': real([0, 1, 10, 11]) } },
      ['v(2)'],
    );

    assert.equal(result.grid.alignedPoints, 6);
    const signal = result.signals['v(2)'];
    if (!signal || signal.status !== 'compared') throw new Error('expected compared signal');
    assert.deepEqual(signal.absoluteError, { max: 0, rms: 0 });
  });

  it('refuses to align nested DC sweeps whose segment counts differ', () => {
    const result = alignAndMeasure(
      { grid: [0, 1, 0, 1, 0, 1], signals: { 'v(2)': real([0, 1, 10, 11, 20, 21]) } },
      { grid: [0, 1, 0, 1], signals: { 'v(2)': real([0, 1, 10, 11]) } },
      ['v(2)'],
    );

    assert.equal(result.grid.alignedPoints, 0);
    assert.equal(result.grid.excludedOutOfRange, 6);
  });

  it('matches the unchanged xyce nmos-level1-dc nested sweep against ngspice (#384)', { skip: !hasNgspice }, async () => {
    const manifest = JSON.parse(readFileSync('benchmarks/corpus/xyce/manifest.json', 'utf8')) as {
      circuits: Array<ClassicCircuit>;
    };
    const circuit = manifest.circuits.find(candidate => candidate.id === 'nmos-level1-dc');
    if (!circuit) throw new Error('missing nmos-level1-dc fixture');
    const input = readFileSync(circuit.localPath);
    assert.equal(createHash('sha256').update(input).digest('hex'), circuit.sha256);

    const [spiceTs, ngspice] = await Promise.all([
      runNativeSpiceTs(input, circuit),
      runNativeNgspice(input, circuit),
    ]);
    const spiceDc = spiceTs.analyses.find(analysis => analysis.type === 'dc');
    const ngspiceDc = ngspice.analyses.find(analysis => analysis.type === 'dc');
    if (!spiceDc || !ngspiceDc) throw new Error('expected DC results from both engines');
    const result = alignAndMeasure(spiceDc.series, ngspiceDc.series, ['v(5)', 'v(2)']);

    assert.equal(result.grid.alignedPoints, 361);
    const supply = result.signals['v(5)'];
    const source = result.signals['v(2)'];
    if (supply?.status !== 'compared' || source?.status !== 'compared') throw new Error('expected compared signals');
    assert.equal(supply.absoluteError.max, 0);
    // ngspice stops Newton at RELTOL=1e-3; spice-ts lands on the analytic square-law root.
    assert.ok(source.absoluteError.max < 1e-3, `v(2) max abs error ${source.absoluteError.max}`);
  });

  // xyce/inductor-transient v(2) = L·di/dt steps from -50 V to 0 V just after the 1 ms
  // breakpoint. ngspice samples 1 ms and then 1.01 ms; spice-ts samples inside that interval.
  const steppedSpiceTs = {
    grid: [0, 1e-3, 1.0036693e-3, 1.5e-3, 2e-3],
    signals: { 'v(2)': real([-50, -50, 0, 0, 0]) },
  };
  const steppedNgspice = {
    grid: [0, 1e-3, 1.01e-3, 2e-3],
    signals: { 'v(2)': real([-50, -50, 0, 0]) },
  };

  it('charges a step inside an unresolved ngspice interval to linear interpolation on the spice-ts grid', () => {
    const signal = alignAndMeasure(steppedSpiceTs, steppedNgspice, ['v(2)']).signals['v(2)'];
    if (signal?.status !== 'compared') throw new Error('expected compared signal');
    // The interpolated reference is (1 - 0.36693) * -50 = -31.65 V although both traces are exact.
    assert.ok(Math.abs(signal.absoluteError.max - 31.6535) < 1e-3, `max ${signal.absoluteError.max}`);
  });

  it('compares one-sided across an ngspice interval that opens at a shared breakpoint (#445)', () => {
    const breakpoints = sharedGridPoints(steppedSpiceTs.grid, steppedNgspice.grid);
    assert.deepEqual([...breakpoints], [0, 1e-3, 2e-3]);
    const result = alignAndMeasure(steppedSpiceTs, steppedNgspice, ['v(2)'], { breakpoints });
    assert.equal(result.grid.alignedPoints, 5);
    const signal = result.signals['v(2)'];
    if (signal?.status !== 'compared') throw new Error('expected compared signal');
    assert.equal(signal.sampleCount, 5);
    assert.deepEqual(signal.absoluteError, { max: 0, rms: 0 });
  });

  it('still charges a post-breakpoint value that matches neither side of the step', () => {
    const wrong = { ...steppedSpiceTs, signals: { 'v(2)': real([-50, -50, 10, 0, 0]) } };
    const breakpoints = sharedGridPoints(wrong.grid, steppedNgspice.grid);
    const signal = alignAndMeasure(wrong, steppedNgspice, ['v(2)'], { breakpoints }).signals['v(2)'];
    if (signal?.status !== 'compared') throw new Error('expected compared signal');
    // Nearer reconstruction is the right-sided 0 V, not the interpolated -31.65 V.
    assert.ok(Math.abs(signal.absoluteError.max - 10) < 1e-9, `max ${signal.absoluteError.max}`);
  });

  it('keeps plain linear interpolation in intervals that do not open at a shared point', () => {
    const spiceTs = { grid: [0.5, 1, 1.5], signals: { 'v(out)': real([0, 1, 0]) } };
    const ngspice = { grid: [0, 1, 2], signals: { 'v(out)': real([0, 1, 0]) } };
    const breakpoints = sharedGridPoints(spiceTs.grid, ngspice.grid);
    assert.deepEqual([...breakpoints], [1]);
    const signal = alignAndMeasure(spiceTs, ngspice, ['v(out)'], { breakpoints }).signals['v(out)'];
    if (signal?.status !== 'compared') throw new Error('expected compared signal');
    // t = 0.5 lies in (0, 1), which opens at no shared point: compared with the linear 0.5.
    // t = 1.5 lies in (1, 2): the right-sided hold of 0 at t = 2 matches spice-ts exactly.
    assert.equal(signal.absoluteError.max, 0.5);
    assert.equal(signal.sampleCount, 3);
  });

  it('publishes xyce/inductor-transient breakpoint-aligned with the linear metric retained (#445)', { skip: !hasNgspice }, async () => {
    const manifest = JSON.parse(readFileSync('benchmarks/corpus/xyce/manifest.json', 'utf8')) as {
      circuits: Array<ClassicCircuit>;
    };
    const circuit = manifest.circuits.find(candidate => candidate.id === 'inductor-transient');
    if (!circuit) throw new Error('missing inductor-transient fixture');
    const input = readFileSync(circuit.localPath);
    assert.equal(createHash('sha256').update(input).digest('hex'), circuit.sha256);

    const spiceTs = await runNativeSpiceTs(input, circuit);
    const ngspice = await runNativeNgspice(input, circuit);
    const [comparison] = compareExecutions(spiceTs, ngspice);
    if (!comparison) throw new Error('expected a transient comparison');
    assert.equal(comparison.analysis, 'tran');
    const metric = (metrics: ComparisonMetrics, name: string) => {
      const signal = metrics.signals[name];
      if (signal?.status !== 'compared') throw new Error(`expected compared ${name}`);
      return signal.absoluteError.max;
    };
    for (const name of ['v(1)', 'v(2)']) {
      assert.ok(metric(comparison.metrics, name) < 1e-6, `${name} max ${metric(comparison.metrics, name)}`);
      // The pre-#445 metric is still published so the change hides nothing.
      // Its interpolation artifact was 31.65 V; with the ngspice first step
      // (#532) the spice-ts grid near t=0 sat closer to ngspice's (14.90 V),
      // and with the ngspice CKTsaveDelta step after the source corner (#608)
      // the grids around it coincide, so the linear metric is exact as well.
      assert.ok(metric(comparison.linearMetrics, name) < 1e-6, `${name} linear max ${metric(comparison.linearMetrics, name)}`);
    }
    assert.ok(metric(comparison.metrics, 'i(l1)') < 1e-9);
    assert.ok(metric(comparison.linearMetrics, 'i(l1)') < 1e-9);
  });

  it('reports zero-reference relative error as unavailable instead of Infinity', () => {
    const result = alignAndMeasure(
      { grid: [0, 1], signals: { 'v(out)': real([1, 2]) } },
      { grid: [0, 1], signals: { 'v(out)': real([0, 0]) } },
      ['v(out)'],
    );

    const signal = result.signals['v(out)'];
    assert.equal(signal?.status, 'compared');
    if (!signal || signal.status !== 'compared') throw new Error('expected compared signal');
    assert.deepEqual(signal.relativeError, {
      max: null,
      rms: null,
      sampleCount: 0,
      excludedZeroReferences: 2,
    });
  });

  it('preserves missing signals in the report', () => {
    const result = alignAndMeasure(
      { grid: [0], signals: {} },
      { grid: [0], signals: { 'v(out)': real([1]) } },
      ['v(out)'],
    );

    assert.deepEqual(result.signals['v(out)'], {
      status: 'missing',
      missingFrom: ['spice-ts'],
    });
  });

  it('compares a legal descending DC sweep when both engines succeed', async () => {
    const fixture: ComparisonFixture = {
      name: 'descending-dc',
      analysis: 'dc',
      netlist: '* descending DC sweep\nV1 in 0 0\nR1 in 0 1k\n.dc V1 5 0 -1\n.end',
      signals: ['v(in)'],
    };

    const result = await compareFixture(fixture, {
      runSpiceTs: async () => successfulRun([5, 4, 3, 2, 1, 0], { 'v(in)': [5, 4, 3, 2, 1, 0] }),
      runNgspice: async () => successfulRun([5, 3, 1, 0], { 'v(in)': [5, 3, 1, 0] }),
    });

    assert.equal(result.spiceTs.status, 'success');
    assert.equal(result.ngspice.status, 'success');
    assert.equal(result.status, 'compared');
    assert.deepEqual(result.metrics?.grid, {
      spiceTsPoints: 6,
      ngspicePoints: 4,
      alignedPoints: 6,
      excludedOutOfRange: 0,
    });
    const signal = result.metrics?.signals['v(in)'];
    assert.equal(signal?.status, 'compared');
    if (!signal || signal.status !== 'compared') throw new Error('expected compared signal');
    assert.deepEqual(signal.absoluteError, { max: 0, rms: 0 });
  });
});

describe('runner failure handling', () => {
  it('preserves failed engine runs without dropping the fixture', async () => {
    const fixture: ComparisonFixture = {
      name: 'failed-op',
      analysis: 'op',
      netlist: '* invalid\n.end',
      signals: ['v(out)'],
    };
    const failed: EngineRun = {
      status: 'failed',
      convergence: 'failed',
      runtimeMs: 2,
      command: ['ngspice', '-b'],
      error: 'convergence failed',
    };

    const result = await compareFixture(fixture, {
      runSpiceTs: async () => successfulRun([0], { 'v(out)': [1] }),
      runNgspice: async () => failed,
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.ngspice, failed);
    assert.equal(result.metrics, null);
  });

  it('turns a thrown runner error into a preserved failed run', async () => {
    const fixture: ComparisonFixture = {
      name: 'thrown-op',
      analysis: 'op',
      netlist: '* invalid\n.end',
      signals: ['v(out)'],
    };

    const result = await compareFixture(fixture, {
      runSpiceTs: async () => successfulRun([0], { 'v(out)': [1] }),
      runNgspice: async () => { throw new Error('raw parse failed'); },
    });

    assert.equal(result.status, 'failed');
    const ngspice = result.ngspice;
    if (ngspice.status === 'success') throw new Error('expected failed ngspice run');
    assert.equal(ngspice.status, 'failed');
    assert.equal(ngspice.convergence, 'failed');
    assert.equal(ngspice.error, 'raw parse failed');
  });
});

describe('ngspice raw parser', () => {
  it('parses real and complex plots without losing plot boundaries', () => {
    const raw = [
      'Title: fixture',
      'Plotname: Operating Point',
      'Flags: real',
      'No. Variables: 1',
      'No. Points: 1',
      'Variables:',
      '\t0\tv(out)\tvoltage',
      'Values:',
      '0\t\t2.000000e+00',
      'Title: fixture',
      'Plotname: AC Analysis',
      'Flags: complex',
      'No. Variables: 2',
      'No. Points: 1',
      'Variables:',
      '\t0\tfrequency\tfrequency',
      '\t1\tv(out)\tvoltage',
      'Values:',
      '0\t\t1.000000e+03,0.000000e+00',
      '\t5.000000e-01,-2.500000e-01',
    ].join('\n');

    const plots = parseNgspiceRaw(raw);
    assert.equal(plots.length, 2);
    assert.deepEqual(plots[0]?.signals['v(out)'], [{ re: 2, im: 0 }]);
    assert.deepEqual(plots[1]?.grid, [1000]);
    assert.deepEqual(plots[1]?.signals['v(out)'], [{ re: 0.5, im: -0.25 }]);
  });
});

describe('stable JSON schema', () => {
  it('serializes the v2 schema in a stable key order', () => {
    const json = serializeReport({
      schemaVersion: 'spice-ts-ngspice-comparison/v2',
      generatedAt: '2026-10-09T00:00:00.000Z',
      environment: { platform: 'linux', arch: 'x64', node: 'v22', cpu: 'test' },
      tools: {
        spiceTs: { version: '0.3.0', command: ['pnpm', 'bench:compare:v2'] },
        ngspice: { version: 'ngspice-47', command: ['ngspice', '-b', '-r', '<raw>', '<netlist>'] },
      },
      alignment: {
        targetGrid: 'spice-ts',
        interpolation: 'linear',
        relativeZeroThreshold: 1e-15,
      },
      fixtures: [],
    });

    assert.equal(
      json,
      '{\n  "schemaVersion": "spice-ts-ngspice-comparison/v2",\n  "generatedAt": "2026-10-09T00:00:00.000Z",\n  "environment": {\n    "platform": "linux",\n    "arch": "x64",\n    "node": "v22",\n    "cpu": "test"\n  },\n  "tools": {\n    "spiceTs": {\n      "version": "0.3.0",\n      "command": [\n        "pnpm",\n        "bench:compare:v2"\n      ]\n    },\n    "ngspice": {\n      "version": "ngspice-47",\n      "command": [\n        "ngspice",\n        "-b",\n        "-r",\n        "<raw>",\n        "<netlist>"\n      ]\n    }\n  },\n  "alignment": {\n    "targetGrid": "spice-ts",\n    "interpolation": "linear",\n    "relativeZeroThreshold": 1e-15\n  },\n  "fixtures": []\n}\n',
    );
  });
});

describe('ngspice initial-state semantics', () => {
  it('confirms .ic UIC/non-UIC, mixed-case, and .nodeset reference behavior', { skip: !hasNgspice }, async () => {
    const runs = await Promise.all(INITIAL_STATE_FIXTURES.map(runNgspice));
    for (const run of runs) assert.equal(run.status, 'success');

    const firstVoltage = (runIndex: number): number => {
      const run = runs[runIndex];
      if (run.status !== 'success') throw new Error(run.error);
      return run.series.signals['v(out)'][0].re;
    };

    assert.equal(firstVoltage(0), 1);
    assert.ok(Math.abs(firstVoltage(1) - 3) < 1e-5);
    assert.equal(firstVoltage(2), 0.5);
    assert.ok(Math.abs(firstVoltage(3) - 3) < 1e-5);
  });
});
