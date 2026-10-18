import { readFile, writeFile } from 'node:fs/promises';
import { ROOT } from './ingest.js';
async function main() {
const manifest = JSON.parse(await readFile(`${ROOT}/manifest.json`, 'utf8'));
const probe = JSON.parse(await readFile(`${ROOT}/probe.json`, 'utf8'));
const source = manifest.sources[0];
const table = '| Deck | Pinned source URL | SPDX licence | SHA-256 |\n|---|---|---|---|\n' + manifest.circuits.map((c: { id: string; sourceUrl: string; licence: string; sha256: string }) => `| ${c.id} | ${c.sourceUrl} | ${c.licence} | ${c.sha256} |`).join('\n') + '\n';
const section = '\n## corpus-o: Xyce analog/device regression inputs (#1045)\n\n'
  + `Pinned Xyce_Regression revision: \`${source.revision}\`. ${manifest.circuits.length} original, unadapted decks; both engines receive identical bytes. ${source.basis}\n\n`
  + `Licence grant: ${source.licenseUrl} (SHA-256 \`${source.licenseSha256}\`); retained unchanged in \`${source.licensePath}\`. Full GPL-3.0 text retained in \`${source.licenseTextPath}\` (SHA-256 \`${source.licenseTextSha256}\`), copied unchanged from corpus-n because upstream links a missing COPYING. GPL applies to these independent benchmark inputs, not simulator package code.\n\n`
  + table;
const exclusions = probe.probes.filter((p: { status: string }) => p.status !== 'success');
await writeFile(`${ROOT}/SOURCES.md`, '# corpus-o provenance and selection\n' + section
  + '\n## Reproduction and selection\n\n'
  + 'Clone https://github.com/Xyce/Xyce_Regression and set CORPUS_O_UPSTREAM to that checkout. Run `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-o/ingest.ts`, then `pnpm exec tsx benchmarks/corpus/corpus-o/provenance.ts`, then `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-o/parity.ts`. The generator appends the root source section once. Verification: `pnpm exec tsx --test benchmarks/corpus/corpus-o/corpus-o.test.ts`.\n\n'
  + 'Scope/order are fixed in ingest.ts: SANDLER/TL431/MCNC BJT applications first, AC/noise second, then diode/BJT/switch families in en path order. Shared corpus-h staticVerdict excludes separate licence notices, dependencies, host commands and decks without analyses. SHA-256 dedupe covers every other benchmarks/corpus directory (including terminal-newline-normalised hashes) and earlier candidates. survey.json retains every candidate and static exclusion. probe.json retains every eligible ngspice attempt. Stop at 24 reference successes, or exhaust eligible candidates: this batch exhausts them with 23 successes. No spice-ts execution informed selection. Attempted AC and switch decks did not yield an ngspice reference and are explicitly excluded below, not adapted. No simulator code changes; this is a new baseline, not a speed improvement.\n\n'
  + '## Excluded after ngspice-47 probe\n\n| Path | Status | Reason |\n|---|---|---|\n'
  + exclusions.map((p: { sourcePath: string; status: string; firstErrorLine: string }) => `| ${p.sourcePath} | ${p.status} | ${p.firstErrorLine?.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`).join('\n')
  + '\n\n## Failure and measurement issues\n\n'
  + '- MOS2 noise (o-5): https://github.com/mfiumara/spice-ts/issues/1314\n'
  + '- MOS3 noise (o-6): https://github.com/mfiumara/spice-ts/issues/1315\n'
  + '- MOS9 noise (o-3): https://github.com/mfiumara/spice-ts/issues/1316\n'
  + '- Control-noise export/pairing (o-1, o-10): https://github.com/mfiumara/spice-ts/issues/1317\n'
  + '- Large diode-reference metric deadline: https://github.com/mfiumara/spice-ts/issues/1318\n\n'
  + 'The metric itself is unchanged. Every comparison runs in a uniform 119 s owned process group; expiry preserves the real engine statuses, publishes measurementError, null metrics and not-compared. This is incomplete measurement, not evidence of parity. The initial in-parent corpus-n-style comparison stalled on the 10,000,008-point o-19 reference for over nine minutes; no circuit was dropped. A terminal transport timeout then interrupted the bounded run after o-19. The published run resumes that verified 19-row checkpoint with `--resume <original-core-tree>` (fixture-prefix hashes checked), with no core, fixture or metric changes. Resume requires an explicitly supplied original core tree; it is a local recovery feature, not automatic evidence reuse. Full regeneration without --resume is the canonical command.\n');
const global = await readFile('benchmarks/SOURCES.md', 'utf8');
if (!global.includes('## corpus-o: Xyce analog/device regression inputs (#1045)')) await writeFile('benchmarks/SOURCES.md', global + section);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
