import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [entry, deckPath, mode] = process.argv.slice(2);
if (!entry || !deckPath || !['cold', 'warm'].includes(mode)) throw new Error('invalid worker arguments');
const deck = readFileSync(deckPath, 'utf8');
const core = await import(pathToFileURL(entry));
async function run() { return core.simulate(await core.parseAsync(deck)); }
if (mode === 'warm') await run();
const start = performance.now();
const result = await run();
const elapsed = performance.now() - start;
if (!result.transient) throw new Error('missing transient result');
const vectors = [['time', result.transient.time], ...[...result.transient.voltages].map(([k, v]) => ['v:' + k, v]), ...[...result.transient.currents].map(([k, v]) => ['i:' + k, v])];
const hash = createHash('sha256');
let points = 0;
for (const [name, values] of vectors) {
  hash.update(JSON.stringify([name, values.length]));
  const bytes = Buffer.allocUnsafe(values.length * 8);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error(`non-finite output ${name}`);
    bytes.writeDoubleLE(values[i], i * 8);
  }
  points += values.length;
  hash.update(bytes);
}
if (!points) throw new Error('empty result');
console.log(JSON.stringify({ elapsed, output: hash.digest('hex'), points }));
