#!/usr/bin/env tsx
/**
 * Reproducible spice-ts/ngspice correctness comparison harness.
 *
 * Usage:
 *   pnpm bench:compare:v2 -- --output /tmp/comparison-v2-report.json
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { SimulationResult } from '../packages/core/dist/index.js';
import { cmosRingOscillator, rcChain, rcChainAC, resistorLadder } from './circuits/generators.js';

export const RELATIVE_ZERO_THRESHOLD = 1e-15;
export const SCHEMA_VERSION = 'spice-ts-ngspice-comparison/v2' as const;

export type AnalysisType = 'op' | 'dc' | 'ac' | 'tran';

export interface ComplexValue {
  re: number;
  im: number;
}

export interface SampleSeries {
  grid: number[];
  signals: Record<string, ComplexValue[]>;
  /** Per-point secondary DC coordinate, when the engine exposes it. */
  secondaryGrid?: number[];
}

export interface SuccessfulEngineRun {
  status: 'success';
  convergence: 'converged';
  runtimeMs: number;
  command: string[];
  series: SampleSeries;
}

export interface FailedEngineRun {
  status: 'failed' | 'unsupported';
  convergence: 'failed' | 'unsupported';
  runtimeMs: number;
  command: string[];
  error: string;
}

export type EngineRun = SuccessfulEngineRun | FailedEngineRun;

export interface ComparisonFixture {
  name: string;
  analysis: AnalysisType;
  netlist: string;
  signals: string[];
}

export interface ErrorSummary {
  max: number;
  rms: number;
}

export interface RelativeErrorSummary {
  max: number | null;
  rms: number | null;
  sampleCount: number;
  excludedZeroReferences: number;
}

export type SignalComparison =
  | {
      status: 'compared';
      sampleCount: number;
      absoluteError: ErrorSummary;
      relativeError: RelativeErrorSummary;
    }
  | {
      status: 'missing';
      missingFrom: ('spice-ts' | 'ngspice')[];
    };

export interface ComparisonMetrics {
  sweepAlignment?: 'secondary-value' | 'reset-ordinal';
  sweepGroups?: Array<{ ordinal: number; secondaryValue?: number; alignedPoints: number; unmatched?: 'spice-ts' | 'ngspice' }>;
  grid: {
    spiceTsPoints: number;
    ngspicePoints: number;
    alignedPoints: number;
    excludedOutOfRange: number;
  };
  signals: Record<string, SignalComparison>;
}

export interface FixtureReport {
  name: string;
  analysis: AnalysisType;
  netlistSha256: string;
  status: 'compared' | 'failed';
  signals: string[];
  spiceTs: EngineRun;
  ngspice: EngineRun;
  metrics: ComparisonMetrics | null;
}

export interface ComparisonReport {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  environment: {
    platform: string;
    arch: string;
    node: string;
    cpu: string;
  };
  tools: {
    spiceTs: { version: string; command: string[] };
    ngspice: { version: string; command: string[] };
  };
  alignment: {
    targetGrid: 'spice-ts';
    interpolation: 'linear';
    relativeZeroThreshold: number;
  };
  fixtures: FixtureReport[];
}

export interface ComparisonDependencies {
  runSpiceTs: (fixture: ComparisonFixture) => Promise<EngineRun>;
  runNgspice: (fixture: ComparisonFixture) => Promise<EngineRun>;
}

interface ParsedPlot extends SampleSeries {
  plotName: string;
}

function magnitude(value: ComplexValue): number {
  return Math.hypot(value.re, value.im);
}

function difference(a: ComplexValue, b: ComplexValue): number {
  return Math.hypot(a.re - b.re, a.im - b.im);
}

// Loop reduction instead of Math.max(...values): a spread of ~100k+ values
// overflows the call stack with RangeError (#611). NaN propagates like Math.max.
function maxOf(values: number[]): number {
  let max = -Infinity;
  for (const value of values) {
    if (Number.isNaN(value)) return Number.NaN;
    if (value > max) max = value;
  }
  return max;
}

function rms(values: number[]): number {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function linear(
  grid: number[],
  values: ComplexValue[],
  from: number,
  to: number,
  target: number,
): ComplexValue | null {
  const span = grid[to] - grid[from];
  if (span <= 0 || values[from] === undefined || values[to] === undefined) return null;
  const fraction = (target - grid[from]) / span;
  return {
    re: values[from].re + (values[to].re - values[from].re) * fraction,
    im: values[from].im + (values[to].im - values[from].im) * fraction,
  };
}

/**
 * Reference value(s) at `target`. `linear` is the usual interpolation between the bracketing
 * samples. `rightSided` is set only when the bracket opens at a transient breakpoint: the
 * reconstruction from the samples after the breakpoint, valid if the waveform steps there.
 */
function interpolate(
  grid: number[],
  values: ComplexValue[],
  target: number,
  breakpoints?: ReadonlySet<number>,
): { linear: ComplexValue; rightSided?: ComplexValue } | null {
  if (grid.length === 0 || target < grid[0] || target > grid[grid.length - 1]) return null;
  if (grid.length === 1) return target === grid[0] && values[0] !== undefined ? { linear: values[0] } : null;

  let low = 0;
  let high = grid.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (grid[middle] === target) return values[middle] === undefined ? null : { linear: values[middle] };
    if (grid[middle] < target) low = middle + 1;
    else high = middle - 1;
  }

  const upper = low;
  const lower = upper - 1;
  const interpolated = linear(grid, values, lower, upper, target);
  if (interpolated === null) return null;
  if (!breakpoints?.has(grid[lower])) return { linear: interpolated };
  // Extrapolate backwards from the first two samples after the breakpoint; with only one
  // sample left, hold it.
  const rightSided = upper + 1 < grid.length
    ? linear(grid, values, upper, upper + 1, target)
    : values[upper];
  return rightSided === null || rightSided === undefined
    ? { linear: interpolated }
    : { linear: interpolated, rightSided };
}

/**
 * Split a sweep grid into maximal monotonic runs. A run ends only where the grid
 * strictly reverses its direction (a nested DC sweep restarting its primary
 * source); repeated values such as transient breakpoints stay in one run.
 */
export function monotonicSegments(grid: number[]): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let start = 0;
  let direction = 0;
  for (let index = 1; index < grid.length; index += 1) {
    const step = Math.sign(grid[index] - grid[index - 1]);
    if (step === 0) continue;
    if (direction === 0) direction = step;
    else if (step !== direction) {
      segments.push({ start, end: index });
      start = index;
    }
  }
  if (grid.length > 0) segments.push({ start, end: grid.length });
  return segments;
}

export function sweepSegments(series: SampleSeries): Array<{ start: number; end: number; secondaryValue?: number }> {
  if (series.secondaryGrid === undefined) return monotonicSegments(series.grid);
  if (series.secondaryGrid.length !== series.grid.length || series.secondaryGrid.some(value => !Number.isFinite(value))) throw new Error('invalid secondary DC grid');
  const segments: Array<{ start: number; end: number; secondaryValue: number }> = [];
  for (let start = 0; start < series.grid.length;) {
    const secondaryValue = series.secondaryGrid[start];
    let end = start + 1;
    while (end < series.grid.length && series.secondaryGrid[end] === secondaryValue) end++;
    segments.push({ start, end, secondaryValue });
    start = end;
  }
  if (new Set(segments.map(segment => segment.secondaryValue)).size !== segments.length) throw new Error('repeated secondary DC coordinate');
  return segments;
}

/**
 * Transient breakpoints as evidenced by the outputs: the time points present, bit-identical,
 * in both engines' grids. Adaptive time steps essentially never coincide exactly; forced
 * breakpoints (t = 0, source corners, TSTOP) do.
 */
export function sharedGridPoints(spiceTsGrid: readonly number[], ngspiceGrid: readonly number[]): Set<number> {
  const spiceTsPoints = new Set(spiceTsGrid);
  return new Set(ngspiceGrid.filter(point => spiceTsPoints.has(point)));
}

export interface AlignmentOptions {
  /**
   * Transient only: breakpoints from {@link sharedGridPoints}. The comparison is one-sided
   * across every ngspice interval that opens at one of them (#445).
   *
   * Both engines land exactly on source breakpoints (PWL/PULSE corners) and report there the
   * solution of the step that ends at the breakpoint: the left limit. A quantity such as
   * L·di/dt can step at that instant, and ngspice first reports its right limit at the next
   * sample. Linear interpolation across that interval invents intermediate values neither
   * engine produced and charges them as error. Inside such an interval only, each spice-ts
   * sample is compared with the nearer of two reconstructions: the linear interpolation
   * (continuous waveform) and the right-sided reconstruction from the samples after the
   * breakpoint (waveform steps at the breakpoint). No other interval and no tolerance changes.
   */
  breakpoints?: ReadonlySet<number>;
}

/** Reference-only work, reusable across target chunks without changing sample order. */
export function prepareAlignmentReference(ngspice: SampleSeries) {
  const segments = sweepSegments(ngspice).map(({ start, end, secondaryValue }) => {
    const grid = ngspice.grid.slice(start, end);
    const descending = grid.length > 1 && grid[0] > grid[grid.length - 1];
    return { start, end, secondaryValue, descending, grid: descending ? grid.reverse() : grid };
  });
  const values = new Map<string, ComplexValue[][]>();
  return { segments, valuesFor(name: string) {
    let prepared = values.get(name);
    if (prepared === undefined) {
      prepared = segments.map(({ start, end, descending }) => {
        const part = ngspice.signals[name].slice(start, end);
        return descending ? part.reverse() : part;
      });
      values.set(name, prepared);
    }
    return prepared;
  } };
}

/**
 * Compare on the spice-ts output points, linearly interpolating the ngspice reference.
 * With `breakpoints` the reference is not interpolated across a breakpoint
 * step it leaves unresolved; see {@link AlignmentOptions}.
 */
export function alignAndMeasure(
  spiceTs: SampleSeries,
  ngspice: SampleSeries,
  requestedSignals: string[],
  options: AlignmentOptions = {},
  preparedReference = prepareAlignmentReference(ngspice),
): ComparisonMetrics {
  // A two-source nested DC sweep restarts the primary grid for every secondary
  // value, so each engine's grid is a sequence of monotonic segments. Points are
  // only ever aligned within the segment with the same ordinal in both engines;
  // interpolating across the repeated grid would compare unrelated sweep points.
  const spiceSegments = sweepSegments(spiceTs);
  const referenceSegments = preparedReference.segments;
  const explicit = spiceTs.secondaryGrid !== undefined && ngspice.secondaryGrid !== undefined;
  const referenceCoordinates = new Map(referenceSegments.map((group, index) => [group.secondaryValue, index]));
  const ordinalFallback = !explicit && (spiceTs.secondaryGrid !== undefined || ngspice.secondaryGrid !== undefined || spiceSegments.length > 1 || referenceSegments.length > 1);
  const pairing = spiceSegments.map((group, ordinal) => {
    if (explicit) return referenceCoordinates.get(group.secondaryValue) ?? -1;
    if (spiceSegments.length !== referenceSegments.length) return -1;
    if (ordinalFallback) {
      const reference = referenceSegments[ordinal];
      // Unknown secondary coordinates cannot justify interpolation. Require the
      // same primary samples (in acquisition order) in each reset-ordinal group.
      if (group.end - group.start !== reference.end - reference.start) return -1;
      for (let index = group.start; index < group.end; index += 1) {
        if (spiceTs.grid[index] !== ngspice.grid[reference.start + index - group.start]) return -1;
      }
    }
    return ordinal;
  });
  const pairedReferences = new Set(pairing);
  const groupAlignedPoints = spiceSegments.map(() => 0);
  const { breakpoints } = options;
  const targetIndexes = spiceSegments.flatMap(({ start, end }, ordinal) => {
      const segment = pairing[ordinal];
      if (segment < 0) return [];
      const referenceGrid = referenceSegments[segment].grid;
      const targets: Array<{ point: number; index: number; segment: number }> = [];
      for (let index = start; index < end; index += 1) {
        const point = spiceTs.grid[index];
        if (referenceGrid.length > 0 && point >= referenceGrid[0] && point <= referenceGrid[referenceGrid.length - 1]) {
          targets.push({ point, index, segment });
        }
      }
      groupAlignedPoints[ordinal] = targets.length;
      return targets;
    });
  const signals: Record<string, SignalComparison> = {};

  for (const requestedName of requestedSignals) {
    const name = requestedName.toLowerCase();
    const spiceValues = spiceTs.signals[name];
    const ngspiceValues = ngspice.signals[name];
    if (spiceValues === undefined || ngspiceValues === undefined) {
      const missingFrom: ('spice-ts' | 'ngspice')[] = [];
      if (spiceValues === undefined) missingFrom.push('spice-ts');
      if (ngspiceValues === undefined) missingFrom.push('ngspice');
      signals[requestedName] = { status: 'missing', missingFrom };
      continue;
    }

    const absoluteErrors: number[] = [];
    const relativeErrors: number[] = [];
    let excludedZeroReferences = 0;
    const referenceValues = preparedReference.valuesFor(name);
    for (const { point, index, segment } of targetIndexes) {
      const actual = spiceValues[index];
      const candidates = interpolate(referenceSegments[segment].grid, referenceValues[segment], point, breakpoints);
      if (actual === undefined || candidates === null) continue;
      const { rightSided } = candidates;
      const reference = rightSided !== undefined && difference(actual, rightSided) < difference(actual, candidates.linear)
        ? rightSided
        : candidates.linear;
      const absoluteError = difference(actual, reference);
      absoluteErrors.push(absoluteError);
      const referenceMagnitude = magnitude(reference);
      if (referenceMagnitude <= RELATIVE_ZERO_THRESHOLD) excludedZeroReferences += 1;
      else relativeErrors.push(absoluteError / referenceMagnitude);
    }

    signals[requestedName] = {
      status: 'compared',
      sampleCount: absoluteErrors.length,
      absoluteError: {
        max: absoluteErrors.length > 0 ? maxOf(absoluteErrors) : 0,
        rms: absoluteErrors.length > 0 ? rms(absoluteErrors) : 0,
      },
      relativeError: {
        max: relativeErrors.length > 0 ? maxOf(relativeErrors) : null,
        rms: relativeErrors.length > 0 ? rms(relativeErrors) : null,
        sampleCount: relativeErrors.length,
        excludedZeroReferences,
      },
    };
  }

  return {
    ...(ordinalFallback || explicit ? { sweepAlignment: explicit ? 'secondary-value' as const : 'reset-ordinal' as const, sweepGroups: [
      ...spiceSegments.map((group, ordinal) => ({ ordinal, ...(group.secondaryValue === undefined ? {} : { secondaryValue: group.secondaryValue }), alignedPoints: groupAlignedPoints[ordinal], ...(pairing[ordinal] < 0 ? { unmatched: 'ngspice' as const } : {}) })),
      ...referenceSegments.flatMap((group, ordinal) => pairedReferences.has(ordinal) ? [] : [{ ordinal, ...(group.secondaryValue === undefined ? {} : { secondaryValue: group.secondaryValue }), alignedPoints: 0, unmatched: 'spice-ts' as const }]),
    ] } : {}),
    grid: {
      spiceTsPoints: spiceTs.grid.length,
      ngspicePoints: ngspice.grid.length,
      alignedPoints: targetIndexes.length,
      excludedOutOfRange: spiceTs.grid.length - targetIndexes.length,
    },
    signals,
  };
}

function parseValue(token: string): ComplexValue {
  const [realPart, imaginaryPart] = token.trim().split(',');
  return { re: Number(realPart), im: imaginaryPart === undefined ? 0 : Number(imaginaryPart) };
}

export function parseNgspiceRaw(raw: string): ParsedPlot[] {
  const starts: number[] = [];
  const titlePattern = /^Title:/gm;
  for (let match = titlePattern.exec(raw); match !== null; match = titlePattern.exec(raw)) starts.push(match.index);
  const plots: ParsedPlot[] = [];

  for (let sectionIndex = 0; sectionIndex < starts.length; sectionIndex += 1) {
    const section = raw.slice(starts[sectionIndex], starts[sectionIndex + 1] ?? raw.length);
    const plotName = section.match(/^Plotname:\s*(.+)$/m)?.[1]?.trim();
    const variableCount = Number(section.match(/^No\. Variables:\s*(\d+)/m)?.[1]);
    const pointCount = Number(section.match(/^No\. Points:\s*(\d+)/m)?.[1]);
    const variablesStart = section.indexOf('Variables:');
    const valuesStart = section.indexOf('Values:');
    if (!plotName || !Number.isInteger(variableCount) || !Number.isInteger(pointCount) || variablesStart < 0 || valuesStart < 0) continue;

    const variableLines = section.slice(variablesStart + 'Variables:'.length, valuesStart).trim().split('\n');
    const variableNames = variableLines
      .map(line => line.match(/^\s*\d+\s+(\S+)/)?.[1]?.toLowerCase())
      .filter((name): name is string => name !== undefined);
    if (variableNames.length !== variableCount) continue;

    const valueLines = section.slice(valuesStart + 'Values:'.length).trim().split('\n').filter(Boolean);
    const rows: ComplexValue[][] = [];
    let lineIndex = 0;
    for (let point = 0; point < pointCount; point += 1) {
      const row: ComplexValue[] = [];
      for (let variable = 0; variable < variableCount; variable += 1) {
        const line = valueLines[lineIndex++] ?? '';
        const token = variable === 0 ? line.replace(/^\s*\d+\s+/, '').trim() : line.trim();
        row.push(parseValue(token));
      }
      rows.push(row);
    }

    const firstVariableIsGrid = variableNames[0] === 'time' || variableNames[0] === 'frequency' || plotName.toLowerCase().includes('dc transfer');
    const grid = firstVariableIsGrid ? rows.map(row => row[0].re) : rows.map((_, index) => index);
    const signals: Record<string, ComplexValue[]> = {};
    for (let variable = firstVariableIsGrid ? 1 : 0; variable < variableNames.length; variable += 1) {
      signals[variableNames[variable]] = rows.map(row => row[variable]);
    }
    plots.push({ plotName, grid, signals });
  }

  return plots;
}

function requestedSignal(
  signal: string,
  voltage: (name: string) => readonly (number | { magnitude: number; phase: number })[],
  current: (name: string) => readonly (number | { magnitude: number; phase: number })[],
  complex: boolean,
): ComplexValue[] {
  const match = signal.match(/^([vi])\((.+)\)$/i);
  if (!match) throw new Error(`Unsupported signal syntax: ${signal}`);
  const values = match[1].toLowerCase() === 'v' ? voltage(match[2]) : current(match[2]);
  return values.map(value => {
    if (!complex || typeof value === 'number') return { re: value as number, im: 0 };
    const radians = value.phase * Math.PI / 180;
    return { re: value.magnitude * Math.cos(radians), im: value.magnitude * Math.sin(radians) };
  });
}

function simulationToSeries(result: SimulationResult, fixture: ComparisonFixture): SampleSeries {
  const signals: Record<string, ComplexValue[]> = {};
  if (fixture.analysis === 'op') {
    if (!result.dc) throw new Error('spice-ts did not return an operating point');
    for (const signal of fixture.signals) {
      const match = signal.match(/^([vi])\((.+)\)$/i);
      if (!match) throw new Error(`Unsupported signal syntax: ${signal}`);
      const value = match[1].toLowerCase() === 'v' ? result.dc.voltage(match[2]) : result.dc.current(match[2]);
      signals[signal.toLowerCase()] = [{ re: value, im: 0 }];
    }
    return { grid: [0], signals };
  }
  if (fixture.analysis === 'dc') {
    if (!result.dcSweep) throw new Error('spice-ts did not return a DC sweep');
    for (const signal of fixture.signals) {
      signals[signal.toLowerCase()] = requestedSignal(
        signal,
        node => Array.from(result.dcSweep!.voltage(node)),
        source => Array.from(result.dcSweep!.current(source)),
        false,
      );
    }
    return { grid: Array.from(result.dcSweep.sweepValues), signals };
  }
  if (fixture.analysis === 'tran') {
    if (!result.transient) throw new Error('spice-ts did not return a transient analysis');
    for (const signal of fixture.signals) {
      signals[signal.toLowerCase()] = requestedSignal(
        signal,
        node => result.transient!.voltage(node),
        source => result.transient!.current(source),
        false,
      );
    }
    return { grid: result.transient.time, signals };
  }
  if (!result.ac) throw new Error('spice-ts did not return an AC analysis');
  for (const signal of fixture.signals) {
    signals[signal.toLowerCase()] = requestedSignal(
      signal,
      node => result.ac!.voltage(node),
      source => result.ac!.current(source),
      true,
    );
  }
  return { grid: result.ac.frequencies, signals };
}

export async function runSpiceTs(fixture: ComparisonFixture): Promise<EngineRun> {
  const command = ['@spice-ts/core', 'simulate', `<${fixture.name}.cir>`];
  const start = performance.now();
  try {
    const { simulate } = await import('../packages/core/dist/index.js');
    const result = await simulate(fixture.netlist);
    return {
      status: 'success',
      convergence: 'converged',
      runtimeMs: performance.now() - start,
      command,
      series: simulationToSeries(result, fixture),
    };
  } catch (error) {
    return {
      status: 'failed',
      convergence: 'failed',
      runtimeMs: performance.now() - start,
      command,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function expectedPlotName(analysis: AnalysisType): string {
  if (analysis === 'op') return 'operating point';
  if (analysis === 'dc') return 'dc transfer';
  if (analysis === 'ac') return 'ac analysis';
  return 'transient analysis';
}

export async function runNgspice(fixture: ComparisonFixture): Promise<EngineRun> {
  const command = ['ngspice', '-b', '-r', '<temporary-rawfile>', `<${fixture.name}.cir>`];
  const directory = mkdtempSync(join(tmpdir(), 'spice-ts-comparison-'));
  const netlistPath = join(directory, `${fixture.name}.cir`);
  const rawPath = join(directory, `${fixture.name}.raw`);
  writeFileSync(netlistPath, fixture.netlist);
  writeFileSync(join(directory, '.spiceinit'), 'set filetype=ascii\n');
  const start = performance.now();
  try {
    const completed = spawnSync('ngspice', ['-b', '-r', rawPath, netlistPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: directory },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    const runtimeMs = performance.now() - start;
    if (completed.error || completed.status !== 0) {
      const detail = completed.error?.message ?? [completed.stderr, completed.stdout].filter(Boolean).join('\n').trim();
      return {
        status: 'failed',
        convergence: 'failed',
        runtimeMs,
        command,
        error: detail || `ngspice exited ${completed.status}`,
      };
    }
    const plots = parseNgspiceRaw(readFileSync(rawPath, 'utf8'));
    const expected = expectedPlotName(fixture.analysis);
    const plot = plots.find(candidate => candidate.plotName.toLowerCase().includes(expected));
    if (!plot) {
      return {
        status: 'unsupported',
        convergence: 'unsupported',
        runtimeMs,
        command,
        error: `ngspice raw output did not contain ${expected}`,
      };
    }
    return {
      status: 'success',
      convergence: 'converged',
      runtimeMs,
      command,
      series: { grid: plot.grid, signals: plot.signals },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function compareFixture(
  fixture: ComparisonFixture,
  dependencies: ComparisonDependencies = { runSpiceTs, runNgspice },
): Promise<FixtureReport> {
  const captureFailure = async (runner: () => Promise<EngineRun>, command: string[]): Promise<EngineRun> => {
    const start = performance.now();
    try {
      return await runner();
    } catch (error) {
      return {
        status: 'failed',
        convergence: 'failed',
        runtimeMs: performance.now() - start,
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const [spiceTs, ngspice] = await Promise.all([
    captureFailure(() => dependencies.runSpiceTs(fixture), ['@spice-ts/core', 'simulate', `<${fixture.name}.cir>`]),
    captureFailure(() => dependencies.runNgspice(fixture), ['ngspice', '-b', '-r', '<temporary-rawfile>', `<${fixture.name}.cir>`]),
  ]);
  const comparable = spiceTs.status === 'success' && ngspice.status === 'success';
  const metrics = comparable ? alignAndMeasure(spiceTs.series, ngspice.series, fixture.signals) : null;
  const complete = metrics !== null
    && metrics.grid.alignedPoints > 0
    && Object.values(metrics.signals).every(signal => signal.status === 'compared' && signal.sampleCount > 0);
  return {
    name: fixture.name,
    analysis: fixture.analysis,
    netlistSha256: createHash('sha256').update(fixture.netlist).digest('hex'),
    status: complete ? 'compared' : 'failed',
    signals: fixture.signals,
    spiceTs,
    ngspice,
    metrics,
  };
}

export function serializeReport(report: ComparisonReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function ngspiceVersion(): string {
  try {
    const output = execFileSync('ngspice', ['--version'], { encoding: 'utf8' });
    return output.match(/ngspice-\d+(?:\.\d+)*/i)?.[0] ?? output.trim().split('\n')[0];
  } catch {
    return 'unavailable';
  }
}

function spiceTsVersion(): string {
  const packageJson = JSON.parse(readFileSync(resolve('packages/core/package.json'), 'utf8')) as { version: string };
  return packageJson.version;
}

export const INITIAL_STATE_FIXTURES: ComparisonFixture[] = [
  {
    name: 'ic-without-uic',
    analysis: 'tran',
    netlist: '* .ic without UIC\nV1 out 0 DC 1\nR1 out 0 1k\n.ic V(out)=3\n.tran 1u 2u\n.end',
    signals: ['v(out)'],
  },
  {
    name: 'ic-with-uic',
    analysis: 'tran',
    netlist: '* .ic with UIC\nR1 out 0 1k\nC1 out 0 1u\n.ic V(out)=3\n.tran 1u 2u UIC\n.end',
    signals: ['v(out)'],
  },
  {
    name: 'nodeset-op',
    analysis: 'op',
    netlist: '* .nodeset operating point\nV1 in 0 DC 1\nR1 in out 1k\nR2 out 0 1k\n.nodeset V(out)=9\n.op\n.end',
    signals: ['v(out)'],
  },
  {
    name: 'ic-with-uic-mixed-case-node',
    analysis: 'tran',
    netlist: '* case-insensitive .ic node\nR1 OUT 0 1k\nC1 OUT 0 1u\n.ic V(out)=3\n.tran 1u 2u UIC\n.end',
    signals: ['v(OUT)'],
  },
];

export const RING_OSCILLATOR_FIXTURES: ComparisonFixture[] = [3, 5, 11].map(stages => ({
  name: `ring-oscillator-${stages}-stage`,
  analysis: 'tran',
  netlist: cmosRingOscillator(stages),
  signals: ['v(n1)'],
}));

export const DEFAULT_FIXTURES: ComparisonFixture[] = [
  { name: 'resistor-ladder-op', analysis: 'op', netlist: resistorLadder(3), signals: ['v(2)'] },
  { name: 'rc-chain-ac', analysis: 'ac', netlist: rcChainAC(1), signals: ['v(2)'] },
  {
    name: 'rc-chain-tran',
    analysis: 'tran',
    netlist: rcChain(1, { stopTime: 5e-3, timestep: 1e-5 }),
    signals: ['v(2)'],
  },
  ...INITIAL_STATE_FIXTURES,
  ...RING_OSCILLATOR_FIXTURES,
];

export async function createReport(fixtures = DEFAULT_FIXTURES): Promise<ComparisonReport> {
  const fixtureReports: FixtureReport[] = [];
  for (const fixture of fixtures) fixtureReports.push(await compareFixture(fixture));
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
    },
    tools: {
      spiceTs: { version: spiceTsVersion(), command: ['pnpm', 'bench:compare:v2'] },
      ngspice: { version: ngspiceVersion(), command: ['ngspice', '-b', '-r', '<raw>', '<netlist>'] },
    },
    alignment: {
      targetGrid: 'spice-ts',
      interpolation: 'linear',
      relativeZeroThreshold: RELATIVE_ZERO_THRESHOLD,
    },
    fixtures: fixtureReports,
  };
}

async function main(): Promise<void> {
  const outputFlag = process.argv.indexOf('--output');
  const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
  if (outputFlag >= 0 && !outputPath) throw new Error('--output requires a path');
  const report = await createReport();
  const json = serializeReport(report);
  if (outputPath) writeFileSync(resolve(outputPath), json);
  else process.stdout.write(json);
  if (report.fixtures.some(fixture => fixture.status === 'failed')) process.exitCode = 1;
}

if (basename(process.argv[1] ?? '') === 'comparison-harness.ts') {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
