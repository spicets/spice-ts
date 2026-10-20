#!/usr/bin/env tsx
/**
 * Deterministic report runner for the licensed Berkeley SPICE3f5 corpus.
 *
 * Usage:
 *   pnpm exec tsx benchmarks/corpus/classic/report.ts --output benchmarks/corpus/classic/report.json
 *   pnpm exec tsx benchmarks/corpus/classic/report.ts --check
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  alignAndMeasure,
  parseNgspiceRaw,
  type AnalysisType as ComparisonAnalysisType,
  type ComparisonMetrics,
  type ComplexValue,
  type SampleSeries,
} from '../../comparison-harness.js';
import { pairPlots } from '../../plot-pairing.js';
import { declaredSecondaryGrid } from '../../sweep-coordinates.js';
import type { DotAnalysisRun } from '../../../packages/core/src/results.js';

export const CLASSIC_REPORT_SCHEMA = 'spice-ts-classic-comparison/v1' as const;
export type ClassicAnalysisType = ComparisonAnalysisType | 'pz' | 'noise' | 'disto' | 'sp';
export type EngineStatus = 'success' | 'failed' | 'unsupported';
export type ConvergenceStatus = 'converged' | 'failed' | 'not-run';

export interface ExpectedStatus {
  expectedStatus: 'pass' | 'fail';
  reason?: string;
}

export interface ClassicCircuit {
  id: string;
  category: string;
  analyses: ClassicAnalysisType[];
  sourcePath: string;
  sourceUrl: string;
  localPath: string;
  sha256: string;
  ngspice: ExpectedStatus;
  spiceTs: ExpectedStatus;
}

export interface ClassicManifest {
  schemaVersion: number;
  source: Record<string, unknown> & { name: string; revision: string; license: string };
  circuits: ClassicCircuit[];
}

export interface EngineAnalysis {
  type: ClassicAnalysisType;
  plotName: string;
  plotId?: string;
  series: SampleSeries;
}

export interface EngineExecution {
  status: EngineStatus;
  convergence: ConvergenceStatus;
  analyses: EngineAnalysis[];
  error?: string;
}

interface EngineAnalysisReport {
  type: ClassicAnalysisType;
  plotName: string;
  points: number;
  signals: string[];
}

interface EngineReport {
  status: EngineStatus;
  convergence: ConvergenceStatus;
  inputSha256: string;
  analyses: EngineAnalysisReport[];
  error?: string;
}

export interface AnalysisComparison {
  analysis: ClassicAnalysisType;
  plot?: { spiceTs?: string; ngspice?: string };
  unmatched?: 'spice-ts' | 'ngspice';
  signals: string[];
  metrics: ComparisonMetrics;
}

export interface ClassicFixtureReport {
  id: string;
  category: string;
  declaredAnalyses: ClassicAnalysisType[];
  sourcePath: string;
  localPath: string;
  input: {
    bytes: number;
    sha256: string;
    identicalForBothEngines: true;
  };
  ngspice: EngineReport;
  spiceTs: EngineReport;
  comparisons: AnalysisComparison[];
  gapIssues: string[];
}

export interface ClassicTotals {
  fixtures: number;
  ngspice: Record<EngineStatus, number>;
  spiceTs: Record<EngineStatus, number>;
  comparedAnalyses: number;
}

export interface ClassicReport {
  schemaVersion: typeof CLASSIC_REPORT_SCHEMA;
  corpus: {
    name: string;
    revision: string;
    license: string;
    fixtureCount: number;
  };
  tools: { ngspice: string; spiceTs: string };
  policy: {
    fixtureAdaptation: 'none';
    perCircuitToleranceTuning: false;
    comparisonGrid: 'spice-ts';
    interpolation: 'linear';
  };
  gapIssues: Array<{ url: string; scope: string }>;
  totals: ClassicTotals;
  fixtures: ClassicFixtureReport[];
}

export interface ClassicReportDependencies {
  readFixture: (localPath: string) => Promise<Buffer>;
  runNgspice: (input: Buffer, circuit: ClassicCircuit) => Promise<EngineExecution>;
  runSpiceTs: (input: Buffer, circuit: ClassicCircuit) => Promise<EngineExecution>;
  tools: { ngspice: string; spiceTs: string };
}

const GAP_ISSUES = [
  {
    url: 'https://github.com/mfiumara/spice-ts/issues/76',
    scope: 'benchmark-driven parser and unsupported device-card coverage',
  },
  {
    url: 'https://github.com/mfiumara/spice-ts/issues/75',
    scope: 'noise, pole-zero, and distortion analysis coverage',
  },
  {
    url: 'https://github.com/mfiumara/spice-ts/issues/7',
    scope: 'transmission-line device coverage',
  },
] as const;

function sha256(input: Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function sortedSignals(series: SampleSeries): string[] {
  return Object.keys(series.signals).sort((left, right) => left.localeCompare(right));
}

function reportEngine(execution: EngineExecution, inputSha256: string): EngineReport {
  const report: EngineReport = {
    status: execution.status,
    convergence: execution.convergence,
    inputSha256,
    analyses: execution.analyses
      .map(analysis => ({
        type: analysis.type,
        plotName: analysis.plotName,
        points: analysis.series.grid.length,
        signals: sortedSignals(analysis.series),
      }))
      .sort((left, right) => left.type.localeCompare(right.type) || left.plotName.localeCompare(right.plotName)),
  };
  if (execution.error) report.error = execution.error;
  return report;
}

/**
 * Find the reference plot for a spice-ts analysis. Some analyses (ngspice
 * `.noise`) emit several plots of one type, so an exact plot-name match wins;
 * otherwise the first plot of the same type is used.
 */
export function findMatchingAnalysis(
  candidates: readonly EngineAnalysis[],
  analysis: Pick<EngineAnalysis, 'type' | 'plotName'>,
): EngineAnalysis | undefined {
  const sameType = candidates.filter(candidate => candidate.type === analysis.type);
  const plotName = analysis.plotName.toLowerCase();
  return sameType.find(candidate => candidate.plotName.toLowerCase() === plotName) ?? sameType[0];
}

function compareExecutions(spiceTs: EngineExecution, ngspice: EngineExecution): AnalysisComparison[] {
  const comparisons: AnalysisComparison[] = [];
  for (const { left: spiceAnalysis, right: ngspiceAnalysis } of pairPlots(spiceTs.analyses, ngspice.analyses)) {
    if (!spiceAnalysis || !ngspiceAnalysis) {
      const own = (spiceAnalysis ?? ngspiceAnalysis)!;
      const signals = sortedSignals(own.series);
      const empty = { grid: [], signals: {} };
      comparisons.push({ analysis: own.type, plot: { spiceTs: spiceAnalysis?.plotId ?? spiceAnalysis?.plotName, ngspice: ngspiceAnalysis?.plotId ?? ngspiceAnalysis?.plotName }, unmatched: spiceAnalysis ? 'ngspice' : 'spice-ts', signals, metrics: alignAndMeasure(spiceAnalysis?.series ?? empty, ngspiceAnalysis?.series ?? empty, signals) });
      continue;
    }
    const common = sortedSignals(spiceAnalysis.series)
      .filter(signal => ngspiceAnalysis.series.signals[signal] !== undefined);
    const signals = common.length ? common : [...new Set([...sortedSignals(spiceAnalysis.series), ...sortedSignals(ngspiceAnalysis.series)])].sort();
    comparisons.push({
      analysis: spiceAnalysis.type,
      ...(spiceAnalysis.plotId === undefined && ngspiceAnalysis.plotId === undefined && spiceTs.analyses.filter(a => a.type === spiceAnalysis.type).length === 1 ? {} : { plot: { spiceTs: spiceAnalysis.plotId ?? spiceAnalysis.plotName, ngspice: ngspiceAnalysis.plotId ?? ngspiceAnalysis.plotName } }),
      signals,
      metrics: alignAndMeasure(spiceAnalysis.series, ngspiceAnalysis.series, signals),
    });
  }
  return comparisons.sort((left, right) => left.analysis.localeCompare(right.analysis));
}

function gapsFor(circuit: ClassicCircuit): string[] {
  const gaps = new Set<string>(['https://github.com/mfiumara/spice-ts/issues/76']);
  if (circuit.analyses.some(analysis => analysis === 'noise' || analysis === 'pz' || analysis === 'disto')) {
    gaps.add('https://github.com/mfiumara/spice-ts/issues/75');
  }
  if (circuit.category === 'transmission-line') {
    gaps.add('https://github.com/mfiumara/spice-ts/issues/7');
  }
  return [...gaps];
}

export function summarizeClassicReport(fixtures: ClassicFixtureReport[]): ClassicTotals {
  const totals: ClassicTotals = {
    fixtures: fixtures.length,
    ngspice: { success: 0, failed: 0, unsupported: 0 },
    spiceTs: { success: 0, failed: 0, unsupported: 0 },
    comparedAnalyses: 0,
  };
  for (const fixture of fixtures) {
    totals.ngspice[fixture.ngspice.status] += 1;
    totals.spiceTs[fixture.spiceTs.status] += 1;
    totals.comparedAnalyses += fixture.comparisons.length;
  }
  return totals;
}

export async function buildClassicReport(
  manifest: ClassicManifest,
  dependencies: ClassicReportDependencies,
): Promise<ClassicReport> {
  const fixtures: ClassicFixtureReport[] = [];
  for (const circuit of manifest.circuits) {
    const input = await dependencies.readFixture(circuit.localPath);
    const digest = sha256(input);
    if (digest !== circuit.sha256) {
      throw new Error(`${circuit.id}: SHA-256 mismatch (expected ${circuit.sha256}, observed ${digest})`);
    }

    // Both runners receive the same immutable Buffer object. Native ngspice is
    // given these bytes directly; spice-ts receives their lossless UTF-8 text.
    const [ngspice, spiceTs] = await Promise.all([
      dependencies.runNgspice(input, circuit),
      dependencies.runSpiceTs(input, circuit),
    ]);
    fixtures.push({
      id: circuit.id,
      category: circuit.category,
      declaredAnalyses: circuit.analyses,
      sourcePath: circuit.sourcePath,
      localPath: circuit.localPath,
      input: { bytes: input.byteLength, sha256: digest, identicalForBothEngines: true },
      ngspice: reportEngine(ngspice, digest),
      spiceTs: reportEngine(spiceTs, digest),
      comparisons: compareExecutions(spiceTs, ngspice),
      gapIssues: gapsFor(circuit),
    });
  }

  return {
    schemaVersion: CLASSIC_REPORT_SCHEMA,
    corpus: {
      name: manifest.source.name,
      revision: manifest.source.revision,
      license: manifest.source.license,
      fixtureCount: manifest.circuits.length,
    },
    tools: dependencies.tools,
    policy: {
      fixtureAdaptation: 'none',
      perCircuitToleranceTuning: false,
      comparisonGrid: 'spice-ts',
      interpolation: 'linear',
    },
    gapIssues: [...GAP_ISSUES],
    totals: summarizeClassicReport(fixtures),
    fixtures,
  };
}

export function analysisType(plotName: string): ClassicAnalysisType | null {
  const name = plotName.toLowerCase();
  if (name.includes('operating point')) return 'op';
  if (name.includes('dc transfer')) return 'dc';
  if (name.includes('ac analysis')) return 'ac';
  if (name.includes('transient')) return 'tran';
  if (name.includes('noise')) return 'noise';
  if (name.includes('pole-zero') || name.includes('pole zero')) return 'pz';
  if (name.includes('distortion')) return 'disto';
  if (name.includes('sp analysis')) return 'sp';
  return null;
}

function cleanError(error: string, temporaryDirectory?: string): string {
  const withoutDirectory = temporaryDirectory ? error.split(temporaryDirectory).join('<temporary-directory>') : error;
  return withoutDirectory.trim().replaceAll(/\s+/g, ' ').slice(0, 1000);
}

export async function runNativeNgspice(input: Buffer, circuit: ClassicCircuit): Promise<EngineExecution> {
  const directory = await mkdtemp(resolve(tmpdir(), 'spice-ts-classic-report-'));
  const netlistPath = resolve(directory, basename(circuit.localPath));
  const rawPath = resolve(directory, 'output.raw');
  try {
    await writeFile(netlistPath, input);
    await writeFile(resolve(directory, '.spiceinit'), 'set filetype=ascii\n');
    const completed = spawnSync('ngspice', ['-b', '-r', basename(rawPath), basename(netlistPath)], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, HOME: directory },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (completed.error || completed.status !== 0) {
      const detail = completed.error?.message ?? [completed.stderr, completed.stdout].filter(Boolean).join('\n');
      return {
        status: 'failed',
        convergence: 'failed',
        analyses: [],
        error: cleanError(detail || `ngspice exited ${completed.status}`, directory),
      };
    }

    let raw: string;
    try {
      raw = await readFile(rawPath, 'utf8');
    } catch {
      return {
        status: 'failed',
        convergence: 'not-run',
        analyses: [],
        error: 'no raw analysis data produced',
      };
    }
    const analyses = parseNgspiceRaw(raw)
      .map(plot => {
        const type = analysisType(plot.plotName);
        const secondaryGrid = type === 'dc' ? declaredSecondaryGrid(input.toString('utf8'), plot.plotName, plot.grid) : undefined;
        return type ? { type, plotName: plot.plotName, series: { grid: plot.grid, signals: plot.signals, ...(secondaryGrid ? { secondaryGrid } : {}) } } : null;
      })
      .filter((analysis): analysis is EngineAnalysis => analysis !== null);
    if (analyses.length === 0) {
      return {
        status: 'failed',
        convergence: 'not-run',
        analyses: [],
        error: 'no raw analysis data produced',
      };
    }
    return { status: 'success', convergence: 'converged', analyses };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function real(values: Iterable<number>): ComplexValue[] {
  return Array.from(values, re => ({ re, im: 0 }));
}

/**
 * How the native adapter stores each signal's samples. The default keeps one ComplexValue per
 * sample; corpus-f's bounded child packs them into typed arrays instead, because per-sample
 * objects for a 1e6-point transient exhaust the V8 heap (#839). Both encode the same values.
 */
export interface SampleEncoding<S> {
  real(values: Iterable<number>): S;
  complex(values: ComplexValue[]): S;
}

export interface EncodedAnalysis<S> {
  type: ClassicAnalysisType;
  plotName: string;
  plotId?: string;
  series: { grid: number[]; signals: Record<string, S>; secondaryGrid?: number[] };
}

export interface EncodedExecution<S> extends Omit<EngineExecution, 'analyses'> {
  analyses: EncodedAnalysis<S>[];
}

export const OBJECT_SAMPLES: SampleEncoding<ComplexValue[]> = { real, complex: values => values };

export function encodeAnalysis<S>(analysis: EngineAnalysis, encoding: SampleEncoding<S>): EncodedAnalysis<S> {
  return {
    type: analysis.type,
    plotName: analysis.plotName,
    ...(analysis.plotId === undefined ? {} : { plotId: analysis.plotId }),
    series: {
      grid: analysis.series.grid,
      ...(analysis.series.secondaryGrid ? { secondaryGrid: analysis.series.secondaryGrid } : {}),
      signals: Object.fromEntries(Object.entries(analysis.series.signals).map(([name, values]) => [name, encoding.complex(values)])),
    },
  };
}

function phasors(values: Iterable<{ magnitude: number; phase: number }>): ComplexValue[] {
  return Array.from(values, value => {
    const radians = value.phase * Math.PI / 180;
    return { re: value.magnitude * Math.cos(radians), im: value.magnitude * Math.sin(radians) };
  });
}

function poleZeroSignals(result: {
  poles: Array<{ real: number; imaginary: number }>;
  zeros: Array<{ real: number; imaginary: number }>;
}): Record<string, ComplexValue[]> {
  const signals: Record<string, ComplexValue[]> = {};
  result.poles.forEach((value, index) => {
    signals[`v(pole(${index + 1}))`] = [{ re: value.real, im: value.imaginary }];
  });
  result.zeros.forEach((value, index) => {
    signals[`v(zero(${index + 1}))`] = [{ re: value.real, im: value.imaginary }];
  });
  return signals;
}

function mapSignals<T, S>(
  voltages: Map<string, T>,
  currents: Map<string, T>,
  convert: (values: T) => S,
): Record<string, S> {
  const signals: Record<string, S> = {};
  for (const [name, values] of [...voltages.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    signals[`v(${name.toLowerCase()})`] = convert(values);
  }
  for (const [name, values] of [...currents.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    signals[`i(${name.toLowerCase()})`] = convert(values);
  }
  return signals;
}

/**
 * Map a spice-ts `.noise` result onto ngspice-47's two noise plots: the
 * "Noise Spectral Density Curves" spectra (V/sqrt(Hz) output, input-referred
 * density in the input source's unit) and the one-point "Integrated Noise"
 * totals, where ngspice names the input total `i(...)` for a current source.
 */
function noiseAnalyses(noise: {
  frequencies: number[];
  inputSource: string;
  outputNoiseDensity: number[];
  inputNoiseDensity: number[];
  integratedOutputNoise: number | undefined;
  integratedInputNoise: number | undefined;
}): EngineAnalysis[] {
  const analyses: EngineAnalysis[] = [{
    type: 'noise',
    plotName: 'Noise Spectral Density Curves',
    series: {
      grid: noise.frequencies,
      signals: {
        inoise_spectrum: real(noise.inputNoiseDensity),
        onoise_spectrum: real(noise.outputNoiseDensity),
      },
    },
  }];
  if (noise.integratedOutputNoise !== undefined && noise.integratedInputNoise !== undefined) {
    const inputPrefix = noise.inputSource.toLowerCase().startsWith('i') ? 'i' : 'v';
    analyses.push({
      type: 'noise',
      plotName: 'Integrated Noise',
      series: {
        grid: [0],
        signals: {
          [`${inputPrefix}(inoise_total)`]: real([noise.integratedInputNoise]),
          'v(onoise_total)': real([noise.integratedOutputNoise]),
        },
      },
    });
  }
  return analyses;
}

/** ngspice-47 `DISTORTION - ...` plot name for each bounded spice-ts product. */
const DISTORTION_PLOT_NAMES: Record<string, string> = {
  2: 'DISTORTION - 2nd harmonic',
  3: 'DISTORTION - 3rd harmonic',
  'f1+f2': 'DISTORTION - IM: f1+f2',
  'f1-f2': 'DISTORTION - IM: f1-f2',
  '2f1-f2': 'DISTORTION - IM: 2f1-f2',
};

/**
 * Map a spice-ts `.disto` result onto ngspice-47's complex distortion plots:
 * one plot per harmonic/intermodulation product, on the swept F1 grid, with
 * every node voltage `v(n)` and source branch current `i(vx)` kept in
 * rectangular form.
 */
function distortionAnalyses(distortion: {
  frequencies: number[];
  products: readonly (string | number)[];
}): EngineAnalysis[] {
  const internal = distortion as unknown as {
    voltageArrays: Map<string | number, Map<string, Array<{ real: number; imaginary: number }>>>;
    currentArrays: Map<string | number, Map<string, Array<{ real: number; imaginary: number }>>>;
  };
  const rectangular = (values: Array<{ real: number; imaginary: number }>): ComplexValue[] =>
    values.map(value => ({ re: value.real, im: value.imaginary }));
  return distortion.products.map(product => {
    const plotName = DISTORTION_PLOT_NAMES[String(product)];
    if (!plotName) throw new Error(`unmapped spice-ts distortion product ${String(product)}`);
    return {
      type: 'disto' as const,
      plotName,
      series: {
        grid: [...distortion.frequencies],
        signals: mapSignals(
          internal.voltageArrays.get(product) ?? new Map(),
          internal.currentArrays.get(product) ?? new Map(),
          rectangular,
        ),
      },
    };
  });
}

/**
 * `parseFirst` (default, used by the classic and aggregate reports) calls `parse()` before
 * `simulate()`. Since #510 `parse()` runs the same `.param` preprocessing as `simulate()`, so the
 * pre-check reports the same parse error; corpus-f still passes `parseFirst: false` to report
 * exactly what `simulate()` itself does.
 */
export interface NativeSpiceTsOptions {
  parseFirst?: boolean;
  coreModule?: string;
  resolveInclude?: (path: string) => Promise<string>;
}

export async function runNativeSpiceTs(
  input: Buffer,
  circuit: ClassicCircuit,
  options: NativeSpiceTsOptions = {},
): Promise<EngineExecution> {
  return runNativeSpiceTsEncoded(input, circuit, OBJECT_SAMPLES, options);
}

/** `runNativeSpiceTs` with each signal's samples stored by `encoding` (#839). */
export async function runNativeSpiceTsEncoded<S>(
  input: Buffer,
  circuit: ClassicCircuit,
  encoding: SampleEncoding<S>,
  options: NativeSpiceTsOptions = {},
): Promise<EncodedExecution<S>> {
  const text = input.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(input)) {
    return {
      status: 'unsupported',
      convergence: 'not-run',
      analyses: [],
      error: 'fixture is not lossless UTF-8 and cannot be supplied to the spice-ts string API',
    };
  }

  try {
    const core = await import(options.coreModule ?? pathToFileURL(resolve('packages/core/dist/index.js')).href);
    if (options.parseFirst ?? true) core.parse(text);
    const simulated = await core.simulate(text, { sourcePath: circuit.sourcePath, resolveInclude: options.resolveInclude });
    const analyses: EncodedAnalysis<S>[] = [];
    const runs = simulated.control?.runs ?? [];
    // The core also retains lowered straight-line .control runs in analyses[].
    // Their source-order semantics are not the measured dot-card batch rule.
    const hasControl = /^\s*\.control\b/im.test(text.split(/\r?\n/).slice(1).join('\n'));
    const dotRuns = (hasControl ? [] : simulated.analyses ?? []) as DotAnalysisRun[];
    const batchTypes = new Set(['ac', 'dc', 'op', 'tran']);
    // Native retained runs are source ordered, ngspice-47 batch plots are reversed
    // within type. See benchmarks/repeated-dot-1009/README.md (including diode DC).
    const retained = dotRuns.filter(run => batchTypes.has(run.analysis)).sort((a, b) => a.index - b.index);
    const remaining = new Map([...batchTypes].map(type => [type, retained.filter(run => run.analysis === type).length]));
    const results = runs.length > 0 ? runs : dotRuns.length > 0 ? [
      ...retained.map(run => {
        const occurrence = remaining.get(run.analysis)!;
        remaining.set(run.analysis, occurrence - 1);
        return { ...run, plot: `dot:${run.analysis}:${occurrence}` };
      }),
      // Unmeasured types (noise/pz/disto) retain the legacy aggregate mapping.
      { plot: undefined, analysis: undefined, result: simulated },
    ] : [{ plot: undefined, analysis: undefined, result: simulated }];
    for (const run of results) {
      const result = run.result;
      const first = analyses.length;
      const types = run.plot?.startsWith('dot:') ? circuit.analyses.filter(type => type === run.analysis).slice(0, 1) : circuit.analyses;
      for (const type of types) {
        if (runs.length === 0 && dotRuns.length > 0 && run.analysis === undefined && batchTypes.has(type)) continue;
        if (run.analysis !== undefined && run.analysis !== type) continue;
        if (type === 'op' && result.dc) {
          const voltages = new Map([...result.dc.voltages].map(([name, value]: [string, number]) => [name, [value]]));
          const currents = new Map([...result.dc.currents].map(([name, value]: [string, number]) => [name, [value]]));
          analyses.push({ type, plotName: 'Operating Point', series: { grid: [0], signals: mapSignals(voltages, currents, encoding.real) } });
        } else if (type === 'tran' && result.transient) {
          analyses.push({
            type,
            plotName: 'Transient Analysis',
            series: {
              grid: result.transient.time,
              signals: mapSignals(result.transient.voltages, result.transient.currents, encoding.real),
            },
          });
        } else if (type === 'ac' && result.ac) {
          analyses.push({
            type,
            plotName: 'AC Analysis',
            series: {
              grid: result.ac.frequencies,
              signals: mapSignals(result.ac.voltages, result.ac.currents, (values: Iterable<{ magnitude: number; phase: number }>) => encoding.complex(phasors(values))),
            },
          });
        } else if (type === 'dc' && result.dcSweep) {
          const internal = result.dcSweep as unknown as {
            sweepValues: Float64Array;
            voltageArrays: Map<string, Float64Array>;
            currentArrays: Map<string, Float64Array>;
            secondarySweepValues?: Float64Array;
          };
          analyses.push({
            type,
            plotName: 'DC transfer characteristic',
            series: {
              grid: Array.from(internal.sweepValues),
              ...(internal.secondarySweepValues ? { secondaryGrid: Array.from(internal.secondarySweepValues) } : {}),
              signals: mapSignals(internal.voltageArrays, internal.currentArrays, encoding.real),
            },
          });
        } else if (type === 'pz' && result.poleZero) {
          analyses.push(encodeAnalysis({
            type,
            plotName: 'Pole-Zero Analysis',
            series: { grid: [0], signals: poleZeroSignals(result.poleZero) },
          }, encoding));
        } else if (type === 'noise' && result.noise) {
          analyses.push(...noiseAnalyses(result.noise).map(analysis => encodeAnalysis(analysis, encoding)));
        } else if (type === 'disto' && result.distortion) {
          analyses.push(...distortionAnalyses(result.distortion).map(analysis => encodeAnalysis(analysis, encoding)));
        } else if (type === 'sp' && result.sParameters) {
          analyses.push({
            type,
            plotName: 'SP Analysis',
            series: {
              grid: result.sParameters.frequencies,
              signals: Object.fromEntries([...result.sParameters.vectors].map(([name, values]: [string, Array<{ real: number; imaginary: number }>]) => {
                const lower = name.toLowerCase();
                return [/^cy_\d+_\d+$/.test(lower) ? `i(${lower})` : lower,
                  encoding.complex(values.map(value => ({ re: value.real, im: value.imaginary })))];
              })),
            },
          });
        }
      }
      if (run.plot !== undefined) for (const [index, analysis] of analyses.slice(first).entries()) {
        // Noise/disto can produce two raw plots from one analysis command.
        analysis.plotId = analyses.length - first > 1 && /\d+$/.test(run.plot)
          ? run.plot.replace(/\d+$/, String(Number(run.plot.match(/\d+$/)![0]) + index)) : run.plot;
      }
    }
    const missing = circuit.analyses.filter(type => !analyses.some(analysis => analysis.type === type));
    if (missing.length > 0 || analyses.length === 0) {
      return {
        status: 'unsupported',
        convergence: analyses.length > 0 ? 'converged' : 'not-run',
        analyses,
        error: missing.length > 0
          ? `no spice-ts result for analyses: ${missing.join(', ')}`
          : 'fixture declares no runnable analysis',
      };
    }
    return { status: 'success', convergence: 'converged', analyses };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: /unsupported|unknown|parse|expected|invalid/i.test(message) ? 'unsupported' : 'failed',
      convergence: /converg|singular|timestep/i.test(message) ? 'failed' : 'not-run',
      analyses: [],
      error: cleanError(message),
    };
  }
}

function commandVersion(command: string, args: string[], pattern: RegExp): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return 'unavailable';
  const output = `${result.stdout}\n${result.stderr}`;
  return output.match(pattern)?.[0] ?? output.trim().split(/\r?\n/).find(Boolean) ?? 'unknown';
}

export function serializeClassicReport(report: ClassicReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const repoRoot = resolve('.');
const corpusRoot = resolve(repoRoot, 'benchmarks/corpus/classic');

async function createNativeReport(): Promise<ClassicReport> {
  const manifest = JSON.parse(await readFile(resolve(corpusRoot, 'manifest.json'), 'utf8')) as ClassicManifest;
  const corePackage = JSON.parse(await readFile(resolve(repoRoot, 'packages/core/package.json'), 'utf8')) as { version: string };
  return buildClassicReport(manifest, {
    readFixture: localPath => readFile(resolve(repoRoot, localPath)),
    runNgspice: runNativeNgspice,
    runSpiceTs: runNativeSpiceTs,
    tools: {
      ngspice: commandVersion('ngspice', ['--version'], /ngspice-\d+(?:\.\d+)*/i),
      spiceTs: corePackage.version,
    },
  });
}

async function main(): Promise<void> {
  const report = await createNativeReport();
  const json = serializeClassicReport(report);
  const outputIndex = process.argv.indexOf('--output');
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !outputPath) throw new Error('--output requires a path');
  if (outputPath) await writeFile(resolve(outputPath), json);
  else if (!process.argv.includes('--check')) process.stdout.write(json);

  if (process.argv.includes('--check')) {
    const expected = await readFile(resolve(corpusRoot, 'report.json'), 'utf8');
    if (expected !== json) throw new Error('classic report differs; regenerate report.json and review the changed outcomes');
  }

  const { totals } = report;
  process.stderr.write(
    `classic corpus: ${totals.fixtures}; ngspice ${totals.ngspice.success}/${totals.fixtures} success; `
      + `spice-ts ${totals.spiceTs.success}/${totals.fixtures} success; ${totals.comparedAnalyses} analyses compared\n`,
  );
}

if (basename(process.argv[1] ?? '') === 'report.ts') {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
