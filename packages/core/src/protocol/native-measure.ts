import { evaluateMeasureCards, measureCard, measurePlot } from '../measure/dot-measure.js';
import type { ACResult, DCSweepResult, TransientResult } from '../results.js';
import type { AnalysisDirective } from '../types.js';
import type { SimulationRequestV1, AcMeasurementV1, TransientMeasurementV1, TransientMeasurementResultV1 } from './types.js';
import { ProtocolExecutionError, type ProtocolExecutionGuard } from './execution-guard.js';
import { measureCards } from '../measure/registry.js';
import type { Circuit } from '../circuit.js';
import type { SimulationResult } from '../results.js';

function invalid(path: string): never {
  throw new ProtocolExecutionError({ code: 'INVALID_REQUEST', phase: 'validation', retryable: false, message: `Invalid native measurement at ${path}`, details: { path } });
}

const vector = /^(?:v\([^\s(),]+(?:,[^\s(),]+)?\)|i\([^\s(),]+\))$/i;
const acVector = /^v(?:m|db|p)\([^\s(),]+\)$/i;
const name = /^[a-z][a-z0-9_]*$/i;
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function validateNativeMeasurements(request: SimulationRequestV1): void {
  if (request.input.format === 'circuit-json') {
    for (const [i, analysis] of request.input.analyses.entries()) {
      if ((analysis as { measurements?: unknown }).measurements !== undefined) invalid(`/input/analyses/${i}/measurements`);
    }
    return;
  }
  if (request.input.format !== 'spice-ts') return;
  for (const [i, analysis] of request.input.document.analyses.entries()) {
    const entries = (analysis as { measurements?: unknown }).measurements;
    if (entries === undefined) continue;
    const path = `/input/document/analyses/${i}/measurements`;
    if ((analysis.type !== 'tran' && analysis.type !== 'dc' && analysis.type !== 'ac') || !Array.isArray(entries) || entries.length > 100 || (analysis.type === 'dc' && analysis.secondary !== undefined)) invalid(path);
    const names = new Set<string>();
    const object = (x: unknown, at: string): Record<string, unknown> => {
      if (!x || typeof x !== 'object' || Array.isArray(x)) invalid(at);
      return x as Record<string, unknown>;
    };
    const fields = (o: Record<string, unknown>, keys: string[], at: string) => {
      for (const key of Object.keys(o)) if (!keys.includes(key)) invalid(`${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    };
    const crossing = (x: unknown, at: string) => {
      const o = object(x, at); fields(o, ['vector', 'value', 'rise', 'fall', 'cross', 'td'], at);
      if (typeof o.vector !== 'string' || !(analysis.type === 'ac' ? acVector : vector).test(o.vector)) invalid(`${at}/vector`);
      if (!finite(o.value)) invalid(`${at}/value`);
      if (['rise', 'fall', 'cross'].filter(k => o[k] !== undefined).length > 1) invalid(at);
      for (const key of ['rise', 'fall', 'cross']) if (o[key] !== undefined && !(Number.isInteger(o[key]) && (o[key] as number) > 0) && o[key] !== 'last') invalid(`${at}/${key}`);
      if (o.td !== undefined && !finite(o.td)) invalid(`${at}/td`);
    };
    for (const [j, entry] of entries.entries()) {
      const at = `${path}/${j}`; const o = object(entry, at);
      if (typeof o.name !== 'string' || !name.test(o.name) || names.has(o.name.toLowerCase())) invalid(`${at}/name`);
      names.add(o.name.toLowerCase());
      if (o.kind === 'trig') {
        if (analysis.type !== 'tran') invalid(`${at}/kind`);
        fields(o, ['name', 'kind', 'trig', 'targ'], at); crossing(o.trig, `${at}/trig`); crossing(o.targ, `${at}/targ`);
      } else if (o.kind === 'find') {
        fields(o, ['name', 'kind', 'vector', 'at', 'when'], at);
        if (typeof o.vector !== 'string' || !(analysis.type === 'ac' ? acVector : vector).test(o.vector)) invalid(`${at}/vector`);
        if ((o.at === undefined) === (o.when === undefined)) invalid(at);
        if (o.at !== undefined && (!finite(o.at) || (analysis.type === 'ac' && o.at < 0))) invalid(`${at}/at`);
        if (o.when !== undefined) crossing(o.when, `${at}/when`);
      } else if (['avg', 'min', 'max', 'pp', 'rms', 'integ'].includes(o.kind as string)) {
        fields(o, ['name', 'kind', 'vector', 'from', 'to'], at);
        if (typeof o.vector !== 'string' || !(analysis.type === 'ac' ? acVector : vector).test(o.vector)) invalid(`${at}/vector`);
        for (const key of ['from', 'to']) if (o[key] !== undefined && (!finite(o[key]) || (analysis.type === 'ac' && (o[key] as number) < 0))) invalid(`${at}/${key}`);
        if (finite(o.from) && finite(o.to) && o.from > o.to) invalid(`${at}/to`);
      } else invalid(`${at}/kind`);
    }
  }
}

function clause(c: import('./types.js').MeasurementCrossingV1, when = false): string {
  return `${c.vector}${when ? '=' : ' val='}${c.value}${c.rise !== undefined ? ` rise=${c.rise}` : ''}${c.fall !== undefined ? ` fall=${c.fall}` : ''}${c.cross !== undefined ? ` cross=${c.cross}` : ''}${c.td !== undefined ? ` td=${c.td}` : ''}`;
}
function card(m: TransientMeasurementV1 | AcMeasurementV1, analysis: 'tran' | 'dc' | 'ac'): string {
  const prefix = `.meas ${analysis} ${m.name} `;
  if (m.kind === 'trig') return `${prefix}trig ${clause(m.trig)} targ ${clause(m.targ)}`;
  if (m.kind === 'find') return `${prefix}find ${m.vector} ${'at' in m && m.at !== undefined ? `at=${m.at}` : `when ${clause(m.when!, true)}`}`;
  return `${prefix}${m.kind} ${m.vector}${m.from === undefined ? '' : ` from=${m.from}`}${m.to === undefined ? '' : ` to=${m.to}`}`;
}

/** Reuse the measurements already evaluated for this particular text analysis. */
export function textMeasurements(circuit: Circuit, directive: AnalysisDirective, result: SimulationResult, guard: ProtocolExecutionGuard): TransientMeasurementResultV1[] | undefined {
  if (directive.type !== 'tran' && (directive.type !== 'dc' || directive.secondary)) return undefined;
  const lines = new Set(measureCards(circuit).filter(card => /^\.meas(?:ure)?\s+\S+\s+\S+\s+find\s+\S+\s+at\s*=/i.test(card.text)).map(card => card.line));
  const measurements = result.measurements?.filter(m => m.analysis === directive.type && lines.has(m.line));
  if (!measurements?.length) return undefined;
  return measurements.map(m => {
    guard.checkpoint('solve:measurement');
    return m.status === 'ok' && m.value !== undefined && Number.isFinite(m.value)
      ? { name: m.name, value: m.value }
      : { name: m.name, diagnostic: { code: 'MEASUREMENT_FAILED', message: m.error ?? 'Measurement failed' } };
  });
}

export function nativeMeasurements(request: SimulationRequestV1, index: number, directive: AnalysisDirective, result: TransientResult | DCSweepResult | ACResult, guard: ProtocolExecutionGuard): TransientMeasurementResultV1[] | undefined {
  if (request.input.format !== 'spice-ts') return undefined;
  const analysis = request.input.document.analyses[index];
  if ((analysis.type !== 'tran' && analysis.type !== 'dc' && analysis.type !== 'ac') || !analysis.measurements) return undefined;
  const plot = measurePlot(directive, analysis.type === 'tran' ? { transient: result as TransientResult, warnings: [] } : analysis.type === 'dc' ? { dcSweep: result as DCSweepResult, warnings: [] } : { ac: result as ACResult, warnings: [] });
  if (!plot) return undefined;
  const values = new Map<string, number>();
  return analysis.measurements.map((measurement, i) => {
    guard.checkpoint('solve:measurement');
    const m = evaluateMeasureCards([measureCard(card(measurement, analysis.type), i + 1, 0)], analysis.type, plot, values)[0]!;
    return m.status === 'ok' && m.value !== undefined && Number.isFinite(m.value)
    ? { name: m.name, value: m.value }
    : { name: m.name, diagnostic: { code: 'MEASUREMENT_FAILED', message: m.error ?? 'Measurement failed' } };
  });
}
