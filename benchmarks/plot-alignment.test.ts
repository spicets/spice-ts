import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareExecutions } from './aggregate-report.js';
import { buildClassicReport, type EngineAnalysis, type EngineExecution, type ClassicCircuit } from './corpus/classic/report.js';
import { createHash } from 'node:crypto';
import { compareInBatches, packExecution } from './corpus/corpus-f/packed.js';
import { normalizedSignalErrors, pairedReferenceSeries, outcome } from './corpus/corpus-f/lib.js';
import { declaredSecondaryGrid } from './sweep-coordinates.js';
const plot = (id: string, grid: number[], values: number[]): EngineAnalysis => ({ type: 'dc', plotName: id, series: { grid, signals: { 'v(out)': values.map(re => ({ re, im: 0 })) } } });
const execution = (...analyses: EngineAnalysis[]): EngineExecution => ({ status: 'success', convergence: 'converged', analyses });
for (const variant of ['disjoint', 'empty-signals', 'one-empty-signals', 'empty-values', 'empty-grid'] as const) {
  for (const path of ['aggregate', 'packed', 'classic'] as const) {
    test(`${path} retains paired ${variant} coverage without a false match`, async () => {
      const common = { ...plot('DC transfer characteristic', [0, 1], [0, 1]), plotId: 'dc1' };
      const left = { ...plot('DC transfer characteristic', [0, 1], [0, 1]), plotId: 'dc2' };
      const right = { ...plot('DC transfer characteristic', [0, 1], [0, 1]), plotId: 'dc2' };
      if (variant === 'disjoint') {
        left.series.signals = { 'v(left)': left.series.signals['v(out)'] };
        right.series.signals = { 'v(right)': right.series.signals['v(out)'] };
      } else if (variant === 'empty-signals') {
        left.series.signals = {};
        right.series.signals = {};
      } else if (variant === 'one-empty-signals') {
        left.series.signals = {};
      } else if (variant === 'empty-values') {
        right.series.signals['v(out)'] = [];
      } else {
        left.series.grid = [];
        left.series.signals['v(out)'] = [];
      }
      const own = execution(common, left);
      const reference = execution(common, right);
      const bytes = Buffer.from('authored no-overlap adapter input');
      const circuit = { id: 'authored', localPath: 'authored', analyses: ['dc'], sha256: createHash('sha256').update(bytes).digest('hex'), category: 'passive', sourcePath: 'authored', sourceUrl: '', ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } } as ClassicCircuit;
      const comparisons = path === 'aggregate' ? compareExecutions(own, reference)
        : path === 'packed' ? compareInBatches(packExecution(own), packExecution(reference), 1)
          : (await buildClassicReport({ schemaVersion: 1, source: { name: 'authored', revision: 'authored', license: 'MIT' }, circuits: [circuit] }, {
            readFixture: async () => bytes, runNgspice: async () => reference, runSpiceTs: async () => own, tools: { ngspice: 'synthetic', spiceTs: 'synthetic' },
          })).fixtures[0].comparisons;
      assert.equal(comparisons.length, 2);
      assert.equal(comparisons[1].plot?.spiceTs, 'dc2');
      assert.equal(comparisons[1].plot?.ngspice, 'dc2');
      if (variant === 'disjoint') {
        assert.deepEqual(comparisons[1].metrics.signals, {
          'v(left)': { status: 'missing', missingFrom: ['ngspice'] },
          'v(right)': { status: 'missing', missingFrom: ['spice-ts'] },
        });
      }
      const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(own, reference));
      assert.equal(missing, variant === 'disjoint' ? 2 : 1);
      assert.equal(outcome({ ngspice: reference.status, spiceTs: own.status, comparedAnalyses: comparisons.length, spiceTsAnalyses: 1, worstNormalized: Math.max(...errors.map(e => e.normalized)), missingSignals: missing }), 'mismatch');
    });
  }
}
test('packed batching preserves shared-signal semantics for partially overlapping plots', () => {
  const left = plot('dc1', [0, 1], [0, 1]);
  const right = plot('dc1', [0, 1], [0, 1]);
  left.series.signals['v(left)'] = left.series.signals['v(out)'];
  right.series.signals['v(right)'] = right.series.signals['v(out)'];
  assert.deepEqual(compareInBatches(packExecution(execution(left)), packExecution(execution(right)), 1), compareExecutions(execution(left), execution(right)));
});
test('repeated descriptive plots pair by occurrence without reference reuse', () => {
  const a = plot('DC transfer characteristic', [0, 1], [0, 1]);
  const b = plot('DC transfer characteristic', [0, 1], [0, 9]);
  const result = compareExecutions(execution(a, b), execution(a, b));
  assert.equal(result.length, 2);
  assert.equal(result[1].metrics.signals['v(out)'].status, 'compared');
  const metric = result[1].metrics.signals['v(out)'];
  assert.equal(metric.status, 'compared');
  if (metric.status === 'compared') assert.equal(metric.absoluteError.max, 0);
});
test('unmatched reference plots are explicit', () => {
  const a = plot('dc1', [0, 1], [0, 1]);
  const result = compareExecutions(execution(a), execution(a, plot('dc2', [0, 1], [0, 9])));
  assert.equal(result.length, 2);
  assert.equal(result[1].unmatched, 'spice-ts');
});
test('nested sweep resets align all points within separate outer groups', () => {
  const a = plot('dc1', [0, 1, 2, 0, 1, 2], [0, 1, 2, 10, 11, 12]);
  const result = compareExecutions(execution(a), execution(a));
  assert.equal(result[0].metrics.grid.alignedPoints, 6);
  const metric = result[0].metrics.signals['v(out)'];
  assert.equal(metric.status, 'compared');
  if (metric.status === 'compared') assert.equal(metric.absoluteError.max, 0);
});
test('descending nested primary sweep aligns all points', () => {
  const a = plot('dc1', [2, 1, 0, 2, 1, 0], [2, 1, 0, 12, 11, 10]);
  assert.equal(compareExecutions(execution(a), execution(a))[0].metrics.grid.alignedPoints, 6);
});
test('ordinal fallback rejects different primary grids instead of interpolating', () => {
  const own = plot('dc1', [0, 0.5, 1, 0, 0.5, 1], [0, 0.5, 1, 10, 10.5, 11]);
  const reference = plot('dc1', [0, 1, 0, 1], [0, 1, 10, 11]);
  const comparisons = compareExecutions(execution(own), execution(reference));
  assert.equal(comparisons[0].metrics.grid.alignedPoints, 0);
  assert.equal(comparisons[0].metrics.sweepGroups?.filter(group => group.unmatched).length, 4);
  assert.ok(normalizedSignalErrors(comparisons, pairedReferenceSeries(execution(own), execution(reference))).missing > 0);
});
test('ordinal fallback rejects unequal reset counts visibly', () => {
  const own = plot('dc1', [0, 1, 0, 1], [0, 1, 10, 11]);
  const reference = plot('dc1', [0, 1, 0, 1, 0, 1], [0, 1, 10, 11, 20, 21]);
  const metrics = compareExecutions(execution(own), execution(reference))[0].metrics;
  assert.equal(metrics.grid.alignedPoints, 0);
  assert.equal(metrics.sweepGroups?.filter(group => group.unmatched).length, 5);
});
test('ordinal fallback checks coordinates, not merely the grid length', () => {
  const own = plot('dc1', [0, 1, 0, 1], [0, 1, 10, 11]);
  const reference = plot('dc1', [0, 1, 0, 2], [0, 1, 10, 12]);
  const comparisons = compareExecutions(execution(own), execution(reference));
  assert.equal(comparisons[0].metrics.grid.alignedPoints, 2);
  assert.equal(comparisons[0].metrics.sweepGroups?.filter(group => group.unmatched).length, 2);
  assert.ok(normalizedSignalErrors(comparisons, pairedReferenceSeries(execution(own), execution(reference))).missing > 0);
});
test('ordinal fallback checks a singleton secondary group with unknown reference coordinates', () => {
  const own = plot('dc1', [0, 0.5, 1], [0, 0.5, 1]);
  own.series.secondaryGrid = [10, 10, 10];
  const reference = plot('dc1', [0, 1], [0, 1]);
  const metrics = compareExecutions(execution(own), execution(reference))[0].metrics;
  assert.equal(metrics.grid.alignedPoints, 0);
  assert.equal(metrics.sweepAlignment, 'reset-ordinal');
  assert.equal(metrics.sweepGroups?.filter(group => group.unmatched).length, 2);
});
test('packed batching preserves repeated plot pairing', () => {
  const a = plot('DC transfer characteristic', [0, 1], [0, 1]);
  const b = plot('DC transfer characteristic', [0, 1], [0, 9]);
  assert.deepEqual(compareInBatches(packExecution(execution(a, b)), packExecution(execution(a, b)), 1), compareExecutions(execution(a, b), execution(a, b)));
});

test('secondary coordinates pair reordered groups rather than their ordinals', () => {
  const own = plot('dc1', [0, 1, 0, 1], [0, 1, 10, 11]);
  own.series.secondaryGrid = [0, 0, 10, 10];
  const reference = plot('dc1', [0, 1, 0, 1], [10, 11, 0, 1]);
  reference.series.secondaryGrid = [10, 10, 0, 0];
  const metric = compareExecutions(execution(own), execution(reference))[0].metrics;
  assert.equal(metric.grid.alignedPoints, 4);
  const signal = metric.signals['v(out)'];
  assert.equal(signal.status, 'compared');
  if (signal.status === 'compared') assert.equal(signal.absoluteError.max, 0);
  assert.deepEqual(metric.sweepGroups?.map(group => group.secondaryValue), [0, 10]);
  assert.deepEqual(compareInBatches(packExecution(execution(own)), packExecution(execution(reference)), 1), compareExecutions(execution(own), execution(reference)));
});

test('secondary coordinate roundoff retains all mesa11-shaped groups (#1658)', () => {
  const coordinates = [-1.2000000000000002, -0.8000000000000002, -0.40000000000000013, -1.1102230246251565e-16];
  const referenceCoordinates = [-1.2, -0.7999999999999999, -0.3999999999999999, 1.1102230246251565e-16];
  const grid = coordinates.flatMap(() => [0, 1]);
  const own = plot('dc1', grid, grid);
  own.series.secondaryGrid = coordinates.flatMap(value => [value, value]);
  const reference = plot('dc1', grid, grid);
  reference.series.secondaryGrid = referenceCoordinates.flatMap(value => [value, value]);
  const comparisons = compareExecutions(execution(own), execution(reference));
  assert.equal(comparisons[0].metrics.grid.alignedPoints, 8);
  assert.equal(normalizedSignalErrors(comparisons, pairedReferenceSeries(execution(own), execution(reference))).missing, 0);
  assert.deepEqual(compareInBatches(packExecution(execution(own)), packExecution(execution(reference)), 1), comparisons);
});

test('secondary coordinate pairing rejects real offsets and ambiguous roundoff neighbors', () => {
  for (const [left, right] of [
    [[1], [1 + 1e-10]],
    [[0], [Number.EPSILON, -Number.EPSILON]],
    [[Number.EPSILON, -Number.EPSILON], [0]],
    [[0, Number.EPSILON], [0, Number.EPSILON]],
  ]) {
    const own = plot('dc1', left.flatMap(() => [0, 1]), left.flatMap(() => [0, 1]));
    own.series.secondaryGrid = left.flatMap(value => [value, value]);
    const reference = plot('dc1', right.flatMap(() => [0, 1]), right.flatMap(() => [0, 1]));
    reference.series.secondaryGrid = right.flatMap(value => [value, value]);
    const metrics = compareExecutions(execution(own), execution(reference))[0].metrics;
    assert.equal(metrics.grid.alignedPoints, 0);
    assert.equal(metrics.sweepGroups?.filter(group => group.unmatched).length, left.length + right.length);
  }
});

test('unmatched secondary groups cannot masquerade as a match', () => {
  const own = plot('dc1', [0, 1], [0, 1]);
  own.series.secondaryGrid = [0, 0];
  const reference = plot('dc1', [0, 1, 0, 1], [0, 1, 10, 11]);
  reference.series.secondaryGrid = [0, 0, 10, 10];
  const comparisons = compareExecutions(execution(own), execution(reference));
  assert.equal(comparisons[0].metrics.grid.alignedPoints, 2);
  assert.equal(normalizedSignalErrors(comparisons, pairedReferenceSeries(execution(own), execution(reference))).missing, 1);
});

test('nested sweep retains reset identity across the 25k chunk boundary', () => {
  const grid = Array.from({ length: 30000 }, (_, index) => index % 15000);
  const own = plot('dc1', grid, grid.map((value, index) => value + (index >= 15000 ? 100000 : 0)));
  const metrics = compareExecutions(execution(own), execution(own))[0].metrics;
  assert.equal(metrics.grid.alignedPoints, 30000);
  assert.equal(metrics.grid.excludedOutOfRange, 0);
});

test('straight-line literal DC metadata refuses dynamic scripts', () => {
  const text = 'title\n.control\ndc V1 0 1 1 TEMP -40 0 40\n.endc';
  assert.deepEqual(declaredSecondaryGrid(text, 'dc1', [0, 1, 0, 1]), [-40, -40, 0, 0]);
  assert.equal(declaredSecondaryGrid('title\n.control\nrepeat 2\ndc V1 0 1 1 TEMP -40 0 40\nend\n.endc', 'dc1', [0, 1, 0, 1]), undefined);
});

test('literal nested dot-card DC declares secondary coordinates for raw plot names', () => {
  const text = 'title\n.DC V1 0 1 1 V2 700M 800M 100M\n.end';
  for (const id of ['dc1', 'DC transfer characteristic']) {
    assert.deepEqual(declaredSecondaryGrid(text, id, [0, 1, 0, 1]), [0.7000000000000001, 0.7000000000000001, 0.8, 0.8]);
  }
});

test('literal control DC descriptive names require a unique declaration', () => {
  const command = 'dc V1 0 1 1 V2 1 -1 -1';
  assert.deepEqual(declaredSecondaryGrid(`title\n.control\n${command}\n.endc`, 'DC transfer characteristic', [0, 1, 0, 1, 0, 1]), [1, 1, 0, 0, -1, -1]);
  const multiple = `title\n.control\ndc V1 0 1 1\n${command}\n.endc`;
  assert.equal(declaredSecondaryGrid(multiple, 'DC transfer characteristic', [0, 1, 0, 1, 0, 1]), undefined);
  assert.deepEqual(declaredSecondaryGrid(multiple, 'dc2', [0, 1, 0, 1, 0, 1]), [1, 1, 0, 0, -1, -1]);
});

test('literal DC rejects dynamic, ambiguous and nonliteral provenance', () => {
  const card = '.dc V1 0 1 1 V2 0 1 1';
  for (const command of ['run', 'reset', 'source other.cir', 'repeat 2', 'foreach x 1 2', 'while 1', 'dowhile 1', 'if 1', 'goto label', '.if 1']) {
    assert.equal(declaredSecondaryGrid(`title\n${card}\n.control\n${command}\n.endc`, 'dc1', [0, 1, 0, 1]), undefined);
  }
  for (const text of [
    `title\n${card}\n${card}`,
    `title\n${card}\n.control\ndc V1 0 1 1 V2 0 1 1\n.endc`,
    'title\ndc V1 0 1 1 V2 0 1 1',
    'title\n.dc V1 {start} 1 1 V2 0 1 1',
    'title\n.dc V1 0 1 1 V2 $start 1 1',
    'title\n.dc V1 0 1 1 V2 0 1 0',
    'title\n.dc V1 0 1 1 V2 0 1 -1',
  ]) assert.equal(declaredSecondaryGrid(text, 'dc1', [0, 1, 0, 1]), undefined);
  assert.equal(declaredSecondaryGrid(`title\n${card}`, 'dc1', [0, 1]), undefined);
  assert.equal(declaredSecondaryGrid(`title\n${card}`, 'dc1', [0, 1, 0, 1, 0, 1]), undefined);
  assert.equal(declaredSecondaryGrid(`title\n${card}`, 'dc2', [0, 1, 0, 1]), undefined);
  assert.equal(declaredSecondaryGrid(`title\n${card}`, 'tran1', [0, 1, 0, 1]), undefined);
});

test('normalization reads each paired reference peak, not the first plot peak', () => {
  const a = plot('DC transfer characteristic', [0, 1], [1, 2]);
  const b = plot('DC transfer characteristic', [0, 1], [10, 20]);
  const own = execution(a, plot('DC transfer characteristic', [0, 1], [10, 21]));
  const reference = execution(a, b);
  const errors = normalizedSignalErrors(compareExecutions(own, reference), pairedReferenceSeries(own, reference));
  assert.equal(errors.errors[1].ngspicePeak, 20);
  assert.equal(errors.errors[1].normalized, 0.05);
});

test('classic report uses the same one-to-one pairing rather than reusing its first plot', async () => {
  const bytes = Buffer.from('authored adapter input');
  const circuit = { id: 'authored', localPath: 'authored', analyses: ['dc'], sha256: createHash('sha256').update(bytes).digest('hex'), category: 'passive', sourcePath: 'authored', sourceUrl: '', ngspice: { expectedStatus: 'pass' }, spiceTs: { expectedStatus: 'pass' } } as ClassicCircuit;
  const a = plot('DC transfer characteristic', [0, 1], [0, 1]);
  const b = plot('DC transfer characteristic', [0, 1], [0, 9]);
  const report = await buildClassicReport({ schemaVersion: 1, source: { name: 'authored', revision: 'authored', license: 'MIT' }, circuits: [circuit] }, {
    readFixture: async () => bytes, runNgspice: async () => execution(a, b), runSpiceTs: async () => execution(a, b), tools: { ngspice: 'synthetic', spiceTs: 'synthetic' },
  });
  const signal = report.fixtures[0].comparisons[1].metrics.signals['v(out)'];
  assert.equal(signal.status, 'compared');
  if (signal.status === 'compared') assert.equal(signal.absoluteError.max, 0);
});
