/**
 * Line-streaming reader for ngspice ASCII raw files (#694).
 *
 * `parseNgspiceRaw` needs the whole file as one string; a 680 MB transient-noise reference
 * (examples/transient-noise/noi-sc-tr.cir, 2,572,120 points) exceeds the Node string limit.
 * This reader produces the same plots line by line and keeps only the signals the caller asks for,
 * so a reference is never materialised beyond what can be scored. The grid is always kept.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ComplexValue, SampleSeries } from '../../comparison-harness.js';

export interface RawPlot extends SampleSeries {
  plotName: string;
  /** Points declared in the plot header (also `grid.length`). */
  points: number;
}

/** A plot whose kept signals are stored by a {@link ColumnStore}. */
export interface StoredRawPlot<C> {
  plotName: string;
  points: number;
  grid: number[];
  signals: Record<string, C>;
}

/** Where a kept signal's samples go: one ComplexValue each, or packed columns (#839). */
export interface ColumnStore<C> {
  create(points: number): C;
  set(column: C, point: number, re: number, im: number): void;
}

const OBJECT_COLUMNS: ColumnStore<ComplexValue[]> = {
  create: () => [],
  set: (column, _point, re, im) => { column.push({ re, im }); },
};

/** Packed column: the samples of one signal as parallel real/imaginary Float64Arrays. */
export interface PackedColumn { re: Float64Array; im: Float64Array }

export const PACKED_COLUMNS: ColumnStore<PackedColumn> = {
  create: points => ({ re: new Float64Array(points), im: new Float64Array(points) }),
  set: (column, point, re, im) => { column.re[point] = re; column.im[point] = im; },
};

/** Decides which signals of a plot to keep; omitted means keep every signal. */
export type KeepSignal = (plotName: string, signal: string) => boolean;

interface Header {
  plotName?: string;
  variables?: number;
  points?: number;
  names: string[];
}

function parseValue(token: string): ComplexValue {
  const [realPart, imaginaryPart] = token.trim().split(',');
  return { re: Number(realPart), im: imaginaryPart === undefined ? 0 : Number(imaginaryPart) };
}

/**
 * Same plots, names, grid rule and values as `parseNgspiceRaw` (comparison-harness.ts), read
 * line by line: a plot whose variable list does not match its declared count is skipped, the
 * first variable is the grid for `time`/`frequency` vectors and DC transfer plots (otherwise the
 * grid is the point index), and names are lower-cased.
 */
export async function readNgspiceRawFile(path: string, keep?: KeepSignal): Promise<RawPlot[]> {
  return parseRawLines(rawFileLines(path), keep);
}

/**
 * {@link readNgspiceRawFile} into packed Float64Array columns: the same values without one object
 * per sample, so a 1e6-point reference fits in a bounded heap (#839).
 */
export async function readNgspiceRawFilePacked(path: string, keep?: KeepSignal): Promise<Array<StoredRawPlot<PackedColumn>>> {
  return parseRawLinesInto(rawFileLines(path), PACKED_COLUMNS, keep);
}

function rawFileLines(path: string): AsyncIterable<string> {
  return createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
}

export async function parseRawLines(lines: AsyncIterable<string> | Iterable<string>, keep?: KeepSignal): Promise<RawPlot[]> {
  return parseRawLinesInto(lines, OBJECT_COLUMNS, keep);
}

export async function parseRawLinesInto<C>(
  lines: AsyncIterable<string> | Iterable<string>,
  store: ColumnStore<C>,
  keep?: KeepSignal,
): Promise<Array<StoredRawPlot<C>>> {
  const plots: Array<StoredRawPlot<C>> = [];
  let state: 'idle' | 'header' | 'variables' | 'values' = 'idle';
  let header: Header = { names: [] };
  let plot: StoredRawPlot<C> | undefined;
  let columns: Array<C | undefined> = [];
  let gridIsVariable = false;
  let point = 0;
  let variable = 0;

  const finishPlot = (): void => {
    // A truncated values section is padded to the declared point count exactly as parseNgspiceRaw
    // pads it (a missing token parses as Number('') = 0).
    if (plot && state === 'values') {
      while (point < plot.points) storeValue(0, 0);
      plots.push(plot);
    }
    plot = undefined;
  };

  const storeValue = (re: number, im: number): void => {
    if (!plot) return;
    if (variable === 0) plot.grid.push(gridIsVariable ? re : point);
    const column = columns[variable];
    if (column) store.set(column, point, re, im);
    variable += 1;
    if (variable === header.names.length) { variable = 0; point += 1; }
  };

  const startValues = (): void => {
    const { plotName, variables, points, names } = header;
    if (!plotName || !Number.isInteger(variables) || !Number.isInteger(points) || names.length !== variables) {
      state = 'idle';
      return;
    }
    gridIsVariable = names[0] === 'time' || names[0] === 'frequency' || plotName.toLowerCase().includes('dc transfer');
    if (names.length === 0) {
      plots.push({ plotName, points: points!, grid: Array.from({ length: points! }, (_, index) => index), signals: {} });
      state = 'idle';
      return;
    }
    plot = { plotName, points: points!, grid: [], signals: {} };
    columns = names.map((name, index) => {
      if (gridIsVariable && index === 0) return undefined;
      if (keep && !keep(plotName, name)) return undefined;
      const values = store.create(points!);
      plot!.signals[name] = values;
      return values;
    });
    point = 0;
    variable = 0;
    state = 'values';
  };

  for await (const line of lines) {
    if (/^Title:/.test(line)) {
      finishPlot();
      header = { names: [] };
      state = 'header';
      continue;
    }
    if (state === 'header' || state === 'variables') {
      const plotName = /^Plotname:\s*(.+)$/.exec(line);
      if (plotName) header.plotName ??= plotName[1].trim();
      const variables = /^No\. Variables:\s*(\d+)/.exec(line);
      if (variables) header.variables ??= Number(variables[1]);
      const points = /^No\. Points:\s*(\d+)/.exec(line);
      if (points) header.points ??= Number(points[1]);
      if (/^Values:/.test(line)) { startValues(); continue; }
      if (state === 'header' && /^Variables:/.test(line)) { state = 'variables'; continue; }
      if (state === 'variables') {
        const name = /^\s*\d+\s+(\S+)/.exec(line)?.[1]?.toLowerCase();
        if (name !== undefined) header.names.push(name);
      }
      continue;
    }
    // INTERP startup may repeat the variable table and Values marker before
    // numeric output. Like parseNgspiceRaw, retain the final values section.
    if (state === 'values' && /^Values:/.test(line)) { startValues(); continue; }
    if (state !== 'values' || !plot || line.trim() === '' || point >= plot.points) continue;
    const token = variable === 0 ? line.replace(/^\s*\d+\s+/, '').trim() : line.trim();
    const value = parseValue(token);
    storeValue(value.re, value.im);
  }
  finishPlot();
  return plots;
}
