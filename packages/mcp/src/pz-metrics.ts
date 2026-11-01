import type { PoleZeroResult, PoleZeroValue } from '@spice-ts/core';

const rootSchema = {
  type: 'object', additionalProperties: false, required: ['re', 'im', 'frequencyHz'],
  properties: { re: { type: 'number' }, im: { type: 'number' }, frequencyHz: { type: 'number', minimum: 0 } },
};
export const pzMetricsOutputSchema = {
  anyOf: [{
  type: 'object', additionalProperties: false,
  required: ['poles', 'zeros', 'conjugatePairs', 'dominantPole', 'rightHalfPlaneCount', 'stable'],
  properties: {
    poles: { type: 'array', items: rootSchema }, zeros: { type: 'array', items: rootSchema },
    dominantPole: { anyOf: [rootSchema, { type: 'null' }] },
    rightHalfPlaneCount: { type: 'integer', minimum: 0 }, stable: { type: 'boolean' },
    conjugatePairs: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'indices', 'naturalFrequencyRadPerSec', 'naturalFrequencyHz', 'dampingRatio', 'q'],
        properties: {
          kind: { enum: ['pole', 'zero'] },
          indices: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2, maxItems: 2 },
          naturalFrequencyRadPerSec: { type: 'number', exclusiveMinimum: 0 },
          naturalFrequencyHz: { type: 'number', exclusiveMinimum: 0 },
          dampingRatio: { type: 'number' }, q: { type: ['number', 'null'] },
        },
      },
    },
  },
  }, {
    type: 'object', additionalProperties: false, required: ['error'],
    properties: { error: {
      type: 'object', additionalProperties: false, required: ['code', 'message', 'phase', 'retryable', 'details'],
      properties: {
        code: { const: 'INVALID_DATA' }, message: { type: 'string' }, phase: { const: 'analysis' }, retryable: { const: false },
        details: { type: 'object', additionalProperties: false, required: ['kind', 'index', 'metric'], properties: {
          kind: { enum: ['pole', 'zero'] }, index: { type: 'integer', minimum: 0 }, metric: { type: 'string' },
        } },
      },
    } },
  }],
};

export function pzMetrics(result: PoleZeroResult) {
  const invalid = (kind: 'pole' | 'zero', index: number, metric: string): never => {
    throw { code: 'INVALID_DATA', message: `Non-finite or unrepresentable ${kind} ${metric}`, phase: 'analysis', retryable: false, details: { kind, index, metric } };
  };
  const root = (kind: 'pole' | 'zero') => (r: PoleZeroValue, index: number) => {
    if (!Number.isFinite(r.real)) invalid(kind, index, 'real');
    if (!Number.isFinite(r.imaginary)) invalid(kind, index, 'imaginary');
    const norm = Math.hypot(r.real, r.imaginary);
    const frequencyHz = Number.isFinite(norm) ? norm / (2 * Math.PI) : Math.hypot(r.real / (2 * Math.PI), r.imaginary / (2 * Math.PI));
    if (!Number.isFinite(frequencyHz)) invalid(kind, index, 'frequencyHz');
    return { re: r.real, im: r.imaginary, frequencyHz };
  };
  const poles = result.poles.map(root('pole'));
  const zeros = result.zeros.map(root('zero'));
  const pairs = (roots: PoleZeroValue[], kind: 'pole' | 'zero') => {
    const used = new Set<number>();
    return roots.flatMap((r, i) => {
      if (used.has(i) || r.imaginary === 0) return [];
      const j = roots.findIndex((s, j) => j > i && !used.has(j) && s.real === r.real && s.imaginary === -r.imaginary);
      if (j < 0) return [];
      used.add(j);
      const wn = Math.hypot(r.real, r.imaginary);
      if (!Number.isFinite(wn) || wn <= 0) invalid(kind, i, 'naturalFrequencyRadPerSec');
      const naturalFrequencyHz = wn / (2 * Math.PI);
      if (!Number.isFinite(naturalFrequencyHz) || naturalFrequencyHz <= 0) invalid(kind, i, 'naturalFrequencyHz');
      const zeta = -r.real / wn;
      if (!Number.isFinite(zeta)) invalid(kind, i, 'dampingRatio');
      const q = r.real === 0 ? null : 1 / (2 * zeta);
      if (q !== null && !Number.isFinite(q)) invalid(kind, i, 'q');
      return [{ kind, indices: [i, j], naturalFrequencyRadPerSec: wn, naturalFrequencyHz, dampingRatio: zeta, q }];
    });
  };
  return {
    poles, zeros, conjugatePairs: [...pairs(result.poles, 'pole'), ...pairs(result.zeros, 'zero')],
    dominantPole: poles.reduce<(typeof poles)[number] | null>((dominant, p) => dominant === null || p.re > dominant.re ? p : dominant, null),
    rightHalfPlaneCount: poles.filter(p => p.re > 0).length,
    stable: poles.every(p => p.re < 0),
  };
}
