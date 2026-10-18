import type { SimulationResultV1 } from '@spice-ts/core/protocol';

const metricNames = ['dcGainDb', 'f3dbHz', 'unityGainHz', 'phaseMarginDeg', 'gainMarginDb'] as const;
type Metric = typeof metricNames[number];
export interface AcMetricsArgs { output: string; input?: string; analysis?: number }
export const acMetricsProperties = {
  output: { type: 'string', minLength: 1, maxLength: 256 },
  input: { type: 'string', minLength: 1, maxLength: 256 },
  analysis: { type: 'integer', minimum: 0 },
};
export const acMetricsOutputSchema = {
  type: 'object', additionalProperties: false,
  required: [...metricNames, 'referenceFrequencyHz', 'reasons'],
  properties: {
    ...Object.fromEntries(metricNames.map(key => [key, { type: ['number', 'null'] }])),
    referenceFrequencyHz: { type: 'number', exclusiveMinimum: 0 },
    reasons: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(metricNames.map(key => [key, { type: 'string', minLength: 1 }])),
    },
  },
};

function invalid(message: string, details: Record<string, string> = {}): never {
  throw { code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details };
}

export function acMetricsArgs(raw: unknown): AcMetricsArgs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected AC metric selectors');
  const a = raw as Record<string, unknown>;
  if (Object.keys(a).some(key => !['request', 'output', 'input', 'analysis'].includes(key))
    || typeof a.output !== 'string' || !a.output.length || a.output.length > 256
    || (a.input !== undefined && (typeof a.input !== 'string' || !a.input.length || a.input.length > 256))
    || (a.analysis !== undefined && (!Number.isInteger(a.analysis) || (a.analysis as number) < 0))) {
    invalid('Expected output node, optional input node and nonnegative analysis index');
  }
  return a as unknown as AcMetricsArgs;
}

/** Reduce a single AC sweep; never extrapolate a crossing outside sampled frequencies. */
export function acMetrics(result: SimulationResultV1, args: AcMetricsArgs) {
  const selected = result.analyses.filter(a => args.analysis === undefined ? a.type === 'ac' : a.analysisIndex === args.analysis);
  if (selected.length !== 1 || selected[0].type !== 'ac') invalid('Select exactly one AC analysis; stepped analyses must be run separately');
  const a = selected[0];
  const node = (name: string) => {
    const key = Object.keys(a.voltagePhasors).find(key => key.toLowerCase() === name.toLowerCase());
    if (key === undefined) invalid('Unknown voltage node', { reason: 'UNKNOWN_NODE', node: name });
    return a.voltagePhasors[key];
  };
  const out = node(args.output);
  const input = args.input === undefined ? undefined : node(args.input);
  const f = a.frequencyHz;
  if (!f.length || out.length !== f.length || (input && input.length !== f.length)
    || f.some((v, i) => !Number.isFinite(v) || v <= 0 || (i > 0 && v <= f[i - 1]))) invalid('AC frequencies must be finite, positive and increasing');
  const db: number[] = []; const phase: number[] = [];
  for (let i = 0; i < f.length; i++) {
    const p = out[i]; const q = input?.[i];
    if (!Number.isFinite(p.magnitude) || p.magnitude < 0 || !Number.isFinite(p.phaseDegrees)
      || (q && (!Number.isFinite(q.magnitude) || q.magnitude <= 0 || !Number.isFinite(q.phaseDegrees)))) {
      invalid('Transfer function contains invalid phasors or a zero input', { reason: 'UNDEFINED_TRANSFER' });
    }
    db.push(20 * Math.log10(p.magnitude / (q?.magnitude ?? 1)));
    let angle = p.phaseDegrees - (q?.phaseDegrees ?? 0);
    // Choose the principal initial phase, then unwrap relative to the preceding sample.
    angle = ((angle + 180) % 360 + 360) % 360 - 180;
    if (i > 0) {
      while (angle - phase[i - 1] > 180) angle -= 360;
      while (angle - phase[i - 1] < -180) angle += 360;
    }
    phase.push(angle);
  }
  type Crossing = { hz: number; index: number; fraction: number };
  const crossing = (values: number[], target: number): Crossing | undefined => {
    for (let i = 1; i < f.length; i++) {
      if (!Number.isFinite(values[i - 1]) || !Number.isFinite(values[i])) continue;
      if (values[i - 1] >= target && values[i] <= target && values[i - 1] > values[i]) {
        const fraction = (target - values[i - 1]) / (values[i] - values[i - 1]);
        return { hz: Math.exp(Math.log(f[i - 1]) + fraction * Math.log(f[i] / f[i - 1])), index: i, fraction };
      }
    }
    return undefined;
  };
  const at = (values: number[], c: Crossing) => values[c.index - 1] + c.fraction * (values[c.index] - values[c.index - 1]);
  const reasons: Partial<Record<Metric, string>> = {};
  const finite = (key: Metric, value: number | undefined, reason: string) => {
    if (value !== undefined && Number.isFinite(value)) return value;
    reasons[key] = reason;
    return null;
  };
  const bandwidth = crossing(db, db[0] - 10 * Math.log10(2));
  const unity = crossing(db, 0);
  const phaseCrossing = crossing(phase, -180);
  return {
    dcGainDb: finite('dcGainDb', db[0], 'Gain at the lowest sampled frequency is not finite'),
    f3dbHz: finite('f3dbHz', bandwidth?.hz, 'No descending half-power crossing relative to the first sample in sweep'),
    unityGainHz: finite('unityGainHz', unity?.hz, 'No descending unity-gain crossing in sweep'),
    phaseMarginDeg: finite('phaseMarginDeg', unity ? 180 + at(phase, unity) : undefined, 'No finite phase at a unity-gain crossing in sweep'),
    gainMarginDb: finite('gainMarginDb', phaseCrossing ? -at(db, phaseCrossing) : undefined, 'No finite gain at a descending -180 degree phase crossing in sweep'),
    referenceFrequencyHz: f[0], reasons,
  };
}
