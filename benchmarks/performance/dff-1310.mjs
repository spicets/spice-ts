// Run after building core: spice-heavy node benchmarks/performance/dff-1310.mjs [runs] [tstop]
// Omit tstop to measure the unchanged full corpus deck. JSON lines go to stdout.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { simulate } from '../../packages/core/dist/index.js';
const original = readFileSync('benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp', 'utf8');
const runs = Number(process.argv[2] ?? 3);
const stop = process.argv[3];
const deck = stop ? original.replace('TRAN 0.25p 10n', `TRAN 0.25p ${stop}`) : original;
for (let run = 0; run < runs; run++) {
  const start = performance.now();
  const result = await simulate(deck);
  const seconds = (performance.now() - start) / 1000;
  const tran = result.transient;
  if (!tran) throw new Error('Missing transient');
  const hash = createHash('sha256');
  for (const values of [tran.time, ...tran.voltages.values(), ...tran.currents.values()]) {
    for (const value of values) {
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleLE(value);
      hash.update(bytes);
    }
  }
  console.log(JSON.stringify({ run, node: process.version, tstop: stop ?? '10n',
    fixtureSha256: createHash('sha256').update(original).digest('hex'), seconds,
    rows: tran.time.length, outputSha256: hash.digest('hex'), convergence: result.convergence }));
}
