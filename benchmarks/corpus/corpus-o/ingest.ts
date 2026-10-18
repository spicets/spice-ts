import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticVerdict, stripTerminalNewline, DECK_EXTENSIONS } from '../corpus-h/lib.js';
import { runNgspicePacked } from '../corpus-f/outcomes.js';
export const ROOT = 'benchmarks/corpus/corpus-o';
export const REVISION = '7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2';
export const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const repository = 'https://github.com/Xyce/Xyce_Regression';
export const selectedFamily = (path: string) => /^Netlists\/(?:BJT[^/]*|NPN_DC|PNP_DC|DIODE[^/]*|NOISE|VANOISE|VSWITCH|ISWITCH|GSWITCH|ACtests|MCNC_BJT_[^/]*|SANDLER\d+|TL431)\//.test(path);
const priority = (path: string) => /SANDLER|TL431|MCNC_BJT/.test(path) ? 0 : /NOISE|ACtests/.test(path) ? 1 : 2;
async function main() {
  const checkout = process.env.CORPUS_O_UPSTREAM;
  if (!checkout) throw new Error('set CORPUS_O_UPSTREAM to the pinned Xyce_Regression checkout');
  const upstream = (path: string) => execFileSync('git', ['show', `${REVISION}:${path}`], { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
  if (process.argv[2] === '--probe') {
    const path = process.argv[3];
    const bytes = upstream(path);
    const verdict = staticVerdict(bytes, path, new Set<string>());
    if (verdict.reason !== null) throw new Error(`static rejection: ${verdict.reason}`);
    const run = await runNgspicePacked(bytes, { id: 'probe', localPath: path, sourcePath: path, analyses: verdict.analyses, unmappedAnalyses: verdict.unmappedAnalyses } as never);
    await writeFile(process.argv[4], JSON.stringify({ status: run.status, firstErrorLine: run.firstErrorLine ?? null, analyses: run.execution.analyses.map(a => `${a.type}:${a.grid.length}`) }));
    return;
  }
  if (!/ngspice-47\b/.test(spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout)) throw new Error('requires ngspice-47');
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', REVISION], { cwd: checkout, encoding: 'utf8' }).trim().split('\n');
  const existing = new Set<string>();
  for (const corpus of await readdir('benchmarks/corpus')) {
    if (corpus === 'corpus-o') continue;
    let files;
    try { files = await readdir(`benchmarks/corpus/${corpus}`, { recursive: true, withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') continue; throw error; }
    for (const file of files.filter(f => f.isFile() && !f.parentPath.includes('/.upstream'))) {
      const bytes = await readFile(resolve(file.parentPath, file.name));
      existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
    }
  }
  const candidates = [];
  for (const path of paths.filter(p => selectedFamily(p) && DECK_EXTENSIONS.test(p)).sort((a, b) => priority(a) - priority(b) || a.localeCompare(b, 'en'))) {
    const bytes = upstream(path);
    const verdict = staticVerdict(bytes, path, new Set(paths));
    const reason = existing.has(hash(bytes)) || existing.has(hash(stripTerminalNewline(bytes))) ? 'already-in-corpus-or-earlier-candidate' : verdict.reason;
    candidates.push({ path, sha256: hash(bytes), bytes: bytes.length, reason, verdict });
    existing.add(hash(bytes)); existing.add(hash(stripTerminalNewline(bytes)));
  }
  await writeFile(`${ROOT}/survey.json`, JSON.stringify({ revision: REVISION, scope: 'selectedFamily; application then AC/noise then device paths, en order within priority. First 24 ngspice successes. Remaining candidates deferred; spice-ts never consulted.', candidates }, null, 2) + '\n');
  const source = { key: 'xyce', repository, revision: REVISION, license: 'GPL-3.0-or-later', licenseUrl: `${repository}/blob/${REVISION}/README.md`, licensePath: `${ROOT}/licenses/xyce/README.md`, licenseTextPath: `${ROOT}/licenses/xyce/COPYING`, basis: 'Repository README grants GPL version 3 or later; standalone decks with separate notices excluded by unchanged staticVerdict. Independent benchmark data, not package code.' };
  await mkdir(`${ROOT}/licenses/xyce`, { recursive: true });
  await writeFile(source.licensePath, upstream('README.md'));
  // Upstream README links a missing COPYING; retain the full GPL text already vendored by corpus-n.
  await writeFile(source.licenseTextPath, await readFile('benchmarks/corpus/corpus-n/licenses/xyce/GPL-3.0.txt'));
  const sources = [{ ...source, licenseSha256: hash(await readFile(source.licensePath)), licenseTextSha256: hash(await readFile(source.licenseTextPath)) }];
  const circuits = [];
  const probes = [];
  for (const candidate of candidates.filter(c => c.reason === null)) {
    const output = resolve(process.env.TMPDIR ?? '.', 'corpus-o-probe.json');
    const start = performance.now();
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--probe', candidate.path, output], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const probe = child.status === 0 ? JSON.parse(await readFile(output, 'utf8')) : { status: 'failed', firstErrorLine: child.error?.message ?? child.stderr.slice(-1000), analyses: [] };
    probes.push({ sourcePath: candidate.path, sha256: candidate.sha256, wallMs: performance.now() - start, ...probe });
    await writeFile(`${ROOT}/probe.json`, JSON.stringify({ revision: REVISION, probes }, null, 2) + '\n');
    console.log(`${candidate.path}: ${probe.status}`);
    if (probe.status !== 'success') continue;
    if (candidate.verdict.reason !== null) throw new Error('static rejection');
    const sourcePath = `xyce/${candidate.path}`;
    const localPath = `${ROOT}/fixtures/${sourcePath}`;
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, upstream(candidate.path));
    circuits.push({ id: `o-${circuits.length + 1}`, source: 'xyce', upstreamPath: candidate.path, sourcePath, sourceUrl: `${repository}/blob/${REVISION}/${candidate.path}`, revision: REVISION, licence: source.license, localPath, sha256: candidate.sha256, bytes: candidate.bytes, analyses: candidate.verdict.analyses, unmappedAnalyses: candidate.verdict.unmappedAnalyses, sameNameAs: [], includeClosure: [] });
    if (circuits.length === 24) break;
  }
  await writeFile(`${ROOT}/manifest.json`, JSON.stringify({ mechanicalAdaptation: 'none', sources, circuits }, null, 2) + '\n');
  console.log(`selected ${circuits.length} of ${candidates.length} candidates; probed ${probes.length}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
