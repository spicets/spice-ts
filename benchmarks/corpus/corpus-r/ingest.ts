import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = 'benchmarks/corpus/corpus-r';
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const REVISION = '7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2';
const repository = 'https://github.com/Xyce/Xyce_Regression';
// Fixed before running either engine: seven transient decks, five DC device
// sweeps and one noise deck. Selected by device/analysis family, dependency
// closure and novelty only. Intentional invalid-input regression decks stay.
export const PATHS = [
  'Netlists/BJT_EXTNODE/npn_rb_rc_re_3.cir',
  'Netlists/BJT_EXTNODE/npn_rc_re_3.cir',
  'Netlists/Certification_Tests/BUG_647_SON/bjt.cir',
  'Netlists/Certification_Tests/BUG_647_SON/bjt_ambient.cir',
  'Netlists/DIODE/diode_with_sidewall_temp.cir',
  'Netlists/NOISE/unsupported_analysis_mode.cir',
  'Netlists/NOISE/unsupported_device_source.cir',
  'Netlists/Certification_Tests/BUG_983_SON/jfet.cir',
  'Netlists/Certification_Tests/BUG_647_SON/mos1.cir',
  'Netlists/Certification_Tests/BUG_647_SON/mos1_modpar.cir',
  'Netlists/Certification_Tests/ISSUE_239/mos1_test1.cir',
  'Netlists/Certification_Tests/ISSUE_239/mos1_test2.cir',
  'Netlists/Certification_Tests/ISSUE_239/mos1_test3.cir'
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
    circuits.push({ id: `r-${circuits.length + 1}`, source: 'xyce', upstreamPath: path, sourcePath: `xyce/${path}`,
      sourceUrl: `${repository}/blob/${REVISION}/${path}`, revision: REVISION,
      licence: 'GPL-3.0-or-later', localPath, sha256: hash(bytes), upstreamSha256: hash(bytes), bytes: bytes.length,
      adaptation: 'none', includeClosure: [],
      analyses: [...bytes.toString().matchAll(/^\s*\.(ac|dc|tran|op|noise|tf)\b/gim)].map(m => m[1].toLowerCase()),
      unmappedAnalyses: [], sameNameAs: [] });
  }
  const selection = 'Fixed explicit list of 13 standalone decks: BJT external-node DC sweeps, BJT temperature transients, diode sidewall temperature DC sweep, noise invalid-input regressions, JFET level-2 transient, MOS1 temperature/geometry DC sweeps and three MOS1 transient regressions. Seven tran, five dc and one noise; no AC or TF coverage claimed. Chosen by analysis/device family, absence from earlier manifests and no include dependencies before either engine ran. No success filtering, adaptations or tolerance changes. Xyce dialect rejections and deliberately invalid inputs are retained.';
  await save(`${ROOT}/manifest.json`, JSON.stringify({ schemaVersion: 1, issue: 'https://github.com/spicets/spice-ts/issues/1777', sources, selection, mechanicalAdaptation: 'none', circuits }, null, 2) + '\n');
  await save(`${ROOT}/SOURCES.md`, `# corpus-r provenance (#1777)\n\n${repository} at \`${REVISION}\`. SPDX **GPL-3.0-or-later**, repository-wide README licence grant (same licence basis as corpus-k through corpus-o). Original [README](licenses/xyce/README.md), SHA256 \`${hash(license)}\`. Original notices remain unchanged. Full GPL text: [COPYING](licenses/xyce/COPYING), SHA256 \`${hash(licenseText)}\`, copied unchanged from corpus-o because the upstream README links a missing COPYING. GPL covers these independent benchmark data files, not simulator package code.\n\n${selection}\n\nBoth engines receive identical verbatim committed bytes. Original and committed SHA256 are equal; offline tests check both, normalized content hashes and revision-independent source URLs against all earlier manifests. Measurement directives are not removed: waveform parity does not certify every .MEASURE result.\n\n| ID | Pinned upstream URL | Committed SHA256 | Original SHA256 | Licence |\n|---|---|---|---|---|\n${circuits.map(c => `| ${c.id} | ${c.sourceUrl} | \`${c.sha256}\` | \`${c.upstreamSha256}\` | ${c.licence} |`).join('\n')}\n\nIngest: \`pnpm exec tsx ${ROOT}/ingest.ts\`. Benchmark: \`spice-heavy pnpm exec tsx ${ROOT}/parity.ts --jobs 1\`. Verify: \`pnpm exec tsx --test ${ROOT}/corpus-r.test.ts\`. All losses remain in outcomes.json. No aggregate refresh.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ingest().catch(error => { console.error(error); process.exitCode = 1; });
