import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SimulationRequestV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';
import { measurementListSchema } from './measure.js';
import { overrideComponent } from './sweep.js';

export const MAX_MONTE_CARLO_RUNS = 1000;
type Tolerance = { element: string; sigma: number; distribution: 'gaussian' | 'uniform' };
type Scalar = { value: number; unit: string };
type Statistics = { count: number; unit: string; mean: number; std: number; min: number; max: number; p5: number; p95: number };

export const monteCarloProperties = {
  runs: { type: 'integer', minimum: 1, maximum: MAX_MONTE_CARLO_RUNS },
  seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
  tolerances: { type: 'array', minItems: 1, maxItems: 128, items: {
    type: 'object', additionalProperties: false, required: ['element', 'sigma', 'distribution'], properties: {
      element: { type: 'string', minLength: 1 }, sigma: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
      distribution: { enum: ['gaussian', 'uniform'] },
    },
  } },
  measurements: measurementListSchema,
};

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} } satisfies SpiceApiErrorV1;
}

/** Deliberately accepts literal top-level R/C/L values only, not expressions or model cards. */
function nominal(request: SimulationRequestV1, element: string): number {
  if (request.input.format === 'spice-ts') {
    const components = request.input.document?.circuit?.components;
    if (!Array.isArray(components)) invalid('Expected native circuit components');
    const matches = components.filter(c => typeof c?.name === 'string' && c.name.toLowerCase() === element.toLowerCase());
    if (matches.length !== 1) invalid(`Unknown or ambiguous top-level element: ${element}`);
    const component = matches[0];
    const type = element[0].toLowerCase();
    if (typeof component.type !== 'string' || component.type.toLowerCase() !== type) invalid(`Tolerance target ${element} must have matching R/C/L component type`);
    const field = ({ r: 'resistance', c: 'capacitance', l: 'inductance' } as Record<string, string>)[type];
    const value = component.params?.[field];
    if (typeof value !== 'number') invalid(`Tolerance target ${element} requires a literal numeric ${field}`);
    if (!Number.isFinite(value) || value <= 0) invalid(`Nominal component value for ${element} must be finite and positive`);
    return value;
  }
  if (request.input.format !== 'spice' || typeof request.input.source !== 'string') invalid('Monte Carlo requires SPICE text or native spice-ts JSON IR');
  let depth = 0; let control = false;
  const values: string[] = [];
  const lines = request.input.source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\.control\b/i.test(line)) control = true;
    if (/^\s*\.endc\b/i.test(line)) { control = false; continue; }
    if (control) continue;
    if (/^\s*\.subckt\b/i.test(line)) depth++;
    if (/^\s*\.ends\b/i.test(line)) { depth--; continue; }
    const tokens = line.trim().split(/\s+/);
    if (depth !== 0 || tokens[0].toLowerCase() !== element.toLowerCase()) continue;
    if (/^\s*\+/.test(lines[i + 1] ?? '') || tokens.length !== 4) invalid('Tolerance targets require a plain R/C/L scalar card without parameters or continuations');
    values.push(tokens[3]);
  }
  if (values.length !== 1) invalid(`Unknown or ambiguous top-level element: ${element}`);
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?$/i.exec(values[0]);
  if (!match) invalid('Tolerance targets require literal numeric values');
  const scales: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  const value = Number(match[1]) * (scales[(match[2] ?? '').toLowerCase()] ?? 1);
  if (!Number.isFinite(value) || value <= 0) invalid('Nominal component values must be finite and positive');
  return value;
}

function statistics(samples: Scalar[]): Statistics {
  const values = samples.map(s => s.value).sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v / values.length, 0);
  const std = values.length === 1 ? 0 : Math.sqrt(values.reduce((sum, v) => sum + ((v - mean) / Math.sqrt(values.length - 1)) ** 2, 0));
  const percentile = (p: number): number => {
    const index = (values.length - 1) * p; const lo = Math.floor(index); const fraction = index - lo;
    return values[lo] * (1 - fraction) + values[Math.ceil(index)] * fraction;
  };
  const result = { count: values.length, unit: samples[0].unit, mean, std, min: values[0], max: values[values.length - 1], p5: percentile(0.05), p95: percentile(0.95) };
  if (!Object.values(result).every(v => typeof v !== 'number' || Number.isFinite(v))) invalid('Non-finite aggregate statistics');
  return result;
}

/** Every draw uses the original nominal; sequential requests retain the worker safety boundary. */
export async function runMonteCarlo(
  args: unknown, request: SimulationRequestV1,
  execute: (request: SimulationRequestV1, measurements: unknown[]) => Promise<CallToolResult>,
  check: () => void,
): Promise<{ runs: number; seed: number; statistics: Statistics[] }> {
  if (!record(args) || Object.keys(args).some(k => !['request', 'runs', 'seed', 'tolerances', 'measurements'].includes(k))) invalid('Invalid Monte Carlo fields');
  const { runs, seed, tolerances, measurements } = args;
  if (typeof runs !== 'number' || !Number.isSafeInteger(runs) || runs <= 0) invalid('runs must be a positive integer');
  if (runs > MAX_MONTE_CARLO_RUNS) throw { code: 'RESOURCE_LIMIT', message: 'Monte Carlo run cap exceeded', phase: 'validation', retryable: false,
    details: { limit: 'maxMonteCarloRuns', maximum: MAX_MONTE_CARLO_RUNS, actual: runs } } satisfies SpiceApiErrorV1;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) invalid('seed must be an unsigned 32-bit integer');
  if (!Array.isArray(tolerances) || !tolerances.length || tolerances.length > 128) invalid('Expected 1 through 128 tolerances');
  if (!Array.isArray(measurements) || !measurements.length || measurements.length > 128) invalid('Expected 1 through 128 measurements');
  const seen = new Set<string>();
  const targets = tolerances.map(raw => {
    if (!record(raw) || Object.keys(raw).some(k => !['element', 'sigma', 'distribution'].includes(k))
      || typeof raw.element !== 'string' || !/^[RCL][\w.:-]*$/i.test(raw.element)
      || typeof raw.sigma !== 'number' || !Number.isFinite(raw.sigma) || raw.sigma < 0 || raw.sigma >= 0.5
      || !['gaussian', 'uniform'].includes(raw.distribution as string)) invalid('Invalid tolerance fields');
    const tolerance = raw as Tolerance;
    const key = tolerance.element.toLowerCase();
    if (seen.has(key)) invalid('Duplicate tolerance target');
    seen.add(key);
    return { ...tolerance, nominal: nominal(request, tolerance.element) };
  });
  // Mulberry32; open interval prevents log(0) in the Box-Muller normal draw.
  let state = seed;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  const samples: Scalar[][] = measurements.map(() => []);
  for (let i = 0; i < runs; i++) {
    check();
    let changed = request;
    for (const target of targets) {
      const draw = target.distribution === 'uniform' ? Math.sqrt(3) * (2 * random() - 1)
        : Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
      const value = target.nominal * (1 + target.sigma * draw);
      if (!Number.isFinite(value) || value <= 0) invalid('Perturbed component value is nonpositive or non-finite; reduce sigma');
      changed = overrideComponent(changed, target.element, value);
    }
    const response = await execute(changed, measurements);
    if (response.isError) throw response.structuredContent!.error;
    const reduced = response.structuredContent?.measurements;
    if (!Array.isArray(reduced) || reduced.length !== samples.length) invalid('Missing measurements');
    reduced.forEach((m, index) => {
      if (!record(m) || typeof m.value !== 'number' || !Number.isFinite(m.value) || typeof m.unit !== 'string') invalid(`Measurement ${index} failed: ${JSON.stringify(m)}`);
      if (samples[index].length && samples[index][0].unit !== m.unit) invalid('Measurement units changed between runs');
      samples[index].push({ value: m.value, unit: m.unit });
    });
    check();
  }
  return { runs, seed, statistics: samples.map(statistics) };
}
