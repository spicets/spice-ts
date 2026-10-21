#!/usr/bin/env tsx
/**
 * Corpus-f identical-input outcome report (#484): every committed deck runs unchanged through
 * ngspice-47 and spice-ts; the per-fixture outcome table is published in README.md, losses included.
 *
 * Usage (from the repository root, after `pnpm build`):
 *   pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts            # regenerate outcomes.json + README.md
 *   pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --check    # rerun and compare, write nothing
 *   pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --jobs 4   # parallel fixtures (default 6)
 *   pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --relabel  # recompute buckets/issue links only
 *   pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --fine-reference [--accept-drift]  # add the #592 column to committed transient rows
 *
 * Each fixture runs in its own child process; ngspice and spice-ts each have a 120 s bound.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { SPICE_TS_TIMEOUT_MS } from '../../aggregate-report.js';
import { type FineReference, FINE_REFERENCE_RULE, FINE_REFERENCE_TIMEOUT_MS, fineReferenceColumn, fineReferenceSection } from '../../fine-reference.js';
import {
  analysisType,
  type ClassicAnalysisType,
  type ClassicCircuit,
  type EngineExecution,
} from '../classic/report.js';
import type { CorpusFCircuit, CorpusFManifest } from './ingest.js';
import {
  asPacked,
  compareInBatches,
  defaultBatchSamples,
  lazyExecution,
  PACKED_SAMPLES,
  type PackedAnalysis,
  packEncoded,
  type PackedExecution,
  unpackExecution,
} from './packed.js';
import { batchControlPlots, runCorpusFSpiceTs } from './plot-adapter.js';
import { readNgspiceRawFilePacked } from './raw-stream.js';
import { declaredSecondaryGrid } from '../../sweep-coordinates.js';
import {
  classifyNgspiceFailure,
  CONTROL_SECTION,
  CORPUS_ROOT,
  type EngineStatus,
  firstNgspiceErrorLine,
  firstSpiceTsErrorLine,
  gapBucket,
  MATCH_THRESHOLD,
  NGSPICE_ABSTOL,
  NGSPICE_VNTOL,
  normalizedSignalErrors,
  pairedReferenceSeries,
  type Outcome,
  outcome,
  CURRENT_PEAK_FLOOR,
  PEAK_FLOOR,
  scrub,
  sig3,
  scoredPlotTypes,
  VOLTAGE_PEAK_FLOOR,
} from './lib.js';

/** The published match rule: the per-quantity peak floor (#593) applied by normalizedSignalErrors. Shared with corpus-g. */
export const MATCH_RULE = `matched = both engines succeed, every spice-ts analysis has an ngspice counterpart, and for every common signal max|spice-ts - ngspice| <= ${MATCH_THRESHOLD} x max(peak |ngspice signal|, floor). The floor is uniform per quantity (#593): ${VOLTAGE_PEAK_FLOOR} V for node voltages v(...) and ${CURRENT_PEAK_FLOOR} A for branch currents i(...), so a signal whose ngspice peak is zero or tiny matches when the absolute difference is at most the ngspice-47 default VNTOL (${NGSPICE_VNTOL} V) or ABSTOL (${NGSPICE_ABSTOL} A); every other quantity (pole/zero roots, noise spectra) keeps ${PEAK_FLOOR}. Deck .options tolerances are not consulted. Errors are taken at spice-ts points with ngspice interpolated (transient breakpoint alignment as in the aggregate report).`;

export const REPORT_SCHEMA = 'spice-ts-corpus-f-outcomes/v1' as const;
const MANIFEST_PATH = resolve(CORPUS_ROOT, 'manifest.json');
const JSON_PATH = resolve(CORPUS_ROOT, 'outcomes.json');
const MARKDOWN_PATH = resolve(CORPUS_ROOT, 'README.md');
/** Some CIDER decks need about 115 s alone in ngspice-47, so its bound is wider than spice-ts's 120 s. */
const NGSPICE_TIMEOUT_MS = 600_000;
/** Per-fixture child bound: both default runs, the fine-reference ngspice run (#592) and slack. */
export const FIXTURE_CHILD_TIMEOUT_MS = NGSPICE_TIMEOUT_MS + SPICE_TS_TIMEOUT_MS + FINE_REFERENCE_TIMEOUT_MS + 60_000;
const CHILD_FLAG = '--corpus-f-fixture-child';
const SPICE_TS_CHILD_FLAG = '--corpus-f-spice-ts-child';

export interface EngineOutcome {
  status: EngineStatus;
  /** Analyses produced, as `type:points`. */
  analyses: string[];
  firstErrorLine?: string;
  /** Why a successful engine run has nothing to compare. */
  note?: string;
}

export const CONTROL_ONLY_NOTE = 'ran its .control block (analyses run from .control, or the block ends with quit), so -r exported no vectors to compare';

export interface FixtureOutcome {
  id: string;
  sourcePath: string;
  sha256: string;
  analyses: string[];
  unmappedAnalyses: string[];
  /** Fixtures of other public corpora with the same file name (upstream variants, different bytes). */
  sameNameAs: string[];
  ngspice: EngineOutcome;
  spiceTs: EngineOutcome;
  comparedAnalyses: number;
  comparedSignals: number;
  /** Worst absolute error divided by the ngspice peak of that signal, 3 significant digits. */
  worstNormalizedError: number | null;
  worstSignal: string | null;
  outcome: Outcome;
  gapBucket: string | null;
  /**
   * Diagnostic fine-step reference column (#592), present when the headline comparison includes a
   * transient. It never changes `outcome`, which the headline column alone defines.
   */
  fineReference?: FineReference;
}

export interface CorpusFReport {
  schemaVersion: typeof REPORT_SCHEMA;
  outcomeSha256: string;
  source: { revision: string; license: string; manifestSha256: string };
  tools: { ngspice: string; spiceTs: string; node: string };
  environment: { platform: string; release: string; arch: string; cpu: string };
  commands: { generate: string; verify: string; ngspice: string; spiceTs: string };
  policy: {
    input: 'byte-identical fixture for both engines';
    fixtureAdaptation: 'none';
    perCircuitToleranceTuning: false;
    matchThreshold: number;
    matchRule: string;
    /** Absent before #592. */
    fineReference?: string;
    deterministicHashExcludes: ['environment', 'tools.node', 'ngspice.analyses', 'spiceTs.analyses'];
  };
  totals: {
    fixtures: number;
    ngspice: Record<EngineStatus, number>;
    spiceTs: Record<EngineStatus, number>;
    outcomes: Record<Outcome, number>;
  };
  gapBuckets: Array<{ bucket: string; fixtures: number; ngspiceSuccess: number; ids: string[]; issue: string | null }>;
  fixtures: FixtureOutcome[];
}

/**
 * Gap issues for this batch, filed after searching open and closed issues for duplicates
 * (`.temp` joins the existing #459). Keys are gap buckets; buckets where ngspice also fails every
 * fixture get no issue.
 */
export const GAP_ISSUES: Record<string, string> = {
  "device: XSPICE A-element code models": 'https://github.com/mfiumara/spice-ts/issues/487',
  "control: ngspice control-language scripting (set/let/save/foreach/meas/...)": 'https://github.com/mfiumara/spice-ts/issues/488',
  "control: analysis commands inside .control (tran/dc/op/ac/...)": 'https://github.com/mfiumara/spice-ts/issues/489',
  "device: Q/D instance forms (AREA=/M= keywords, thermal nodes, VBIC PNP)": 'https://github.com/mfiumara/spice-ts/issues/490',
  "device: P/Y-element lossy multiconductor lines (CPL, TXL)": 'https://github.com/mfiumara/spice-ts/issues/491',
  "source: parenthesised and extended waveform syntax": 'https://github.com/mfiumara/spice-ts/issues/492',
  "expression: quoted/brace expressions in values (TEMPER, functions)": 'https://github.com/mfiumara/spice-ts/issues/493',
  "directive: other .options fields (noinit, bypass, warn, ramptime, seedinfo)": 'https://github.com/mfiumara/spice-ts/issues/494',
  "expression: B-source V= and expression functions/operators": 'https://github.com/mfiumara/spice-ts/issues/495',
  "directive: numparam extensions (.func, .csparam, .if, string/vector .param)": 'https://github.com/mfiumara/spice-ts/issues/496',
  "model: CIDER numerical device models (NUMD/NUMOS/NBJT)": 'https://github.com/mfiumara/spice-ts/issues/497',
  "device: R-card forms (r=, ac=, noisy=, resistor models)": 'https://github.com/mfiumara/spice-ts/issues/498',
  "source: RF port sources (portnum/z0)": 'https://github.com/mfiumara/spice-ts/issues/499',
  "model: MESFET/HFET levels and parameters (NMF/NHFET, Z-card)": 'https://github.com/mfiumara/spice-ts/issues/500',
  "source: TRNOISE/EXTERNAL waveforms": 'https://github.com/mfiumara/spice-ts/issues/501',
  "directive: .global": 'https://github.com/mfiumara/spice-ts/issues/502',
  "model: VERSION= strings on BSIM model cards": 'https://github.com/mfiumara/spice-ts/issues/503',
  "model: BSIM3 revisions other than 3.3 (VERSION=3.0/3.1/3.2.x)": 'https://github.com/mfiumara/spice-ts/issues/594',
  "model: BSIM3 non-quasi-static model (NQSMOD=1)": 'https://github.com/mfiumara/spice-ts/issues/692',
  "model: BSIM4 (LEVEL=14/54)": 'https://github.com/mfiumara/spice-ts/issues/3',
  "analysis: .pz beyond ideal R, L, C": 'https://github.com/mfiumara/spice-ts/issues/504',
  "directive: .measure": 'https://github.com/mfiumara/spice-ts/issues/505',
  "model: VDMOS power MOSFET": 'https://github.com/mfiumara/spice-ts/issues/506',
  "device: S/W-element switches": 'https://github.com/mfiumara/spice-ts/issues/507',
  "syntax: µ (micro sign) scale suffix": 'https://github.com/mfiumara/spice-ts/issues/508',
  "directive: .temp / .options temp": 'https://github.com/mfiumara/spice-ts/issues/459',
};

export const HARNESS_ISSUE = 'https://github.com/mfiumara/spice-ts/issues/528';

/** Findings beyond the gap buckets: correctness bugs and harness defects exposed by this batch. */
export const FOLLOW_UP_ISSUES: ReadonlyArray<{ url: string; scope: string }> = [
  { url: 'https://github.com/mfiumara/spice-ts/issues/509', scope: 'a .model VDMOS card is silently dropped and the M device simulates with no model (examples/vdmos/vdmosp-out.sp mismatch, 9e75 A vs 14.44 A)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/510', scope: 'parse() rejects .param decks that simulate() accepts; the shared corpus adapter reports parse()\'s error (corpus-f calls simulate() only)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/511', scope: 'triage of the 10 ngspice-successful decks that exceed the 1% parity threshold' },
  { url: HARNESS_ISSUE, scope: 'the ngspice harness exports no vectors for decks that run analyses from .control or quit inside it' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/590', scope: 'closed by #601: MOS1 depletion junction capacitance (tests/general/mosmem.cir now matches; #511 triage in TRIAGE-511.md)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/591', scope: 'closed by #601: MOS1 Meyer gate capacitance from TOX; residual i(vs) mismatch is grid discretisation per #627/#629, routed to #592' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/626', scope: 'BSIM3 4-bit NAND adder (examples/snapshot/adder_mos_circ.cir): internal-node mismatch 1.54 after #624/#648; root cause not established (#511 triage)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/655', scope: 'TRNOISE/TRRANDOM decks compare independent random realisations; ngspice-47 reseeds each run, so these values are not reproducible (transient-noise simple-noise, rts-1)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/592', scope: 'metric: ngspice\'s coarse default-step output is scored as spice-ts error (rca3040, switches-manual-p92; rtlinv, mos-test, fourbitadder and ltra2_2_line match after the #689 step-control merge; #511 triage). The headline metric is unchanged; the transient fine-step reference section at the end of this table publishes both default runs against one ngspice fine-TMAX reference per deck' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/593', scope: 'metric: zero/near-zero ngspice peaks turned fV-uV residuals into mismatches; fixed by the per-quantity VNTOL/ABSTOL peak floor in the match rule above (rca3040 AC v(2) now 5.64e-10; #511 triage)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/698', scope: 'closed: fourbitadder TTL internal nodes kept 1-7 uV residuals above the VNTOL floor (split from #593); bisected to transient step control, not the BJT model: #689 (ngspice CKTtrunc) and #758 (dctran first step and order) bring the uV-level nodes within 0.15 uV at default steps and every signal within 50 nV at TMAX 10 ps (regression guard in triage-511.test.ts)' },
];

const OUTCOMES: Outcome[] = ['matched', 'mismatch', 'not-compared', 'spice-ts-loss', 'ngspice-failed', 'both-failed'];
const STATUSES: EngineStatus[] = ['success', 'failed', 'unsupported'];

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asClassic(circuit: CorpusFCircuit): ClassicCircuit {
  return {
    id: circuit.id,
    category: 'corpus-f',
    analyses: circuit.analyses as ClassicAnalysisType[],
    sourcePath: circuit.sourcePath,
    sourceUrl: circuit.sourceUrl,
    localPath: circuit.localPath,
    sha256: circuit.sha256,
    ngspice: { expectedStatus: 'pass' },
    spiceTs: { expectedStatus: 'pass' },
  };
}

export { packExecution, unpackExecution } from './packed.js';

/** A reference run: ngspice's execution (either sample form) with its status and first error line. */
export interface ReferenceRun<E = EngineExecution> {
  execution: E;
  firstErrorLine?: string;
  note?: string;
  status: EngineStatus;
}

/** ngspice-47 batch run on the identical bytes, with per-sample objects (see {@link runNgspicePacked}). */
export async function runNgspice(input: Buffer, circuit: CorpusFCircuit): Promise<ReferenceRun> {
  const run = await runNgspicePacked(input, circuit);
  return { ...run, execution: unpackExecution(run.execution) };
}

/**
 * ngspice-47 batch run on the identical bytes; keeps its own output for the first error line. The
 * raw file is streamed into packed columns (#839), keeping only the signals `select` accepts
 * (every signal without it): the metric scores common signals only, so dropping the others
 * changes no outcome.
 */
export async function runNgspicePacked(input: Buffer, circuit: CorpusFCircuit, select?: ReferenceSelection): Promise<ReferenceRun<PackedExecution>> {
  // SP and op-only control plots are not exported by batch -r. Reuse the
  // unchanged-deck wrapper and retain their real plot IDs for standard pairing.
  const opOnly = circuit.analyses.length === 1 && circuit.analyses[0] === 'op'
    && (circuit.unmappedAnalyses ?? []).length === 0;
  if ((circuit.analyses.includes('sp') || opOnly) && /^\s*\.control\b/im.test(input.toString('utf8').split(/\r?\n/).slice(1).join('\n'))) {
    const { runControlReference } = await import('./control-vectors.js');
    const run = await runControlReference(input, circuit, select);
    return { ...run, execution: asPacked(run.execution) };
  }
  const directory = await mkdtemp(resolve(tmpdir(), 'spice-ts-corpus-f-'));
  const netlistPath = resolve(directory, basename(circuit.localPath));
  const rawPath = resolve(directory, 'output.raw');
  try {
    await writeFile(netlistPath, input);
    await writeFile(resolve(directory, '.spiceinit'), 'set filetype=ascii\n');
    const completed = spawnSync('ngspice', ['-b', '-r', basename(rawPath), basename(netlistPath)], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, HOME: directory },
      timeout: NGSPICE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${completed.stdout ?? ''}\n${completed.stderr ?? ''}`;
    const errorLine = firstNgspiceErrorLine(output, directory);
    const failed = (status: EngineStatus, line: string | undefined) => ({
      execution: { status: 'failed' as const, convergence: 'failed' as const, analyses: [], error: line },
      firstErrorLine: line,
      status,
    });
    if ((completed.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      return failed('failed', `ngspice exceeded the ${NGSPICE_TIMEOUT_MS} ms bound`);
    }
    if (completed.error) return failed('failed', scrub(completed.error.message, directory));
    if (completed.status !== 0) {
      return failed(classifyNgspiceFailure(output), errorLine ?? `ngspice exited ${completed.status ?? completed.signal}`);
    }
    const keep = select && ((plotName: string, signal: string) => {
      const type = analysisType(plotName);
      return type !== null && select(type, signal);
    });
    let plots: Awaited<ReturnType<typeof readNgspiceRawFilePacked>> = [];
    try { plots = await readNgspiceRawFilePacked(rawPath, keep); } catch { plots = []; }
    const analyses = plots.flatMap((plot): PackedAnalysis[] => {
      const type = analysisType(plot.plotName);
      const secondaryGrid = type === 'dc' ? declaredSecondaryGrid(input.toString('utf8'), plot.plotName, plot.grid, 'batch-dot') : undefined;
      return type ? [{ type, plotName: plot.plotName, grid: Float64Array.from(plot.grid), signals: plot.signals, ...(secondaryGrid ? { secondaryGrid: Float64Array.from(secondaryGrid) } : {}) }] : [];
    });
    // -r does not export analyses run inside .control. Reuse the control-vector wrapper
    // on identical bytes, not wrdata expressions (which may square-root the spectra).
    // Retain noise, S-parameter and sensitivity control plots, with packed, selected columns.
    let exportNote: string | undefined;
    const exportTypes = [
      ...(/^\s*noise\s+/im.test(input.toString('utf8')) ? ['noise' as const] : []),
      ...(circuit.analyses.includes('sp') ? ['sp' as const] : []),
      ...(circuit.analyses.includes('sens') ? ['sens' as const] : []),
    ];
    if (analyses.length === 0 && !errorLine && exportTypes.length > 0
      && /^\s*\.control\b/im.test(input.toString('utf8'))) {
      const { controlWrapperDeck, controlExportDiagnostics } = await import('./control-vectors.js');
      await writeFile(resolve(directory, 'fixture.cir'), input);
      await writeFile(resolve(directory, 'wrapper.cir'), controlWrapperDeck(exportTypes));
      const exported = spawnSync('ngspice', ['-b', 'wrapper.cir'], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, HOME: directory },
        timeout: NGSPICE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
      });
      const diagnostics = await controlExportDiagnostics(directory, `${exported.stdout ?? ''}\n${exported.stderr ?? ''}`);
      const exportOutput = diagnostics.output;
      exportNote = diagnostics.note;
      const exportError = firstNgspiceErrorLine(exportOutput, directory);
      if (exported.error || exported.status !== 0 || exportError) {
        return { ...failed(classifyNgspiceFailure(exportOutput),
          scrub(exported.error?.message ?? exportError ?? `ngspice export exited ${exported.status}`, directory)),
          ...(exportNote ? { note: exportNote } : {}) };
      }
      const files = (await readdir(directory)).filter(name => /^(?:noise|sp|sens)\d+\.raw$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
      for (const file of files) {
        const retained = await readNgspiceRawFilePacked(resolve(directory, file), keep);
        for (const plot of retained) {
          const type = analysisType(plot.plotName);
          if (type !== 'noise' && type !== 'sp' && type !== 'sens') continue;
          analyses.push({ type, plotName: plot.plotName, plotId: file.replace(/\.raw$/, ''),
            grid: Float64Array.from(plot.grid), signals: plot.signals });
        }
      }
    }
    if (analyses.length === 0 && !errorLine && /^\s*\.control\b/im.test(input.toString('utf8'))) {
      return { execution: { status: 'success', convergence: 'converged', analyses: [] }, status: 'success', note: CONTROL_ONLY_NOTE };
    }
    if (analyses.length === 0) {
      return failed(errorLine ? classifyNgspiceFailure(output) : 'failed', errorLine ?? 'no raw analysis data produced');
    }
    return { execution: { status: 'success', convergence: 'converged', analyses }, status: 'success', ...(exportNote ? { note: exportNote } : {}) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * spice-ts on the identical bytes in a bounded child process (same 120 s bound as the aggregate
 * report). Calls `simulate()` only: unlike the aggregate adapter it skips the `parse()` pre-check,
 * which rejects `.param` decks that `simulate()` accepts, so the published error is simulate()'s.
 */
export async function runBoundedSimulate(input: Buffer, circuit: ClassicCircuit): Promise<EngineExecution> {
  return unpackExecution(await runBoundedSimulatePacked(input, circuit));
}

/**
 * {@link runBoundedSimulate} without per-sample objects: the child packs every signal into
 * Float64Arrays as it maps the simulate() result, and they stay packed (#839).
 */
export async function runBoundedSimulatePacked(input: Buffer, circuit: ClassicCircuit): Promise<PackedExecution> {
  const directory = await mkdtemp(resolve(tmpdir(), 'spice-ts-corpus-f-ts-'));
  const inputPath = resolve(directory, 'fixture.cir');
  const circuitPath = resolve(directory, 'circuit.json');
  const outputPath = resolve(directory, 'execution.v8');
  try {
    await writeFile(inputPath, input);
    await writeFile(circuitPath, JSON.stringify(circuit));
    const completed = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), SPICE_TS_CHILD_FLAG, inputPath, circuitPath, outputPath],
      { cwd: process.cwd(), encoding: 'utf8', timeout: SPICE_TS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
    );
    if (completed.error || completed.status !== 0) {
      const timedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      const detail = timedOut
        ? `spice-ts exceeded the ${SPICE_TS_TIMEOUT_MS} ms aggregate execution bound`
        : completed.error?.message || [completed.stderr, completed.stdout].filter(Boolean).join('\n').trim()
          || `spice-ts child exited ${completed.status}`;
      return { status: 'failed', convergence: timedOut ? 'failed' : 'not-run', analyses: [], error: detail.slice(0, 1000) };
    }
    return deserialize(await readFile(outputPath)) as PackedExecution;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function producedAnalyses(execution: PackedExecution): string[] {
  return execution.analyses.map(analysis => `${analysis.type}:${analysis.grid.length}`).sort();
}

/** Which ngspice reference signals can be scored: exactly those spice-ts produced, per plot type. */
export type ReferenceSelection = (type: string, signal: string) => boolean;

/**
 * Every signal spice-ts produced, per plot type. A type can have several plots (noise: spectrum
 * and integrated) and compareExecutions may pair any of them, so the selection is their union.
 */
export function referenceSelection(execution: Pick<EngineExecution, 'analyses'>): ReferenceSelection {
  const produced = new Map<string, Set<string>>();
  for (const analysis of execution.analyses) {
    const signals = produced.get(analysis.type) ?? new Set<string>();
    for (const signal of Object.keys(analysis.series.signals)) signals.add(signal);
    produced.set(analysis.type, signals);
  }
  return (type, signal) => produced.get(type)?.has(signal) ?? false;
}

/**
 * Runs one fixture through both engines and reduces it to its published outcome. With the default
 * ngspice reference, a fixture whose headline comparison includes a transient also gets the
 * fine-step reference column (#592); a custom reference (the control-vector supplement) does not.
 */
export async function runFixture(
  circuit: CorpusFCircuit,
  reference: (input: Buffer, circuit: CorpusFCircuit, select: ReferenceSelection) => Promise<ReferenceRun<EngineExecution | PackedExecution>> = runNgspicePacked,
  options: { fineReference?: boolean } = {},
): Promise<FixtureOutcome> {
  // The ingestion manifest preserves the historical batch-only classification.
  // Promote SP at execution time now that both adapters compare complex vectors.
  if (scoredPlotTypes(circuit).includes('sp')) {
    circuit = {
      ...circuit,
      analyses: [...new Set([...circuit.analyses, 'sp'])],
      unmappedAnalyses: circuit.unmappedAnalyses.filter(type => type !== 'sp'),
    };
  }
  const input = await readFile(resolve(circuit.localPath));
  if (sha256(input) !== circuit.sha256) throw new Error(`${circuit.id}: fixture SHA-256 mismatch`);
  // Older manifests predate batch S-parameter/sensitivity support. Promote declarations without
  // rewriting the ingested corpus identity or changing the bytes sent to either engine.
  circuit = {
    ...circuit,
    analyses: [...new Set([...circuit.analyses, ...circuit.unmappedAnalyses.filter(type => type === 'sp' || type === 'sens')])],
    unmappedAnalyses: circuit.unmappedAnalyses.filter(type => type !== 'sp' && type !== 'sens'),
  };
  // spice-ts runs first so a reference reader may keep only the signals that can be compared
  // (#694): compareExecutions scores common signals only, so the outcome is the same either way.
  // Both engines stay packed; the metric sees per-sample objects one bounded batch at a time (#839).
  const spiceTs = { execution: await runBoundedSimulatePacked(input, asClassic(circuit)) };
  let spiceTsView = lazyExecution(spiceTs.execution);
  const ngspice = await reference(input, circuit, referenceSelection(spiceTsView));
  const ngspiceExecution = asPacked(ngspice.execution);
  let comparisonExecution = spiceTs.execution;
  if (reference === runNgspicePacked) {
    const paired = batchControlPlots(input.toString('utf8'), spiceTs.execution.analyses, ngspiceExecution.analyses);
    comparisonExecution = { ...spiceTs.execution, analyses: paired.candidate };
    ngspiceExecution.analyses = paired.reference;
    spiceTsView = lazyExecution(comparisonExecution);
  }
  const spiceTsStatus: EngineStatus = spiceTs.execution.status;
  const comparisons = ngspice.status === 'success' && spiceTsStatus === 'success'
    ? compareInBatches(comparisonExecution, ngspiceExecution)
    : [];
  const { errors, missing } = normalizedSignalErrors(comparisons, pairedReferenceSeries(spiceTsView, lazyExecution(ngspiceExecution)));
  const worst = errors.reduce<typeof errors[number] | null>((current, error) =>
    current === null || error.normalized > current.normalized ? error : current, null);
  const spiceTsError = firstSpiceTsErrorLine(spiceTs.execution.error);
  const result: FixtureOutcome = {
    id: circuit.id,
    sourcePath: circuit.sourcePath,
    sha256: circuit.sha256,
    analyses: circuit.analyses,
    unmappedAnalyses: circuit.unmappedAnalyses,
    sameNameAs: circuit.sameNameAs,
    ngspice: { status: ngspice.status, analyses: producedAnalyses(ngspiceExecution) },
    spiceTs: { status: spiceTsStatus, analyses: producedAnalyses(spiceTs.execution) },
    comparedAnalyses: comparisons.length,
    comparedSignals: errors.length,
    worstNormalizedError: worst ? sig3(worst.normalized) : null,
    worstSignal: worst ? `${worst.analysis} ${worst.signal}` : null,
    outcome: outcome({
      ngspice: ngspice.status,
      spiceTs: spiceTsStatus,
      comparedAnalyses: comparisons.length,
      spiceTsAnalyses: new Set(spiceTs.execution.analyses.map(analysis => analysis.type)).size,
      worstNormalized: worst ? worst.normalized : null,
      missingSignals: missing,
    }),
    gapBucket: gapBucket(spiceTsError, spiceTsStatus) ?? null,
  };
  if (ngspice.firstErrorLine) result.ngspice.firstErrorLine = ngspice.firstErrorLine;
  if (ngspice.note) result.ngspice.note = ngspice.note;
  if (spiceTsError) result.spiceTs.firstErrorLine = spiceTsError;
  const defaultReference = reference === runNgspicePacked || reference === runNgspice;
  if ((options.fineReference ?? defaultReference) && comparisons.some(comparison => comparison.analysis === 'tran')) {
    // Lazy views: the fine column reads the default runs signal by signal, like the headline (#839).
    result.fineReference = await fineReferenceColumn({
      deck: input.toString('utf8'),
      fileName: basename(circuit.localPath),
      spiceTs: spiceTsView,
      ngspice: lazyExecution(ngspiceExecution),
      headline: comparisons,
      budget: defaultBatchSamples(),
    });
  }
  return result;
}

function runChild(id: string, timeoutMs: number): Promise<FixtureOutcome | { id: string; error: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), CHILD_FLAG, id], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').at(-1) ?? '';
      try {
        resolvePromise(JSON.parse(line) as FixtureOutcome);
      } catch {
        resolvePromise({ id, error: `fixture child exited ${code}: ${scrub(stderr || stdout)}` });
      }
    });
  });
}

function commandVersion(command: string, args: string[], pattern: RegExp): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return 'unavailable';
  return pattern.exec(`${result.stdout}\n${result.stderr}`)?.[0] ?? 'unknown';
}

/**
 * The outcome hash covers statuses, error lines, comparisons and buckets. It excludes the
 * environment and the per-engine analysis point counts: ngspice-47's transient-noise (TRNOISE RTS)
 * and Monte-Carlo decks produce a different number of time points on every run, even at the
 * default seed, so point counts are published but not hashed.
 */
function deterministicView(report: Omit<CorpusFReport, 'outcomeSha256'> | CorpusFReport): unknown {
  return JSON.parse(JSON.stringify(report, function (this: Record<string, unknown>, key: string, value: unknown) {
    if (key === 'outcomeSha256' || key === 'environment' || key === 'node') return undefined;
    if (key === 'analyses' && this !== null && typeof this === 'object' && 'status' in this) return undefined;
    return value;
  }));
}

export function outcomeDigest(report: Omit<CorpusFReport, 'outcomeSha256'> | CorpusFReport): string {
  return sha256(JSON.stringify(deterministicView(report)));
}

export function summarize(fixtures: FixtureOutcome[]): Pick<CorpusFReport, 'totals' | 'gapBuckets'> {
  const count = <T extends string>(keys: T[], pick: (fixture: FixtureOutcome) => T): Record<T, number> =>
    Object.fromEntries(keys.map(key => [key, fixtures.filter(fixture => pick(fixture) === key).length])) as Record<T, number>;
  const buckets = new Map<string, FixtureOutcome[]>();
  for (const fixture of fixtures) {
    if (!fixture.gapBucket) continue;
    buckets.set(fixture.gapBucket, [...(buckets.get(fixture.gapBucket) ?? []), fixture]);
  }
  return {
    totals: {
      fixtures: fixtures.length,
      ngspice: count(STATUSES, fixture => fixture.ngspice.status),
      spiceTs: count(STATUSES, fixture => fixture.spiceTs.status),
      outcomes: count(OUTCOMES, fixture => fixture.outcome),
    },
    gapBuckets: [...buckets.entries()]
      .map(([bucket, members]) => ({
        bucket,
        fixtures: members.length,
        ngspiceSuccess: members.filter(member => member.ngspice.status === 'success').length,
        ids: members.map(member => member.id),
        issue: GAP_ISSUES[bucket] ?? null,
      }))
      .sort((left, right) => right.fixtures - left.fixtures || left.bucket.localeCompare(right.bucket)),
  };
}

export async function buildReport(manifest: CorpusFManifest, jobs: number, only?: Set<string>): Promise<CorpusFReport> {
  const circuits = manifest.circuits.filter(circuit => !only || only.has(circuit.id));
  const results = new Array<FixtureOutcome>(circuits.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < circuits.length) {
      const index = next;
      next += 1;
      const result = await runChild(circuits[index].id, FIXTURE_CHILD_TIMEOUT_MS);
      if ('error' in result && !('outcome' in result)) throw new Error(`${circuits[index].id}: ${result.error}`);
      results[index] = result as FixtureOutcome;
      done += 1;
      process.stderr.write(`corpus-f: ${done}/${circuits.length} ${circuits[index].id} ${results[index].outcome}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  const base: Omit<CorpusFReport, 'outcomeSha256'> = {
    schemaVersion: REPORT_SCHEMA,
    source: {
      revision: manifest.source.revision,
      license: manifest.source.license,
      manifestSha256: sha256(await readFile(MANIFEST_PATH)),
    },
    tools: {
      ngspice: commandVersion('ngspice', ['--version'], /ngspice-\d+(?:\.\d+)*/i),
      spiceTs: (JSON.parse(await readFile(resolve('packages/core/package.json'), 'utf8')) as { version: string }).version,
      node: process.version,
    },
    environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    commands: {
      generate: 'pnpm build && pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts',
      verify: 'pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --check',
      ngspice: 'ngspice -b -r <raw> <identical-fixture> (HOME=<tmp> with .spiceinit "set filetype=ascii")',
      spiceTs: '@spice-ts/core simulate(<identical-fixture>) in a bounded child process (no parse() pre-check)',
    },
    policy: {
      input: 'byte-identical fixture for both engines',
      fixtureAdaptation: 'none',
      perCircuitToleranceTuning: false,
      matchThreshold: MATCH_THRESHOLD,
      matchRule: MATCH_RULE,
      fineReference: FINE_REFERENCE_RULE,
      deterministicHashExcludes: ['environment', 'tools.node', 'ngspice.analyses', 'spiceTs.analyses'],
    },
    ...summarize(results),
    fixtures: results,
  };
  return { ...base, outcomeSha256: outcomeDigest(base) };
}

function cell(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/`/g, "'");
}

export function renderMarkdown(report: CorpusFReport): string {
  const { totals } = report;
  const ngspiceSuccess = report.fixtures.filter(fixture => fixture.ngspice.status === 'success');
  const lines = [
    '# corpus-f: ngspice examples and regression decks (batch 1, #484)',
    '',
    'Generated by `pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts`; do not edit by hand. Provenance, per-file licence and the exclusion list are in [SOURCES.md](SOURCES.md).',
    '',
    `Every deck below is byte-identical to ngspice \`${report.source.revision}\` (${report.source.license}) and runs unchanged through both engines. No fixture is edited and no tolerance is tuned per circuit. Every spice-ts failure is published as a loss.`,
    '',
    '## Totals',
    '',
    `- Fixtures: ${totals.fixtures}. Outcome SHA-256: \`${report.outcomeSha256}\`.`,
    `- ngspice (${report.tools.ngspice}): ${totals.ngspice.success} success, ${totals.ngspice.failed} failed, ${totals.ngspice.unsupported} unsupported.`,
    `- spice-ts (${report.tools.spiceTs}): ${totals.spiceTs.success} success, ${totals.spiceTs.failed} failed, ${totals.spiceTs.unsupported} unsupported.`,
    `- Outcomes: ${OUTCOMES.map(name => `${name} ${totals.outcomes[name]}`).join(', ')}.`,
    `- Of the ${ngspiceSuccess.length} decks ngspice runs successfully, spice-ts matches ${totals.outcomes.matched}, mismatches ${totals.outcomes.mismatch}, produces no comparable result for ${totals.outcomes['not-compared']} and fails ${totals.outcomes['spice-ts-loss']}. For ${ngspiceSuccess.filter(fixture => fixture.ngspice.note).length} of those ngspice successes the deck runs its analyses from \`.control\` (or its control block ends with \`quit\`), so \`ngspice -r\` exports no vectors: they cannot be compared even when spice-ts runs them (harness follow-up ${HARNESS_ISSUE}).`,
    '',
    '## Method',
    '',
    `- ngspice: \`${report.commands.ngspice}\`. Status success means exit 0 and at least one op/dc/ac/tran/pz/noise/disto plot in the raw file; failed/unsupported is classified from ngspice's own output.`,
    `- spice-ts: \`${report.commands.spiceTs}\`, through the same adapter as the aggregate parity report. A deck whose analyses spice-ts does not return is unsupported.`,
    `- ${report.policy.matchRule}`,
    '- SP declarations are promoted from the historical manifest at execution time (#1627). ngspice sources the byte-identical fixture through the control export wrapper and writes every retained plot by ID. Complex S/Y/Z vectors are compared directly (real and imaginary parts), with the same 1% metric and generic peak floor. Non-SP analysis detection is unchanged.',
    '- OP-only `.control` decks also use that unchanged-fixture export wrapper (#1652). Every retained OP plot is paired by plot ID and common vector name using the standard threshold and per-quantity floors. Decks that destroy their OP plots remain not-compared; mixed-analysis and non-control OP decks keep their existing reference path.',
    '- "worst" is that normalised error for the worst signal. ngspice-failed rows are not spice-ts losses but cannot be compared.',
    `- Bounds: ngspice ${NGSPICE_TIMEOUT_MS / 1000} s, spice-ts ${SPICE_TS_TIMEOUT_MS / 1000} s per fixture. The outcome hash excludes ${report.policy.deterministicHashExcludes.join(', ')}: ngspice's TRNOISE and Monte-Carlo decks change their time-point count from run to run even at the default seed.`,
    `- Regenerate: \`${report.commands.generate}\`; verify without writing: \`${report.commands.verify}\`.`,
    `- Machine: ${report.environment.platform} ${report.environment.release} ${report.environment.arch}, ${report.environment.cpu}; Node ${report.tools.node}.`,
    `- ${report.fixtures.filter(fixture => fixture.sameNameAs.length > 0).length} fixtures share a file name with a fixture of another public corpus; their bytes differ (ngspice-modified variants). They are marked † below so they are not read as independent evidence.`,
    '',
    '## Follow-up issues',
    '',
    ...FOLLOW_UP_ISSUES.map(issue => `- ${issue.url}: ${issue.scope}.`),
    '',
    '## spice-ts gap buckets',
    '',
    'Grouped from spice-ts\'s own first error line. "ngspice ok" counts the fixtures in the bucket that ngspice runs successfully.',
    '',
    '| Bucket | Fixtures | ngspice ok | Issue |',
    '|---|---|---|---|',
    ...report.gapBuckets.map(bucket => `| ${cell(bucket.bucket)} | ${bucket.fixtures} | ${bucket.ngspiceSuccess} | ${bucket.issue ?? (bucket.ngspiceSuccess === 0 ? 'none: ngspice also fails every fixture in this bucket' : 'none filed')} |`),
    '',
    '## Every fixture',
    '',
    '| Fixture | ngspice | spice-ts | Outcome | Worst | Worst signal | First error line (ngspice / spice-ts) |',
    '|---|---|---|---|---|---|---|',
    ...report.fixtures.map(fixture => {
      const errors = [
        fixture.ngspice.firstErrorLine ? `ngspice: ${fixture.ngspice.firstErrorLine}` : '',
        fixture.ngspice.note ? `ngspice note: ${fixture.ngspice.note}` : '',
        fixture.spiceTs.firstErrorLine ? `spice-ts: ${fixture.spiceTs.firstErrorLine}` : '',
      ].filter(Boolean).join(' / ');
      return `| [${fixture.sourcePath}](fixtures/${fixture.sourcePath})${fixture.sameNameAs.length > 0 ? ' †' : ''} | ${fixture.ngspice.status} | ${fixture.spiceTs.status} | ${fixture.outcome} | ${fixture.worstNormalizedError ?? ''} | ${cell(fixture.worstSignal)} | ${cell(errors)} |`;
    }),
    '',
    ...fineReferenceSection(report.fixtures.map(fixture => ({
      label: `[${fixture.sourcePath}](fixtures/${fixture.sourcePath})`,
      status: fixture.outcome,
      fineReference: fixture.fineReference,
    }))),
  ];
  return lines.join('\n');
}

/** A committed row whose headline compared a transient: the rows that carry the #592 column. */
export function isTransientRow(fixture: FixtureOutcome): boolean {
  return fixture.comparedAnalyses > 0
    && fixture.ngspice.analyses.some(analysis => analysis.startsWith('tran:'))
    && fixture.spiceTs.analyses.some(analysis => analysis.startsWith('tran:'));
}

/**
 * Adds the fine-reference column (#592) to committed rows without regenerating the whole corpus.
 * Every transient row is rerun with `run` (the corpus's own fixture child, which computes the
 * column); its headline fields must equal the committed row through the hashed view, and only
 * `fineReference` is copied in. Headline drift (a committed row that is stale against the current
 * engines) aborts unless `acceptDrift` is set; then the drifted row is replaced by its rerun in
 * full, so its headline and fine columns come from the same run, and the drift is returned so it
 * can be published. Callers recompute totals from the returned rows.
 */
export async function withFineReference(
  fixtures: FixtureOutcome[],
  run: (id: string) => Promise<FixtureOutcome | { id: string; error: string }>,
  jobs: number,
  label: string,
  acceptDrift = false,
): Promise<{ fixtures: FixtureOutcome[]; drift: string[] }> {
  const headline = (fixture: FixtureOutcome): string => {
    const { fineReference: _fine, ...rest } = fixture;
    return JSON.stringify(deterministicView({ fixtures: [rest] } as unknown as CorpusFReport));
  };
  const candidates = fixtures.map((fixture, index) => ({ fixture, index })).filter(({ fixture }) => isTransientRow(fixture));
  const updated = [...fixtures];
  const drift: string[] = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const { fixture, index } = candidates[next];
      next += 1;
      const result = await run(fixture.id);
      if ('error' in result && !('outcome' in result)) throw new Error(`${fixture.id}: ${result.error}`);
      const rerun = result as FixtureOutcome;
      done += 1;
      if (headline(rerun) !== headline(fixture)) {
        drift.push(`${fixture.id} (committed ${fixture.outcome} ${fixture.worstNormalizedError} ${fixture.worstSignal}, rerun ${rerun.outcome} ${rerun.worstNormalizedError} ${rerun.worstSignal})`);
        if (acceptDrift) updated[index] = rerun;
      } else {
        const { fineReference: _previous, ...rest } = fixture;
        updated[index] = rerun.fineReference ? { ...rest, fineReference: rerun.fineReference } : rest;
      }
      process.stderr.write(`${label} --fine-reference: ${done}/${candidates.length} ${fixture.id} ${rerun.fineReference?.status ?? 'no column'}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  drift.sort();
  if (drift.length > 0 && !acceptDrift) {
    throw new Error(`${label}: headline drift against the committed report; refresh it, or rerun with --accept-drift to replace the drifted rows: ${drift.join('; ')}`);
  }
  for (const line of drift) process.stderr.write(`${label} --fine-reference: refreshed stale row ${line}\n`);
  return { fixtures: updated, drift };
}

export function stableReport(report: CorpusFReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Recomputes gap buckets, issue links, totals and the outcome digest from committed fixture
 * outcomes without rerunning either engine (buckets depend only on the recorded first error line).
 */
export function relabel(report: CorpusFReport): CorpusFReport {
  const fixtures = report.fixtures.map(fixture => ({
    ...fixture,
    ngspice: fixture.ngspice.note ? { ...fixture.ngspice, note: CONTROL_ONLY_NOTE } : fixture.ngspice,
    gapBucket: gapBucket(fixture.spiceTs.firstErrorLine, fixture.spiceTs.status) ?? null,
  }));
  const { outcomeSha256: _previous, ...rest } = report;
  const base = { ...rest, ...summarize(fixtures), fixtures };
  return { ...base, outcomeSha256: outcomeDigest(base) };
}

/**
 * Rewrites the batch-1 part of README.md and keeps the control-vector supplement (#521), which
 * control-vectors.ts measures separately, instead of silently dropping it.
 */
export function mergeReadme(existing: string, batch: string): string {
  const supplement = existing.split(CONTROL_SECTION)[1];
  return supplement === undefined ? batch : `${batch.trimEnd()}\n${CONTROL_SECTION}${supplement}`;
}

async function writeReadme(report: CorpusFReport): Promise<void> {
  await writeFile(MARKDOWN_PATH, mergeReadme(await readFile(MARKDOWN_PATH, 'utf8'), renderMarkdown(report)));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--relabel')) {
    const report = relabel(JSON.parse(await readFile(JSON_PATH, 'utf8')) as CorpusFReport);
    await writeFile(JSON_PATH, stableReport(report));
    await writeReadme(report);
    process.stderr.write(`corpus-f --relabel: outcome ${report.outcomeSha256}\n`);
    return;
  }
  const check = argv.includes('--check');
  const jobsIndex = argv.indexOf('--jobs');
  const jobs = jobsIndex >= 0 ? Number(argv[jobsIndex + 1]) : 6;
  if (argv.includes('--fine-reference')) {
    const committed = JSON.parse(await readFile(JSON_PATH, 'utf8')) as CorpusFReport;
    const { fixtures } = await withFineReference(committed.fixtures, id => runChild(id, FIXTURE_CHILD_TIMEOUT_MS), jobs, 'corpus-f', argv.includes('--accept-drift'));
    const { outcomeSha256: _previous, ...rest } = committed;
    const base = { ...rest, policy: { ...rest.policy, fineReference: FINE_REFERENCE_RULE }, ...summarize(fixtures), fixtures };
    const report = { ...base, outcomeSha256: outcomeDigest(base) };
    await writeFile(JSON_PATH, stableReport(report));
    await writeReadme(report);
    process.stderr.write(`corpus-f --fine-reference: outcome ${report.outcomeSha256}\n`);
    return;
  }
  process.stderr.write(`corpus-f report${check ? ' --check' : ''}: pid ${process.pid}; stop with: kill ${process.pid}\n`);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as CorpusFManifest;
  const report = await buildReport(manifest, jobs);
  if (check) {
    const committed = JSON.parse(await readFile(JSON_PATH, 'utf8')) as CorpusFReport;
    // Compare fixtures through the hashed view, so ngspice's run-to-run point counts are not listed.
    const hashed = (fixture: unknown): string => JSON.stringify(deterministicView({ fixtures: [fixture] } as unknown as CorpusFReport));
    const differing = report.fixtures
      .filter((fixture, index) => hashed(fixture) !== hashed(committed.fixtures[index]))
      .map(fixture => fixture.id);
    if (committed.outcomeSha256 !== report.outcomeSha256) {
      const regenerated = resolve(tmpdir(), `corpus-f-outcomes-check-${process.pid}.json`);
      await writeFile(regenerated, stableReport(report));
      throw new Error(`corpus-f outcome differs: committed ${committed.outcomeSha256}, regenerated ${report.outcomeSha256} (written to ${regenerated}); fixtures: ${differing.join(', ') || 'none (report-level fields differ)'}`);
    }
    if ((await readFile(MARKDOWN_PATH, 'utf8')).split(CONTROL_SECTION)[0].trimEnd() !== renderMarkdown(committed).trimEnd()) {
      throw new Error('corpus-f README.md differs from the committed report.json');
    }
  } else {
    await writeFile(JSON_PATH, stableReport(report));
    await writeReadme(report);
  }
  process.stderr.write(`corpus-f: ${report.totals.fixtures} fixtures; outcome ${report.outcomeSha256}; ${JSON.stringify(report.totals.outcomes)}\n`);
}

if (process.argv[2] === SPICE_TS_CHILD_FLAG) {
  (async () => {
    const [inputPath, circuitPath, outputPath] = process.argv.slice(3);
    const circuit = JSON.parse(await readFile(circuitPath, 'utf8')) as ClassicCircuit;
    // Match ngspice's isolated cwd: the unchanged fixture, without upstream companions
    // or the parent's circuit.json/execution.v8 protocol files. Missing reads reject.
    const directory = resolve(inputPath, '..', 'run');
    await mkdir(directory);
    const input = await readFile(inputPath);
    await writeFile(resolve(directory, 'fixture.cir'), input);
    await writeFile(outputPath, serialize(packEncoded(await runCorpusFSpiceTs(input, circuit, PACKED_SAMPLES, {
      resolveInclude: path => readFile(resolve(directory, path), 'utf8'),
    }))));
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (process.argv[2] === CHILD_FLAG) {
  (async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as CorpusFManifest;
    const circuit = manifest.circuits.find(candidate => candidate.id === process.argv[3]);
    if (!circuit) throw new Error(`unknown fixture ${process.argv[3]}`);
    process.stdout.write(`${JSON.stringify(await runFixture(circuit))}\n`);
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (basename(process.argv[1] ?? '') === 'outcomes.ts') {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
