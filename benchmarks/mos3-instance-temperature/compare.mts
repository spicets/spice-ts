import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { simulate } from '../../packages/core/src/index.js';

const { references } = JSON.parse(readFileSync(new URL('./reference.json', import.meta.url), 'utf8')) as {
  references: { id: string; deck: string; sha256: string; op: number[]; dc: number[][] }[];
};
const maxima = { op: [0, 0, 0], dc: [0, 0, 0] };
let failures = 0;
for (const reference of references) {
  if (createHash('sha256').update(reference.deck).digest('hex') !== reference.sha256) {
    throw new Error(`Deck hash mismatch: ${reference.id}`);
  }
  try {
    const result = await simulate(reference.deck);
    const op = [result.dc!.voltage('d'), result.dc!.voltage('s'), result.dc!.current('VD')];
    const sweep = result.dcSweep!;
    const check = (actual: number[], expected: number[], analysis: 'op' | 'dc') => {
      actual.forEach((value, index) => {
        const error = Math.abs(value - expected[index]);
        maxima[analysis][index] = Math.max(maxima[analysis][index], error / Math.abs(expected[index]));
        if (!(error < 1e-12 + 1e-7 * Math.abs(expected[index]))) {
          throw new Error(`${reference.id} ${analysis} signal ${index} outside MOS3 parity tolerance`);
        }
      });
    };
    check(op, reference.op, 'op');
    reference.dc.forEach((row, index) => {
      if (sweep.sweepValues[index] !== row[0]) throw new Error('DC temperature grid mismatch');
      check([sweep.voltage('d')[index], sweep.voltage('s')[index], sweep.current('VD')[index]], row.slice(1), 'dc');
    });
  } catch (error) {
    failures++;
    console.error(reference.id, error instanceof Error ? error.message : error);
  }
}
console.log(JSON.stringify({ references: references.length, failures, signals: ['v(d)', 'v(s)', 'i(VD)'], maxRelativeError: maxima }));
if (failures) process.exitCode = 1;
