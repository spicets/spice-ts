#!/usr/bin/env tsx
/**
 * Aggregate, identical-input parity report for the five public 20-circuit corpora.
 *
 * Usage:
 *   pnpm exec tsx benchmarks/aggregate-report.ts
 *   pnpm exec tsx benchmarks/aggregate-report.ts --check
 *   pnpm exec tsx benchmarks/aggregate-report.ts --fine-reference   # add the #592 column to committed transient rows
 *
 * Both modes validate fixture hashes and pinned provenance before running any engine, so a stale
 * benchmarks/SOURCES.md or fixture tree fails in seconds. Runs are concurrency-safe: --check never
 * writes, each engine execution uses its own temporary directory, and generation publishes via
 * per-run temporary files plus atomic rename. Stop a run with `kill <pid>` (the PID is printed at
 * start); never pattern-kill other lanes' runs.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import {
  alignAndMeasure,
  sharedGridPoints,
  type AlignmentOptions,
  type ComparisonMetrics,
  type SampleSeries,
} from './comparison-harness.js';
import {
  runNativeNgspice,
  runNativeSpiceTs,
  type ClassicAnalysisType,
  type ClassicCircuit,
  type EngineExecution,
} from './corpus/classic/report.js';
import { type FineReference, FINE_REFERENCE_RULE, fineReferenceColumn, fineReferenceSection } from './fine-reference.js';
import { pairPlots } from './plot-pairing.js';
import { prepareAlignmentReference, sweepSegments } from './comparison-harness.js';
import { REFRESH_METRIC_TRANSITIONS, REFRESH_STATUS_TRANSITIONS } from './aggregate-refresh-855/transitions.js';

const SCHEMA = 'spice-ts-aggregate-parity/v1' as const;
const CORPORA = ['ngspice', 'classic', 'xyce', 'corpus-d', 'corpus-e'] as const;
const FIXTURES_PER_CORPUS = 20;
const TOTAL_FIXTURES = CORPORA.length * FIXTURES_PER_CORPUS;
const JSON_PATH = resolve('benchmarks/aggregate-report.json');
const MARKDOWN_PATH = resolve('benchmarks/AGGREGATE_PARITY.md');
const FIXTURE_TREE_SHA256 = '23aaa91cfde358550eec443e8b5aaec134d7a7f930b1810f6e7f7db2532d6307';
const SOURCES_SHA256 = 'd6bb12d27b99cff81ac14244e2871e9d45b6144aedd39ff5340ba6cce55e27d7';

type CorpusId = typeof CORPORA[number];
type Status = 'success' | 'failed' | 'unsupported';

interface ExpectedStatus {
  expectedStatus?: 'pass' | 'fail';
  failureKind?: string;
  reason?: string;
  status?: string;
}

interface CorpusCircuit extends Omit<ClassicCircuit, 'ngspice' | 'spiceTs'> {
  ngspice?: ExpectedStatus;
  spiceTs: ExpectedStatus;
}

interface CorpusManifest {
  source: { name: string; revision: string; license: string };
  circuits: CorpusCircuit[];
}

interface EngineReceipt {
  status: Status;
  convergence: EngineExecution['convergence'];
  runtimeMs: number;
  command: string[];
  inputSha256: string;
  analyses: Array<{ type: ClassicAnalysisType; points: number; signals: string[] }>;
  error?: string;
}

interface FixtureReceipt {
  key: string;
  corpus: CorpusId;
  id: string;
  category: string;
  declaredAnalyses: ClassicAnalysisType[];
  localPath: string;
  input: { bytes: number; sha256: string; identicalForBothEngines: true };
  ngspice: EngineReceipt;
  spiceTs: EngineReceipt;
  /** Reports generated before #445 carry no `linearMetrics`. */
  comparisons: Array<Omit<ComparisonReceipt, 'linearMetrics'> & { linearMetrics?: ComparisonMetrics }>;
  gapIssues: string[];
  /**
   * Diagnostic fine-step reference column (#592), present when a transient was compared. Its
   * ngspice input is the fixture with only the `.tran` TMAX rewritten, so it is not the
   * byte-identical input the headline comparisons use; it changes no status or envelope.
   */
  fineReference?: FineReference;
}

export interface ComparisonReceipt {
  analysis: ClassicAnalysisType;
  plot?: { spiceTs?: string; ngspice?: string; ngspiceIndex?: number };
  unmatched?: 'spice-ts' | 'ngspice';
  signals: string[];
  /** Primary metric (`policy.breakpointAlignment`): one-sided at shared transient breakpoints. */
  metrics: ComparisonMetrics;
  /**
   * Secondary, pre-#445 metric: plain linear interpolation of ngspice everywhere. Published so
   * that the breakpoint-aware primary metric hides no error. Identical to `metrics` for every
   * non-transient analysis.
   */
  linearMetrics: ComparisonMetrics;
}

interface MatchedPointEnvelope {
  comparedSignals: number;
  relativeComparedSignals: number;
  absoluteSamples: number;
  relativeSamples: number;
  excludedZeroReferences: number;
  maximumAbsoluteError: number;
  maximumAbsoluteRms: number;
  maximumRelativeError: number | null;
  maximumRelativeRms: number | null;
}

interface StatusTransition {
  engine: 'ngspice' | 'spiceTs';
  fixture: string;
  from: Status;
  to: Status;
  explanation: string;
  gapIssues: string[];
}

export interface AggregateReport {
  schemaVersion: typeof SCHEMA;
  outcomeSha256: string;
  provenance: { fixtureTreeSha256: string; sourcesSha256: string };
  corpusSources: Array<{ id: CorpusId; name: string; revision: string; license: string; fixtureCount: number }>;
  environment: { platform: string; release: string; arch: string; cpu: string; node: string };
  tools: { spiceTs: string; ngspice: string; pnpm: string };
  commands: { generate: string; verify: string; ngspice: string; spiceTs: string };
  policy: {
    input: 'byte-identical fixture for both engines';
    fixtureAdaptation: 'none';
    perCircuitToleranceTuning: false;
    comparisonGrid: 'spice-ts';
    interpolation: 'linear';
    /** Absent before #445. See `AlignmentOptions.breakpoints` in comparison-harness.ts. */
    breakpointAlignment?: 'one-sided at time points shared by both transient grids; linear metric retained';
    /** Absent before #592. */
    fineReference?: string;
    timing: 'single wall-clock execution per engine and fixture; descriptive, not a speed claim';
    deterministicHashExcludes: ['environment', 'runtimeMs', 'error'];
  };
  totals: {
    fixtures: number;
    corpusFixtures: Record<CorpusId, number>;
    ngspice: Record<Status, number>;
    spiceTs: Record<Status, number>;
    comparedFixtures: number;
    comparedAnalyses: number;
    runtimeMs: Record<'ngspice' | 'spiceTs', number>;
  };
  matchedPointEnvelope: MatchedPointEnvelope;
  comparisonToPrevious: {
    issueUrl: string;
    pullRequestUrl: string;
    headSha: string;
    outcomeSha256: string;
    totals: AggregateReport['totals'];
    matchedPointEnvelope: MatchedPointEnvelope;
    statusTransitions: StatusTransition[];
    metricTransitions: string[];
  };
  gapIssues: Array<{ url: string; scope: string }>;
  fixtures: FixtureReceipt[];
}

const HISTORICAL_REPORT: AggregateReport['comparisonToPrevious'] = {
  issueUrl: 'https://github.com/mfiumara/spice-ts/issues/321',
  pullRequestUrl: 'https://github.com/mfiumara/spice-ts/pull/325',
  headSha: 'ad7ba71b65848053afa7bc64ba22fd989ef89ca4',
  outcomeSha256: '68aa8e2e7b78b82f801da84cf5c88c489634d203f44bca5df9345a1946deddb9',
  totals: {
    fixtures: 100,
    corpusFixtures: { ngspice: 20, classic: 20, xyce: 20, 'corpus-d': 20, 'corpus-e': 20 },
    ngspice: { success: 52, failed: 9, unsupported: 39 },
    spiceTs: { success: 55, failed: 2, unsupported: 43 },
    comparedFixtures: 43,
    comparedAnalyses: 58,
    runtimeMs: { ngspice: 77_150.906, spiceTs: 270_491.926 },
  },
  matchedPointEnvelope: {
    comparedSignals: 878,
    relativeComparedSignals: 848,
    absoluteSamples: 9_182_709,
    relativeSamples: 9_147_783,
    excludedZeroReferences: 34_926,
    maximumAbsoluteError: 1169140310571.719,
    maximumAbsoluteRms: 1169140310571.719,
    maximumRelativeError: 45497356677842.63,
    maximumRelativeRms: 872317191517.6284,
  },
  statusTransitions: [
    {
      engine: 'spiceTs',
      fixture: 'classic/diode-distortion',
      from: 'failed',
      to: 'success',
      explanation: 'Accepted bounded nonlinear diode distortion (#363, PR #367) removed the ideal-RLC-only .disto rejection, after which the row was unsupported only because the corpus harness did not map .disto results (#391). The harness now maps result.distortion onto the three ngspice-47 two-tone plots (DISTORTION - IM: f1+f2, f1-f2 and 2f1-f2) with the same v(n)/i(vx) names on the swept F1 grid, adding three disto comparisons of 5 signals each. 100 of 101 points align: the last ngspice frequency is 99999999.99999923 Hz (multiplicative accumulation) against an exact 1e8 Hz in spice-ts, so that point is excluded out of range. Published errors: v(2) relative max 2.588e-4 on f1+f2 and f1-f2 (absolute max 1.77e-11 V) and 3.874e-4 on 2f1-f2 (absolute max 3.03e-14 V); i(vcc) and i(vcc2) have the same relative error as v(2); v(1) and v(3) are exactly zero in ngspice and within 4e-23 V in spice-ts. The change is in the harness, not the simulator.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/75', 'https://github.com/mfiumara/spice-ts/issues/391'],
    },
    {
      engine: 'spiceTs',
      fixture: 'ngspice/vbic-fo',
      from: 'unsupported',
      to: 'success',
      explanation: 'Accepted bounded VBIC FO DC support (#352, PR #361) lets the unchanged nested DC sweep complete with 707 points, adding one DC comparison of 6 signals. With per-segment nested-DC alignment (#384, PR #394) 700 points align and 7 are excluded out of range; worst absolute max is 6.71e-6 A on i(vc) and 3.77e-6 A on i(vb), matching the #352 point-by-point verifier. Before #394 the same run reported a 0.3 V harness artifact on source-forced nodes (#401).',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/5', 'https://github.com/mfiumara/spice-ts/issues/352'],
    },
    {
      engine: 'spiceTs',
      fixture: 'ngspice/hfet-inverter',
      from: 'unsupported',
      to: 'success',
      explanation: 'Accepted bounded NHFET level-5 support (#339, PR #360) accepts the Z cards, so the unchanged transient completes and adds one comparison. Published losses: v(4) absolute max 2.272 V (RMS 1.611 V) and v(3) 2.231 V (RMS 1.239 V); i(vdd) absolute max 0.00372 A.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/76', 'https://github.com/mfiumara/spice-ts/issues/339'],
    },
    ...['classic/bjt-noise', 'classic/resistor-noise'].map(fixture => ({
      engine: 'spiceTs' as const,
      fixture,
      from: 'unsupported' as const,
      to: 'success' as const,
      explanation: 'Accepted classic-corpus .noise mapping (#380, PR #383) compares the noise spectra and integrated totals spice-ts already produced, adding two noise analyses. Worst relative max is 4.9e-4 (bjt-noise onoise) and 1.7e-7 (resistor-noise). The change is in the harness, not the simulator.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/75', 'https://github.com/mfiumara/spice-ts/issues/380'],
    })),
    {
      engine: 'spiceTs',
      fixture: 'xyce/inductor-transient',
      from: 'failed',
      to: 'success',
      explanation: 'Accepted inductor-ringing step-loop termination (#366, PR #377) lets the unchanged transient finish inside the 120000 ms bound and adds one comparison. Under plain linear interpolation v(1) and v(2) show absolute max 31.65 V (RMS 8.27 V, relative max about 1.0), while i(l1) agrees to 2.4e-14 A. That error was the #445 interpolation artifact: with breakpoint alignment (PR #458) the primary metric is 9.33e-10 V (RMS 1.05e-10 V) on v(1) and v(2), and the 31.65 V linear value stays published as linearMetrics.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/366'],
    },
    {
      engine: 'spiceTs',
      fixture: 'ngspice/probe-ac',
      from: 'unsupported',
      to: 'success',
      explanation: 'Accepted ngspice .control/.endc block contract (#381, PR #387) no longer rejects the control block, so the unchanged AC fixture completes and adds one comparison of 4 signals. 15 of 16 points align (1 excluded out of range), and the worst absolute max is 4.4e-16 V.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/76', 'https://github.com/mfiumara/spice-ts/issues/381'],
    },
    {
      engine: 'spiceTs',
      fixture: 'classic/bjt-mixer-distortion',
      from: 'unsupported',
      to: 'failed',
      explanation: 'Accepted BJT charge storage (#385, PR #400) now accepts the CJS model parameter that used to reject this netlist at parse time. Upstream comments out both .disto commands, so the fixture has no analysis at all: spice-ts now parses it fully and fails with "No analysis command specified", and the corpus harness classifies that as failed. ngspice also fails on the same bytes (exits 0 with no raw analysis data). This is a published status loss, not a simulator regression: neither engine produces a comparable result.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/75', 'https://github.com/mfiumara/spice-ts/issues/385'],
    },
    {
      engine: 'spiceTs',
      fixture: 'ngspice/mesa-oscillator',
      from: 'unsupported',
      to: 'success',
      explanation: 'Accepted B-source I= expressions and NMF level-2 MESFET (#340, PR #421) let the unchanged transient complete, adding one comparison of 37 signals. 2041 points align and 47 are excluded out of range. Before .tran TSTART output omission (#432, PR #440), spice-ts also emitted the 3219 points before TSTART = 1 ns that ngspice omits, and 3266 points were excluded. Published loss: worst absolute max 0.178 V on v(6) (RMS 0.0244 V), with relative max up to 0.86 on v(8).',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/76', 'https://github.com/mfiumara/spice-ts/issues/340', 'https://github.com/mfiumara/spice-ts/issues/432'],
    },
    {
      engine: 'spiceTs',
      fixture: 'ngspice/vbic-temperature',
      from: 'unsupported',
      to: 'success',
      explanation: '.OPTIONS TEMP with ngspice-47 semantics (#459) sets the circuit temperature (NOACCT stays a no-op), and the bounded VBIC now applies the ngspice vbictemp.c mapping (IS, IBEI, IBEN, IBCI, IBCN, ISP, GAMM, PE, PC, PS, the zero-bias capacitances, kT/q and tVcrit from TNOM = 27 C to 150 C). The unchanged DC sweep completes with 101 points, all aligned, adding one DC comparison of 6 signals. Published loss: i(vc) absolute max 9.235e-7 A (RMS 1.714e-7 A, relative max 1.13e-4), i(v1) 7.607e-7 A (RMS 1.357e-7 A, relative max 8.79e-5) and i(vb) 1.670e-7 A (RMS 3.729e-8 A, relative max 3.43e-4); v(1), v(q1_b) and v(q1_c) are exact. The same bounded VBIC on the same deck at 27 C differs by up to 2.67e-6 A on i(vc), so the residual is the existing bounded-model gap, not the temperature mapping.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/76', 'https://github.com/mfiumara/spice-ts/issues/459'],
    },
    {
      engine: 'spiceTs',
      fixture: 'ngspice/ac-zero-frequency',
      from: 'unsupported',
      to: 'success',
      explanation: 'The ngspice control-language interpreter (#488, PR #584) runs the unchanged .control block (ac lin 1 0Hz 0Hz, let, if/else, echo, quit) that was rejected before (at the #325 baseline as an unsupported .control dot command, later at its let command). spice-ts computes v(3) = 0.4999999999999999 at 0 Hz against the deck\'s own 0.5 gold value (error 2.2e-16, inside its 1e-15 check) and prints INFO: success, as ngspice-47 does when run directly. ngspice stays failed in this harness because the script quits before writing raw data, so no comparison, signal or sample is added and this is not counted as a parity result.',
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/76', 'https://github.com/mfiumara/spice-ts/issues/488'],
    },
    ...([
      ['ngspice/mos-amplifier-transient', 'LEVEL=2', 'one transient comparison of 24 signals (worst v(5) 5.300 V, abs RMS 2.893 V, on 442 aligned points)'],
      ['classic/mos-amplifier', 'LEVEL=2', 'one transient comparison of 24 signals (worst v(5) 5.300 V, abs RMS 2.893 V, on 442 aligned points)'],
      ['classic/bsim1-device-sweep', 'LEVEL=4 (BSIM1)', 'one DC comparison of 24 signals (worst i(vds) 1.31e-4 A, abs RMS 6.78e-5 A, on 500 aligned points)'],
      ['classic/bsim2-device-sweep', 'LEVEL=5 (BSIM2)', 'one DC comparison of 24 signals (worst i(vds) 2.40e-4 A, abs RMS 1.38e-4 A, on 500 aligned points)'],
    ] as const).map(([fixture, level, removed]) => ({
      engine: 'spiceTs' as const,
      fixture,
      from: 'success' as const,
      to: 'unsupported' as const,
      explanation: `Typed UnsupportedModelLevelError for MOSFET levels other than 1, 6, 8 and 49 (#530, PR #552). The unchanged deck uses a ${level} MOSFET card, which spice-ts had been running with Level-1 equations and no warning, so the earlier success, including the #325 baseline, was not a ${level} simulation. It is now rejected at compile time instead, which removes ${removed}. This is a coverage loss, not an accuracy gain; implementing the model is tracked in #565.`,
      gapIssues: ['https://github.com/mfiumara/spice-ts/issues/530', 'https://github.com/mfiumara/spice-ts/issues/565'],
    })),
  ],
  metricTransitions: [
    'Totals: ngspice unchanged at 52/9/39 success/failed/unsupported; spice-ts 55/2/43 to 61/1/38. Comparable coverage changes from 58 analyses across 43 fixtures to 67 across 48: classic/diode-distortion adds three disto analyses (#391), ngspice/vbic-fo, ngspice/vbic-temperature (#459), ngspice/hfet-inverter, xyce/inductor-transient, ngspice/probe-ac and ngspice/mesa-oscillator add one analysis each, classic/bjt-noise and classic/resistor-noise add two each, and ngspice/vbic-common-emitter-ac keeps its AC and PZ analyses (now a real VBIC simulation; see below). ngspice/mos-amplifier-transient, classic/mos-amplifier, classic/bsim1-device-sweep and classic/bsim2-device-sweep each lose their one analysis: they move from success to unsupported because their LEVEL=2/4/5 MOSFET cards are now rejected instead of silently running Level-1 equations (#530, PR #552). classic/bjt-mixer-distortion moves from unsupported to failed and adds no comparison. ngspice/ac-zero-frequency moves from unsupported to success (#488, PR #584) and adds no comparison, because ngspice produces no raw data for it. Signals change from 878 to 879 absolute and from 848 to 847 relative: nine of the added signals are the extra vbic-common-emitter-ac poles and zeros that the pencil-eigenvalue .pz (#451, PR #466) finds and six are the ngspice/vbic-temperature DC signals, while the four rejected MOSFET fixtures remove 96 absolute and 92 relative. Samples change from 9,182,709 to 9,388,702 absolute and from 9,147,783 to 9,364,821 relative; excluded zero references change from 34,926 to 23,881. The per-merge sample counts are in the bisect items below: the denser transient grids after #400/#417 and the mesa-oscillator samples add samples, and the sparser BJT/MOS transient grids after #456 (PR #463), #468 (PR #478) and #520 (PR #536) and the #552 rejections remove them.',
    'Nested DC sweeps are now aligned per segment (#384, PR #394). Worst per-signal absolute max: ngspice/jfet-vds-vgs 3 V v(1) to 3.10e-6 A i(vd); xyce/njfet-2109-dc 1.875 V v(2) to 1.47e-6 A; xyce/nmos-level1-dc 18 V v(4) to 0.000682 V v(2); xyce/pnp-dc 2 V v(4) to 0.00119 V v(3). The old values were harness artifacts, not simulator errors.',
    'Grounded-substrate BJT model resolution (#382, PR #392) changes three corpus-e fixtures. Gains: bjt-rtl-inverter-chain worst DC abs max 4.71 to 1.86 V and OP 0.194 to 0.119 V; bjt-diffpair-current-source worst AC abs max 90.1 to 83.9 V. Published losses: bjt-diffpair-transient and bjt-diffpair-current-source OP v(4)/v(5) abs 1.107 to 1.148 V and supply currents i(vcc)/i(vee) rel about 0.086 to 0.089 in OP and TRAN; bjt-diffpair-current-source AC v(3) abs max 0.0859 to 0.0997 V and TRAN v(4) rel max 68.1 to 348.7 (rel RMS 9.54 to 35.3) and v(5) rel max 43.8 to 97.5; bjt-rtl-inverter-chain DC i(vin) rel max 78.2 to 157.9 (rel RMS 17.9 to 35.1), TRAN i(vcc) abs max 0.00437 to 0.00457 A and v(2) rel max 1.13 to 1.21. Transient grids change from 198 to 191, 111 to 107 and 170 to 156 points.',
    'PULSE zero TR/TF now defaults to TSTEP like ngspice (#375, PR #379). xyce/rlc-transient worst absolute max falls from 10 V v(1) to 0.000752 V v(2) on 1018 instead of 1002 points; classic/mos-memory-cell from 22496.7 A i(vwb) to 9.91 V v(8) on 144 instead of 158 points (v(8) remains a 9.9 V loss); ngspice/ltra-line-transient from 2.499 V v(168) to 0.416 V v(3) on 665 instead of 685 points. Published losses: ltra-line-transient v(3) abs RMS +5.2% (0.04522 to 0.04755 V); mos-memory-cell i(vw) abs RMS +4.7%; classic/lossy-line-aluminium (3968 to 3969 points) raises abs RMS on 89 of 261 signals by at most 0.1% on non-negligible signals and v(x1.x1.x1.x1.x1.x1.x1.x1.4) rel max 2314.5 to 7220.6 at an unchanged 0.2614 V abs max. classic/lossy-line-24-inch and classic/coupled-lossy-lines change only at rounding level.',
    'Worst per-signal envelope: absolute max falls from 1169140310571.719 to 31.65338535154384 and absolute RMS from 1169140310571.719 to 8.272157976952819, now from xyce/inductor-transient TRAN v(1) (the #366 loss). Two things cause this. First, the ngspice/vbic-common-emitter-ac pole comparison is no longer made (#392), which is a coverage change, not an accuracy gain; it leaves classic/rca3040-wideband-amplifier AC v(15) at 154.02408984579006 (RMS 66.59015057379884). Second, BJT charge storage (#400) then lowers that rca3040 AC v(15) error to 1.0237. Relative max falls from 45497356677842.63 to 321200769453.2656 and relative RMS from 872317191517.6284 to 6432928954.616146, still from classic/coupled-lossy-lines v(5), whose absolute max falls from 1.42 to 0.431 V (the relative values were 318874896057.84845 and 6401850478.823812 before DC pnjlim diode limiting, PR #437, and 349781933131.4126 and 6858037632.217204 before transient pnjlim, PR #442; see below); the relative metric still divides by near-zero ngspice samples. No tolerance changed.',
    'Diode CJO aliasing (#365, PR #390) changed no aggregate outcome: the deterministic projection was identical before and after merging it.',
    'Transient step-control change from inductor-ringing termination (#366, PR #377), the only transient-engine change merged in the final window (none of these netlists has a diode, HFET or .noise card, so #405, #360 and #383 cannot affect them): xyce/rlc-transient worsens, with abs max 0.000752 to 0.00213 V on v(2) and 0.000251 to 0.000711 A on i(l1), abs RMS up on all 5 signals, 1018 to 1037 points. This is a published loss. ngspice/mos6-inverter-transient and classic/mos6-inverter-chain (3760 to 3777 points) lower abs RMS on 30 and raise it on 14 of 44 signals, with worst abs max 5.0044 V on v(43) essentially unchanged. ngspice/mos6-simple-inverter-transient (3438 to 3451 points) and corpus-e/mos1-inverter-sweep TRAN (111 to 113 points) change abs RMS by about 1% or less.',
    'Diode VJ/FC depletion-capacitance parity (#388, PR #405) changed no compared diode fixture metric in this run.',
    'BJT charge storage and Early gm (#385, PR #400) and MOS1 bulk-junction currents (#393, PR #417) were merged after the bc99922 refresh and change 26 compared fixtures. The item values above for #392, #379 and #377 were measured before these two merges. Below, A to B means the bc99922 aggregate value (outcome 44261d03) to the 60f49b2 run (outcome c06be5be). Attribution is by device class (BJT to #400, MOS to #417), not bisected. Gains, worst absolute max: classic/rca3040-wideband-amplifier AC v(15) 154.02 to 1.024 and TRAN v(17) 10.42 to 0.311 V (1494 to 3994 points); classic/bjt-differential-pair TRAN v(4) 7.27 to 0.076 V (190 to 3184 points); classic/rtl-inverter-chain TRAN v(5) 4.73 to 0.296 V and DC 1.87 to 1.80 V; corpus-e/bjt-rtl-inverter-chain TRAN v(5) 4.73 to 0.293 V and DC 1.857 to 1.801 V; corpus-e/bjt-diffpair-transient OP v(5) 1.148 to 0.0616 V and TRAN v(4) 7.01 to 0.111 V; corpus-e/bjt-diffpair-current-source AC v(5) 83.9 to 0.517 V, OP v(5) 1.148 to 0.0616 V and TRAN v(5) 4.78 to 0.129 V (TRAN v(4) rel max 348.7 to 286.9); classic/lossy-line-24-inch v(3) 3.65 to 1.125 V; classic/coupled-lossy-lines v(x1.6) 5.20 to 0.391 V with abs RMS down on 41 of 47 signals; classic/mos-memory-cell v(8) 9.91 to 1.91 V; corpus-e/mos1-inverter-sweep OP v(4) 4.58 to 0.214 V; ngspice/mos-amplifier-transient and classic/mos-amplifier abs RMS down on 18 of 24 signals and i(vb) rel max 9.5e6 to 1.6e5; ngspice/mos6-simple-inverter-transient v(11) 4.92 to 4.34 V; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger v(6) 0.989 to 0.763 V. Published losses at the 60f49b2 run, superseded for corpus-e/mos1-inverter-sweep and ngspice/mos6-simple-inverter-transient by case-insensitive .model resolution (PR #436, see below): corpus-e/mos1-inverter-sweep TRAN i(vdd) 0.0036 to 1.234 A, a spike on a femtosecond step before the 3 ns PWL corner where ngspice peaks at 1.77e-3 A (#427), TRAN v(5) 2.50 to 3.74 V, DC i(vdd) 0.00364 to 0.00757 A, and worst DC/TRAN abs max then about 4.35 V; ngspice/mos6-simple-inverter-transient i(vdd) 0.000544 to 0.00191 A (rel max 8072 to 328348) and i(vin) 9.3e-6 to 2.1e-4 A on 3451 to 3229 points; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger i(vin) 2.70e-4 to 5.35e-4 A and v(2) 0.0135 to 0.0268 V, v(6) rel max 36.1 to 148.3, with abs RMS up on 8 of 10 signals; classic/mos-memory-cell i(vs) 0.00367 to 0.0113 A and i(vwb) 0.00052 to 0.00104 A; ngspice/mos6-inverter-transient and classic/mos6-inverter-chain abs RMS up on 19 and down on 23 of 44 signals with v(xndinv2.22) 3.720 to 3.723 V; corpus-e/bjt-diffpair-transient TRAN v(1) rel max 0.039 to 1.0 at 0.0012 V abs; corpus-e/bjt-rtl-inverter-chain OP i(vin) rel 0.22 to 1.0 at 4.6e-12 A abs; classic/lossy-line-24-inch v(3) rel max 84.5 to 2533 and classic/rca3040-wideband-amplifier TRAN v(31) rel max 518 to 4387 at lower absolute error. ngspice/ltra-line-transient, classic/bsim1-device-sweep, classic/bsim2-device-sweep, xyce/nmos-level1-dc and xyce/pmos-level1-dc change only at rounding level.',
    'Merged after the 60f49b2 run: .ac sweep point counts (PR #397), transient Newton limiting only on nonlinear device nodes (#376, PR #425), and B-source I= expressions with NMF level-2 MESFET (#340, PR #421). Apart from the ngspice/mesa-oscillator transition above, no compared metric, grid or engine status changed for any fixture across these three merges.',
    'Diode VT = kT/q and ngspice-47 model aliases (#402/#404, PR #431) merged after the 26a163a run and change six compared analyses (26a163a run to this run). Gains: xyce/diode-sidewall-dc worst i(vin) abs max 5.20e-4 to 1.03e-4 A; corpus-e/diode-bias-sweep DC v(2) 5.86e-4 to 2.48e-4 V and OP v(2) 3.45e-4 to 2.88e-6 V; classic/coupled-lossy-lines worst abs max 0.936 V v(x3.3) to 0.868 V v(x3.1) on 3781 to 3776 points, with abs RMS down on 27 of 47 signals. Published losses: classic/coupled-lossy-lines abs RMS up on 14 of 47 signals, v(x3.2) abs max 0.443 to 0.449 V and v(2) 0.311 to 0.319 V; classic/lossy-line-24-inch abs RMS up on all 3 signals and v(2) abs max 1.1210 to 1.1235 V on 3162 to 3129 points (v(3) improves 1.1252 to 1.1211 V); classic/lossy-line-aluminium abs RMS up on 121 and down on 50 of 261 signals at an unchanged worst abs max of 1.3472 V v(3).',
    'Merged after the 3b2d9ac run. Each step below was bisected with a full 100-fixture run on that main commit using this branch\'s harness; a rerun on 3b2d9ac reproduced outcome 2a6f337a exactly. The numeric-wasm .ac frequency grid (#409, PR #434) is WASM-only and outside this harness. Case-insensitive .model resolution (#427, PR #436) changes the outcome from 2a6f337a to 5b5bbcdb. Three fixtures name models in a different case from their .model cards (NMOS for nmos, p12l5 for P12L5), so before #436 those devices silently ran a default model. Gains: corpus-e/mos1-inverter-sweep DC worst abs max 4.352 V v(6) to 0.00352 V v(3); OP 0.214 V v(4) to 4.5e-10 V; TRAN 4.352 V v(6) to 0.836 V v(3), with v(6) 4.352 to 0.0684 V, i(vdd) 1.234 to 5.81e-5 A (the #427 spike is gone), abs RMS down on 8 of 9 signals and 382 to 164 points against ngspice\'s 65. ngspice/mos6-simple-inverter-transient v(11) 4.336 to 2.956 V, i(vdd) 0.00191 to 0.000232 A and i(vin) 2.1e-4 to 1.5e-5 A on 3229 to 2767 points. Published losses: corpus-e/mos1-inverter-sweep TRAN still has v(3) abs max 0.836 V (RMS 0.278 V) and v(4) 0.176 V, with relative max 1.0 on v(3), v(4) and v(6); ngspice/mos6-simple-inverter-transient v(11) remains a 2.956 V loss (RMS 0.712 V), and its v(1) abs RMS rises at the 1e-15 V rounding level; classic/bsim2-device-sweep currents move by at most 2.4e-14 A, with abs RMS up on 5 of 24 signals and i(vbs1) rel max 0.466 to 0.505. SimulationOptions.maxTimestep in simulate() (#415, PR #433) leaves the outcome at 5b5bbcdb. ngspice pnjlim diode limiting (#430, PR #437) changes the outcome to 4a4fcc16, only on diode-bearing fixtures. Published losses: classic/coupled-lossy-lines worst abs max 0.868 V v(x3.1) to 0.929 V v(x3.3) on 3776 to 3810 points, v(x3.1) 0.868 to 0.882 V, v(x3.2) abs RMS 0.0832 to 0.0888 V, abs RMS up on 19 and down on 23 of 47 signals, and v(5) rel max 3.189e11 to 3.498e11, which sets the new relative envelope; classic/lossy-line-24-inch v(2) 1.1235 to 1.1255 V and v(3) 1.1211 to 1.1222 V on 3129 to 3123 points (abs RMS down on 2 of 3); classic/lossy-line-aluminium abs RMS up on 132 and down on 127 of 261 signals at an unchanged worst abs max of 1.3472 V v(3) (3969 to 3968 points); corpus-e/diode-bias-sweep DC i(v1) rel max 0.515 to 0.999 at an unchanged 2.48e-9 A abs max. xyce/diode-sidewall-dc changes only at rounding level. ngspice dynamic gmin stepping for DC OP (#428, PR #439) changes the outcome to f7955f05, only on classic/mos-memory-cell (148 to 142 points). Gains: i(vs) 0.0113 to 0.000776 A, i(vwb) 0.00104 to 0.000512 A, i(vdd) 1.51e-4 to 6.74e-5 A, abs RMS down on 9 of 13 signals. Published losses: i(vw) abs RMS 7.46e-4 to 8.14e-4 A (rel max 5304 to 9779), v(8) 1.9075 to 1.9092 V, abs RMS up on 4 of 13 signals. Forward .param references and typed .tran/.ac ParseErrors (#422/#423, PR #435) leave the outcome at f7955f05: they only replace the unsupported-row error text of corpus-e/opamp-open-loop-ac and corpus-e/vcvs-operating-point, a leaked TypeError, with a typed .ac ParseError. Engine totals stay at 52/9/39 (ngspice) and 61/1/38 (spice-ts) success/failed/unsupported, and coverage stays at 65 analyses across 49 fixtures, through all six merges.',
    'Merged after the 4fed83d run, bisected the same way: one full 100-fixture run per main commit with this branch\'s harness, and a rerun on 4fed83d reproduced outcome 9f6e3faa exactly. .tran TSTART output omission (#432, PR #440) changes the outcome to bf06ceb6, only on ngspice/mesa-oscillator: spice-ts emits 2088 instead of 5307 transient points, and points excluded out of range fall from 3266 to 47 against ngspice\'s 201. The same 2041 points align, so every metric of its 37 signals is unchanged and the 0.178 V v(6) loss stands. InvalidCircuitError for unresolved device .model references (#414, PR #443) leaves the outcome at bf06ceb6: no fixture references an undefined model, and no spice-ts status or error text changes. Exact pnjlim in the transient Newton loop (#441, PR #442) changes the outcome to 75345f18, only on the three diode-bearing lossy-line fixtures. Gains: classic/coupled-lossy-lines worst abs max 0.929 V v(x3.3) to 0.870 V v(x3.1) on 3810 to 3779 points, v(x3.3) 0.929 to 0.835 V (abs RMS 0.180 to 0.156 V), v(x3.1) 0.882 to 0.870 V, and v(5) rel max 3.498e11 to 3.212e11 (rel RMS 6.858e9 to 6.433e9), which lowers the relative envelope; classic/lossy-line-aluminium abs RMS down on 149 and up on 111 of 261 signals, by at most 0.23% on signals above 0.01 V RMS, at an unchanged worst abs max of 1.3472 V v(3) (3968 to 3970 points). Published losses: classic/coupled-lossy-lines abs RMS up on 27 and down on 15 of 47 signals, v(x3.2) abs max 0.450 to 0.476 V (RMS 0.0888 to 0.0912 V), v(4) abs max 0.4945 to 0.4964 V and v(5) abs RMS 0.1205 to 0.1211 V; classic/lossy-line-24-inch abs RMS up on all 3 signals, v(2) abs max 1.1255 to 1.1291 V (rel max 10.4 to 15.6) and v(3) rel max 170 to 450 at an unchanged 1.1222 V abs max, on 3123 to 3107 points. Matched samples change from 9,485,000 to 9,484,017 absolute and from 9,449,285 to 9,448,424 relative; excluded zero references change from 35,715 to 35,593. Engine totals stay at 52/9/39 (ngspice) and 61/1/38 (spice-ts) success/failed/unsupported, and coverage stays at 65 analyses across 49 fixtures and 935/906 signals, through all three merges.',
    'Merged after the 3f3e2ca run (#413 refresh at 417f435), bisected the same way: one full 100-fixture run per main commit with the 667a704 (PR #458) harness. A rerun on 417f435 reproduced every committed metric exactly as linearMetrics. Breakpoint alignment (#445, PR #458) is a harness change that lowers only the primary transient metric, on 17 fixtures; abs RMS falls on 233 transient signals and rises on none, and linearMetrics keeps every pre-#458 value. It moves the absolute envelope from 31.65338535154384 (xyce/inductor-transient v(1), now 9.33e-10 V) to 5.0044039999247225 (ngspice/mos6-inverter-transient v(43), unchanged, a published loss) and the absolute RMS envelope from 8.272157976952819 to 2.655527382661988 (ngspice/mos-amplifier-transient v(5)). This supersedes the envelope statement above. Diode junction charge q(v) in transient (#403/#389, PR #452) changes only classic/coupled-lossy-lines (3779 to 3813 points) and classic/lossy-line-24-inch (3107 to 3112 points); classic/lossy-line-aluminium is unchanged. Gains: coupled-lossy-lines abs RMS down on 24 of 47 signals, v(5) rel RMS 6.433e9 to 6.403e9; lossy-line-24-inch v(3) rel max 450 to 171 and v(2) rel max 15.6 to 9.96. Published losses: coupled-lossy-lines worst abs max 0.870 to 0.889 V v(x3.1), abs RMS up on 18 of 47 signals, v(4) rel max 274 to 971, v(2) rel max 90.5 to 198, i(v1) rel max 2.64 to 7.98, and v(5) rel max 321200769453.2656 to 321200769455.61346, which sets the relative envelope; lossy-line-24-inch v(2) abs max 1.129 to 1.133 V and v(3) abs RMS 0.375 to 0.392 V. NHFET level-5 inverse operation at VGS (#448, PR #454) changes only ngspice/hfet-inverter (587 to 593 points): abs RMS down on 4 of 6 signals and v(3) rel max 5624 to 5452, but v(4) and v(3) keep their 2.272 V and 2.231 V abs max losses, v(4) abs RMS rises 1.611 to 1.615 V and i(vin) rel max rises 1271 to 3208. The 667a704 main run then reproduces the 2c11c9f outcome exactly. The .disto harness mapping (#391, PR #464) changes only classic/diode-distortion (see its status transition): spice-ts 61/1/38 to 62/1/37, coverage 65 to 68 analyses across 49 to 50 fixtures, 935 to 950 absolute and 906 to 915 relative signals, 9,485,666 to 9,487,166 absolute and 9,449,958 to 9,450,858 relative samples, and 35,708 to 36,308 excluded zero references (the zero v(1) and v(3) distortion products). No tolerance changed.',
    'Merged after the 667a704 run (the #391 harness above), bisected the same way: one full 100-fixture run per main commit with the #391 harness (PR #464 head 5e9489e merged into each commit). The 5e9489e --check run reproduces outcome 3c5ec193. AMD fill-reducing column ordering for Gilbert-Peierls LU (#444, PR #449) changes pivot order and therefore last-digit rounding in every LU solve. It changes no status and no compared analysis, but the deterministic projection of 40 fixtures moves: DC, OP, AC, noise and disto metrics only at rounding level (for example classic/bjt-noise onoise_total relative max 4.88592e-4 to 4.88602e-4), and transient step sequences on stiff or switching circuits, which shift their grids and metrics. Gains: ngspice/mesa-oscillator v(6) abs max 0.1782 to 0.1771 V (2088 to 2089 points, 2041 to 2042 aligned); classic/coupled-lossy-lines abs RMS down on 27 and up on 15 of 47 signals, v(4) rel max 970.5 to 280.7 (3813 to 3816 points); classic/lossy-line-24-inch v(2) abs max 1.1333 to 1.1323 V; corpus-e/bjt-diffpair-transient v(4) abs RMS 0.0903 to 0.0877 V (3195 to 3193 points); the classic/coupled-lossy-lines v(5) rel max 321200769455.61346 to 321200768925.4484 and rel RMS 6402773048.130738 to 6400132539.273393, which lowers the relative envelope. Published losses: ngspice/hfet-inverter (593 to 558 points) abs RMS up on 4 of 6 signals, v(3) 1.234 to 1.261 V, i(vin) rel max 3208 to 5425 and i(vdd) RMS 1.002e-3 to 1.014e-3 A, at unchanged 2.272 V and 2.231 V worst abs max; ngspice/mesa-oscillator abs RMS up on 27 of 37 signals, by at most 0.1%; ngspice/jimi-fuzz (567467 to 567405 points) abs RMS up on 9 of 21 signals at about 1e-5 relative; corpus-e/bjt-diffpair-transient v(5) abs max 0.0890 to 0.0969 V (RMS 0.0381 to 0.0403 V); classic/lossy-line-24-inch v(3) rel max 171 to 196; classic/lossy-line-aluminium abs RMS up on 107 and down on 143 of 261 signals at about 1e-5 relative; classic/rca3040-wideband-amplifier TRAN (3994 to 3993 points) abs RMS up on 12 and down on 11 signals, v(15) abs max 0.3378 to 0.3389 V. The pre-#455 MOS6 rows moved too (3782 to 3788 points; abs RMS down on 30 and up on 14 of 44 signals, v(13) 1.132 to 1.234 V); #455 supersedes them. Bounded VBIC small-signal .ac/.pz (#446, PR #457) changes only ngspice/vbic-common-emitter-ac and the vbic-fo spice-ts signal list (two internal excess-phase nodes, no compared metric change). vbic-common-emitter-ac goes from unsupported to success, as it was in the #325 baseline, so it is no longer a status transition. That baseline success silently ran a default level-1 NPN (#382, PR #392); this is the first real VBIC comparison. AC (500 of 501 points aligned, one excluded out of range): i(vmeas) abs max 4.63e-6 A (relative max 1.08e-7), v(1) 1.84e-4 V, v(2) and v(4) 7.36e-5 V, i(vcc) 7.36e-8 A, v(3) 1.03e-9 V. PZ is a published loss (#451): spice-ts finds 3 poles and 1 zero against ngspice 7 and 6, and the four compared values are off by 1.14e12 (pole(1)), 5.41e11 (pole(2)), 8.65e10 (pole(3)) and 1.25e12 (zero(1)), with relative errors 0.95 to 1.0. zero(1) sets the absolute max and RMS envelope at 1251172988128.5068. MOSFET level 6 (#447, PR #455) changes only the three MOS6 fixtures. Gains: ngspice/mos6-inverter-transient and classic/mos6-inverter-chain (same deck, 3788 to 3872 points) worst abs max 5.0044 V v(43) to 0.2798 V v(xndinv4.14), with v(43) 5.0044 to 0.00623 V and abs RMS down on 41 of 44 signals; ngspice/mos6-simple-inverter-transient (2767 to 590 points) v(11) 2.956 to 0.2215 V (RMS 0.712 to 0.0216 V) and i(vdd) 2.32e-4 to 8.14e-5 A. Published losses: i(vin) abs RMS 5.22e-6 to 1.61e-5 A on mos6-simple-inverter-transient (abs max 1.53e-5 to 2.27e-5 A) and 7.09e-6 to 1.47e-5 A on the two mos6inv rows (abs max falls 3.69e-5 to 3.21e-5 A), from trapezoidal ringing in the source current (#461); mos6-simple-inverter-transient i(vdd) rel max 1729 to 22447; mos6inv v(1) abs RMS 2.3e-16 to 5.4e-16 V. Without vbic-common-emitter-ac the worst absolute max is now 4.7543 V on ngspice/mos-amplifier-transient v(6) (unchanged), and the worst absolute RMS stays 2.6555 V on its v(5). Totals across these three merges: spice-ts 62/1/37 to 63/1/36, 68 to 70 analyses, 50 to 51 fixtures, 950 to 960 absolute and 915 to 924 relative signals. Absolute samples change from 9,487,166 to 9,486,322 and relative samples from 9,450,858 to 9,447,756; excluded zero references change from 36,308 to 38,566. ngspice is unchanged at 52/9/39. Diode NBV/TBV1 breakdown parity (#438/#429, PR #460), merged next, leaves every compared metric, grid and status unchanged: a full run on 4ed111e reproduces the 3490527 per-fixture metrics exactly. This refresh (#467) adds only gap links: #451 on ngspice/vbic-common-emitter-ac and #461 on the three MOS6 fixtures. No fixture or tolerance changed.',
    'Merged after the 4ed111e run above (PR #470 head b8b3173, outcome fedbff5e), bisected the same way: one full 100-fixture run per main commit with the b8b3173 harness merged in, with the SOURCES.md pin set to that commit\'s catalogue in the throwaway worktree. Pencil-eigenvalue .pz (#451, PR #466, main 6bae695) changes the outcome to e1bd8b6a, only on the three pole-zero fixtures. It supersedes the #451 PZ loss and the 1251172988128.5068 envelope stated above. ngspice/vbic-common-emitter-ac PZ now reports 7 poles and 6 zeros, the same counts as ngspice, and all 13 are compared (4 to 13 signals): relative errors are 1.26e-9 to 1.20e-7, the largest absolute errors are 13716.6 on zero(1) and 13002.8 on pole(1), whose magnitudes are 1.2e12 to 1.3e12, and pole(7) is off by 7.0e-4. zero(1) still sets the absolute max and absolute RMS envelope, now at 13716.60302734375 (a single-point PZ signal, so max equals RMS). classic/pole-zero-four-stage worst abs max falls from 0.01295 (pole(1)) to 1.49e-8 (pole(3)), and classic/pole-zero-three-stage from 0.004812 (pole(3), relative 2.4e-4) to 3.65e-12 on all three poles. Signals change from 960 to 969 absolute and from 924 to 933 relative, and samples by 9. No status changes. Nonlinear device charges integrated with NIintegrate state (#456, PR #463, main 0f50fb1) changes the outcome to b9cb7e52 on 15 transient analyses; every DC, OP, AC, noise, disto and PZ analysis is unchanged, and so are the three MOS6 fixtures, which #463 does not cover (remaining scope #468). Gains: BJT/MOS transients take far fewer points at similar or lower worst error: classic/rca3040-wideband-amplifier TRAN worst v(14) 0.3534 to 0.3386 V (RMS 0.197 to 0.152 V) on 3993 to 714 points, classic/rtl-inverter-chain v(5) 0.2959 to 0.2849 V on 3247 to 234 points, classic/bjt-differential-pair 3184 to 159 points at an unchanged 0.1194 V worst, corpus-e/bjt-diffpair-transient 3193 to 166 points and corpus-e/bjt-diffpair-current-source 3291 to 228 points; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger abs RMS down on 8 of 10 signals (v(6) RMS 0.461 to 0.277 V); ngspice/mos-amplifier-transient and classic/mos-amplifier v(5) abs RMS 2.656 to 2.334 V on 1855 to 716 points; classic/coupled-lossy-lines worst 0.889 V v(x3.1) to 0.870 V v(x3.3), abs RMS down on 28 of 47, and v(5) rel max 321200768925.4484 to 248110022136.66394 (rel RMS 6400132539.273393 to 5222101415.434834), which lowers the relative envelope; classic/mos-memory-cell v(8) 1.909 to 1.906 V. Published losses: ngspice/mesa-oscillator worst 0.1782 V v(8) to 0.3582 V v(4), abs RMS up on 36 of 37 signals (v(2) RMS 0.025 to 0.106 V) on 2089 to 3861 points, a start-up phase shift from voltage-based step control (#469); corpus-e/bjt-rtl-inverter-chain TRAN v(3) 0.2949 to 0.5997 V, v(2) 0.119 to 0.214 V and i(vcc) 3.96e-4 to 6.00e-4 A on 3229 to 170 points (ngspice 80), also #469; ngspice/mos-amplifier-transient and classic/mos-amplifier worst v(6) 4.754 to 4.805 V, abs RMS up on 9 of 24; ngspice/hfet-inverter v(3) abs RMS 1.261 to 1.328 V (rel max 574 to 6771) at unchanged 2.272 V and 2.231 V worst abs max (558 to 457 points); classic/rtl-inverter-chain v(5) abs RMS 0.041 to 0.145 V; corpus-e/bjt-diffpair-transient abs RMS up on 7 of 12 (v(5) 0.040 to 0.056 V); corpus-e/bjt-diffpair-current-source v(5) 0.1291 to 0.1309 V, abs RMS up on 6 of 12; classic/bjt-differential-pair abs RMS up on 6 of 12; classic/lossy-line-24-inch v(2) 1.132 to 1.134 V and v(3) rel max 196 to 1059 (3112 to 3151 points). Absolute samples change from 9,486,331 to 9,270,848, relative samples from 9,447,765 to 9,233,357, and excluded zero references from 38,566 to 37,491. Diode sidewall charge with the bottom F1 above FCS*VJSW and the MODEINITPRED junction predictor (#450, PR #471, main 25dd3ed) changes the outcome to 6f8aa84d, only on the three diode-bearing lossy-line transients. Gains: classic/lossy-line-aluminium abs RMS down on 224 and up on 36 of 261 signals at an unchanged worst abs max of 1.347 V v(3) (3970 to 3976 points); classic/lossy-line-24-inch abs RMS down on all 3 signals and v(3) rel max 1059 to 193 (3151 to 3143 points); classic/coupled-lossy-lines worst 0.870 to 0.866 V v(x3.3) (3820 to 3810 points). Published losses: classic/coupled-lossy-lines abs RMS up on 32 of 47 signals and v(5) rel max 248110022136.66394 to 248284946174.52246 (rel RMS 5222101415.434834 to 5233588211.050267), which sets the relative envelope; classic/lossy-line-24-inch v(2) abs max 1.134 to 1.135 V. Absolute samples change from 9,270,848 to 9,271,920, relative samples from 9,233,357 to 9,234,466, and excluded zero references from 37,491 to 37,454. Without the PZ rows the worst absolute max is now 4.805 V and the worst absolute RMS 2.334 V, both on ngspice/mos-amplifier-transient (v(6) and v(5)). Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), and coverage at 70 analyses across 51 fixtures, through all three merges. No fixture, tolerance or harness logic changed.',
    'Merged after the 25dd3ed run above (PR #470 head 44d2d62, outcome 2d1d8d2f), bisected the same way: one full 100-fixture run per main commit with the 44d2d62 harness merged in. The M2 scaling runtime benchmark (#426, PR #476, main 34e85e9) adds files outside the corpus and leaves benchmarks/SOURCES.md unchanged: aggregate-report.ts --check passes on that merge and reproduces outcome 2d1d8d2f exactly. VBIC substrate terminal and thermal-node rejection (#453, PR #473, main 3a7ad44, SOURCES.md pin set to its catalogue in the throwaway worktree) changes the outcome to 20093b20, only on the two VBIC fixtures; no status, grid or signal list changes. Gains: ngspice/vbic-common-emitter-ac AC abs RMS down on all 6 signals (i(vmeas) abs max 4.63e-6 to 2.87e-6 A, relative max 1.08e-7 to 6.67e-8; v(1) 1.84e-4 to 1.21e-4 V); its PZ abs error falls on all 13 poles and zeros (zero(1) 13716.6 to 7022.0, pole(1) 13002.8 to 7175.3, zero(2) 569.0 to 140.0, pole(7) 7.0e-4 to 5.2e-4) and the worst relative error falls from 1.20e-7 to 7.62e-8 (pole(6)); ngspice/vbic-fo DC i(v1) and i(vb) relative max 1.24e-3 to 9.29e-4 (rel RMS 8.08e-5 to 6.47e-5). pole(1) now sets the absolute max and absolute RMS envelope at 7175.34033203125 (a single-point PZ signal, so max equals RMS); this supersedes the 13716.60302734375 envelope stated above. Published losses: ngspice/vbic-fo i(v1) and i(vb) abs max 3.7715827e-6 to 3.7715832e-6 A and i(vc) 6.7147750e-6 to 6.7147755e-6 A (each about +5e-13 A), and their abs RMS 2.25100978e-7 to 2.25101017e-7 A (i(v1), i(vb)) and 2.89437148e-7 to 2.89437158e-7 A (i(vc)). Recording the M2 scaling deck sources (#480, PR #481, main ef8c5d4) edits only benchmarks/SOURCES.md and CI: the run on the merged branch, with the SOURCES.md pin moved from b88cb2bb to 53cd510c, reproduces every per-fixture metric, grid and status of the 3a7ad44 run. Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), coverage at 70 analyses across 51 fixtures and 969/933 signals, and matched samples at 9,271,920 absolute and 9,234,466 relative through all three merges. The relative envelope (classic/coupled-lossy-lines v(5)) is unchanged. No fixture, tolerance or harness logic changed.',
    'Merged after the ef8c5d4 run above (PR #470 head cc21aec, outcome 3cd2ed62), bisected the same way: one full 100-fixture run per main commit with the cc21aec harness merged in and the SOURCES.md pin set to that commit\'s catalogue in the throwaway worktree. ngspice true gmin stepping as the DC operating-point fallback (#462, PR #474, main 90b461b, pin 7c3bae20) changes the outcome to 5a57e79a only through the pin: every per-fixture metric, grid and status equals the ef8c5d4 run, because no corpus fixture reaches the fallback. The MNA stamp value-slot cache in transient assembly (#475, PR #485, main 9ba80af, same pin) reproduces outcome 5a57e79a exactly, so it is outcome-neutral. MOS6 Meyer and junction charges integrated with TransientChargeState (#468, PR #478, main 1e8d9f8, pin cdd28c98) changes the outcome on the three MOS6 fixtures only; no status, signal list or envelope changes. Gains: ngspice/mos6-simple-inverter-transient (590 to 321 points, ngspice 308) v(11) abs max 0.2215 to 0.1057 V (RMS 0.0216 to 0.0124 V), i(vdd) 8.14e-5 to 6.17e-7 A (rel max 22447 to 1.16) and i(vin) 2.27e-5 to 2.01e-6 A (RMS 1.61e-5 to 2.28e-7 A), which removes the i(vdd) rel max and i(vin) RMS losses published for #455; on ngspice/mos6-inverter-transient and classic/mos6-inverter-chain (same deck) i(vin) abs max 3.21e-5 to 1.13e-5 A (RMS 1.47e-5 to 9.05e-7 A) and i(vdd) 1.97e-4 to 4.35e-5 A (RMS 8.62e-5 to 1.12e-5 A), so the #461 i(vin) RMS loss on all three MOS6 rows shrinks by 16x to 71x (#461 stays open: mos6inv i(vin) still alternates more often than ngspice). Published losses: on ngspice/mos6-inverter-transient and classic/mos6-inverter-chain (3872 to 912 points, ngspice 315) the worst abs max rises from 0.2798 V v(xndinv4.14) to 0.3261 V v(xndinv3.14) (v(xndinv3.14) 0.2719 to 0.3261 V, RMS 0.0106 to 0.0247 V; v(xndinv4.14) 0.2798 to 0.3239 V, RMS 0.0098 to 0.0294 V), abs max is worse on 39 and abs RMS on 36 of 44 signals, v(5) 0.0076 to 0.0752 V, v(43) 0.0062 to 0.0724 V and v(42) rel max 233.7 to 1.945e5. These voltage errors scale with RELTOL: spice-ts transient Newton lacks ngspice\'s MOS6 device convergence test and MODEINITPRED, which the old generic C(v) history hid by taking about 4x more steps (#479). mos6-simple-inverter-transient v(1) abs max moves 2.7e-15 to 3.6e-15 V, at rounding level. Absolute samples change from 9,271,920 to 9,010,095, relative samples from 9,234,466 to 8,983,151, and excluded zero references from 37,454 to 26,944. The absolute envelope (7175.34033203125, vbic-common-emitter-ac pole(1)) and the relative envelope (classic/coupled-lossy-lines v(5)) are unchanged; without the PZ rows the worst absolute max and RMS stay 4.805 V and 2.334 V on ngspice/mos-amplifier-transient. Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), and coverage at 70 analyses across 51 fixtures and 969/933 signals, through all three merges. No fixture, tolerance or harness logic changed.',
    'ngspice CKTterr charge LTE and PULSE omitted-parameter breakpoints (#469, PR #483, main 96a9039), merged after the 1e8d9f8 run above, leaves benchmarks/SOURCES.md (pin cdd28c98) unchanged. Its run on the merged branch, against the 1e8d9f8 run (outcome ec8af832), changes 12 transient analyses and no status, signal list or non-transient analysis; ngspice/mesa-oscillator is unchanged. Gains: corpus-e/bjt-rtl-inverter-chain (170 to 179 points, ngspice 80) worst v(3) 0.5997 to 0.2940 V (RMS 0.196 to 0.131 V) and v(2) 0.2140 to 0.1190 V, abs RMS down on 6 of 8, which removes the #463 loss attributed to #469 above (the PULSE in that deck omits PER, so before #483 it had no breakpoints); ngspice/mos-amplifier-transient and classic/mos-amplifier worst v(6) 4.805 to 4.784 V, v(9) 1.118 to 1.100 V, abs RMS down on 12 of 24; classic/coupled-lossy-lines (3810 to 3917 points) worst 0.866 V v(x3.3) to 0.845 V v(x3.1), abs RMS down on 29 of 47, and v(5) rel max 248284946174.52246 to 231274507458.05075 (rel RMS 5233588211.050267 to 4829584075.03667), which lowers the relative envelope; classic/lossy-line-24-inch (3143 to 3289 points) v(2) 1.1353 to 1.1153 V, abs RMS down on 2 of 3; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger abs RMS down on 8 of 10 at an unchanged 0.770 V worst; classic/rtl-inverter-chain (234 to 210 points) v(5) RMS 0.1448 to 0.1363 V. Published losses: ngspice/rc-transient and classic/rc-transient (79 to 107 points, ngspice 86) v(2) and i(vin) abs max 6.89e-4 to 1.67e-3 (RMS 2.15e-4 to 3.91e-4) and v(2) rel max 0.0143 to 0.327, after omitted PULSE TR/TF default to TSTEP as in ngspice vsrcload.c (PR #483 reports the error against the closed-form answer falls from 7.6e-4 to 2.3e-4 V, against 2.4e-4 V for ngspice, so this is a matched-point loss against ngspice only); corpus-e/bjt-rtl-inverter-chain v(5) 0.2434 to 0.2821 V; ngspice/mos-amplifier-transient and classic/mos-amplifier v(5) abs max 4.494 to 4.571 V and v(4) 1.266 to 1.276 V, abs RMS up on 9 of 24; classic/lossy-line-24-inch v(3) 1.1039 to 1.1224 V (now its worst) and v(2) rel max 15.4 to 19.1; classic/coupled-lossy-lines abs RMS up on 12 of 47 and v(x3.4) rel max 187 to 525; classic/mos-memory-cell (143 to 152 points) abs RMS up on 8 of 13 (v(4) rel max 0.578 to 0.701); classic/rtl-inverter-chain abs RMS up on 4 of 8 (v(3) 0.1147 to 0.1213 V). corpus-e/bjt-schmitt-trigger, which ngspice cannot parse (no comparison), moves from 3210 to 3212 spice-ts transient points. Absolute samples change from 9,010,095 to 9,014,923, relative samples from 8,983,151 to 8,987,523, and excluded zero references from 26,944 to 27,400. The absolute envelope (7175.34033203125) is unchanged; without the PZ rows the worst absolute max is now 4.784 V on ngspice/mos-amplifier-transient v(6) and the worst absolute RMS 2.334 V on its v(5). Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), and coverage at 70 analyses across 51 fixtures and 969/933 signals. No fixture, tolerance or harness logic changed.',
    'VBIC per-junction pnjlim and DC-sweep gmin fallback through substrate latch-up (#472, PR #512, main 6ce5b1b), merged after the 96a9039 run above, leaves benchmarks/SOURCES.md (pin cdd28c98) unchanged. Its run on the merged branch, against the 96a9039 run (outcome 6616f7d6), changes only the two VBIC fixtures; no status, grid, signal list or sample count changes, and every other fixture reproduces exactly. Gains: ngspice/vbic-common-emitter-ac PZ abs error falls on 12 of 13 poles and zeros (pole(2) 4757.49 to 4755.42, pole(3) and pole(4) 69.489 to 68.593, pole(5) 159.51 to 159.40, zero(1) 7022.01 to 7021.92, zero(3) and zero(4) 1607.941 to 1607.932, the others at about 1e-5 relative); its AC abs max and abs RMS fall on 5 of 6 signals (i(vmeas) 2.872996e-6 to 2.872988e-6 A, v(1) 1.208172e-4 to 1.208169e-4 V); ngspice/vbic-fo i(vc) abs max 6.714775452613e-6 to 6.714775452596e-6 A (abs RMS down 7e-19 A). Published losses: ngspice/vbic-fo i(v1) and i(vb) abs RMS 2.2510101662138e-7 to 2.2510101662194e-7 A (+6e-19 A, rounding level, abs max unchanged); ngspice/vbic-common-emitter-ac PZ pole(1) abs error 7175.34033203125 to 7853.15771484375 (relative 6.14e-9 to 6.72e-9), which raises the absolute max and absolute RMS envelope to 7853.15771484375 (a single-point PZ signal, so max equals RMS) and supersedes the 7175.34033203125 envelope stated above; its AC v(3) abs max 9.11e-10 to 1.20e-9 V (abs RMS 2.228e-10 to 2.284e-10 V; v(3) has a zero reference, so no relative metric); and AC i(vcc) relative max 1.06306e-7 to 1.06320e-7 at a slightly lower abs max (4.568421e-8 to 4.568409e-8 A). The relative envelope (classic/coupled-lossy-lines v(5)) is unchanged; without the PZ rows the worst absolute max stays 4.784 V on ngspice/mos-amplifier-transient v(6) and the worst absolute RMS 2.334 V on its v(5). Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), coverage at 70 analyses across 51 fixtures and 969/933 signals, and matched samples at 9,014,923 absolute and 8,987,523 relative. No fixture, tolerance or harness logic changed.',
    'Merged after the 6ce5b1b run above, bisected the same way: one full 100-fixture run per main commit with this branch head c8018ec merged in. The issue #63 agent-workflow CI tests (#63, PR #515, main c9d04b3) touch only examples, docs and the lockfile: aggregate-report.ts --check passes unchanged on that merge (outcome 023dc75d). ngspice parenthesised source waveforms and PULSE NP (#492, PR #523, main dc4557f) adds a benchmarks/SOURCES.md entry, so the pin moves from cdd28c98 to 8fa511b0; with that pin its run reproduces every per-fixture metric, grid and status of the c8018ec run, because no corpus deck uses the new syntax. The static trapezoidal history kept under source breakpoints (#482, PR #522, main a8c90e8) changes 12 transient analyses and no status, signal list or non-transient analysis. Gains: ngspice/mesa-oscillator (3861 to 1348 points, ngspice 201) worst 0.3582 V v(4) to 0.2901 V v(8), abs max and abs RMS down on 36 of 37 signals (v(4) RMS 0.101 to 0.057 V), which shrinks the #463 start-up phase loss; ngspice/mos6-inverter-transient and classic/mos6-inverter-chain (912 to 822 points, ngspice 315) worst v(xndinv3.14) 0.3261 to 0.2921 V, abs max down on 39 and abs RMS on 42 of 44 signals (v(43) 0.0724 to 0.0110 V, v(5) 0.0752 to 0.0196 V, v(42) rel max 1.945e5 to 218), which shrinks the #479 loss; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger (3227 to 204 points, ngspice 135) worst v(6) 0.770 to 0.758 V (RMS 0.277 to 0.201 V, rel max 2378 to 287), abs RMS down on 7 of 10; classic/lossy-line-aluminium (3976 to 6387 points) abs RMS down on 260 of 261 signals at an unchanged 1.3472 V v(3) worst; corpus-e/mos1-inverter-sweep TRAN v(5) 0.0475 to 0.00451 V and i(vdd) 5.81e-5 to 5.16e-5 A at an unchanged 0.836 V v(3) worst; ngspice/ltra-line-transient (665 to 662 points) v(3) 0.4162 to 0.4126 V; ngspice/mos-amplifier-transient and classic/mos-amplifier (698 to 442 points) v(5) abs max 4.571 to 4.521 V, v(6) RMS 1.949 to 1.736 V and v(16) RMS 1.005 to 0.769 V. Published losses: classic/coupled-lossy-lines (3917 to 5972 points) worst 0.845 V v(x3.1) to 0.865 V v(x3.3), abs max up on 29 and abs RMS on 32 of 47 signals (v(2) 0.321 to 0.495 V, v(5) 0.426 to 0.517 V), and v(5) rel max 231274507458.05075 to 535751686335.6694 (rel RMS 4829584075.03667 to 7807328392.665471), which raises the relative envelope; classic/lossy-line-24-inch (3289 to 3380 points) v(2) abs max 1.115 to 1.414 V (now its worst; RMS 0.174 to 0.204 V), v(3) 1.122 to 1.210 V and v(3) rel max 183 to 858; ngspice/mos-amplifier-transient and classic/mos-amplifier worst v(6) 4.784 to 4.806 V and abs RMS up on 12 of 24 (v(5) 2.334 to 2.345 V); ngspice/mos6-inverter-transient and classic/mos6-inverter-chain v(xndinv4.14) rel max 20.5 to 126 at a lower 0.275 V abs max; ngspice/ltra-line-transient v(2) abs RMS 0.0719 to 0.0816 V; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger v(4) 0.1158 to 0.1180 V; classic/lossy-line-aluminium abs max up on 63 signals by at most 1.1e-12 V. corpus-e/bjt-schmitt-trigger, which ngspice cannot parse (no comparison), moves from 3212 to 167 spice-ts transient points. Absolute samples change from 9,014,923 to 9,568,125, relative samples from 8,987,523 to 9,530,324, and excluded zero references from 27,400 to 37,801. The absolute envelope (7853.15771484375, vbic-common-emitter-ac pole(1)) is unchanged; without the PZ rows the worst absolute max is now 4.806 V on ngspice/mos-amplifier-transient v(6) and the worst absolute RMS 2.345 V on its v(5). Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), and coverage at 70 analyses across 51 fixtures and 969/933 signals, through all three merges. No fixture, tolerance or harness logic changed. BJT AREA=/M=/positional area and the typed diode thermal-node form (#490, PR #527, main 7a0a486), merged next, leaves benchmarks/SOURCES.md (pin 8fa511b0) unchanged: its run on the merged branch reproduces outcome c6f33703 of the a8c90e8 run exactly, so it is outcome-neutral (no corpus deck uses those forms).',
    'Merged after the 7a0a486 run above (PR #470 head 0eeb242, outcome c6f33703), bisected the same way: one full 100-fixture run per main commit with 0eeb242 merged in (git merge --no-commit in throwaway worktrees). MOS1-3 defaults matching ngspice-47, with TOX/NSUB-derived KP and VTO (PR #534, main 5967c02, outcome 3fa89735), changes only ngspice/mos-amplifier-transient and classic/mos-amplifier (same deck, 442 to 435 points, ngspice 2429). Gains: abs RMS down on 9 of 24 signals, v(12) 1.170 to 0.093 V, v(11) 0.720 to 0.183 V, v(7) 0.757 to 0.228 V, v(13) 0.969 to 0.428 V, v(4) 1.270 to 0.767 V, v(10) 2.152 to 1.254 V, v(16) 2.731 to 2.159 V and i(vin) rel max 481.9 to 189.4. Published losses: abs RMS up on 12 of 24; the worst abs max moves from 4.806 V v(6) to 5.255 V v(5) (v(5) RMS 2.345 to 2.897 V), v(6) 4.806 to 5.053 V, v(1) 1.837 to 2.379 V, v(9) 1.093 to 1.374 V, i(vccp) 3.60e-3 to 4.52e-3 A and v(8) rel max 225.9 to 971.3. The ngspice-47 LTRA convolution model for O elements (#520, PR #536, main e029152, outcome 546f7478) changes only the three LTRA transients and drops the internal line nodes from the spice-ts signal lists. Gains: ngspice/ltra-line-transient (662 to 599 points, ngspice 497) worst v(3) 0.4126 to 0.0880 V, v(2) 0.342 to 0.084 V (RMS 0.0816 to 0.0098 V), v(3) rel max 31.0 to 0.93, abs RMS down on 4 of 6; classic/lossy-line-24-inch (3380 to 2488 points) worst 1.414 V v(2) to 0.494 V v(3), v(2) 1.414 to 0.368 V, v(3) 1.210 to 0.494 V and v(3) rel max 858 to 113; classic/coupled-lossy-lines (5972 to 3141 points) worst 0.865 to 0.816 V v(x3.3), abs RMS down on 39 of 47, v(5) 0.517 to 0.058 V, v(2) 0.495 to 0.115 V, and v(5) rel max 535751686335.6694 to 190231.44 (rel RMS 7807328392.665471 to 7661.09). That removes the relative envelope loss published for #522: the relative envelope falls to 1075904.729730855 (ngspice/mos6-inverter-transient v(xndinv2.32), unchanged by these merges) and the relative RMS envelope to 201300.57592313777 (ngspice/hfet-inverter i(vdd), also unchanged). Published losses: ngspice/ltra-line-transient i(vs) abs RMS 5.524e-7 to 5.600e-7 A; classic/coupled-lossy-lines v(x1.21) 0.0136 to 0.0141 V (RMS 6.66e-4 to 9.89e-4 V) and i(v1) rel max 14.0 to 26.9 at a lower abs max. Analysis commands run from .control blocks (#489, PR #516, main d8a5d41) reproduces outcome 546f7478 exactly, so it is outcome-neutral. BJT default IS=1e-16 and the kT/q thermal voltage for ngspice-47 parity (#519/#525, PR #540, main 5aa704d, outcome 0c36526c) changes 23 analyses on 14 fixtures and no status. Gains: classic/rca3040-wideband-amplifier DC worst 0.2383 V v(12) to 0.0638 V v(15) and TRAN 0.3386 V v(14) to 0.2563 V v(15), abs RMS down on 18 and 19 of 21; classic/rtl-inverter-chain DC v(5) 1.803 to 0.0035 V and TRAN worst 0.2846 V v(5) to 0.0880 V v(3) (210 to 203 points); corpus-e/bjt-rtl-inverter-chain DC v(5) 1.801 to 0.0019 V, OP 0.1187 V to 4.6e-8 V and TRAN worst v(3) 0.2940 to 0.0880 V; classic/bjt-differential-pair TRAN worst 0.1194 to 0.0059 V; corpus-e/bjt-diffpair-transient OP 0.1194 V to 5.2e-7 V and TRAN 0.1202 to 0.0334 V; corpus-e/bjt-diffpair-current-source AC 0.517 V to 2.7e-5 V, OP 0.1194 V to 5.0e-7 V and TRAN 0.1309 to 0.0339 V (228 to 238 points); xyce/npn-dc v(1) 0.1192 V to 5.4e-4 V; xyce/pnp-dc v(3) 1.19e-3 to 9.8e-4 V; classic/bjt-noise onoise_total rel max 4.886e-4 to 1.23e-7; ngspice/jimi-fuzz OP worst 6.71e-4 to 3.5e-8 V; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger (204 to 210 points) v(6) 0.7580 to 0.7573 V, abs RMS down on 9 of 10; classic/coupled-lossy-lines v(5) rel max 190231.44 to 178278.03. Published losses: classic/rca3040-wideband-amplifier AC v(14) abs max 1.017 to 1.775 V (RMS 0.521 to 1.382 V), with v(15), v(16) and v(17) moving the same way, while their relative max falls (v(14) 0.0285 to 0.0220); its TRAN i(vin) rel max 19.3 to 290; classic/coupled-lossy-lines worst 0.816 V v(x3.3) to 0.927 V v(x3.1) and abs RMS up on 34 of 47 (v(x3.2) rel max 18.9 to 546); classic/lossy-line-24-inch v(3) 0.494 to 0.512 V and v(2) 0.368 to 0.383 V (RMS 0.054 to 0.064 V, rel max 13.0 to 71.6); ngspice/jimi-fuzz TRAN (567405 to 567030 points) v(11) 3.656 to 3.662 V and v(3)/v(9) rel max 2.49e4 to 6.38e4; classic/bjt-differential-pair v(3) rel max 3.6 to 28.3 at a lower abs max; corpus-e/bjt-diffpair-transient v(2) abs RMS 5.03e-4 to 5.67e-4 V. corpus-e/bjt-diffpair-ac, which ngspice cannot run (no comparison), moves from 100 to 99 spice-ts transient points. The ahkab and Gnucap SPICE3 translation corpora (#524, PR #535 main 670acce and PR #533 main fbbbe85) add corpora outside the five aggregate corpora and leave the fixture tree pin unchanged; #533 adds a benchmarks/SOURCES.md section, so the pin moves from 8fa511b0 to 2552da00, and the run on the fbbbe85 merge reproduces every per-fixture metric, grid and status of the 5aa704d run. Absolute samples change from 9,568,125 to 9,427,074, relative samples from 9,530,324 to 9,400,650, and excluded zero references from 37,801 to 26,424. The absolute envelope (7853.15771484375, vbic-common-emitter-ac pole(1)) is unchanged; without the PZ rows the worst absolute max is now 5.255 V and the worst absolute RMS 2.897 V, both on ngspice/mos-amplifier-transient v(5). Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), and coverage at 70 analyses across 51 fixtures and 969/933 signals, through all six merges. No fixture, tolerance or harness logic changed.',
    'Merged after the fbbbe85 run above (PR #470 head 969d955, outcome 9d9321d6, squash-merged as 38acdbb with an identical tree), bisected with one full 100-fixture run per main commit in throwaway worktrees, each with only the SOURCES.md pin set to that commit\'s catalogue. The Xyce SPICE3 translation corpus (#524 lane 3, PR #537, main fdc3af6) adds a corpus outside the five aggregate corpora and a benchmarks/SOURCES.md section, so the pin moves from 2552da00 to 33b51481; its run reproduces every per-fixture metric, grid and status of the fbbbe85 run. The typed UnsupportedModelTypeError for unsupported .model types (#509, PR #542, main 327aa28) reproduces them too; it changes only the spice-ts error text of corpus-d/pwm-switch, which stays unsupported (the HIGH_SW .model card is now rejected before the S device card) and is excluded from the deterministic projection. LU factor reuse when the matrix is bit-identical (#486, PR #541, main 5589ab1) also reproduces every per-fixture metric, grid and status exactly (outcome c703b84a with pin 33b51481), so all three merges are outcome-neutral. The mcp lifecycle-script fix (#517, PR #546, main 21eea3e) reproduces outcome c703b84a exactly. The ngspice first transient step at the t = 0 breakpoint (#532, PR #545, main 7b8a1ba, outcome b682fde3) changes 25 transient analyses on 25 compared fixtures, and the spice-ts output of 9 fixtures that ngspice cannot run (no comparison); no status, signal list or non-transient analysis changes. Gains: classic/bjt-differential-pair abs RMS down on 10 of 12 (v(2) 6.35e-4 to 1.79e-4 V, i(vin) 6.54e-7 to 1.36e-7 A); classic/coupled-lossy-lines worst 0.9272 V v(x3.1) to 0.8275 V v(x3.3) (v(x3.1) 0.927 to 0.727 V), abs RMS down on 32 of 47; classic/lossy-line-24-inch v(3) 0.5115 to 0.4979 V and v(2) 0.3828 to 0.3745 V; classic/rca3040-wideband-amplifier TRAN worst 0.2563 V v(15) to 0.2304 V v(14), abs RMS down on 16 of 21; ngspice/ltra-line-transient v(2) 0.0842 to 0.0768 V, abs RMS down on 5 of 6; ngspice/mos6-inverter-transient and classic/mos6-inverter-chain worst v(xndinv3.14) 0.2921 to 0.2849 V; ngspice/mesa-oscillator worst v(8) 0.2901 to 0.2889 V, abs max down on 35 of 37; classic/lossy-line-aluminium abs RMS down on 236 of 261; classic/rtl-inverter-chain v(5) RMS 2.87e-3 to 2.62e-3 V; corpus-e/bjt-rtl-inverter-chain abs RMS down on 7 of 8; the relative max envelope falls from 1075904.729730855 to 975815.5539797375 (ngspice/mos6-inverter-transient v(xndinv2.32)). Published losses: ngspice/mos-amplifier-transient and classic/mos-amplifier worst v(5) 5.255 to 5.300 V and v(6) 5.053 to 5.083 V, abs max up on 17 of 24 (abs RMS down on 17); ngspice/schmitt-trigger and classic/ecl-schmitt-trigger v(6) 0.7573 to 0.7638 V and v(7) 0.7110 to 0.7153 V; ngspice/rc-transient and classic/rc-transient v(2) and i(vin) 1.665e-3 to 1.720e-3 (RMS 3.91e-4 to 4.07e-4) on 107 to 109 points; ngspice/mos6-inverter-transient and classic/mos6-inverter-chain abs RMS up on 36 of 44 signals (i(vin) 1.04e-5 to 1.14e-5 A, RMS 7.93e-7 to 8.65e-7 A; v(42) rel max 218 to 1220); corpus-e/bjt-diffpair-transient v(5) 0.0334 to 0.0346 V and v(4) 0.0326 to 0.0338 V; classic/mos-memory-cell v(4) 0.0160 to 0.0172 V; corpus-e/mos1-inverter-sweep TRAN abs RMS up on 7 of 9 at a 0.8361 to 0.8363 V v(3) worst; ngspice/hfet-inverter i(vin) 1.513e-3 to 1.546e-3 A; ngspice/jimi-fuzz v(3) and v(9) rel max 6.38e4 to 3.59e5; and the relative RMS envelope rises from 201300.57592313777 to 203361.3440880642 (ngspice/hfet-inverter i(vdd)). Gummel-Poon iterate-relative junction limiting and the substrate junction (#538/#539, PR #550, main 2a8112c, outcome 75420c0c) changes 24 analyses on 14 BJT fixtures and no status or signal list. Gains: classic/coupled-lossy-lines (3165 to 3098 points) abs RMS down on 38 of 47 (v(2) 0.1220 to 0.0472 V, v(4) 0.1426 to 0.0256 V, v(5) rel max 2.99e5 to 32.1, i(vcc) 3.87e-3 to 2.47e-3 A); classic/lossy-line-24-inch (2529 to 2429 points) v(3) 0.4979 to 0.4559 V and v(2) 0.3745 to 0.3005 V; corpus-e/bjt-diffpair-transient and corpus-e/bjt-diffpair-current-source OP v(5) 5.17e-7 and 4.98e-7 to 4.03e-7 and 3.85e-7 V; corpus-e/bjt-rtl-inverter-chain OP v(3) 8.4e-9 to 4.2e-9 V. Published losses: classic/coupled-lossy-lines worst v(x3.3) 0.8275 to 0.8435 V and i(v1) 1.16e-4 to 1.25e-4 A; classic/lossy-line-24-inch v(3) rel max 6.05 to 8520 and v(2) rel max 250 to 693; classic/bjt-noise onoise_spectrum abs max 2.58e-14 to 3.38e-14 (rel max 1.58e-7 to 2.07e-7) and onoise_total 6.37e-12 to 9.83e-12 (rel 1.23e-7 to 1.91e-7); ngspice/jimi-fuzz TRAN i(v_v2) rel max 4198 to 2.38e5; ngspice/schmitt-trigger and classic/ecl-schmitt-trigger abs max up on 7 of 10 at an unchanged 0.7638 V worst; classic/rtl-inverter-chain DC, xyce/npn-dc and corpus-e/bjt-rtl-inverter-chain DC abs RMS up on 6 of 8 signals at unchanged worst values. Absolute samples change from 9,427,074 to 9,437,401 (#545) and then 9,433,536 (#550), relative samples from 9,400,650 to 9,410,774 and then 9,407,172, and excluded zero references from 26,424 to 26,627 and then 26,364. The absolute envelope (7853.15771484375, vbic-common-emitter-ac pole(1)) is unchanged; without the PZ rows the worst absolute max is now 5.300 V and the worst absolute RMS 2.893 V, both on ngspice/mos-amplifier-transient v(5). Engine totals stay at 52/9/39 (ngspice) and 63/1/36 (spice-ts), and coverage at 70 analyses across 51 fixtures and 969/933 signals, through all six merges. No fixture, tolerance or harness logic changed.',
    'MOS level-1 body effect, signed VTO and LD, with a typed UnsupportedModelLevelError for unimplemented MOSFET levels (#530, PR #552, main 2812371, outcome 3c88e414), merged after the 2a8112c run above, adds a benchmarks/SOURCES.md section and re-pins SOURCES_SHA256 to d4a0994d on main; its run with that pin, against the 2a8112c run (outcome 75420c0c), changes 8 fixtures. ngspice/mos-amplifier-transient, classic/mos-amplifier (LEVEL=2), classic/bsim1-device-sweep (LEVEL=4) and classic/bsim2-device-sweep (LEVEL=5) move from success to unsupported (status transitions above, follow-up #565), removing 4 analyses, 96 absolute and 92 relative signals; the published 5.300 V v(5) mos-amplifier loss leaves the report because the fixture is no longer simulated, not because it was fixed. Gains: classic/mos-memory-cell (155 points) worst 1.906 V v(8) to 0.248 V v(3), with v(8) 1.906 to 0.0831 V, v(3) 1.875 to 0.248 V, v(5) 1.861 to 0.0284 V and v(6) 0.0518 to 0.0150 V, abs max down on 8 of 13 signals. Published losses: classic/mos-memory-cell abs RMS up on 6 of 13 signals (v(4) 6.41e-3 to 6.79e-3 V) and i(vdd) abs max 6.42e-5 to 6.72e-5 A. ngspice/ltra-line-transient, xyce/nmos-level1-dc and corpus-e/mos1-inverter-sweep change only at rounding level (no abs max or abs RMS moves by more than 0.84%). Engine totals move from 63/1/36 to 59/1/40 (spice-ts) with ngspice unchanged at 52/9/39, and coverage from 70 analyses across 51 fixtures to 66 across 47 and from 969/933 to 873/841 signals. Absolute samples change from 9,433,536 to 9,388,320, relative samples from 9,407,172 to 9,364,374, and excluded zero references from 26,364 to 23,946. The absolute envelope (7853.15771484375, vbic-common-emitter-ac pole(1)) and the relative envelopes (975815.5539797375 and 203361.3440880642) are unchanged; without the PZ rows the worst absolute max is now 3.663 V on ngspice/jimi-fuzz TRAN v(11) and the worst absolute RMS 1.619 V on ngspice/hfet-inverter v(4). No fixture, tolerance or harness logic changed.',
    'Merged after the 2812371 run above, bisected the same way. The VDMOS power MOSFET model (#506, PR #562, main a32f755) leaves benchmarks/SOURCES.md (pin d4a0994d) unchanged, and its run reproduces outcome 3c88e414 of the 2812371 run exactly, so it is outcome-neutral (no corpus deck uses a VDMOS card). XSPICE A elements with the gain, summer, mult, divide, pwl, limit, int and d_dt code models (#487, PR #554, main 0e1aeb4) add a benchmarks/SOURCES.md section, so the pin moves from d4a0994d to fa95e5d0 (main itself still pins d4a0994d, so --check fails on 0e1aeb4 alone on the pin); with that pin its run (outcome 8a19a9d7) reproduces every per-fixture metric, grid and status of the a32f755 run, and only the pin moves the outcome hash. Engine totals, coverage, signal and sample counts and every envelope are unchanged by both merges. No fixture, tolerance or harness logic changed.',
    'Merged after the 0e1aeb4 run above, bisected the same way (pin fa95e5d0; of these eight merges only #571 touches benchmarks/SOURCES.md). Gummel-Poon CKTgmin junction currents and the ngspice reverse junction law (#551/#525, PR #564, main a55f854, outcome d428d47d) changes 24 analyses on 14 BJT fixtures and no status, signal list or envelope. Gains: corpus-e/bjt-diffpair-transient OP worst 4.03e-7 V v(5) to 1.04e-8 V v(6) (v(5) 4.03e-7 to 1.16e-9 V, i(vcc) 8.06e-11 to 2.32e-13 A); corpus-e/bjt-diffpair-current-source OP worst 3.85e-7 to 1.94e-8 V and AC v(5) 2.707e-5 to 2.356e-5 V, AC abs RMS down on 9 of 12; corpus-e/bjt-rtl-inverter-chain OP worst 4.62e-8 V v(2) to 8.0e-9 V v(5); classic/rtl-inverter-chain and corpus-e/bjt-rtl-inverter-chain DC i(vin) rel max 44.6 and 1.62 to 4.9e-4 and 9.4e-4, and TRAN v(2) rel max 1.000 to 0.061 at unchanged abs max; ngspice/jimi-fuzz OP abs max down on 6 of 13 (v(8) 4.31e-9 to 1.53e-9 V) and TRAN i(v_v2) rel max 2.38e5 to 1.44e4; classic/coupled-lossy-lines abs RMS down on 28 of 47 (v(4) 0.0256 to 0.0244 V, i(v1) 1.247e-4 to 1.151e-4 A); classic/lossy-line-24-inch v(3) rel max 8520 to 8.24 and v(2) rel max 693 to 20.1 (v(2) abs RMS 0.0415 to 0.0398 V); ngspice/schmitt-trigger and classic/ecl-schmitt-trigger abs max down on 8 of 10 at an unchanged 0.7638 V worst. Published losses: classic/bjt-noise onoise_spectrum abs max 3.38e-14 to 4.97e-14 (rel max 2.07e-7 to 3.05e-7), inoise_spectrum 9.21e-17 to 1.34e-16 and onoise_total 9.83e-12 to 1.32e-11 (rel 1.91e-7 to 2.56e-7); classic/lossy-line-24-inch (2429 to 2396 points) v(3) 0.4559 to 0.4698 V and v(2) 0.3005 to 0.3094 V; classic/coupled-lossy-lines (3098 to 3084 points) worst v(x3.3) 0.8435 to 0.8457 V, abs max up on 16 of 47, v(2) rel max 16.0 to 768 and v(5) rel max 32.1 to 206; ngspice/jimi-fuzz TRAN (566974 to 567015 points) worst v(11) 3.6634 to 3.6641 V, abs RMS up on 12 of 13 and v(3)/v(9) rel max 1.92e4 to 6.70e4, and its OP v(11) 3.39e-8 to 3.47e-8 V; corpus-e/bjt-diffpair-transient and corpus-e/bjt-diffpair-current-source OP v(6) 7.50e-9 to 1.04e-8 V; classic/rca3040-wideband-amplifier AC abs RMS up on 15 of 21 at an unchanged 1.775 V v(14) worst. Absolute samples change from 9,388,320 to 9,388,096, relative samples from 9,364,374 to 9,364,215, and excluded zero references from 23,946 to 23,881. Transient recording from the solution vector (#548, PR #556, main 1eafa79) and the ngspice-47 TXL (Y) and CPL (P) lossy lines (#491, PR #543, main 702faed) each reproduce outcome d428d47d exactly, so both are outcome-neutral (no aggregate deck uses a Y or P element). The issue-348 example snapshot refresh (#513, PR #557, main 54e1dcf) changes only examples/ and is outcome-neutral: this branch on 54e1dcf differs from the 702faed run only in ngspice/vbic-temperature. B-source V= expressions, ngspice expression operators and ASRC tc1/tc2 (#495, PR #563, main 0cd12dc) reproduce outcome d428d47d exactly, so it is outcome-neutral, and so does no trapezoidal history or LTE predictor from the UIC seed (#560, PR #569, main 85fe60d). The ngspice resistor card forms and .model R references (#498, PR #571, main 20146d5) add a benchmarks/SOURCES.md section, so the pin moves from fa95e5d0 to 596e6067; with that pin its run (outcome cf76a8af) reproduces every per-fixture metric, grid and status of the 85fe60d run, and only the pin moves the outcome hash (the spice-ts error text of corpus-d/pwm-switch now lists R among the supported .model types; it stays unsupported and error text is outside the projection). The .ac lin 2 single-point grid (#555, PR #567, main a4a57f9) reproduces outcome cf76a8af exactly, so it is outcome-neutral. Engine totals (59/1/40 spice-ts, 52/9/39 ngspice), coverage (66 analyses across 47 fixtures, 873/841 signals) and every envelope are unchanged by these eight merges; without the PZ rows the worst absolute max is now 3.664 V on ngspice/jimi-fuzz TRAN v(11). No fixture, tolerance or harness logic changed.',
    '.OPTIONS TEMP with the ngspice-47 VBIC temperature mapping (#459, this branch on main a4a57f9, pin 649db81a after its SOURCES.md section), run against the a4a57f9 run (outcome cf76a8af), changes only ngspice/vbic-temperature (status transition above): one DC analysis of 6 signals and 101 aligned points; no other fixture, grid, status or envelope changes. Signals change from 873 to 879 absolute and from 841 to 847 relative, absolute samples from 9,388,096 to 9,388,702 and relative samples from 9,364,215 to 9,364,821; excluded zero references stay at 23,881. Engine totals move from 59/1/40 to 60/1/39 (spice-ts) with ngspice unchanged at 52/9/39, and coverage from 66 analyses across 47 fixtures to 67 across 48. No fixture, tolerance or harness logic changed.',
    'Merged after the a4a57f9 run above (#577), bisected the same way: one full 100-fixture run per main commit in a throwaway worktree, each with only the SOURCES.md pin set to that commit\'s catalogue (596e6067 before #465, 649db81a from #465 on; no other merge touches benchmarks/SOURCES.md, so main pins 649db81a and needs no re-pin). Structural column singletons pivoted first in Gilbert-Peierls LU (#568, PR #572, main fcb2fee, outcome f276fb19, against outcome cf76a8af of the a4a57f9 run) changes LU pivot order and therefore last-digit rounding on 14 fixtures: ngspice/jfet-vds-vgs, ngspice/rc-transient, classic/rc-transient, ngspice/mos6-simple-inverter-transient, ngspice/hfet-inverter, classic/lossy-line-aluminium, classic/mos-memory-cell, xyce/diode-sidewall-dc, xyce/nmos-level1-dc, xyce/rlc-transient, xyce/vccs-dc, xyce/vcvs-dc, corpus-e/diode-bias-sweep and corpus-e/mos1-inverter-sweep. No status, grid, point count, signal list, sample count or envelope changes. Of the 91 absolute max/RMS metrics that move, 46 fall (gains) and 45 rise (published losses); each moves by less than 1e-10 relative, or is a machine-epsilon error of at most 4.71e-14 (for example xyce/diode-sidewall-dc v(1) and v(2) abs max 2.22e-16 V to exactly 0, classic/mos-memory-cell v(2) abs max 6.66e-16 to 1.11e-15 V, corpus-e/mos1-inverter-sweep TRAN v(2) 3.11e-15 to 3.55e-15 V, ngspice/rc-transient and classic/rc-transient v(1) 2.22e-16 to 1.11e-16 V). The docs-only #514 change (PR #575, main 3fc4885) is outcome-neutral. Typed errors for unsupported or mismatched .model types via the Circuit API and JSON protocol (#544, PR #573, main d22d905) reproduces outcome f276fb19 exactly, so it is outcome-neutral. .OPTIONS TEMP with the ngspice-47 VBIC temperature mapping (#459, PR #465, main f85bf35, outcome 04034bfd) changes only ngspice/vbic-temperature, exactly as published above for its branch: unsupported to success, one DC analysis of 6 compared signals. The resistor with no resistance defaulting to 1 mOhm like ngspice-47 (#574, PR #576, main 93987d0) reproduces outcome 04034bfd exactly (no aggregate deck has a value-less resistor), so it is outcome-neutral. Engine totals stay at 52/9/39 (ngspice) and 60/1/39 (spice-ts), coverage at 67 analyses across 48 fixtures and 879/847 signals, matched samples at 9,388,702 absolute and 9,364,821 relative, excluded zero references at 23,881, and every envelope is unchanged. No fixture, tolerance or harness logic changed.',
    'Merged after the #583 refresh (main a17758d, outcome 5684db4e), bisected with one full 100-fixture run on 85a4805 and on 8013a23, plus spice-ts runs of the two changed fixtures on every main commit in between (throwaway worktrees). Corpus-f batch 1 (#484, PR #529, main 2bd9938), .ic nodes held in the transient operating point without UIC (#531, PR #586, main bf2e416) and the ngspice-47 S/W switches (#507, PR #579, main 85a4805) are outcome-neutral together: the 85a4805 run with only the pins updated reproduces every per-fixture status, analysis, grid, point count, signal list and metric of the a17758d run. #529 makes runNativeSpiceTs in benchmarks/corpus/classic/report.ts accept a parseFirst option (default true, which the aggregate keeps), so the fixture tree pin moves from 13b4675c to d5327777; #579 adds a benchmarks/SOURCES.md section (pin 649db81a to f08dac8c), and RF port sources with .sp S-parameter analysis (#499, PR #585, main e2d384c) adds another and re-pins SOURCES_SHA256 to e9d9663c on main, which left only the fixture tree pin stale. The spice-ts error text of corpus-d/pwm-switch now lists SW and CSW among the supported .model types; it stays unsupported (HIGH_SW is not an ngspice switch type) and error text is outside the projection. ngspice quoted/brace numparam expressions, TEMPER and v() resistors (#493, PR #587, main 727b56e) and #585 leave both changed fixtures bit-identical to 85a4805. MOS1 depletion junction and Meyer gate charges integrated like ngspice (#590/#591, PR #601, main 46f4bc6) changes the outcome on two MOS1 transients only, and no status, signal list or envelope: the dotted BSIM version parsing (#503, PR #599, main cda916d) and precomputed resistor/capacitor stamp slots (#570, PR #580, main 8013a23) leave both bit-identical to 46f4bc6 (outcome 8f3485f9 on 8013a23). Gains: classic/mos-memory-cell (155 to 161 points, ngspice 150) worst 0.248 V v(3) to 1.40e-3 V v(4), with v(3) 0.248 to 4.54e-4 V (RMS 0.109 to 6.2e-5 V), v(8) 0.0831 to 9.8e-4 V, v(5) 0.0284 to 2.4e-4 V, v(6) 0.0150 to 1.2e-4 V, v(4) 0.0127 to 1.40e-3 V, i(vw) 3.32e-3 to 6.2e-6 A, i(vs) 7.66e-4 to 3.1e-6 A, i(vwb) 5.09e-4 to 1.8e-5 A, i(vdd) 6.72e-5 to 6.1e-7 A and i(vdd) rel max 15.7 to 0.17, which removes the #552 abs RMS and i(vdd) losses published above; ngspice/ltra-line-transient (611 to 613 points, ngspice 497) i(vs) 2.44e-6 to 9.4e-7 A (RMS 5.6e-7 to 5.3e-8 A), v(3) 0.0873 to 0.0868 V and i(vdd) 2.62e-4 to 2.59e-4 A. Published losses: ngspice/ltra-line-transient v(2) abs max 0.0768 to 0.0836 V (RMS 9.30e-3 to 9.71e-3 V), v(3) abs RMS 0.0153 to 0.0157 V and rel max 0.921 to 0.937, i(vs) rel max 1.0 to 26.2 at a lower abs max, i(vdd) rel max 1.000 to 1.014; classic/mos-memory-cell i(vwb) rel max 1.0003 to 1.0028; v(168) and the mos-memory-cell supply nodes move at machine-epsilon level (at most 8.2e-14 V). Absolute samples change from 9,388,702 to 9,388,792, relative samples from 9,364,821 to 9,364,906, and excluded zero references from 23,881 to 23,886. corpus-f .control decks scored against ngspice-47 wrapper vectors (#521, PR #610, main 3ac28da) and the BSIM3 drain/source interchange with the PMOS type*VTH0 threshold (#582, PR #605, main 3f26f10) are outcome-neutral: a full run on 3f26f10 merged into this branch reproduces every per-fixture status, grid, signal list and metric of the 8013a23 run (outcome 4a1a2d89); #605 adds a benchmarks/SOURCES.md section, so the pin moves from e9d9663c to a0fc235c. Engine totals stay at 52/9/39 (ngspice) and 60/1/39 (spice-ts), coverage at 67 analyses across 48 fixtures and 879/847 signals, and every envelope is unchanged. No fixture, tolerance or harness logic changed.',
    'Merged after the #613 refresh (main 4632b7b, outcome d0a5c915), bisected with one full 100-fixture run per main commit in a throwaway worktree, each with that commit\'s own harness and only the SOURCES.md pin set to that commit\'s catalogue. ngspice diagnostic, bypass and ramptime options (#494, PR #600, main 098da44) adds a benchmarks/SOURCES.md section (pin a0fc235c to 59d75744; main itself still pins a0fc235c). Its run (outcome dc5fd4bf) reproduces every per-fixture status, analysis, grid, point count, signal list and metric of the #613 run, so it is outcome-neutral. .pz with sources, active elements and differential pairs (#504, PR #614, main 7c66aab), transient result columns in a chunked typed buffer (#609, PR #617, main f5e9c5b) and the VDMOS inverter i(vdd) test pin (#596, PR #620, main 98d2d5d) each reproduce outcome dc5fd4bf exactly, so each is outcome-neutral on its own: the three pole-zero fixtures and every transient grid are unchanged. The ngspice control-language interpreter (#488, PR #584, main e58322e) adds another section (pin 59d75744 to 391461fe; main still pins a0fc235c) and changes only ngspice/ac-zero-frequency (status transition above): spice-ts goes from unsupported to success, ngspice stays failed, so no comparison, signal or sample is added. .global net resolution through subcircuit flattening (#502, PR #603, this branch merged with main e58322e) adds a benchmarks/SOURCES.md section for its six project-authored MIT probes, so the pin moves from 391461fe to 98991942. Its run reproduces every per-fixture status, analysis, grid, point count, signal list and metric of the e58322e run; no aggregate deck uses .global, so it is outcome-neutral. Engine totals move from 60/1/39 to 61/1/38 (spice-ts) with ngspice unchanged at 52/9/39. Coverage stays at 67 analyses across 48 fixtures and 879/847 signals, and every envelope is unchanged. No fixture, tolerance or harness logic changed.',
    'The runtime sums in the totals above are single samples on a shared, heavily loaded host. No spice-ts run hit the 120000 ms bound in this run. They are not comparable with the previous 77150.906 / 270491.926 ms sample and support no speed claim.',
  ],
};

const GAP_ISSUES = [
  { url: 'https://github.com/mfiumara/spice-ts/issues/76', scope: 'parser syntax, directives, expressions, and unsupported device cards' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/75', scope: 'noise, pole-zero, and distortion analyses' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/7', scope: 'transmission-line devices' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/5', scope: 'BJT model coverage' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/3', scope: 'MOS model coverage' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/123', scope: 'jimi-fuzz transient waveform divergence' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/280', scope: 'newly exposed classic-corpus execution failures and RCA3040 regression' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/366', scope: 'non-terminating xyce/inductor-transient simulation' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/391', scope: 'unmapped .disto results in the corpus harness (classic/diode-distortion now compared; see the ledger)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/427', scope: 'MOS1 inverter transient supply-current spike after #417 (closed by PR #436; residual mos1-inverter-sweep TRAN losses published in the ledger)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/432', scope: 'transient output emitted before .tran TSTART (closed by PR #440)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/451', scope: '.pz root-finder missed poles and zeros on wide-spread time constants (closed by PR #466; vbic-common-emitter-ac now matches ngspice\'s 7 poles and 6 zeros at relative error up to 1.2e-7)' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/468', scope: 'MOS6 (level 6) still uses the generic C(v) trapezoidal history instead of the #456 charge state' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/469', scope: 'charge-based LTE (ngspice CKTterr) for device charges; targets the post-#456 mesa-oscillator and bjt-rtl-inverter-chain step-control losses' },
  { url: 'https://github.com/mfiumara/spice-ts/issues/461', scope: 'trapezoidal ringing in source currents driving voltage-dependent capacitance (MOS6 i(vin) loss)' },
] as const;

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return paths.flat().sort();
}

async function provenance(root: string): Promise<AggregateReport['provenance']> {
  const fixtureFiles = (await Promise.all(
    CORPORA.map(corpus => filesBelow(resolve(root, `benchmarks/corpus/${corpus}`))),
  )).flat().sort();
  const fixtureTree = createHash('sha256');
  for (const path of fixtureFiles) {
    fixtureTree.update(relative(root, path));
    fixtureTree.update('\0');
    fixtureTree.update(await readFile(path));
    fixtureTree.update('\0');
  }
  return {
    fixtureTreeSha256: fixtureTree.digest('hex'),
    sourcesSha256: sha256(await readFile(resolve(root, 'benchmarks/SOURCES.md'))),
  };
}

async function readManifest(root: string, corpus: CorpusId): Promise<CorpusManifest> {
  return JSON.parse(
    await readFile(resolve(root, `benchmarks/corpus/${corpus}/manifest.json`), 'utf8'),
  ) as CorpusManifest;
}

const PREVIOUS_REPORT: AggregateReport['comparisonToPrevious'] = {
  issueUrl: 'https://github.com/mfiumara/spice-ts/issues/502',
  pullRequestUrl: 'https://github.com/mfiumara/spice-ts/pull/603',
  headSha: 'a91fd90db94c6f5fbfe1f53b420aa5d4298527f1',
  outcomeSha256: '4cb5cbd09a8045fbd35e337d44fcc7064175bfdd0521a85d477da768d08d063f',
  totals: {
    fixtures: 100,
    corpusFixtures: { ngspice: 20, classic: 20, xyce: 20, 'corpus-d': 20, 'corpus-e': 20 },
    ngspice: { success: 52, failed: 9, unsupported: 39 },
    spiceTs: { success: 61, failed: 1, unsupported: 38 },
    comparedFixtures: 48,
    comparedAnalyses: 67,
    runtimeMs: { ngspice: 6554.499, spiceTs: 27822.473 },
  },
  matchedPointEnvelope: {
    comparedSignals: 879,
    relativeComparedSignals: 847,
    absoluteSamples: 9388792,
    relativeSamples: 9364906,
    excludedZeroReferences: 23886,
    maximumAbsoluteError: 7853.15771484375,
    maximumAbsoluteRms: 7853.15771484375,
    maximumRelativeError: 975815.5539797375,
    maximumRelativeRms: 203361.3440880642,
  },
  statusTransitions: REFRESH_STATUS_TRANSITIONS.map(transition => ({ ...transition, gapIssues: [...transition.gapIssues] })),
  metricTransitions: [...REFRESH_METRIC_TRANSITIONS, ...HISTORICAL_REPORT.metricTransitions],
};

const REFRESH_GUIDANCE = 'If the change is intended, refresh with `pnpm exec tsx benchmarks/aggregate-report.ts`, '
  + 'update the pinned hashes in benchmarks/aggregate-report.ts, and commit the regenerated '
  + 'benchmarks/aggregate-report.json and benchmarks/AGGREGATE_PARITY.md.';

/**
 * Validates every aggregate input without running an engine, so stale provenance fails in
 * seconds instead of after all fixtures. Read-only: safe to run concurrently.
 */
export async function preflightAggregateInputs(root = resolve('.')): Promise<AggregateReport['provenance']> {
  for (const corpus of CORPORA) {
    const manifest = await readManifest(root, corpus);
    if (manifest.circuits.length !== FIXTURES_PER_CORPUS) {
      throw new Error(`${corpus}: expected ${FIXTURES_PER_CORPUS} fixtures, found ${manifest.circuits.length}`);
    }
    for (const circuit of manifest.circuits) {
      const digest = sha256(await readFile(resolve(root, circuit.localPath)));
      if (digest !== circuit.sha256) {
        throw new Error(
          `${corpus}/${circuit.id}: fixture SHA-256 mismatch for ${circuit.localPath} (manifest ${circuit.sha256}, actual ${digest})`,
        );
      }
    }
  }

  const actual = await provenance(root);
  const stale = [
    ['benchmarks/SOURCES.md', SOURCES_SHA256, actual.sourcesSha256],
    [`aggregate fixture tree (benchmarks/corpus/{${CORPORA.join(',')}})`, FIXTURE_TREE_SHA256, actual.fixtureTreeSha256],
  ].filter(([, pinned, current]) => pinned !== current);
  if (stale.length > 0) {
    const details = stale.map(([input, pinned, current]) => `${input} SHA-256 pinned ${pinned}, actual ${current}`);
    throw new Error(`aggregate provenance is stale: ${details.join('; ')}. ${REFRESH_GUIDANCE}`);
  }
  return actual;
}

/**
 * Publishes generated artifacts through per-run temporary files and atomic renames, so a
 * concurrent reader (for example another lane's --check) never observes a torn file.
 */
export async function writeAggregateArtifacts(
  paths: { jsonPath: string; markdownPath: string },
  json: string,
  md: string,
  transition?: { path: string; content: string },
): Promise<void> {
  const runId = `${process.pid}.${randomUUID()}`;
  const publish = async (path: string, content: string): Promise<void> => {
    const temporary = `${path}.${runId}.tmp`;
    try {
      await writeFile(temporary, content);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  // Publish the linked detail before the Markdown that references it.
  if (transition) {
    await mkdir(dirname(transition.path), { recursive: true });
    await publish(transition.path, transition.content);
  }
  await Promise.all([[paths.jsonPath, json], [paths.markdownPath, md]].map(([path, content]) => publish(path, content)));
}

function commandVersion(command: string, args: string[], pattern?: RegExp): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return 'unavailable';
  const output = `${result.stdout}\n${result.stderr}`;
  return pattern?.exec(output)?.[0] ?? output.trim().split(/\r?\n/).find(Boolean) ?? 'unknown';
}

function normalizeStatus(execution: EngineExecution, expected?: ExpectedStatus): Status {
  if (execution.status === 'success') return 'success';
  if (execution.status === 'unsupported' || expected?.failureKind === 'unsupported') return 'unsupported';
  return 'failed';
}

function receipt(
  execution: EngineExecution,
  expected: ExpectedStatus | undefined,
  runtimeMs: number,
  command: string[],
  digest: string,
): EngineReceipt {
  const value: EngineReceipt = {
    status: normalizeStatus(execution, expected),
    convergence: execution.convergence,
    runtimeMs: Number(runtimeMs.toFixed(3)),
    command,
    inputSha256: digest,
    analyses: execution.analyses.map(analysis => ({
      type: analysis.type,
      points: analysis.series.grid.length,
      signals: Object.keys(analysis.series.signals).sort(),
    })).sort((left, right) => left.type.localeCompare(right.type)),
  };
  if (execution.error) value.error = execution.error;
  return value;
}

function commonSignals(left: SampleSeries, right: SampleSeries): string[] {
  return Object.keys(left.signals).filter(signal => right.signals[signal] !== undefined).sort();
}

function measureInChunks(
  spiceTs: SampleSeries,
  ngspice: SampleSeries,
  signals: string[],
  options: AlignmentOptions = {},
): ComparisonMetrics {
  // Missing vectors cannot be sliced into chunks. Keep their coverage metrics,
  // including the zero-sample result for an empty target grid.
  if (spiceTs.grid.length === 0 || signals.some(signal => !Object.hasOwn(spiceTs.signals, signal) || !Object.hasOwn(ngspice.signals, signal))) return alignAndMeasure(spiceTs, ngspice, signals, options);
  // Preserve the whole nested coordinate space. Slicing only the target loses its reset ordinal
  // at a 25k boundary and falsely compares that slice with every reference group.
  if (spiceTs.secondaryGrid || ngspice.secondaryGrid || sweepSegments(spiceTs).length > 1 || sweepSegments(ngspice).length > 1) return alignAndMeasure(spiceTs, ngspice, signals, options);
  // Prepare the full reference once, not once per 25k target chunk (#1318).
  // Target chunks and their reduction order stay unchanged for exact metric parity.
  const reference = prepareAlignmentReference(ngspice);
  const chunkSize = 25_000;
  const chunks = Array.from({ length: Math.ceil(spiceTs.grid.length / chunkSize) }, (_, index) => {
    const start = index * chunkSize;
    const end = start + chunkSize;
    return alignAndMeasure({
      grid: spiceTs.grid.slice(start, end),
      signals: Object.fromEntries(signals.map(signal => [signal, spiceTs.signals[signal].slice(start, end)])),
    }, ngspice, signals, options, reference);
  });
  const comparedSignals: ComparisonMetrics['signals'] = {};
  for (const signal of signals) {
    const parts = chunks.map(chunk => chunk.signals[signal]);
    if (parts.some(part => part.status !== 'compared')) {
      comparedSignals[signal] = { status: 'missing', missingFrom: ['spice-ts'] };
      continue;
    }
    const values = parts.filter(part => part.status === 'compared');
    const absoluteCount = values.reduce((sum, value) => sum + value.sampleCount, 0);
    const relativeCount = values.reduce((sum, value) => sum + value.relativeError.sampleCount, 0);
    comparedSignals[signal] = {
      status: 'compared',
      sampleCount: absoluteCount,
      absoluteError: {
        max: Math.max(0, ...values.map(value => value.absoluteError.max)),
        rms: absoluteCount === 0 ? 0 : Math.sqrt(values.reduce(
          (sum, value) => sum + value.absoluteError.rms ** 2 * value.sampleCount,
          0,
        ) / absoluteCount),
      },
      relativeError: {
        max: relativeCount === 0 ? null : Math.max(...values.flatMap(value => value.relativeError.max === null ? [] : [value.relativeError.max])),
        rms: relativeCount === 0 ? null : Math.sqrt(values.reduce(
          (sum, value) => sum + (value.relativeError.rms ?? 0) ** 2 * value.relativeError.sampleCount,
          0,
        ) / relativeCount),
        sampleCount: relativeCount,
        excludedZeroReferences: values.reduce((sum, value) => sum + value.relativeError.excludedZeroReferences, 0),
      },
    };
  }
  return {
    grid: {
      spiceTsPoints: spiceTs.grid.length,
      ngspicePoints: ngspice.grid.length,
      alignedPoints: chunks.reduce((sum, chunk) => sum + chunk.grid.alignedPoints, 0),
      excludedOutOfRange: chunks.reduce((sum, chunk) => sum + chunk.grid.excludedOutOfRange, 0),
    },
    signals: comparedSignals,
  };
}

/**
 * Matches every spice-ts analysis with its ngspice counterpart. For transients the primary
 * metric does not interpolate ngspice across a breakpoint step it leaves unresolved (#445);
 * the pre-#445 linear metric is retained alongside it.
 */
export function compareExecutions(left: EngineExecution, right: EngineExecution): ComparisonReceipt[] {
  const comparisons: ComparisonReceipt[] = [];
  for (const { left: spiceAnalysis, right: ngspiceAnalysis } of pairPlots(left.analyses, right.analyses)) {
    if (!spiceAnalysis || !ngspiceAnalysis) {
      const own = (spiceAnalysis ?? ngspiceAnalysis)!;
      const unmatched = spiceAnalysis ? 'ngspice' : 'spice-ts';
      const signals = Object.keys(own.series.signals).sort();
      const metrics: ComparisonMetrics = {
        grid: { spiceTsPoints: spiceAnalysis?.series.grid.length ?? 0, ngspicePoints: ngspiceAnalysis?.series.grid.length ?? 0, alignedPoints: 0, excludedOutOfRange: spiceAnalysis?.series.grid.length ?? 0 },
        signals: Object.fromEntries(signals.map(signal => [signal, { status: 'missing', missingFrom: [unmatched] }])),
      };
      comparisons.push({ analysis: own.type, plot: { spiceTs: spiceAnalysis?.plotId ?? spiceAnalysis?.plotName, ngspice: ngspiceAnalysis?.plotId ?? ngspiceAnalysis?.plotName }, unmatched, signals, metrics, linearMetrics: metrics });
      continue;
    }
    const common = commonSignals(spiceAnalysis.series, ngspiceAnalysis.series);
    // A paired plot without shared signals is missing coverage, not absent.
    const signals = common.length ? common : [...new Set([...Object.keys(spiceAnalysis.series.signals), ...Object.keys(ngspiceAnalysis.series.signals)])].sort();
    comparisons.push({
      analysis: spiceAnalysis.type,
      ...(spiceAnalysis.plotId === undefined && ngspiceAnalysis.plotId === undefined && left.analyses.filter(a => a.type === spiceAnalysis.type).length === 1 ? {} : { plot: { spiceTs: spiceAnalysis.plotId ?? spiceAnalysis.plotName, ngspice: ngspiceAnalysis.plotId ?? ngspiceAnalysis.plotName, ngspiceIndex: right.analyses.indexOf(ngspiceAnalysis) } }),
      signals,
      metrics: measureInChunks(spiceAnalysis.series, ngspiceAnalysis.series, signals, {
        breakpoints: spiceAnalysis.type === 'tran'
          ? sharedGridPoints(spiceAnalysis.series.grid, ngspiceAnalysis.series.grid)
          : undefined,
      }),
      linearMetrics: measureInChunks(spiceAnalysis.series, ngspiceAnalysis.series, signals),
    });
  }
  return comparisons.sort((a, b) => a.analysis.localeCompare(b.analysis));
}

function gapIssues(circuit: CorpusCircuit): string[] {
  const text = `${circuit.category} ${circuit.analyses.join(' ')} ${circuit.spiceTs.reason ?? ''}`.toLowerCase();
  const issues = new Set<string>(['https://github.com/mfiumara/spice-ts/issues/76']);
  if (/noise|pole|pz|disto/.test(text)) issues.add('https://github.com/mfiumara/spice-ts/issues/75');
  if (/transmission|lossy|ltra/.test(text)) issues.add('https://github.com/mfiumara/spice-ts/issues/7');
  if (/bjt|vbic|npn|pnp/.test(text)) issues.add('https://github.com/mfiumara/spice-ts/issues/5');
  if (/mos|bsim/.test(text)) issues.add('https://github.com/mfiumara/spice-ts/issues/3');
  if (circuit.id === 'jimi-fuzz') issues.add('https://github.com/mfiumara/spice-ts/issues/123');
  if (circuit.localPath.endsWith('/INDUCTOR/inductor.cir')) issues.add('https://github.com/mfiumara/spice-ts/issues/366');
  if (circuit.localPath.endsWith('/d_mos1.inv1.ckt')) issues.add('https://github.com/mfiumara/spice-ts/issues/427');
  if (circuit.localPath.endsWith('/mesa/mesosc.cir')) issues.add('https://github.com/mfiumara/spice-ts/issues/432');
  if (circuit.localPath.endsWith('/vbic/CEamp.cir')) issues.add('https://github.com/mfiumara/spice-ts/issues/451');
  if (/\/mos6\/(mos6inv|simpleinv)\.cir$|\/spice3f5\/mos6inv\.cir$/.test(circuit.localPath)) issues.add('https://github.com/mfiumara/spice-ts/issues/461');
  if (['mos6-inverter-chain', 'mos-amplifier', 'mos-memory-cell', 'rca3040-wideband-amplifier'].includes(circuit.id)) {
    issues.add('https://github.com/mfiumara/spice-ts/issues/280');
  }
  return [...issues];
}

async function timed(run: () => Promise<EngineExecution>): Promise<{ execution: EngineExecution; runtimeMs: number }> {
  const started = performance.now();
  const execution = await run();
  return { execution, runtimeMs: performance.now() - started };
}

/** Same wall-clock bound the classic runner applies to every ngspice subprocess. */
export const SPICE_TS_TIMEOUT_MS = 120_000;
const SPICE_TS_CHILD_FLAG = '--spice-ts-child';

/**
 * Runs the in-process spice-ts adapter inside a child process so a non-terminating
 * simulation is recorded as a failed execution instead of stalling the aggregate.
 * The child reports its own adapter runtime; v8 serialization preserves typed arrays
 * and non-finite samples exactly.
 */
export async function runBoundedSpiceTs(
  input: Buffer,
  circuit: ClassicCircuit,
  timeoutMs: number,
): Promise<{ execution: EngineExecution; runtimeMs: number }> {
  const directory = await mkdtemp(resolve(tmpdir(), 'spice-ts-aggregate-'));
  const inputPath = resolve(directory, 'fixture.cir');
  const circuitPath = resolve(directory, 'circuit.json');
  const outputPath = resolve(directory, 'execution.v8');
  const started = performance.now();
  try {
    await writeFile(inputPath, input);
    await writeFile(circuitPath, JSON.stringify(circuit));
    const completed = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), SPICE_TS_CHILD_FLAG, inputPath, circuitPath, outputPath],
      { cwd: process.cwd(), encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
    );
    if (completed.error || completed.status !== 0) {
      const timedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      const detail = timedOut
        ? `spice-ts exceeded the ${timeoutMs} ms aggregate execution bound`
        : completed.error?.message || [completed.stderr, completed.stdout].filter(Boolean).join('\n').trim()
          || `spice-ts child exited ${completed.status}`;
      return {
        execution: { status: 'failed', convergence: timedOut ? 'failed' : 'not-run', analyses: [], error: detail.slice(0, 1000) },
        runtimeMs: performance.now() - started,
      };
    }
    return deserialize(await readFile(outputPath)) as { execution: EngineExecution; runtimeMs: number };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function spiceTsChild(inputPath: string, circuitPath: string, outputPath: string): Promise<void> {
  const input = await readFile(inputPath);
  const circuit = JSON.parse(await readFile(circuitPath, 'utf8')) as ClassicCircuit;
  await writeFile(outputPath, serialize(await timed(() => runNativeSpiceTs(input, circuit))));
}

function deterministicView(report: Omit<AggregateReport, 'outcomeSha256'> | AggregateReport): unknown {
  return JSON.parse(JSON.stringify(
    report,
    (key, value) => key === 'outcomeSha256' || key === 'environment' || key === 'runtimeMs' || key === 'error'
      ? undefined
      : value,
  ));
}

function deterministicDigest(report: Omit<AggregateReport, 'outcomeSha256'> | AggregateReport): string {
  return sha256(`${JSON.stringify(deterministicView(report))}\n`);
}

function countStatuses(fixtures: FixtureReceipt[], engine: 'ngspice' | 'spiceTs'): Record<Status, number> {
  const totals: Record<Status, number> = { success: 0, failed: 0, unsupported: 0 };
  for (const fixture of fixtures) totals[fixture[engine].status] += 1;
  return totals;
}

function runtimeSums(fixtures: FixtureReceipt[]): AggregateReport['totals']['runtimeMs'] {
  const sum = (engine: 'ngspice' | 'spiceTs') => Number(fixtures
    .reduce((total, fixture) => total + fixture[engine].runtimeMs, 0)
    .toFixed(3));
  return { ngspice: sum('ngspice'), spiceTs: sum('spiceTs') };
}

export function matchedPointEnvelope(fixtures: FixtureReceipt[]): MatchedPointEnvelope {
  const compared = fixtures.flatMap(fixture => fixture.comparisons.flatMap(comparison =>
    Object.values(comparison.metrics.signals).filter(signal => signal.status === 'compared'),
  ));
  const relative = compared.filter(signal => signal.relativeError.max !== null);
  return {
    comparedSignals: compared.length,
    relativeComparedSignals: relative.length,
    absoluteSamples: compared.reduce((sum, signal) => sum + signal.sampleCount, 0),
    relativeSamples: compared.reduce((sum, signal) => sum + signal.relativeError.sampleCount, 0),
    excludedZeroReferences: compared.reduce((sum, signal) => sum + signal.relativeError.excludedZeroReferences, 0),
    maximumAbsoluteError: Math.max(0, ...compared.map(signal => signal.absoluteError.max)),
    maximumAbsoluteRms: Math.max(0, ...compared.map(signal => signal.absoluteError.rms)),
    maximumRelativeError: relative.length === 0 ? null : Math.max(...relative.map(signal => signal.relativeError.max as number)),
    maximumRelativeRms: relative.length === 0 ? null : Math.max(...relative.map(signal => signal.relativeError.rms as number)),
  };
}

export function validateAggregateAccounting(report: AggregateReport): void {
  if (
    report.provenance.fixtureTreeSha256 !== FIXTURE_TREE_SHA256
    || report.provenance.sourcesSha256 !== SOURCES_SHA256
  ) {
    throw new Error(
      `aggregate provenance changed: fixture tree ${report.provenance.fixtureTreeSha256}; sources ${report.provenance.sourcesSha256}`,
    );
  }
  if (report.fixtures.length !== TOTAL_FIXTURES || report.totals.fixtures !== TOTAL_FIXTURES) {
    throw new Error(`aggregate accounting must contain ${TOTAL_FIXTURES} fixtures`);
  }

  if (new Set(report.fixtures.map(fixture => fixture.key)).size !== TOTAL_FIXTURES) {
    throw new Error(`aggregate accounting must contain ${TOTAL_FIXTURES} unique fixture keys`);
  }
  if (new Set(report.fixtures.map(fixture => fixture.localPath)).size !== TOTAL_FIXTURES) {
    throw new Error(`aggregate accounting must contain ${TOTAL_FIXTURES} unique local paths`);
  }
  if (new Set(report.fixtures.map(fixture => fixture.input.sha256)).size !== TOTAL_FIXTURES) {
    throw new Error(`aggregate accounting must contain ${TOTAL_FIXTURES} unique input hashes`);
  }

  for (const corpus of CORPORA) {
    const actual = report.fixtures.filter(fixture => fixture.corpus === corpus).length;
    if (actual !== FIXTURES_PER_CORPUS || report.totals.corpusFixtures[corpus] !== actual) {
      throw new Error(`${corpus}: aggregate accounting must contain ${FIXTURES_PER_CORPUS} fixtures`);
    }
  }
  if (report.corpusSources.length !== CORPORA.length) {
    throw new Error(`aggregate accounting must retain ${CORPORA.length} corpus sources`);
  }

  for (const fixture of report.fixtures) {
    if (
      fixture.input.identicalForBothEngines !== true
      || fixture.ngspice.inputSha256 !== fixture.input.sha256
      || fixture.spiceTs.inputSha256 !== fixture.input.sha256
    ) {
      throw new Error(`${fixture.key}: engine input hashes must match the byte-identical fixture`);
    }
  }

  for (const engine of ['ngspice', 'spiceTs'] as const) {
    const statuses = report.totals[engine];
    if (statuses.success + statuses.failed + statuses.unsupported !== TOTAL_FIXTURES) {
      throw new Error(`${engine} outcomes must reconcile to ${TOTAL_FIXTURES} fixtures`);
    }
    if (JSON.stringify(statuses) !== JSON.stringify(countStatuses(report.fixtures, engine))) {
      throw new Error(`${engine} outcome totals differ from per-fixture outcomes`);
    }
  }

  const comparedFixtures = report.fixtures.filter(fixture => fixture.comparisons.length > 0).length;
  const comparedAnalyses = report.fixtures.reduce((sum, fixture) => sum + fixture.comparisons.length, 0);
  if (report.totals.comparedFixtures !== comparedFixtures || report.totals.comparedAnalyses !== comparedAnalyses) {
    throw new Error('comparison totals differ from per-fixture error availability');
  }
  if (JSON.stringify(report.totals.runtimeMs) !== JSON.stringify(runtimeSums(report.fixtures))) {
    throw new Error('runtime sums differ from per-fixture receipts');
  }
  if (JSON.stringify(report.matchedPointEnvelope) !== JSON.stringify(matchedPointEnvelope(report.fixtures))) {
    throw new Error('matched-point envelope differs from per-signal metrics');
  }
  for (const transition of report.comparisonToPrevious.statusTransitions) {
    const fixture = report.fixtures.find(candidate => candidate.key === transition.fixture);
    if (!fixture || fixture[transition.engine].status !== transition.to || transition.explanation.length === 0) {
      throw new Error(`${transition.engine}/${transition.fixture}: invalid or unexplained status transition`);
    }
  }
}

/** The #592 column for a fixture whose headline compared a transient; nothing otherwise. */
async function fineReferenceFor(
  input: Buffer,
  localPath: string,
  spiceTs: EngineExecution,
  ngspice: EngineExecution,
  comparisons: ComparisonReceipt[],
): Promise<{ fineReference?: FineReference }> {
  if (!comparisons.some(comparison => comparison.analysis === 'tran')) return {};
  return {
    fineReference: await fineReferenceColumn({
      deck: input.toString('utf8'),
      fileName: basename(localPath),
      spiceTs,
      ngspice,
      headline: comparisons,
    }),
  };
}

/**
 * Adds the fine-reference column (#592) to the committed report without regenerating it: each
 * fixture with a compared transient is rerun through both default runs, its headline comparisons
 * must equal the committed ones through the deterministic projection, and only `fineReference` is
 * copied in. Headline drift aborts, so no unrelated outcome change is folded in; refresh first.
 */
export async function addFineReference(committed: AggregateReport): Promise<AggregateReport> {
  await preflightAggregateInputs();
  const manifests = new Map(await Promise.all(CORPORA.map(async corpus => [corpus, await readManifest(resolve('.'), corpus)] as const)));
  const drift: string[] = [];
  const fixtures: FixtureReceipt[] = [];
  for (const fixture of committed.fixtures) {
    const { fineReference: _previous, ...rest } = fixture;
    if (!fixture.comparisons.some(comparison => comparison.analysis === 'tran')) {
      fixtures.push(rest);
      continue;
    }
    const circuit = manifests.get(fixture.corpus)!.circuits.find(candidate => candidate.id === fixture.id)!;
    const input = await readFile(resolve(circuit.localPath));
    const ngspice = await runNativeNgspice(input, circuit as ClassicCircuit);
    const spiceTs = await runBoundedSpiceTs(input, circuit as ClassicCircuit, SPICE_TS_TIMEOUT_MS);
    const comparisons = compareExecutions(spiceTs.execution, ngspice);
    const projection = (value: unknown) => JSON.stringify(deterministicView({ comparisons: value } as never));
    if (projection(comparisons) !== projection(fixture.comparisons)) {
      drift.push(fixture.key);
      fixtures.push(rest);
      continue;
    }
    const column = await fineReferenceFor(input, circuit.localPath, spiceTs.execution, ngspice, comparisons);
    fixtures.push({ ...rest, ...column });
    process.stderr.write(`aggregate --fine-reference: ${fixture.key} ${column.fineReference?.status ?? 'no column'}\n`);
  }
  if (drift.length > 0) {
    throw new Error(`aggregate: headline drift against the committed report; refresh it before adding the #592 column: ${drift.join(', ')}`);
  }
  const { outcomeSha256: _outcome, ...base } = committed;
  const updated: Omit<AggregateReport, 'outcomeSha256'> = {
    ...base,
    policy: { ...base.policy, fineReference: FINE_REFERENCE_RULE },
    fixtures,
  };
  const report = { ...updated, outcomeSha256: deterministicDigest(updated) };
  validateAggregateAccounting(report);
  return report;
}

export async function buildAggregateReport(): Promise<AggregateReport> {
  const inputProvenance = await preflightAggregateInputs();
  const fixtures: FixtureReceipt[] = [];
  const corpusSources: AggregateReport['corpusSources'] = [];

  for (const corpus of CORPORA) {
    const manifest = await readManifest(resolve('.'), corpus);
    if (manifest.circuits.length !== FIXTURES_PER_CORPUS) {
      throw new Error(`${corpus}: expected ${FIXTURES_PER_CORPUS} fixtures, found ${manifest.circuits.length}`);
    }
    corpusSources.push({ id: corpus, ...manifest.source, fixtureCount: manifest.circuits.length });

    for (const circuit of manifest.circuits) {
      const input = await readFile(resolve(circuit.localPath));
      const digest = sha256(input);
      if (digest !== circuit.sha256) throw new Error(`${corpus}/${circuit.id}: fixture SHA-256 mismatch`);
      const compatible = circuit as ClassicCircuit;
      const ngspice = await timed(() => runNativeNgspice(input, compatible));
      const spiceTs = await runBoundedSpiceTs(input, compatible, SPICE_TS_TIMEOUT_MS);
      const comparisons = compareExecutions(spiceTs.execution, ngspice.execution);
      fixtures.push({
        key: `${corpus}/${circuit.id}`,
        corpus,
        id: circuit.id,
        category: circuit.category,
        declaredAnalyses: circuit.analyses,
        localPath: circuit.localPath,
        input: { bytes: input.byteLength, sha256: digest, identicalForBothEngines: true },
        ngspice: receipt(ngspice.execution, circuit.ngspice, ngspice.runtimeMs, ['ngspice', '-b', '-r', '<raw>', '<identical-fixture>'], digest),
        spiceTs: receipt(spiceTs.execution, circuit.spiceTs, spiceTs.runtimeMs, ['@spice-ts/core', 'simulate', '<identical-fixture>'], digest),
        comparisons,
        gapIssues: gapIssues(circuit),
        ...(await fineReferenceFor(input, circuit.localPath, spiceTs.execution, ngspice.execution, comparisons)),
      });
    }
  }

  const corpusFixtures = Object.fromEntries(CORPORA.map(corpus => [corpus, fixtures.filter(fixture => fixture.corpus === corpus).length])) as Record<CorpusId, number>;
  const base: Omit<AggregateReport, 'outcomeSha256'> = {
    schemaVersion: SCHEMA,
    provenance: inputProvenance,
    corpusSources,
    environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version },
    tools: {
      spiceTs: (JSON.parse(await readFile(resolve('packages/core/package.json'), 'utf8')) as { version: string }).version,
      ngspice: commandVersion('ngspice', ['--version'], /ngspice-\d+(?:\.\d+)*/i),
      pnpm: commandVersion('pnpm', ['--version']),
    },
    commands: {
      generate: 'pnpm exec tsx benchmarks/aggregate-report.ts',
      verify: 'pnpm exec tsx benchmarks/aggregate-report.ts --check',
      ngspice: 'ngspice -b -r <raw> <identical-fixture>',
      spiceTs: '@spice-ts/core simulate(<identical-fixture>)',
    },
    policy: {
      input: 'byte-identical fixture for both engines',
      fixtureAdaptation: 'none',
      perCircuitToleranceTuning: false,
      comparisonGrid: 'spice-ts',
      interpolation: 'linear',
      breakpointAlignment: 'one-sided at time points shared by both transient grids; linear metric retained',
      fineReference: FINE_REFERENCE_RULE,
      timing: 'single wall-clock execution per engine and fixture; descriptive, not a speed claim',
      deterministicHashExcludes: ['environment', 'runtimeMs', 'error'],
    },
    totals: {
      fixtures: fixtures.length,
      corpusFixtures,
      ngspice: countStatuses(fixtures, 'ngspice'),
      spiceTs: countStatuses(fixtures, 'spiceTs'),
      comparedFixtures: fixtures.filter(fixture => fixture.comparisons.length > 0).length,
      comparedAnalyses: fixtures.reduce((sum, fixture) => sum + fixture.comparisons.length, 0),
      runtimeMs: runtimeSums(fixtures),
    },
    matchedPointEnvelope: matchedPointEnvelope(fixtures),
    comparisonToPrevious: PREVIOUS_REPORT,
    gapIssues: [...GAP_ISSUES],
    fixtures,
  };
  const report = { ...base, outcomeSha256: deterministicDigest(base) };
  validateAggregateAccounting(report);
  return report;
}

const METHOD_ISSUE_URL = 'https://github.com/mfiumara/spice-ts/issues/445';

/** Methodology text for the alignment the report was actually generated with. */
export function comparisonMethodLines(policy: AggregateReport['policy']): string[] {
  const base = '- Comparison method: errors are evaluated at the spice-ts output points with ngspice linearly '
    + 'interpolated onto them; relative errors divide by that ngspice value.';
  const artifact = 'At a source breakpoint both engines report the left limit, so a waveform that steps there '
    + '(for example L·di/dt at a PWL corner) shows its right limit only at the next ngspice sample. Linear '
    + 'interpolation across that interval invents values neither engine produced and charges them as error at '
    + 'every spice-ts point inside it.';
  if (policy.breakpointAlignment !== undefined) {
    return [
      base,
      `- Breakpoint alignment ([#445](${METHOD_ISSUE_URL})): ${artifact} For transients, every time point present in both engines' grids is treated as a breakpoint. Inside an ngspice interval that opens at one, each spice-ts sample is compared with the nearer of the linear interpolation and the right-sided reconstruction from the next two ngspice samples. Every other sample, analysis, and tolerance is unchanged.`,
      '- The pre-#445 plain-linear metric is still published for every comparison as `linearMetrics` in `benchmarks/aggregate-report.json`, so the change hides no loss. The envelope below uses the primary breakpoint-aligned metric.',
    ];
  }
  return [
    base,
    `- Known artifact ([#445](${METHOD_ISSUE_URL})): ${artifact} The next regeneration compares one-sided across such intervals and keeps this plain-linear metric as a secondary column.`,
  ];
}

/** Stable, content-addressed name: rendering an accepted report never depends on today's date. */
export function aggregateTransitionArtifact(report: AggregateReport): { path: string; content: string } {
  return {
    path: `benchmarks/results/aggregate-transitions/${report.outcomeSha256}.json`,
    content: `${JSON.stringify(report.comparisonToPrevious, null, 2)}\n`,
  };
}

/** The accepted baseline has aggregate metrics, not a per-fixture metric snapshot. */
function metricMoveLines(report: AggregateReport): string[] {
  const previous = report.comparisonToPrevious;
  const before = {
    ...previous.matchedPointEnvelope,
    comparedAnalyses: previous.totals.comparedAnalyses,
    comparedFixtures: previous.totals.comparedFixtures,
  };
  const after = {
    ...report.matchedPointEnvelope,
    comparedAnalyses: report.totals.comparedAnalyses,
    comparedFixtures: report.totals.comparedFixtures,
  };
  return (Object.keys(before) as Array<keyof typeof before>).flatMap(metric => {
    const from = before[metric];
    const to = after[metric];
    if (from === null || to === null || from === to) return [];
    return [{ metric, from, to, magnitude: from === 0 ? Infinity : Math.abs((to - from) / from) }];
  }).sort((a, b) => b.magnitude - a.magnitude || a.metric.localeCompare(b.metric))
    .slice(0, 10)
    .map(move => `- Metric ${move.metric}: ${move.from} → ${move.to}.`);
}

export function aggregateMarkdown(report: AggregateReport): string {
  const { totals } = report;
  const { matchedPointEnvelope: envelope, comparisonToPrevious: previous } = report;
  const issueNumber = previous.issueUrl.split('/').at(-1);
  const pullRequestNumber = previous.pullRequestUrl.split('/').at(-1);
  const transitionLines = previous.statusTransitions.length === 0
    ? ['- Status transitions: none. Both engines retained every prior success, failure, and unsupported classification.']
    : previous.statusTransitions.map(transition => `- ${transition.engine} \`${transition.fixture}\`: ${transition.from} → ${transition.to}.`);
  const detail = aggregateTransitionArtifact(report);
  const gapUrls = [...new Set([...report.gapIssues.map(issue => issue.url), ...report.fixtures.flatMap(fixture => fixture.gapIssues)])];
  const lines = [
    '# Aggregate 100-circuit parity report',
    '',
    'This report publishes all outcomes, including failures and unsupported cases. It makes no speed or superiority claim.',
    '',
    '## Reproduction',
    '',
    `- Generate: \`${report.commands.generate}\``,
    `- Verify committed outcomes: \`${report.commands.verify}\``,
    `- Machine: ${report.environment.cpu}; ${report.environment.platform} ${report.environment.release} ${report.environment.arch}; Node ${report.environment.node}`,
    `- Tools: spice-ts ${report.tools.spiceTs}; ${report.tools.ngspice}; pnpm ${report.tools.pnpm}`,
    `- Deterministic outcome SHA-256 (host, timings, and error text excluded): \`${report.outcomeSha256}\``,
    `- Aggregate fixture-tree SHA-256: \`${report.provenance.fixtureTreeSha256}\`.`,
    `- Source catalogue SHA-256: \`${report.provenance.sourcesSha256}\`.`,
    '- Runtime is one wall-clock sample per engine/fixture. Treat it as diagnostic data, not a performance comparison.',
    '',
    '## Policy and totals',
    '',
    '- Both engines receive the exact same fixture bytes; each row records the common SHA-256.',
    '- No fixture adaptation and no per-circuit tolerance tuning.',
    ...comparisonMethodLines(report.policy),
    `- Accounted fixtures: ${totals.fixtures} (${CORPORA.map(corpus => `${corpus}=${totals.corpusFixtures[corpus]}`).join(', ')}).`,
    '',
    '| Engine | Success | Failed | Unsupported |',
    '|---|---:|---:|---:|',
    `| ngspice | ${totals.ngspice.success} | ${totals.ngspice.failed} | ${totals.ngspice.unsupported} |`,
    `| spice-ts | ${totals.spiceTs.success} | ${totals.spiceTs.failed} | ${totals.spiceTs.unsupported} |`,
    '',
    `- Matched-point errors: ${totals.comparedAnalyses} analyses across ${totals.comparedFixtures} fixtures. Full per-signal max/RMS absolute and relative errors are in \`benchmarks/aggregate-report.json\`.`,
    `- Matched signals: ${envelope.comparedSignals} absolute (${envelope.absoluteSamples} samples); ${envelope.relativeComparedSignals} relative (${envelope.relativeSamples} samples, ${envelope.excludedZeroReferences} zero references excluded).`,
    `- Matched-point envelope (worst per signal): absolute max ${envelope.maximumAbsoluteError}, absolute RMS ${envelope.maximumAbsoluteRms}, relative max ${envelope.maximumRelativeError}, relative RMS ${envelope.maximumRelativeRms}.`,
    `- Descriptive single-run runtime sums: ngspice ${totals.runtimeMs.ngspice.toFixed(3)} ms; spice-ts ${totals.runtimeMs.spiceTs.toFixed(3)} ms.`,
    '',
    '## Transition from the previous accepted report',
    '',
    `- Baseline: [issue #${issueNumber}](${previous.issueUrl}), [PR #${pullRequestNumber}](${previous.pullRequestUrl}), head \`${previous.headSha}\`, outcome \`${previous.outcomeSha256}\`.`,
    `- Previous totals: ngspice ${previous.totals.ngspice.success}/${previous.totals.ngspice.failed}/${previous.totals.ngspice.unsupported} success/failed/unsupported; spice-ts ${previous.totals.spiceTs.success}/${previous.totals.spiceTs.failed}/${previous.totals.spiceTs.unsupported}; ${previous.totals.comparedAnalyses} analyses across ${previous.totals.comparedFixtures} fixtures.`,
    `- Previous matched-point envelope: absolute max ${previous.matchedPointEnvelope.maximumAbsoluteError}, absolute RMS ${previous.matchedPointEnvelope.maximumAbsoluteRms}, relative max ${previous.matchedPointEnvelope.maximumRelativeError}, relative RMS ${previous.matchedPointEnvelope.maximumRelativeRms}.`,
    ...transitionLines,
    '- Top 10 aggregate metric moves by |change / baseline| (zero baselines first; null and unchanged values omitted). Includes coverage counts and both error increases and decreases; not a per-circuit ranking.',
    ...metricMoveLines(report),
    `- [Full transition ledger](${detail.path.replace('benchmarks/', '')}) (${previous.statusTransitions.length} status changes, ${previous.metricTransitions.length} historical narratives).`,
    '',
    '## Gap tracking',
    '',
    ...report.gapIssues.map(issue => `- [#${issue.url.split('/').at(-1)}] — ${issue.scope}`),
    '',
    ...gapUrls.map(url => `[#${url.split('/').at(-1)}]: ${url}`),
    '',
    '## Per-circuit outcomes',
    '',
    '| Fixture | Analyses | ngspice | spice-ts | Runtime ms (ng/spice-ts) | Compared analyses | Gap issues |',
    '|---|---|---|---|---:|---:|---|',
    ...report.fixtures.map(fixture => {
      const gaps = fixture.gapIssues.map(url => `[#${url.split('/').at(-1)}]`).join(', ');
      return `| ${fixture.key} | ${fixture.declaredAnalyses.join(', ') || 'none'} | ${fixture.ngspice.status} | ${fixture.spiceTs.status} | ${fixture.ngspice.runtimeMs.toFixed(1)}/${fixture.spiceTs.runtimeMs.toFixed(1)} | ${fixture.comparisons.length} | ${gaps} |`;
    }),
    '',
    'Every unsupported or failed spice-ts row is a published loss. Convergence details, unrounded runtimes, engine error strings, input hashes, commands, signal lists, point counts, and matched-point metrics are retained in [the JSON report](aggregate-report.json).',
    '',
    ...(report.policy.fineReference === undefined ? [] : [
      ...fineReferenceSection(report.fixtures.map(fixture => ({
        label: fixture.key,
        status: `${fixture.ngspice.status}/${fixture.spiceTs.status}`,
        fineReference: fixture.fineReference,
      }))),
      'Status in this table is the engine status pair (ngspice/spice-ts); the aggregate report has no matched/mismatch status. The columns use the corpus-f normalised metric (worst |error| / reference peak with the per-quantity floors), not the absolute and relative metrics above.',
      '',
    ]),
  ];
  return lines.join('\n');
}

function stableReport(report: AggregateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function verifyCommittedArtifacts(
  generated: AggregateReport,
  committedJson: string,
  committedMarkdown: string,
  committedTransitions?: string,
): void {
  let committed: AggregateReport;
  try {
    committed = JSON.parse(committedJson) as AggregateReport;
  } catch (error) {
    throw new Error(`committed aggregate JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const committedProjection = JSON.stringify(deterministicView(committed));
  const generatedProjection = JSON.stringify(deterministicView(generated));
  if (committedProjection !== generatedProjection) {
    const committedByKey = new Map((committed.fixtures ?? []).map(fixture => [fixture.key, fixture]));
    const differing = (generated.fixtures ?? []).flatMap(fixture => {
      const previous = committedByKey.get(fixture.key);
      if (previous && JSON.stringify(deterministicView(previous as never)) === JSON.stringify(deterministicView(fixture as never))) return [];
      return [`${fixture.key} (spice-ts ${previous?.spiceTs.status ?? 'missing'} -> ${fixture.spiceTs.status}; ngspice ${previous?.ngspice.status ?? 'missing'} -> ${fixture.ngspice.status})`];
    });
    throw new Error(`committed aggregate deterministic JSON projection differs from regenerated outcomes; differing fixtures: ${differing.join(', ') || 'none'}`);
  }

  const digest = deterministicDigest(committed);
  if (committed.outcomeSha256 !== digest || generated.outcomeSha256 !== digest) {
    throw new Error(`aggregate deterministic JSON projection hash mismatch: committed=${committed.outcomeSha256}; regenerated=${generated.outcomeSha256}; calculated=${digest}`);
  }

  if (committedTransitions !== undefined && committedTransitions !== aggregateTransitionArtifact(committed).content) {
    throw new Error('committed aggregate transition detail differs from the committed JSON projection');
  }

  validateAggregateAccounting(committed);

  if (committedMarkdown !== aggregateMarkdown(committed)) {
    throw new Error('committed aggregate Markdown differs from the committed JSON projection');
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--fine-reference')) {
    process.stderr.write(`aggregate --fine-reference: pid ${process.pid}; to stop only this run: kill ${process.pid}\n`);
    const report = await addFineReference(JSON.parse(await readFile(JSON_PATH, 'utf8')) as AggregateReport);
    await writeAggregateArtifacts({ jsonPath: JSON_PATH, markdownPath: MARKDOWN_PATH }, stableReport(report), aggregateMarkdown(report), aggregateTransitionArtifact(report));
    process.stderr.write(`aggregate --fine-reference: outcome ${report.outcomeSha256}\n`);
    return;
  }
  const check = process.argv.includes('--check');
  // Each run is isolated (read-only inputs, per-engine temporary directories, atomic writes),
  // so concurrent runs are safe. Stop a run by its own PID, never by a global pattern match.
  process.stderr.write(`aggregate${check ? ' --check' : ''}: pid ${process.pid}; to stop only this run: kill ${process.pid}\n`);
  const report = await buildAggregateReport();
  const json = stableReport(report);
  const md = aggregateMarkdown(report);
  if (check) {
    const [committedJson, committedMarkdown] = await Promise.all([
      readFile(JSON_PATH, 'utf8'),
      readFile(MARKDOWN_PATH, 'utf8'),
    ]);
    verifyCommittedArtifacts(report, committedJson, committedMarkdown);
    const committed = JSON.parse(committedJson) as AggregateReport;
    const transition = aggregateTransitionArtifact(committed);
    if (await readFile(resolve(transition.path), 'utf8') !== transition.content) {
      throw new Error('committed aggregate transition detail differs from the committed JSON projection');
    }
  } else {
    await writeAggregateArtifacts({ jsonPath: JSON_PATH, markdownPath: MARKDOWN_PATH }, json, md, aggregateTransitionArtifact(report));
  }
  process.stderr.write(`aggregate: ${report.totals.fixtures} fixtures; outcome ${report.outcomeSha256}; compared ${report.totals.comparedAnalyses} analyses\n`);
}

if (process.argv[2] === SPICE_TS_CHILD_FLAG) {
  const [inputPath, circuitPath, outputPath] = process.argv.slice(3);
  spiceTsChild(inputPath, circuitPath, outputPath).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (basename(process.argv[1] ?? '') === 'aggregate-report.ts') {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
