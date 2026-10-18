import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNgspiceRaw } from '../../comparison-harness.js';
import { PACKED_COLUMNS, parseRawLines, parseRawLinesInto } from './raw-stream.js';

// ngspice-47, issue13431.spice with .option INTERP: the variable table and
// Values marker repeat during startup before the first interpolated sample.
const table = '0 time time\n1 v(out) voltage\n2 i(v1) current\nValues:\n';
const header = 'Title: interp startup\nPlotname: Transient Analysis\nFlags: real\nNo. Variables: 3\nNo. Points: 2\nVariables:\n';
const samples = '0 1e-5\n2\n-0.002\n1 2e-5\n4\n-0.004\n';

test('INTERP repeated startup tables do not become waveform samples (#1434)', async () => {
  const ordinary = header + table + samples;
  const repeated = header + table.repeat(16) + samples;
  assert.deepEqual(parseNgspiceRaw(repeated), parseNgspiceRaw(ordinary));
  assert.deepEqual(await parseRawLines(repeated.split('\n')), await parseRawLines(ordinary.split('\n')));
  assert.deepEqual(await parseRawLinesInto(repeated.split('\n'), PACKED_COLUMNS),
    await parseRawLinesInto(ordinary.split('\n'), PACKED_COLUMNS));
  const selected = await parseRawLines(repeated.split('\n'), (_plot, signal) => signal === 'i(v1)');
  assert.deepEqual(selected[0].grid, [1e-5, 2e-5]);
  assert.deepEqual(Object.keys(selected[0].signals), ['i(v1)']);
  assert.deepEqual(selected[0].signals['i(v1)'].map(value => value.re), [-0.002, -0.004]);
});
