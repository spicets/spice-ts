import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = 'benchmarks/corpus/corpus-q';
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const REVISION = '7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2';
const repository = 'https://github.com/Xyce/Xyce_Regression';
// Fixed before running either engine: six AC and six DC measurement decks,
// plus three standalone transient source decks. No engine-success filtering.
export const PATHS = [
  'Netlists/MEASURE_AC/AvgTestAC.cir',
  'Netlists/MEASURE_AC/DerivTestAC.cir',
  'Netlists/MEASURE_AC/EquationEvalTestAC.cir',
  'Netlists/MEASURE_AC/IntegTestAC.cir',
  'Netlists/MEASURE_AC/MaxMinPPTestAC.cir',
  'Netlists/MEASURE_AC/RMSTestAC.cir',
  'Netlists/MEASURE_DC/AvgTest1DC.cir',
  'Netlists/MEASURE_DC/DerivTest1DC.cir',
  'Netlists/MEASURE_DC/EquationEvalTestDC.cir',
  'Netlists/MEASURE_DC/IntegTest1DC.cir',
  'Netlists/MEASURE_DC/MaxMinPPTest1DC.cir',
  'Netlists/MEASURE_DC/RMSTest1DC.cir',
  'Netlists/SOURCES/sources.cir',
  'Netlists/VSIN/bug510.cir',
  'Netlists/VSIN/vsin.cir',
] as const;
async function download(path: string) {
  const url = `${repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${REVISION}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
async function save(path: string, bytes: Buffer | string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
export async function ingest() {
  const license = await download('README.md');
  const licensePath = `${ROOT}/licenses/xyce/README.md`;
  await save(licensePath, license);
  const sources = [{ key: 'xyce', repository, revision: REVISION, license: 'GPL-3.0-or-later',
    licensePath, licenseSha256: hash(license), licenseUrl: `${repository}/blob/${REVISION}/README.md` }];
  // Upstream README links a missing COPYING; retain the full GPL text already
  // preserved by corpus-o, not a replacement licence grant.
  const licenseTextPath = `${ROOT}/licenses/xyce/COPYING`;
  const licenseText = await readFile('benchmarks/corpus/corpus-o/licenses/xyce/COPYING');
  await save(licenseTextPath, licenseText);
  Object.assign(sources[0], { licenseTextPath, licenseTextSha256: hash(licenseText) });
  const circuits = [];
  for (const path of PATHS) {
    const bytes = await download(path);
    if (/^\s*\.(?:include|inc|lib)\b/im.test(bytes.toString())) throw new Error(`dependency: ${path}`);
    const localPath = `${ROOT}/fixtures/xyce/${path}`;
    await save(localPath, bytes);
    circuits.push({ id: `q-${circuits.length + 1}`, source: 'xyce', upstreamPath: path, sourcePath: `xyce/${path}`,
      sourceUrl: `${repository}/blob/${REVISION}/${path}`, revision: REVISION,
      licence: 'GPL-3.0-or-later', localPath, sha256: hash(bytes), upstreamSha256: hash(bytes), bytes: bytes.length,
      adaptation: 'none', includeClosure: [],
      analyses: [...bytes.toString().matchAll(/^\s*\.(ac|dc|tran|op)\b/gim)].map(m => m[1].toLowerCase()),
      unmappedAnalyses: [], sameNameAs: [] });
  }
  const selection = 'Fixed explicit list of six standalone AC measurement decks (AVG, DERIV, equation, INTEG, MAX/MIN/PP, RMS), their six DC counterparts, and three standalone transient source regression decks. Chosen by analysis/family and absence from earlier committed manifests, before either engine ran. No success filtering, adaptations, dependencies or vendor libraries. Xyce dialect failures and deliberately failing measurements are retained.';
  await save(`${ROOT}/manifest.json`, JSON.stringify({ schemaVersion: 1, issue: 'https://github.com/spicets/spice-ts/issues/1763', sources, selection, mechanicalAdaptation: 'none', circuits }, null, 2) + '\n');
  await save(`${ROOT}/SOURCES.md`, `# corpus-q provenance (#1763)\n\n${repository} at \`${REVISION}\`. SPDX **GPL-3.0-or-later**, repository-wide README licence grant (same licence basis as corpus-k through corpus-o). Original [README](licenses/xyce/README.md), SHA256 \`${hash(license)}\`. Original notices remain unchanged. Full GPL text: [COPYING](licenses/xyce/COPYING), SHA256 \`${hash(licenseText)}\`, copied unchanged from corpus-o because the upstream README links a missing COPYING. GPL covers these independent benchmark data files, not simulator package code.\n\n${selection}\n\nBoth engines receive identical verbatim committed bytes. Original and committed SHA256 are equal; offline tests check both, normalized content hashes and revision-independent source URLs against all earlier manifests. Measurement directives are not removed: waveform parity does not certify every .MEASURE result.\n\n| ID | Pinned upstream URL | Committed SHA256 | Original SHA256 |\n|---|---|---|---|\n${circuits.map(c => `| ${c.id} | ${c.sourceUrl} | \`${c.sha256}\` | \`${c.upstreamSha256}\` |`).join('\n')}\n\nIngest: \`pnpm exec tsx ${ROOT}/ingest.ts\`. Benchmark: \`spice-heavy pnpm exec tsx ${ROOT}/parity.ts --jobs 1\`. Verify: \`pnpm exec tsx --test ${ROOT}/corpus-q.test.ts\`. All losses remain in outcomes.json. No aggregate refresh.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ingest().catch(error => { console.error(error); process.exitCode = 1; });
