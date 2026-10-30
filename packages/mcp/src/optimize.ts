import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SimulationRequestV1, SimulationResultV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';
import { measureResult, measurementListSchema } from './measure.js';
import { overrideParameters } from './params.js';
import { overrideComponent } from './sweep.js';

export type Evaluation = { params: Record<string, number>; value: number; error: number };
type Parameter = { name: string; min: number; max: number; kind?: 'param' | 'component' };

export const optimizeProperties = {
  parameters: { type: 'array', minItems: 1, maxItems: 3, items: {
    type: 'object', required: ['name', 'min', 'max'], additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['param', 'component'], default: 'param' }, min: { type: 'number' }, max: { type: 'number' } },
  } },
  objective: measurementListSchema.items,
  target: { type: 'number' },
  tolerance: { type: 'number', exclusiveMinimum: 0, description: 'Absolute tolerance; defaults to max(abs(target) * 0.001, 1e-9).' },
  maxEvaluations: { type: 'integer', minimum: 1, maximum: 100, default: 40 },
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} } satisfies SpiceApiErrorV1;
}

/** Deterministic, sequential scalar optimization with one shared simulation budget. */
export async function runOptimize(
  args: unknown,
  request: SimulationRequestV1,
  execute: (request: SimulationRequestV1, measurements: unknown) => Promise<CallToolResult>,
  check: (history: Evaluation[]) => void,
): Promise<object> {
  if (!record(args) || Object.keys(args).some(key => !['request', 'parameters', 'objective', 'target', 'tolerance', 'maxEvaluations'].includes(key))) invalid('Invalid optimize fields');
  if (!Array.isArray(args.parameters) || args.parameters.length < 1 || args.parameters.length > 3) invalid('Expected 1 through 3 parameters');
  for (const p of args.parameters) {
    if (!record(p) || Object.keys(p).some(key => !['name', 'kind', 'min', 'max'].includes(key))
      || typeof p.name !== 'string'
      || !(p.kind === 'component' ? /^[A-Za-z_][\w.:-]*$/ : /^[A-Za-z_]\w*$/).test(p.name)
      || (p.kind !== undefined && p.kind !== 'param' && p.kind !== 'component')
      || !finite(p.min) || !finite(p.max) || p.min >= p.max || !Number.isFinite(p.max - p.min)
      || (p.kind === 'component' && p.min <= 0)) invalid('Invalid optimize parameter');
  }
  const parameters = args.parameters as Parameter[];
  if (new Set(parameters.map(p => p.name.toLowerCase())).size !== parameters.length) invalid('Parameter names must be unique (case-insensitive)');
  if (!finite(args.target)) invalid('target must be finite');
  const target = args.target;
  const tolerance = args.tolerance === undefined ? Math.max(Math.abs(target) * 0.001, 1e-9) : args.tolerance;
  if (!finite(tolerance) || tolerance <= 0) invalid('tolerance must be finite and positive');
  const maxEvaluations = args.maxEvaluations === undefined ? 40 : args.maxEvaluations;
  if (!finite(maxEvaluations) || !Number.isInteger(maxEvaluations) || maxEvaluations < 1) invalid('maxEvaluations must be a positive integer');
  if (maxEvaluations > 100) throw { code: 'RESOURCE_LIMIT', message: 'Optimization evaluation cap exceeded', phase: 'validation', retryable: false,
    details: { limit: 'maxEvaluations', maximum: 100, actual: maxEvaluations } } satisfies SpiceApiErrorV1;

  const midpoint = Object.fromEntries(parameters.map(p => [p.name, p.min + (p.max - p.min) / 2]));
  // Resolve names and input format before any simulation, including tiny budgets.
  const apply = (values: Record<string, number>): SimulationRequestV1 => {
    const paramValues = Object.fromEntries(parameters.filter(p => p.kind !== 'component').map(p => [p.name, values[p.name]]));
    let changed = Object.keys(paramValues).length ? overrideParameters(request, paramValues) : request;
    for (const p of parameters) if (p.kind === 'component') changed = overrideComponent(changed, p.name, values[p.name]);
    return changed;
  };
  apply(midpoint);
  const history: Evaluation[] = [];
  let best: Evaluation | undefined;
  let evaluations = 0;
  let failure: unknown;
  const cache = new Map<string, Evaluation>();
  const converged = (): boolean => best !== undefined && best.error <= tolerance;
  const stopped = (): boolean => failure !== undefined || converged() || evaluations >= maxEvaluations;
  const objectiveError = (message: string, details?: unknown): void => {
    failure = { code: 'OBJECTIVE_ERROR', message, ...(details === undefined ? {} : { details }) };
  };

  // Use the same selector validator as spice_measure without launching a worker.
  const probe = measureResult({ analyses: [] } as unknown as SimulationResultV1, [args.objective]).measurements[0];
  if ('error' in probe && probe.error.code === 'INVALID_MEASUREMENT') objectiveError(probe.error.message, probe.error);

  const evaluate = async (params: Record<string, number>): Promise<Evaluation | undefined> => {
    const key = JSON.stringify(parameters.map(p => params[p.name]));
    const cached = cache.get(key);
    if (cached) return cached;
    if (stopped()) return undefined;
    check(history);
    const changed = apply(params);
    evaluations++;
    const response = await execute(changed, [args.objective]);
    const content = response.structuredContent;
    if (response.isError) {
      failure = content?.error ?? { code: 'OBJECTIVE_ERROR', message: 'Objective simulation failed without a structured error' };
      check(history);
      return undefined;
    }
    const measurements = content?.measurements;
    const measurement: unknown = Array.isArray(measurements) ? measurements[0] : undefined;
    if (!record(measurement) || measurement.error !== undefined || !finite(measurement.value)) {
      objectiveError('Objective measurement did not return a finite value', record(measurement) ? measurement.error : undefined);
      check(history);
      return undefined;
    }
    const entry: Evaluation = { params: { ...params }, value: measurement.value, error: Math.abs(measurement.value - target) };
    history.push(entry);
    cache.set(key, entry);
    // Strict comparison preserves the earliest evaluation on ties.
    if (!best || entry.error < best.error) best = entry;
    check(history);
    return entry;
  };

  // Endpoints matter for unreachable targets and boundary optima. Golden-section
  // reduction reuses one interior point per iteration and caches repeated tuples.
  const searchAxis = async (base: Record<string, number>, p: Parameter, allowance: number): Promise<void> => {
    const end = Math.min(maxEvaluations, evaluations + allowance);
    const sample = async (x: number): Promise<Evaluation | undefined> => {
      if (evaluations >= end || stopped()) return undefined;
      return evaluate({ ...base, [p.name]: x });
    };
    let lo = p.min; let hi = p.max;
    await sample(lo);
    await sample(hi);
    const ratio = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - ratio * (hi - lo);
    let x2 = lo + ratio * (hi - lo);
    let f1 = await sample(x1);
    let f2 = await sample(x2);
    // A bounded iteration count also protects against floating-point stagnation
    // when all prospective points are already in the tuple cache.
    for (let iteration = 0; iteration < 256 && f1 && f2 && evaluations < end && !stopped(); iteration++) {
      if (f1.error <= f2.error) {
        hi = x2; x2 = x1; f2 = f1;
        x1 = hi - ratio * (hi - lo);
        if (!(lo < x1 && x1 < x2)) break;
        f1 = await sample(x1);
      } else {
        lo = x1; x1 = x2; f1 = f2;
        x2 = lo + ratio * (hi - lo);
        if (!(x1 < x2 && x2 < hi)) break;
        f2 = await sample(x2);
      }
    }
  };

  if (!failure) {
    if (parameters.length === 1) {
      await searchAxis(midpoint, parameters[0], maxEvaluations);
    } else {
      await evaluate(midpoint);
      // Reserve a fair share for every coordinate in each of two passes rather
      // than exhausting the entire budget on the first coordinate.
      const axes = parameters.length * 2;
      for (let axis = 0; axis < axes && !stopped(); axis++) {
        const allowance = Math.ceil((maxEvaluations - evaluations) / (axes - axis));
        await searchAxis(best?.params ?? midpoint, parameters[axis % parameters.length], allowance);
      }
    }
  }
  check(history);
  const reached = converged() && failure === undefined;
  return {
    bestParams: best?.params ?? null,
    achievedValue: best?.value ?? null,
    target, tolerance, converged: reached, evaluations, history,
    ...(failure !== undefined ? { error: failure } : reached ? {} : {
      error: { code: 'TARGET_NOT_REACHED', message: 'Target was not reached within the evaluation budget' },
    }),
  };
}
