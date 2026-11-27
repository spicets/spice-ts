import type { AnalysisResultV1, SimulationResultV1 } from '@spice-ts/core/protocol';

const kinds = ['min', 'max', 'avg', 'rms', 'rmsError', 'meanAbsoluteError', 'relativeRmsError', 'maxAbsoluteError', 'totalVariation', 'pp', 'at', 'slope', 'cross', 'when', 'crossingCount', 'integ', 'absInteg', 'timeCentroid', 'delay', 'duty', 'timeInBand', 'longestTimeInBand', 'pulseWidth', 'period', 'frequency'] as const;
type Crossing = { signal: string; threshold: number; edge?: 'rising' | 'falling' | 'either'; occurrence?: number };
type Measurement = {
  kind: typeof kinds[number]; signal: string; analysis: number; step?: number;
  from?: number; to?: number; at?: number; value?: number; lower?: number; upper?: number;
  edge?: 'rising' | 'falling' | 'either'; occurrence?: number;
  trigger?: Crossing; target?: Crossing; referenceSignal?: string;
};
type MeasurementErrorCode = 'INVALID_MEASUREMENT' | 'UNKNOWN_SIGNAL' | 'UNKNOWN_ANALYSIS' | 'AMBIGUOUS_ANALYSIS' | 'UNKNOWN_STEP' | 'OUT_OF_RANGE' | 'NO_CROSSING' | 'NON_FINITE_RESULT';
type MeasurementResult = { value: number; unit: string } | { error: { code: MeasurementErrorCode; message: string } };

const signalDescription = 'Case-insensitive v(node), v(positive,negative), or i(branch); AC also accepts mag(...), db(...), and phase(...) around one such selector. An exact literal voltage name takes precedence over differential parsing. Node 0 is ground. No arbitrary expressions.';

export const measurementListSchema = {
  type: 'array', minItems: 1, maxItems: 128,
  items: {
    type: 'object', required: ['kind', 'analysis'], additionalProperties: false,
    allOf: [{
      if: { properties: { kind: { const: 'delay' } } },
      then: { required: ['trigger', 'target'], not: { anyOf: ['signal', 'at', 'value', 'edge'].map(key => ({ required: [key] })) } },
      else: { required: ['signal'], not: { anyOf: ['trigger', 'target'].map(key => ({ required: [key] })) } },
    }, {
      if: { properties: { kind: { enum: ['cross', 'when', 'pulseWidth', 'period', 'frequency'] } } },
      else: { not: { required: ['occurrence'] } },
    }, {
      if: { properties: { kind: { const: 'crossingCount' } } },
      then: { required: ['value'], not: { required: ['at'] } },
    }, {
      if: { properties: { kind: { const: 'duty' } } },
      then: { required: ['value'], not: { anyOf: ['at', 'edge', 'occurrence', 'trigger', 'target'].map(key => ({ required: [key] })) } },
    }, {
      if: { properties: { kind: { enum: ['timeInBand', 'longestTimeInBand'] } } },
      then: { required: ['lower', 'upper'], not: { anyOf: ['at', 'value', 'edge', 'occurrence', 'trigger', 'target', 'referenceSignal'].map(key => ({ required: [key] })) } },
      else: { not: { anyOf: ['lower', 'upper'].map(key => ({ required: [key] })) } },
    }, {
      if: { properties: { kind: { enum: ['pulseWidth', 'period', 'frequency'] } } },
      then: { required: ['value', 'edge'], properties: { edge: { enum: ['rising', 'falling'] } }, not: { required: ['at'] } },
    }, {
      if: { properties: { kind: { enum: ['rmsError', 'meanAbsoluteError', 'relativeRmsError', 'maxAbsoluteError'] } } },
      then: { required: ['referenceSignal'], not: { anyOf: ['at', 'value', 'edge'].map(key => ({ required: [key] })) } },
      else: { not: { required: ['referenceSignal'] } },
    }, {
      if: { properties: { kind: { const: 'slope' } } },
      then: { required: ['at'], not: { anyOf: ['value', 'edge', 'occurrence', 'trigger', 'target', 'referenceSignal'].map(key => ({ required: [key] })) } },
    }, {
      if: { properties: { kind: { enum: ['totalVariation', 'timeCentroid'] } } },
      then: { not: { anyOf: ['at', 'value', 'edge'].map(key => ({ required: [key] })) } },
    }],
    properties: {
      kind: { enum: kinds, description: 'timeCentroid returns the absolute time in seconds weighted by |signal| over the transient window. slope returns the transient piecewise-linear segment slope at time at, using the right segment at an interior knot and the left segment at the final endpoint. maxAbsoluteError returns the maximum absolute difference from referenceSignal over the nonzero transient window, including interpolated boundaries, in the signal unit. totalVariation sums absolute successive changes of the transient waveform within the window, including interpolated boundaries, in the signal unit.' }, signal: { type: 'string', minLength: 1, maxLength: 256, description: signalDescription },
      referenceSignal: { type: 'string', minLength: 1, maxLength: 256, description: signalDescription },
      analysis: { type: 'integer', minimum: 0 },
      step: { type: 'integer', minimum: 0, description: 'Zero-based step.index from SimulationResultV1; use 0 for an unstepped analysis.' },
      ...Object.fromEntries(['from', 'to', 'at', 'value'].map(key => [key, { type: 'number' }])),
      lower: { type: 'number', description: 'Inclusive lower band limit. timeInBand sums visits; longestTimeInBand returns the longest uninterrupted visit. Both use piecewise-linear transient traces within from/to in seconds, without extrapolation. Equal limits count only flat intervals.' },
      upper: { type: 'number', description: 'Inclusive upper band limit for timeInBand and longestTimeInBand, greater than or equal to lower.' },
      edge: { enum: ['rising', 'falling', 'either'], description: 'For crossingCount, defaults to either and counts threshold contacts in the inclusive window, with unit 1. A plateau counts at first contact; an initial plateau counts a falling departure at its end. Constant threshold has no contacts. For pulseWidth, rising selects high pulses and falling selects low pulses. Period and frequency use consecutive crossings of the selected direction.' },
      occurrence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'One-based crossing, complete pulse, or consecutive-crossing pair within from/to; defaults to 1.' },
      ...Object.fromEntries(['trigger', 'target'].map(key => [key, {
        type: 'object', description: 'Transient crossing; counted independently within from/to. Delay is target time minus trigger time, in seconds.', required: ['signal', 'threshold'], additionalProperties: false,
        properties: { signal: { type: 'string', minLength: 1, maxLength: 256, description: signalDescription }, threshold: { type: 'number' }, edge: { enum: ['rising', 'falling', 'either'], description: 'Defaults to either.' }, occurrence: { type: 'integer', minimum: 1, description: 'One-based crossing number; defaults to 1.' } },
      }])),
    },
  },
};

function error(code: MeasurementErrorCode, message: string): MeasurementResult {
  return { error: { code, message } };
}

function valid(value: unknown): value is Measurement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Measurement;
  const crossingValid = (c: Crossing | undefined): boolean => !!c && typeof c === 'object' && !Array.isArray(c)
    && typeof c.signal === 'string' && c.signal.length > 0 && c.signal.length <= 256
    && typeof c.threshold === 'number' && Number.isFinite(c.threshold)
    && (c.edge === undefined || ['rising', 'falling', 'either'].includes(c.edge))
    && (c.occurrence === undefined || (Number.isSafeInteger(c.occurrence) && c.occurrence > 0))
    && Object.keys(c).every(key => ['signal', 'threshold', 'edge', 'occurrence'].includes(key));
  return kinds.includes(m.kind) && (m.kind === 'delay' ? crossingValid(m.trigger) && crossingValid(m.target) && m.signal === undefined : typeof m.signal === 'string' && m.signal.length > 0 && m.signal.length <= 256 && m.trigger === undefined && m.target === undefined)
    && Number.isInteger(m.analysis) && m.analysis >= 0
    && (m.step === undefined || (Number.isInteger(m.step) && m.step >= 0))
    && ['from', 'to', 'at', 'value', 'lower', 'upper'].every(key => {
      const n = (m as unknown as Record<string, unknown>)[key];
      return n === undefined || (typeof n === 'number' && Number.isFinite(n));
    })
    && Object.keys(m).every(key => ['kind', 'signal', 'analysis', 'step', 'from', 'to', 'at', 'value', 'lower', 'upper', 'edge', 'occurrence', 'trigger', 'target', 'referenceSignal'].includes(key))
    && (['rmsError', 'meanAbsoluteError', 'relativeRmsError', 'maxAbsoluteError'].includes(m.kind) ? typeof m.referenceSignal === 'string' && m.referenceSignal.length > 0 && m.referenceSignal.length <= 256 && m.at === undefined && m.value === undefined && m.edge === undefined : m.referenceSignal === undefined)
    && (m.kind !== 'delay' || (m.at === undefined && m.value === undefined && m.edge === undefined))
    && (m.kind !== 'duty' || (m.value !== undefined && m.at === undefined && m.edge === undefined))
    && (['timeInBand', 'longestTimeInBand'].includes(m.kind) ? m.lower !== undefined && m.upper !== undefined && m.lower <= m.upper && m.at === undefined && m.value === undefined && m.edge === undefined : m.lower === undefined && m.upper === undefined)
    && (!['pulseWidth', 'period', 'frequency'].includes(m.kind) || (m.value !== undefined && m.at === undefined && (m.edge === 'rising' || m.edge === 'falling')))
    && (m.occurrence === undefined || (['cross', 'when', 'pulseWidth', 'period', 'frequency'].includes(m.kind) && Number.isSafeInteger(m.occurrence) && m.occurrence > 0))
    && (m.edge === undefined || ['rising', 'falling', 'either'].includes(m.edge))
    && (m.from === undefined || m.to === undefined || m.from <= m.to)
    && (m.kind !== 'at' || m.at !== undefined)
    && (m.kind !== 'slope' || (m.at !== undefined && m.value === undefined && m.edge === undefined))
    && (!['totalVariation', 'timeCentroid'].includes(m.kind) || (m.at === undefined && m.value === undefined && m.edge === undefined))
    && (!['cross', 'when', 'crossingCount'].includes(m.kind) || m.value !== undefined)
    && (m.kind !== 'crossingCount' || m.at === undefined);
}

function series(a: AnalysisResultV1, signal: string): { x: number[]; y: number[]; unit: string; axisUnit: string } | undefined {
  if (a.type === 'tf' || a.type === 'noise') return undefined;
  const match = /^(?:(db|mag|phase)\()?([vi])\(([^()]+)\)\)?$/i.exec(signal);
  if (!match) return undefined;
  const [, transform, quantity, name] = match;
  const voltage = quantity.toLowerCase() === 'v';
  // Projections are available only for AC phasors.
  if (transform && (a.type !== 'ac' || !signal.endsWith('))'))) return undefined;
  if (!transform && signal.endsWith('))')) return undefined;
  const values = a.type === 'ac'
    ? (voltage ? a.voltagePhasors : a.currentPhasors)
    : (voltage ? a.voltagesV : a.currentsA);
  // An exact literal voltage name wins over interpreting its commas as separators.
  const literal = voltage && Object.keys(values).some(key => key.toLowerCase() === name.toLowerCase());
  const nodes = voltage && !literal ? name.split(',').map(node => node.trim()) : [name];
  if (nodes.some(node => !node.trim()) || (voltage && nodes.length > 2)) return undefined;
  const keys = nodes.map((node, i) => voltage && node === '0' ? '0' : Object.keys(values).find(key => key.toLowerCase() === (nodes.length === 1 && i === 0 ? name : node).toLowerCase())
    ?? Object.keys(values).find(key => key.toLowerCase() === node.toLowerCase()));
  if (keys.some(key => key === undefined)) return undefined;
  const projection = transform?.toLowerCase();
  const length = a.type === 'ac' ? a.frequencyHz.length : a.type === 'tran' ? a.timeS.length : a.type === 'dc' ? a.axis.values.length : 1;
  let y: number[];
  if (a.type === 'ac') {
    const phasors = voltage ? a.voltagePhasors : a.currentPhasors;
    const get = (key: string) => voltage && key === '0' ? Array.from({ length }, () => ({ magnitude: 0, phaseDegrees: 0 })) : phasors[key];
    const positive = get(keys[0]!);
    const negative = keys.length === 2 ? get(keys[1]!) : undefined;
    if (negative && negative.length !== positive.length) return undefined;
    y = positive.map((p, i) => {
      let magnitude = p.magnitude;
      let phase = p.phaseDegrees;
      // Subtracting zero must retain the positive phasor's phase branch before unwrapping.
      if (negative && negative[i].magnitude !== 0) {
        const n = negative[i];
        const rad = Math.PI / 180;
        // Reduce whole turns before conversion, retaining small angles near zero.
        const normalize = (degrees: number): number => {
          const angle = degrees % 360;
          return angle > 180 ? angle - 360 : angle <= -180 ? angle + 360 : angle;
        };
        const real = p.magnitude * Math.cos(normalize(p.phaseDegrees) * rad) - n.magnitude * Math.cos(normalize(n.phaseDegrees) * rad);
        const imag = p.magnitude * Math.sin(normalize(p.phaseDegrees) * rad) - n.magnitude * Math.sin(normalize(n.phaseDegrees) * rad);
        magnitude = Math.hypot(real, imag);
        phase = Math.atan2(imag, real) / rad;
      }
      return projection === 'phase' ? (magnitude > 0 && Number.isFinite(magnitude) && Number.isFinite(phase) ? phase : NaN)
        : projection === 'db' ? 20 * Math.log10(magnitude) : magnitude;
    });
  } else {
    const get = (key: string): number[] => {
      if (voltage && key === '0') return Array(length).fill(0);
      const value = (voltage ? a.voltagesV : a.currentsA)[key];
      return typeof value === 'number' ? [value] : value;
    };
    const positive = get(keys[0]!);
    const negative = keys.length === 2 ? get(keys[1]!) : undefined;
    if (negative && negative.length !== positive.length) return undefined;
    y = negative ? positive.map((value, i) => value - negative[i]) : positive;
  }
  if (a.type === 'ac' && projection === 'phase') {
    const descending = a.frequencyHz.length > 1 && a.frequencyHz[0] > a.frequencyHz[a.frequencyHz.length - 1];
    if (descending) y.reverse();
    for (let i = 1; i < y.length; i++) {
      const delta = y[i] - y[i - 1];
      y[i] = y[i - 1] + ((delta + 180) % 360 + 360) % 360 - 180;
    }
    if (descending) y.reverse();
  }
  return {
    x: a.type === 'ac' ? a.frequencyHz : a.type === 'tran' ? a.timeS : a.type === 'dc' ? a.axis.values : [0],
    y, unit: projection === 'phase' ? 'deg' : projection === 'db' ? 'dB' : voltage ? 'V' : 'A',
    axisUnit: a.type === 'ac' ? 'Hz' : a.type === 'tran' ? 's' : a.type === 'dc' ? a.axis.unit : '',
  };
}

/** Scalar-only reduction of a bounded simulation. Each measurement fails independently. */
export function measureResult(result: SimulationResultV1, measurements: unknown[]): { measurements: MeasurementResult[] } {
  return { measurements: measurements.map(raw => {
    if (!valid(raw)) return error('INVALID_MEASUREMENT', 'Invalid measurement fields');
    const m = raw;
    const analyses = result.analyses.filter(a => a.analysisIndex === m.analysis);
    if (!analyses.length) return error('UNKNOWN_ANALYSIS', 'No analysis with this index');
    if (m.step === undefined && analyses.length !== 1) return error('AMBIGUOUS_ANALYSIS', `Analysis has ${analyses.length} steps; select a zero-based step index`);
    const analysis = m.step === undefined ? analyses[0] : analyses.find(a => (a.step?.index ?? 0) === m.step);
    if (!analysis) return error('UNKNOWN_STEP', 'No step with this index in the selected analysis');
    if (m.kind === 'delay') {
      if (analysis.type !== 'tran') return error('INVALID_MEASUREMENT', 'Delay requires a transient analysis');
      const crossing = (spec: Crossing): MeasurementResult => {
        const data = series(analysis, spec.signal);
        if (!data) return error('UNKNOWN_SIGNAL', `Signal ${spec.signal} is unavailable`);
        const { x, y } = data;
        if (!x.length || x.length !== y.length || ![...x, ...y].every(Number.isFinite)) return error('NON_FINITE_RESULT', 'Signal has empty or non-finite data');
        if (x.some((v, i) => i > 0 && v <= x[i - 1])) return error('INVALID_MEASUREMENT', 'Analysis axis must be strictly increasing');
        const lo = m.from ?? x[0]; const hi = m.to ?? x[x.length - 1];
        if (lo < x[0] || hi > x[x.length - 1] || lo > hi) return error('OUT_OF_RANGE', 'Measurement lies outside the analysis window');
        let count = 0;
        let initialPlateau = y[0] === spec.threshold;
        for (let i = 1; i < x.length; i++) {
          const rising = y[i - 1] < spec.threshold && y[i] >= spec.threshold;
          const falling = (y[i - 1] > spec.threshold && y[i] <= spec.threshold)
            || (initialPlateau && y[i] < spec.threshold);
          if (y[i] !== spec.threshold) initialPlateau = false;
          if (!(spec.edge === 'rising' ? rising : spec.edge === 'falling' ? falling : rising || falling)) continue;
          const time = x[i - 1] + (x[i] - x[i - 1]) * ((spec.threshold - y[i - 1]) / (y[i] - y[i - 1]));
          if (time < lo || time > hi) continue;
          if (++count === (spec.occurrence ?? 1)) return { value: time, unit: 's' };
        }
        return error('NO_CROSSING', `No crossing for ${spec.signal} in the selected window`);
      };
      const trigger = crossing(m.trigger!);
      if ('error' in trigger) return trigger;
      const target = crossing(m.target!);
      if ('error' in target) return target;
      const value = target.value - trigger.value;
      return Number.isFinite(value) ? { value, unit: 's' } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
    }
    if (['integ', 'absInteg', 'timeCentroid', 'duty', 'timeInBand', 'longestTimeInBand', 'pulseWidth', 'period', 'frequency', 'rmsError', 'meanAbsoluteError', 'relativeRmsError', 'maxAbsoluteError', 'totalVariation', 'slope', 'crossingCount'].includes(m.kind) && analysis.type !== 'tran') return error('INVALID_MEASUREMENT', `${m.kind} requires a transient analysis`);
    const data = series(analysis, m.signal);
    if (!data) return error('UNKNOWN_SIGNAL', `Signal or projection ${m.signal} is unavailable`);
    let { x, y } = data;
    if (!x.length || x.length !== y.length || ![...x, ...y].every(Number.isFinite)) return error('NON_FINITE_RESULT', 'Signal has empty or non-finite data');
    let referenceY: number[] | undefined;
    if (m.kind === 'rmsError' || m.kind === 'meanAbsoluteError' || m.kind === 'relativeRmsError' || m.kind === 'maxAbsoluteError') {
      const reference = series(analysis, m.referenceSignal!);
      if (!reference) return error('UNKNOWN_SIGNAL', `Signal or projection ${m.referenceSignal} is unavailable`);
      if (reference.unit !== data.unit) return error('INVALID_MEASUREMENT', 'Signals must have matching units');
      if (reference.y.length !== x.length || !reference.y.every(Number.isFinite)) return error('NON_FINITE_RESULT', 'Reference signal has empty, misaligned or non-finite data');
      referenceY = reference.y;
      if (m.kind !== 'relativeRmsError') {
        y = y.map((v, i) => v - reference.y[i]);
        if (!y.every(Number.isFinite)) return error('NON_FINITE_RESULT', 'Signal difference is non-finite');
      }
      if (x.some((v, i) => i > 0 && v <= x[i - 1])) return error('INVALID_MEASUREMENT', 'Transient axis must be strictly increasing');
    }
    if (!['pulseWidth', 'period', 'frequency'].includes(m.kind) && x.length > 1 && x[0] > x[x.length - 1]) { x = [...x].reverse(); y = [...y].reverse(); }
    if (x.some((v, i) => i > 0 && v <= x[i - 1])) return error('INVALID_MEASUREMENT', 'Analysis axis must be strictly monotonic');
    const lo = m.from ?? x[0];
    const hi = m.to ?? x[x.length - 1];
    if (lo < x[0] || hi > x[x.length - 1] || lo > hi || (m.at !== undefined && (m.at < lo || m.at > hi))) return error('OUT_OF_RANGE', 'Measurement lies outside the analysis window');
    if (m.kind === 'slope') {
      if (x.length < 2) return error('INVALID_MEASUREMENT', 'Slope requires at least two samples');
      let left = 0; let right = x.length - 1;
      while (left < right) {
        const middle = (left + right + 1) >>> 1;
        if (x[middle] <= m.at!) left = middle;
        else right = middle - 1;
      }
      const i = Math.min(left, x.length - 2);
      const delta = y[i + 1] - y[i];
      const width = x[i + 1] - x[i];
      const value = delta / width;
      return Number.isFinite(delta) && Number.isFinite(width) && Number.isFinite(value)
        ? { value, unit: `${data.unit}/s` }
        : error('NON_FINITE_RESULT', 'Slope is non-finite');
    }
    if ((m.kind === 'rmsError' || m.kind === 'meanAbsoluteError' || m.kind === 'relativeRmsError' || m.kind === 'maxAbsoluteError') && hi === lo) return error('INVALID_MEASUREMENT', `${m.kind === 'rmsError' ? 'RMS error' : m.kind === 'relativeRmsError' ? 'Relative RMS error' : m.kind === 'maxAbsoluteError' ? 'Maximum absolute error' : 'Mean absolute error'} requires a nonzero window`);
    if (m.kind === 'pulseWidth' || m.kind === 'period' || m.kind === 'frequency') {
      const threshold = m.value!;
      let entry: number | undefined;
      let count = 0;
      for (let i = 1; i < x.length; i++) {
        const a = y[i - 1]; const b = y[i];
        // A crossing is recorded on first contact with the threshold. A plateau
        // does not create further crossings until the signal leaves it.
        const rising = a < threshold && b >= threshold;
        const falling = a > threshold && b <= threshold;
        if (!rising && !falling) continue;
        const delta = b - a;
        const fraction = Number.isFinite(delta)
          ? (threshold - a) / delta
          : (threshold / 2 - a / 2) / (b / 2 - a / 2);
        const time = x[i - 1] + (x[i] - x[i - 1]) * fraction;
        if (time < lo || time > hi) continue;
        if (m.kind !== 'pulseWidth') {
          if (m.edge !== (rising ? 'rising' : 'falling')) continue;
          if (entry !== undefined && ++count === (m.occurrence ?? 1)) {
            const period = time - entry;
            const value = m.kind === 'frequency' ? 1 / period : period;
            return period > 0 && Number.isFinite(period) && Number.isFinite(value) && value > 0
              ? { value, unit: m.kind === 'frequency' ? 'Hz' : 's' }
              : error('NON_FINITE_RESULT', 'Period or frequency is not representable');
          }
          entry = time;
        } else if (m.edge === (rising ? 'rising' : 'falling')) entry = time;
        else if (entry !== undefined) {
          if (++count === (m.occurrence ?? 1)) {
            const value = time - entry;
            return Number.isFinite(value) ? { value, unit: 's' } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
          }
          entry = undefined;
        }
      }
      return error('NO_CROSSING', m.kind === 'pulseWidth' ? 'No complete pulse in the selected window' : 'No complete period in the selected window');
    }
    if (m.kind === 'totalVariation') {
      let value = 0;
      for (let i = 1; i < x.length; i++) {
        const start = Math.max(lo, x[i - 1]); const end = Math.min(hi, x[i]);
        if (end <= start) continue;
        const width = x[i] - x[i - 1];
        const fraction = Number.isFinite(width) ? (end - start) / width
          : (end / 2 - start / 2) / (x[i] / 2 - x[i - 1] / 2);
        const delta = y[i] - y[i - 1];
        // A subnormal fraction can lose precision even when the clipped change is
        // representable. Prefer the slope only if it retains normal precision; a
        // subnormal slope can be less accurate than a normal fraction.
        const slope = Number.isFinite(width) && Number.isFinite(delta)
          ? Math.abs(delta) / width
          : Math.abs(y[i] / 2 - y[i - 1] / 2) / (x[i] / 2 - x[i - 1] / 2);
        const clippedWidth = end - start;
        if (fraction < 2 ** -1022 && slope >= 2 ** -1022 && Number.isFinite(slope) && Number.isFinite(clippedWidth)) {
          value += slope * clippedWidth;
        } else if (fraction < 2 ** -1022 && Number.isFinite(delta) && Number.isFinite(clippedWidth)) {
          // Keep the fraction normal until after multiplication, avoiding early
          // rounding of both the fraction and the subnormal slope. Halve the
          // endpoints first when the segment width itself overflows.
          const scale = 2 ** -512;
          const scaledWidth = Number.isFinite(width) ? width * scale
            : (x[i] / 2 - x[i - 1] / 2) * (2 * scale);
          value += (clippedWidth / scaledWidth) * Math.abs(delta) * scale;
        } else {
          // Scale the original segment change before adding any DC offset.
          value += Number.isFinite(delta) ? Math.abs(delta) * fraction
            : Math.abs(y[i] / 2 - y[i - 1] / 2) * fraction * 2;
        }
      }
      return Number.isFinite(value) ? { value, unit: data.unit } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
    }
    const interpolate = (at: number, values = y): number => {
      let left = 0; let right = x.length - 1;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (x[middle] < at) left = middle + 1;
        else right = middle;
      }
      const i = left;
      if (i === 0 || x[i] === at) return values[i];
      const width = x[i] - x[i - 1];
      const fraction = m.kind === 'timeCentroid' && !Number.isFinite(width)
        ? (at / 2 - x[i - 1] / 2) / (x[i] / 2 - x[i - 1] / 2)
        : (at - x[i - 1]) / width;
      const delta = values[i] - values[i - 1];
      if (m.kind === 'timeCentroid' && fraction < 2 ** -1022 && Number.isFinite(delta)) {
        const distance = at - x[i - 1];
        const slope = delta / width;
        if (Number.isFinite(distance) && Number.isFinite(slope) && Math.abs(slope) >= 2 ** -1022) {
          return values[i - 1] + slope * distance;
        }
        if (Number.isFinite(distance)) {
          const scale = 2 ** -512;
          const scaledWidth = Number.isFinite(width) ? width * scale
            : (x[i] / 2 - x[i - 1] / 2) * (2 * scale);
          return values[i - 1] + (distance / scaledWidth) * delta * scale;
        }
      }
      return Number.isFinite(delta)
        ? values[i - 1] + delta * fraction
        : values[i - 1] * (1 - fraction) + values[i] * fraction;
    };
    if (m.kind === 'at') return { value: interpolate(m.at!), unit: data.unit };
    if (m.kind === 'cross' || m.kind === 'when' || m.kind === 'crossingCount') {
      if (!data.axisUnit) return error('INVALID_MEASUREMENT', 'Crossings require a swept analysis');
      const target = m.value!;
      let count = 0;
      let initialPlateau = y[0] === target;
      for (let i = 1; i < x.length; i++) {
        const rising = y[i - 1] < target && y[i] >= target;
        const falling = (y[i - 1] > target && y[i] <= target) || (initialPlateau && y[i] < target);
        if (y[i] !== target) initialPlateau = false;
        if (!(m.edge === 'rising' ? rising : m.edge === 'falling' ? falling : rising || falling)) continue;
        const at = x[i - 1] + (x[i] - x[i - 1]) * ((target - y[i - 1]) / (y[i] - y[i - 1]));
        if (at >= lo && at <= hi) {
          count++;
          if (m.kind !== 'crossingCount' && count === (m.occurrence ?? 1)) return { value: at, unit: data.axisUnit };
        }
      }
      if (m.kind === 'crossingCount') return { value: count, unit: '1' };
      return error('NO_CROSSING', 'No crossing in the selected window');
    }
    const points = [lo, ...x.filter(v => v > lo && v < hi), ...(hi > lo ? [hi] : [])];
    const samples = points.map(point => interpolate(point));
    let value: number;
    let unit = data.unit;
    if (m.kind === 'timeCentroid') {
      if (hi === lo) return error('INVALID_MEASUREMENT', 'Time centroid requires a nonzero window');
      {
        const scale = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        if (scale === 0) return error('INVALID_MEASUREMENT', 'Time centroid requires nonzero absolute area');
        // Zero-only edge segments contribute no area. Exclude them from the
        // time normalization so a short pulse is not scaled by an unrelated
        // (possibly enormous) zero-padded portion of the window.
        const first = samples.findIndex(sample => sample !== 0);
        let last = samples.length - 1;
        while (samples[last] === 0) last--;
        const origin = points[Math.max(0, first - 1)];
        const limit = points[Math.min(points.length - 1, last + 1)];
        const wide = !Number.isFinite(limit - origin);
        const span = wide ? limit / 2 - origin / 2 : limit - origin;
        if (!Number.isFinite(scale)) return error('NON_FINITE_RESULT', 'Measurement is non-finite');
        let area = 0; let moment = 0; let underflow = false;
        const add = (start: number, width: number, a: number, b: number) => {
          const weight = width * (a + b) / 2;
          if (weight === 0) { underflow = true; return; }
          area += weight;
          const center = start + width * (a + 2 * b) / (3 * (a + b));
          const contribution = weight * center;
          if (contribution < 2 ** -1022 && (start !== 0 || width !== 0)) underflow = true;
          moment += contribution;
        };
        for (let i = Math.max(1, first); i <= Math.min(points.length - 1, last + 1); i++) {
          const start = (wide ? points[i - 1] / 2 - origin / 2 : points[i - 1] - origin) / span;
          const width = (wide ? points[i] / 2 - points[i - 1] / 2 : points[i] - points[i - 1]) / span;
          const a = samples[i - 1] / scale; const b = samples[i] / scale;
          if ((width === 0 && points[i] !== points[i - 1]) ||
              (a === 0 && samples[i - 1] !== 0) || (b === 0 && samples[i] !== 0)) underflow = true;
          if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
            const fraction = Math.abs(a) / (Math.abs(a) + Math.abs(b));
            add(start, width * fraction, Math.abs(a), 0);
            add(start + width * fraction, width * (1 - fraction), 0, Math.abs(b));
          } else if (a !== 0 || b !== 0) add(start, width, Math.abs(a), Math.abs(b));
        }
        const fraction = moment / area;
        value = wide ? origin * (1 - fraction) + limit * fraction : origin + span * fraction;
        if (!underflow && Number.isFinite(value)) return { value, unit: 's' };
      }
      const scale = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
      if (scale === 0) return error('INVALID_MEASUREMENT', 'Time centroid requires nonzero absolute area');
      if (!Number.isFinite(scale)) return error('NON_FINITE_RESULT', 'Measurement is non-finite');
      const first = samples.findIndex(sample => sample !== 0);
      let last = samples.length - 1;
      while (samples[last] === 0) last--;
      const origin = points[Math.max(0, first - 1)];
      const limit = points[Math.min(points.length - 1, last + 1)];
      const wide = !Number.isFinite(limit - origin);
      // Accumulate positive integrals as binary mantissa/exponent pairs. In
      // particular, do not divide a small segment by the whole window before
      // multiplying its area by its distance from the origin.
      type Sum = { mantissa: number; exponent: number };
      const area: Sum = { mantissa: 0, exponent: 0 };
      const moment: Sum = { mantissa: 0, exponent: 0 };
      const addProduct = (sum: Sum, factors: number[]) => {
        let mantissa = 1; let exponent = 0;
        for (const factor of factors) {
          if (factor === 0) return;
          const e = Math.max(-1022, Math.min(1023, Math.floor(Math.log2(factor))));
          mantissa *= factor / 2 ** e;
          exponent += e;
        }
        if (sum.mantissa === 0) { sum.mantissa = mantissa; sum.exponent = exponent; return; }
        if (exponent > sum.exponent) {
          sum.mantissa *= 2 ** (sum.exponent - exponent);
          sum.exponent = exponent;
        }
        sum.mantissa += mantissa * 2 ** (exponent - sum.exponent);
      };
      const add = (start: number, width: number, magnitude: number, a: number, b: number) => {
        const shape = (a + b) / 2;
        const center = (a + 2 * b) / (3 * (a + b));
        addProduct(area, [width, magnitude, shape]);
        addProduct(moment, [width, magnitude, shape, start]);
        addProduct(moment, [width, magnitude, shape, width, center]);
      };
      for (let i = Math.max(1, first); i <= Math.min(points.length - 1, last + 1); i++) {
        const start = wide ? points[i - 1] / 2 - origin / 2 : points[i - 1] - origin;
        const width = wide ? points[i] / 2 - points[i - 1] / 2 : points[i] - points[i - 1];
        const magnitude = Math.max(Math.abs(samples[i - 1]), Math.abs(samples[i]));
        if (magnitude === 0) continue;
        const a = samples[i - 1] / magnitude; const b = samples[i] / magnitude;
        if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
          const fraction = Math.abs(a) / (Math.abs(a) + Math.abs(b));
          add(start, width * fraction, magnitude, Math.abs(a), 0);
          add(start + width * fraction, width * (1 - fraction), magnitude, 0, Math.abs(b));
        } else add(start, width, magnitude, Math.abs(a), Math.abs(b));
      }
      let mantissa = moment.mantissa / area.mantissa;
      let exponent = moment.exponent - area.exponent;
      while (mantissa >= 2) { mantissa /= 2; exponent++; }
      while (mantissa > 0 && mantissa < 1) { mantissa *= 2; exponent--; }
      const offset = exponent > 1023 ? (mantissa * 2 ** 1023) * 2 ** (exponent - 1023)
        : exponent < -1022 ? (mantissa * 2 ** -1022) * 2 ** (exponent + 1022)
        : mantissa * 2 ** exponent;
      value = wide ? (origin / 2 + offset) * 2 : origin + offset;
      return Number.isFinite(value) ? { value, unit: 's' } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
    } else if (m.kind === 'relativeRmsError') {
      const referenceSamples = points.map(point => interpolate(point, referenceY!));
      let errors = samples.map((v, i) => v - referenceSamples[i]);
      const halfErrors = !errors.every(Number.isFinite);
      if (halfErrors) errors = samples.map((v, i) => v / 2 - referenceSamples[i] / 2);
      const scale = (values: number[]) => values.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
      const referenceScale = scale(referenceSamples);
      if (referenceScale === 0) return error('INVALID_MEASUREMENT', 'Reference RMS must be nonzero');
      const errorScale = scale(errors);
      if (errorScale === 0) return { value: 0, unit: '1' };
      const normalizedRms = (values: number[], magnitude: number) => {
        let rms = 0;
        for (let i = 1; i < points.length; i++) {
          const a = values[i - 1] / magnitude; const b = values[i] / magnitude;
          // Accumulate square roots of the segment integrals, so a tiny
          // duration or squared amplitude cannot disappear before the root.
          const segmentRms = Math.hypot(a / 2 + b / 2, (a / 2 - b / 2) / Math.sqrt(3));
          const weight = Math.sqrt(points[i] - points[i - 1]) / Math.sqrt(hi - lo);
          rms = Math.hypot(rms, weight * segmentRms);
        }
        return rms;
      };
      // Combine mantissas and binary exponents separately so neither an
      // intermediate scale ratio nor a tiny integral factor loses the result.
      const factors = [errorScale, normalizedRms(errors, errorScale), referenceScale, normalizedRms(referenceSamples, referenceScale)];
      let mantissa = halfErrors ? 2 : 1; let exponent = 0;
      for (let i = 0; i < factors.length; i++) {
        const e = Math.min(1023, Math.floor(Math.log2(factors[i])));
        const m = factors[i] / 2 ** e;
        if (i < 2) { mantissa *= m; exponent += e; }
        else { mantissa /= m; exponent -= e; }
      }
      while (mantissa >= 2) { mantissa /= 2; exponent++; }
      while (mantissa < 1) { mantissa *= 2; exponent--; }
      const ratio = exponent > 1023 ? (mantissa * 2 ** 1023) * 2 ** (exponent - 1023)
        : exponent < -1022 ? (mantissa * 2 ** -1022) * 2 ** (exponent + 1022)
        : mantissa * 2 ** exponent;
      return Number.isFinite(ratio) ? { value: ratio, unit: '1' } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
    }
    if (m.kind === 'timeInBand' || m.kind === 'longestTimeInBand') {
      let duration = 0; let longest = 0;
      for (let i = 1; i < points.length; i++) {
        const low = Math.min(samples[i - 1], samples[i]);
        const high = Math.max(samples[i - 1], samples[i]);
        const fullWidth = points[i] - points[i - 1];
        const wide = !Number.isFinite(fullWidth);
        const width = wide ? points[i] / 2 - points[i - 1] / 2 : fullWidth;
        let segment = 0;
        if (low === high) {
          if (low >= m.lower! && low <= m.upper!) segment = width;
        } else {
          const start = Math.max(low, m.lower!); const end = Math.min(high, m.upper!);
          if (end > start) {
            const range = high - low;
            const span = end - start;
            const denominator = Number.isFinite(range) ? range : high / 2 - low / 2;
            const scaledWidth = Number.isFinite(range) ? width : width / 2;
            const ratio = scaledWidth / denominator;
            // Divide the duration first when possible, so a tiny band fraction
            // does not underflow before it can be multiplied by the duration.
            segment = scaledWidth > 1 && Number.isFinite(ratio) && Number.isFinite(span)
              ? span * ratio
              : width * (Number.isFinite(range) ? span / range : (end / 2 - start / 2) / denominator);
          }
        }
        if (wide) segment *= 2;
        // An out-of-band shared sample implies a positive-duration excursion
        // between visits; an on-boundary sample keeps the visit continuous.
        if (m.kind === 'longestTimeInBand' && (samples[i - 1] < m.lower! || samples[i - 1] > m.upper!)) duration = 0;
        duration += segment;
        longest = Math.max(longest, duration);
      }
      value = Math.min(hi - lo, Math.max(0, m.kind === 'timeInBand' ? duration : longest));
      unit = 's';
    } else if (m.kind === 'duty') {
      if (hi === lo) return error('OUT_OF_RANGE', 'Duty requires a nonzero window');
      let duration = 0;
      for (let i = 1; i < points.length; i++) {
        const a = samples[i - 1]; const b = samples[i]; const threshold = m.value!;
        const width = points[i] - points[i - 1];
        if (a > threshold && b > threshold) duration += width;
        else if (a > threshold || b > threshold) {
          const high = Math.max(a, b); const low = Math.min(a, b);
          const range = high - low;
          const fraction = Number.isFinite(range)
            ? (high - threshold) / range
            : (high / 2 - threshold / 2) / (high / 2 - low / 2);
          duration += width * fraction;
        }
      }
      value = Math.min(1, Math.max(0, duration / (hi - lo)));
      unit = '1';
    } else if (m.kind === 'maxAbsoluteError') {
      value = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    } else if (m.kind === 'min' || m.kind === 'max' || m.kind === 'pp') {
      const min = samples.reduce((a, b) => Math.min(a, b));
      const max = samples.reduce((a, b) => Math.max(a, b));
      value = m.kind === 'min' ? min : m.kind === 'max' ? max : max - min;
    } else if (hi === lo) {
      value = m.kind === 'integ' || m.kind === 'absInteg' ? 0 : (m.kind === 'rms' || m.kind === 'rmsError') ? Math.abs(samples[0]) : samples[0];
    } else {
      let integral = 0;
      for (let i = 1; i < points.length; i++) {
        const a = samples[i - 1]; const b = samples[i];
        const width = points[i] - points[i - 1];
        if (m.kind === 'absInteg' || m.kind === 'meanAbsoluteError') {
          const aa = Math.abs(a); const bb = Math.abs(b);
          if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
            const scale = Math.max(aa, bb);
            const fraction = (aa / scale) / (aa / scale + bb / scale);
            integral += width * (aa / 2 * fraction + bb / 2 * (1 - fraction));
          } else integral += width * (aa / 2 + bb / 2);
        } else integral += width * ((m.kind === 'rms' || m.kind === 'rmsError') ? (a * a + a * b + b * b) / 3 : (a + b) / 2);
      }
      value = m.kind === 'integ' || m.kind === 'absInteg' ? integral : (m.kind === 'rms' || m.kind === 'rmsError') ? Math.sqrt(integral / (hi - lo)) : integral / (hi - lo);
    }
    if (m.kind === 'integ' || m.kind === 'absInteg') unit += '*s';
    return Number.isFinite(value) ? { value, unit } : error('NON_FINITE_RESULT', 'Measurement is non-finite');
  }) };
}
