// Identical original deck; no control-block or timestep adaptation.
// Usage: spice-heavy pnpm exec tsx benchmarks/switches-1628/compare.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simulate } from '../../packages/core/src/index.js';

void main();

async function main(): Promise<void> {
const fixture = resolve('benchmarks/corpus/corpus-f/fixtures/examples/probe/switches-manual-p92.cir');
const work = mkdtempSync(join(tmpdir(), 'switches-1628-'));
try {
  const references = [1, 2].map(run => {
    const raw = join(work, `${run}.raw`);
    execFileSync('ngspice', ['-n', '-b', '-r', raw, fixture], { stdio: 'ignore' });
    const bytes = readFileSync(raw);
    const start = bytes.indexOf('Binary:\n') + 'Binary:\n'.length;
    const header = bytes.subarray(0, start).toString();
    const width = Number(/No. Variables: (\d+)/.exec(header)![1]);
    const column = Number(/\n\s*(\d+)\s+v\(10\)/.exec(header)![1]);
    const payload = bytes.subarray(start);
    const rows = Array.from({ length: payload.length / (width * 8) }, (_, i) => ({
      time: payload.readDoubleLE(i * width * 8),
      value: payload.readDoubleLE((i * width + column) * 8),
    }));
    return { rows, payloadSha256: createHash('sha256').update(payload).digest('hex') };
  });
  if (JSON.stringify(references[0].rows) !== JSON.stringify(references[1].rows)) {
    throw new Error('ngspice determinism gate failed');
  }
  const tran = (await simulate(readFileSync(fixture, 'utf8'))).transient!;
  const values = tran.voltage('10');
  const reference = references[0].rows;
  let maxAbs = 0;
  let squared = 0;
  let j = 1;
  tran.time.forEach((time, i) => {
    while (j < reference.length - 1 && reference[j].time < time) j++;
    const a = reference[j - 1];
    const b = reference[j];
    const expected = a.value + (b.value - a.value) * (time - a.time) / (b.time - a.time);
    const error = Math.abs(values[i] - expected);
    maxAbs = Math.max(maxAbs, error);
    squared += error * error;
  });
  const peak = Math.max(...reference.map(row => Math.abs(row.value)));
  console.log(JSON.stringify({ fixture, ngspice: '47', fixtureSha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
    determinism: { points: reference.length, maxAbsDisagreement: 0, payloadSha256: references[0].payloadSha256 },
    spiceTsPoints: tran.time.length, maxAbs, rmsAbs: Math.sqrt(squared / tran.time.length),
    maxNormalized: maxAbs / peak, threshold: 0.01 }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
}
