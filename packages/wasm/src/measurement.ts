import { evaluateMeasureCards, measureCard, measurePlot, TransientResult, type MeasureCard } from '@spice-ts/core';
import type { TransientResultV1 } from '@spice-ts/core/protocol';

export interface WasmMeasurement {
  card: MeasureCard;
  unit: 'V' | 'A';
}

// Deliberately exclude expressions, crossing selectors, parameters and non-numeric bounds.
const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?(?:meg|mil|[tgkmunpf])?';
const vector = '(v|i)\\(([a-z0-9_.$:#-]+)\\)';
const head = '^\\.meas(?:ure)?\\s+tran\\s+[a-z_][a-z0-9_]*\\s+';
const find = new RegExp(`${head}find\\s+${vector}\\s+at\\s*=\\s*(${number})\\s*$`, 'i');
const aggregate = new RegExp(`${head}(?:avg|min|max|rms)\\s+${vector}\\s+from\\s*=\\s*(${number})\\s+to\\s*=\\s*(${number})\\s*$`, 'i');

export function parseWasmMeasurement(text: string, line: number): WasmMeasurement | undefined {
  const match = find.exec(text) ?? aggregate.exec(text);
  if (!match || match.slice(3).some(value => /e[+-]?\d+(?:meg|mil|[tgkmunpf])$/i.test(value))) return undefined;
  const factors: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  const bounds = match.slice(3).map(value => {
    const suffix = /(?:meg|mil|[tgkmunpf])$/i.exec(value)?.[0].toLowerCase();
    return Number.parseFloat(value) * (suffix ? factors[suffix]! : 1);
  });
  if (bounds.some(value => !Number.isFinite(value)) || (bounds.length === 2 && bounds[0]! >= bounds[1]!)) return undefined;
  return { card: measureCard(text, line, 0), unit: match[1]!.toLowerCase() === 'v' ? 'V' : 'A' };
}

export function addMeasurements(result: TransientResultV1, measurements: WasmMeasurement[]): void {
  if (!measurements.length) return;
  const transient = new TransientResult(result.timeS, new Map(Object.entries(result.voltagesV)), new Map(Object.entries(result.currentsA)));
  const plot = measurePlot({ type: 'tran', timestep: 1, stopTime: result.timeS.at(-1) ?? 0 }, { transient, warnings: [] });
  if (!plot) throw new Error('Transient plot unavailable');
  const values = evaluateMeasureCards(measurements.map(m => m.card), 'tran', plot, new Map());
  result.measurements = values.map((m, i) => m.status === 'ok' && m.value !== undefined && Number.isFinite(m.value)
    ? { name: m.name, value: m.value, unit: measurements[i]!.unit }
    : { name: m.name, diagnostic: { code: 'MEASUREMENT_FAILED', message: m.error ?? 'Measurement failed' } });
}
