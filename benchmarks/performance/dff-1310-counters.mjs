// Reproduce the issue-1310 counter receipt; all simulator runs use spice-heavy.
// Usage after pnpm build: node benchmarks/performance/dff-1310-counters.mjs > receipt.json
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform, release, arch, cpus } from 'node:os';

const fixture = 'benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fixtureSha256 = sha256(readFileSync(fixture));
const scratch = mkdtempSync(join(tmpdir(), 'dff-1310-counters-'));
const wrapper = join(scratch, 'stats.cir');
// Source the unmodified deck (including its TRAN); query statistics only afterwards.
const wrapperText = `Issue 1310 stats-only control wrapper\n.control\nsource ${fixture}\nrusage all\nquit\n.endc\n.end\n`;
writeFileSync(wrapper, wrapperText);
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(JSON.stringify(result));
  return result.stdout + result.stderr;
}
const ngspice = [];
for (let i = 0; i < 3; i++) {
  const text = run('spice-heavy', ['ngspice', '-b', wrapper]);
  writeFileSync(join(scratch, `ngspice-${i + 1}.log`), text);
  const counters = Object.fromEntries([...text.matchAll(/^([^\r\n=]+?)\s*=\s*([\d.eE+-]+)\s*$/gm)]
    .map(([, key, value]) => [key.trim(), Number(value)]));
  const rows = Number(text.match(/No\. of Data Rows\s*:\s*(\d+)/)?.[1]);
  for (const key of ['Accepted timepoints', 'Rejected timepoints', 'Transient iterations', 'Transient analysis time', 'Transient load time', 'Transient factor time', 'Transient solve time']) {
    if (!Number.isFinite(counters[key])) throw new Error(`Missing ngspice counter: ${key}`);
  }
  if (!rows) throw new Error('Missing ngspice output');
  ngspice.push({ run: i + 1, rows, counters });
}
const spiceText = run('spice-heavy', ['node', 'benchmarks/performance/dff-1310.mjs', '3']);
writeFileSync(join(scratch, 'spice-ts.jsonl'), spiceText);
const spiceTs = spiceText.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
if (spiceTs.length !== 3 || spiceTs.some((r) => r.fixtureSha256 !== fixtureSha256)) throw new Error('Incomplete or changed spice-ts input');
if (sha256(readFileSync(fixture)) !== fixtureSha256) throw new Error('Fixture changed');
console.log(JSON.stringify({
  revision: run('git', ['rev-parse', 'HEAD']).trim(),
  measuredAt: new Date().toISOString(),
  host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0].model, node: process.version },
  fixture, fixtureSha256,
  ngspiceVersion: run('ngspice', ['--version']).trim(),
  commands: ['spice-heavy ngspice -b <scratch>/stats.cir (three separate processes)', 'spice-heavy node benchmarks/performance/dff-1310.mjs 3'],
  statsWrapper: wrapperText,
  scratch,
  ngspice, spiceTs,
}, null, 2));
