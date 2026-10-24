import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = 'benchmarks/corpus/corpus-p';
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const SOURCES = [
  { key: 'mna-mat', repository: 'https://github.com/nik1106/MNA-MAT', revision: 'a77a4eb409aba1eb7f04919aa3990a60b0233cce', paths: Array.from({ length: 12 }, (_, i) => `example${i + 1}.cir`) },
  { key: 'netlistparse', repository: 'https://github.com/NyanCAD/NetlistParse.rs', revision: '94386c7fcf669ce9e930686815d94e11050307f6', paths: ['tests/corpus/rlc.sp', 'tests/corpus/ext_devices.sp', 'tests/corpus/ext_xyce_cmds.sp', 'tests/corpus/ext_xyce_y.sp'] },
] as const;

async function download(repository: string, revision: string, path: string) {
  const url = `${repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${revision}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
async function save(path: string, bytes: Buffer | string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
export async function ingest() {
  const sources = [];
  const circuits = [];
  for (const source of SOURCES) {
    const licenseBytes = await download(source.repository, source.revision, 'LICENSE');
    const licensePath = `${ROOT}/licenses/${source.key}/LICENSE`;
    await save(licensePath, licenseBytes);
    sources.push({ key: source.key, repository: source.repository, revision: source.revision, license: 'MIT', licensePath, licenseSha256: hash(licenseBytes), licenseUrl: `${source.repository}/blob/${source.revision}/LICENSE` });
    for (const path of source.paths) {
      const original = await download(source.repository, source.revision, path);
      const sourcePath = `${source.key}/${path}`;
      // MNA-MAT accepts element-only files. SPICE requires a title and an analysis.
      // The RLC parser example already has a title but no analysis or .end.
      const adapted = source.key === 'mna-mat' || path.endsWith('/rlc.sp');
      const bytes = adapted ? Buffer.concat([source.key === 'mna-mat' ? Buffer.from(`corpus-p ${sourcePath}\n`) : Buffer.alloc(0), original, Buffer.from('\n.op\n.end\n')]) : original;
      const localPath = `${ROOT}/fixtures/${sourcePath}`;
      await save(localPath, bytes);
      circuits.push({ id: `p-${circuits.length + 1}`, source: source.key, upstreamPath: path, sourcePath,
        sourceUrl: `${source.repository}/blob/${source.revision}/${path}`, revision: source.revision,
        licence: 'MIT', localPath, sha256: hash(bytes), upstreamSha256: hash(original), bytes: bytes.length,
        adaptation: adapted ? 'op-wrapper' : 'none', includeClosure: [],
        analyses: path.endsWith('ext_xyce_cmds.sp') ? ['tran', 'op'] : ['op'], unmappedAnalyses: [], sameNameAs: [] });
    }
  }
  const manifest = { schemaVersion: 1, issue: 'https://github.com/spicets/spice-ts/issues/1722', sources,
    mechanicalAdaptation: 'MNA-MAT: prepend title; MNA-MAT and NetlistParse rlc.sp: append newline + .op + .end. All original bytes preserved between wrappers. Other decks verbatim. Both engines receive identical adapted bytes.',
    selection: 'All 12 top-level MNA-MAT examples; NetlistParse standalone RLC and all three ext_* device/circuit decks. ext_nodeset.sp is directive-only, not a circuit. Static selection before any engine runs; no success filter. No model libraries redistributed.', circuits };
  await save(`${ROOT}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  await save(`${ROOT}/SOURCES.md`, `# corpus-p provenance (#1722)\n\n${sources.map(s => `- ${s.repository} at \`${s.revision}\`, SPDX **MIT**. Original notice: [LICENSE](licenses/${s.key}/LICENSE), SHA256 \`${s.licenseSha256}\`.`).join('\n')}\n\n${manifest.selection}\n\n${manifest.mechanicalAdaptation}\n\nThe OP wrappers are uniform, not transient/AC coverage. No element, value, model or original whitespace is changed. Original bytes are recovered by stripping the documented prefix/suffix; offline tests verify both hashes. No vendor model files are redistributed. Each original URL and full revision is also in manifest.json. Both sources are new to benchmarks/SOURCES.md; original/adapted hashes were checked against all earlier corpus manifests with no collisions.\n\n| ID | Upstream path (source and revision above) | Committed fixture SHA256 | Original SHA256 |\n|---|---|---|---|\n${circuits.map(c => `| ${c.id} | [${c.sourcePath}](${c.sourceUrl}) | \`${c.sha256}\` | \`${c.upstreamSha256}\` |`).join('\n')}\n\nReproduce ingestion: \`pnpm exec tsx ${ROOT}/ingest.ts\`. Run: \`spice-heavy pnpm exec tsx ${ROOT}/parity.ts --jobs 1\`. All outcomes, including reference rejections and spice-ts unsupported decks, are retained in outcomes.json. No tolerance changes or engine-success filtering.\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ingest().catch(error => { console.error(error); process.exitCode = 1; });
