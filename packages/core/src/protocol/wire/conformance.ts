import { compareUnicodeCodePoints } from './canonical-json.js';

export type ConformanceTargetV1 = 'json-value' | 'spice-ts-document' | 'simulation-result' | 'simulation-events';
export interface ConformanceDiagnosticV1 { code: string; path: string; message: string }

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const pointer = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');

function numericDiagnostics(value: unknown, path = ''): ConformanceDiagnosticV1[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return [{ code: 'NON_FINITE_NUMBER', path: path || '/', message: 'JSON numbers must be finite' }];
    if (Object.is(value, -0)) return [{ code: 'NON_CANONICAL_NUMBER', path: path || '/', message: 'Negative zero must be normalized to 0' }];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => numericDiagnostics(entry, `${path}/${index}`));
  if (isRecord(value)) return Object.entries(value).flatMap(([key, entry]) => numericDiagnostics(entry, `${path}/${pointer(key)}`));
  return [];
}

function duplicateDiagnostics(items: unknown, kind: string, path: string): ConformanceDiagnosticV1[] {
  if (!Array.isArray(items)) return [];
  const seen = new Map<string, number>();
  const diagnostics: ConformanceDiagnosticV1[] = [];
  items.forEach((item, index) => {
    if (!isRecord(item) || typeof item.name !== 'string' && typeof item.id !== 'string') return;
    const field = kind === 'Component' ? 'id' : 'name';
    const value = item[field];
    if (typeof value !== 'string') return;
    const normalized = value.toUpperCase();
    const previous = seen.get(normalized);
    if (previous !== undefined) diagnostics.push({
      code: 'DUPLICATE_CASE_INSENSITIVE_ID', path: `${path}/${index}/${field}`,
      message: `${kind} ${field} duplicates ${path}/${previous}/${field} under SPICE case-insensitive comparison`,
    });
    else seen.set(normalized, index);
  });
  return diagnostics;
}

function sortedRecordDiagnostics(record: unknown, path: string): ConformanceDiagnosticV1[] {
  if (!isRecord(record)) return [];
  const actual = Object.keys(record);
  // ECMAScript reorders integer-index keys independently of JSON source order,
  // so their original wire order cannot be diagnosed after parsing.
  if (actual.some((key) => /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4_294_967_295)) return [];
  const sorted = [...actual].sort(compareUnicodeCodePoints);
  const index = actual.findIndex((key, position) => key !== sorted[position]);
  return index < 0 ? [] : [{
    code: 'UNSORTED_RECORD_KEYS', path,
    message: `Record keys must be Unicode code-point sorted; expected ${JSON.stringify(sorted)}, received ${JSON.stringify(actual)}`,
  }];
}

interface AnalysisOrderingState {
  activeIndex: number;
  activeType?: string;
  stepped: boolean;
  stepParameter?: string;
  nextStepIndex: number;
}

function orderingDiagnostics(
  analysis: RecordValue,
  path: string,
  state: AnalysisOrderingState,
): ConformanceDiagnosticV1[] {
  if (typeof analysis.analysisIndex !== 'number') return [];
  const diagnostics: ConformanceDiagnosticV1[] = [];
  const analysisIndex = analysis.analysisIndex;
  const step = isRecord(analysis.step) ? analysis.step : undefined;

  if (analysisIndex === state.activeIndex) {
    if (!state.stepped || step === undefined) {
      diagnostics.push({
        code: 'ILLEGAL_ANALYSIS_INDEX_REUSE', path: `${path}/analysisIndex`,
        message: `analysisIndex ${analysisIndex} may repeat only for stepped results`,
      });
      return diagnostics;
    }
    if (typeof analysis.type === 'string' && analysis.type !== state.activeType) diagnostics.push({
      code: 'ANALYSIS_TYPE_MISMATCH', path: `${path}/type`,
      message: `Repeated analysisIndex ${analysisIndex} must keep analysis type ${String(state.activeType)}`,
    });
    if (typeof step.parameter === 'string' && step.parameter !== state.stepParameter) diagnostics.push({
      code: 'STEP_PARAMETER_MISMATCH', path: `${path}/step/parameter`,
      message: `Repeated analysisIndex ${analysisIndex} must keep step parameter ${String(state.stepParameter)}`,
    });
    if (typeof step.index === 'number' && step.index !== state.nextStepIndex) diagnostics.push({
      code: 'NONCONTIGUOUS_STEP_INDEX', path: `${path}/step/index`,
      message: `Expected step.index ${state.nextStepIndex}, received ${step.index}`,
    });
    if (typeof step.index === 'number') state.nextStepIndex = step.index + 1;
    return diagnostics;
  }

  const expectedAnalysisIndex = state.activeIndex + 1;
  if (analysisIndex !== expectedAnalysisIndex) diagnostics.push({
    code: 'NONCONTIGUOUS_ANALYSIS_INDEX', path: `${path}/analysisIndex`,
    message: `Expected analysisIndex ${expectedAnalysisIndex}, received ${analysisIndex}`,
  });
  state.activeIndex = analysisIndex;
  state.activeType = typeof analysis.type === 'string' ? analysis.type : undefined;
  state.stepped = step !== undefined;
  state.stepParameter = typeof step?.parameter === 'string' ? step.parameter : undefined;
  state.nextStepIndex = 0;
  if (step !== undefined && typeof step.index === 'number') {
    if (step.index !== 0) diagnostics.push({
      code: 'NONCONTIGUOUS_STEP_INDEX', path: `${path}/step/index`,
      message: `Expected step.index 0, received ${step.index}`,
    });
    state.nextStepIndex = step.index + 1;
  }
  return diagnostics;
}

function resultDiagnostics(value: unknown): ConformanceDiagnosticV1[] {
  if (!isRecord(value) || !Array.isArray(value.analyses)) return [];
  const diagnostics: ConformanceDiagnosticV1[] = [];
  const ordering: AnalysisOrderingState = { activeIndex: -1, stepped: false, nextStepIndex: 0 };
  value.analyses.forEach((analysis, index) => {
    if (!isRecord(analysis)) return;
    const base = `/analyses/${index}`;
    diagnostics.push(...orderingDiagnostics(analysis, base, ordering));
    const scalarRecords = analysis.type === 'op' ? ['voltagesV', 'currentsA'] : [];
    const seriesRecords = analysis.type === 'dc' || analysis.type === 'tran' ? ['voltagesV', 'currentsA'] : [];
    const phasorRecords = analysis.type === 'ac' ? ['voltagePhasors', 'currentPhasors'] : [];
    for (const field of [...scalarRecords, ...seriesRecords, ...phasorRecords]) diagnostics.push(...sortedRecordDiagnostics(analysis[field], `${base}/${field}`));
    const axis = analysis.type === 'dc' && isRecord(analysis.axis) ? analysis.axis.values
      : analysis.type === 'tran' ? analysis.timeS : analysis.type === 'ac' ? analysis.frequencyHz : undefined;
    if (!Array.isArray(axis)) return;
    for (const field of [...seriesRecords, ...phasorRecords]) {
      const record = analysis[field];
      if (!isRecord(record)) continue;
      for (const [key, series] of Object.entries(record)) {
        if (Array.isArray(series) && series.length !== axis.length) diagnostics.push({
          code: 'SERIES_LENGTH_MISMATCH', path: `${base}/${field}/${pointer(key)}`,
          message: `Series length ${series.length} does not match axis length ${axis.length}`,
        });
      }
    }
  });
  return diagnostics;
}

function eventDiagnostics(value: unknown): ConformanceDiagnosticV1[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: ConformanceDiagnosticV1[] = [];
  const analyses = new Map<string, string>();
  const nextIndexes = new Map<string, number>();
  const ordering: AnalysisOrderingState = { activeIndex: -1, stepped: false, nextStepIndex: 0 };
  value.forEach((event, index) => {
    if (!isRecord(event)) return;
    const step = isRecord(event.step) ? event.step.index : '';
    const key = `${String(event.analysisIndex)}:${String(step)}`;
    if (event.type === 'analysis-start' && typeof event.analysis === 'string') {
      diagnostics.push(...orderingDiagnostics({ ...event, type: event.analysis }, `/${index}`, ordering));
      analyses.set(key, event.analysis);
      nextIndexes.set(key, 0);
    } else if (event.type === 'point') {
      const expected = nextIndexes.get(key) ?? 0;
      if (event.pointIndex !== expected) diagnostics.push({
        code: 'NONCONTIGUOUS_POINT_INDEX', path: `/${index}/pointIndex`,
        message: `Expected pointIndex ${expected}, received ${String(event.pointIndex)}`,
      });
      if (typeof event.pointIndex === 'number') nextIndexes.set(key, event.pointIndex + 1);
      const pointType = isRecord(event.point) ? event.point.type : undefined;
      const analysis = analyses.get(key);
      if (analysis !== undefined && pointType !== analysis) diagnostics.push({
        code: 'POINT_ANALYSIS_MISMATCH', path: `/${index}/point/type`,
        message: `Point type ${String(pointType)} does not match enclosing analysis ${analysis}`,
      });
    } else if (event.type === 'analysis-end') {
      const emitted = nextIndexes.get(key) ?? 0;
      if (event.pointCount !== emitted) diagnostics.push({
        code: 'POINT_COUNT_MISMATCH', path: `/${index}/pointCount`,
        message: `pointCount ${String(event.pointCount)} does not match ${emitted} emitted points`,
      });
    }
  });
  return diagnostics;
}

export function checkConformanceV1(target: ConformanceTargetV1, value: unknown): ConformanceDiagnosticV1[] {
  const numbers = numericDiagnostics(value);
  if (target === 'json-value') return numbers;
  if (target === 'simulation-result') return [...numbers, ...resultDiagnostics(value)];
  if (target === 'simulation-events') return [...numbers, ...eventDiagnostics(value)];
  if (!isRecord(value)) return [];
  const circuit = isRecord(value.circuit) ? value.circuit : {};
  const nested = Array.isArray(value.subcircuits) ? value.subcircuits.flatMap((subcircuit, index) => {
    if (!isRecord(subcircuit)) return [];
    return [
      ...duplicateDiagnostics(subcircuit.components, 'Component', `/subcircuits/${index}/components`),
      ...duplicateDiagnostics(subcircuit.models, 'Model', `/subcircuits/${index}/models`),
    ];
  }) : [];
  return [
    ...numbers,
    ...duplicateDiagnostics(circuit.components, 'Component', '/circuit/components'),
    ...duplicateDiagnostics(value.models, 'Model', '/models'),
    ...duplicateDiagnostics(value.subcircuits, 'Subcircuit', '/subcircuits'),
    ...nested,
  ];
}
