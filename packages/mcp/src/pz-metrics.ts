import type { PoleZeroResult, PoleZeroValue } from '@spice-ts/core';

const rootSchema = {
  type: 'object', additionalProperties: false, required: ['re', 'im', 'frequencyHz'],
  properties: { re: { type: 'number' }, im: { type: 'number' }, frequencyHz: { type: 'number', minimum: 0 } },
};
export const pzMetricsOutputSchema = {
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
};

export function pzMetrics(result: PoleZeroResult) {
  const root = (r: PoleZeroValue) => ({ re: r.real, im: r.imaginary, frequencyHz: Math.hypot(r.real, r.imaginary) / (2 * Math.PI) });
  const poles = result.poles.map(root);
  const zeros = result.zeros.map(root);
  const pairs = (roots: PoleZeroValue[], kind: 'pole' | 'zero') => {
    const used = new Set<number>();
    return roots.flatMap((r, i) => {
      if (used.has(i) || r.imaginary === 0) return [];
      const j = roots.findIndex((s, j) => j > i && !used.has(j) && s.real === r.real && s.imaginary === -r.imaginary);
      if (j < 0) return [];
      used.add(j);
      const wn = Math.hypot(r.real, r.imaginary);
      const zeta = -r.real / wn;
      return [{ kind, indices: [i, j], naturalFrequencyRadPerSec: wn, naturalFrequencyHz: wn / (2 * Math.PI), dampingRatio: zeta, q: zeta === 0 ? null : 1 / (2 * zeta) }];
    });
  };
  return {
    poles, zeros, conjugatePairs: [...pairs(result.poles, 'pole'), ...pairs(result.zeros, 'zero')],
    dominantPole: poles.reduce<(typeof poles)[number] | null>((dominant, p) => dominant === null || p.re > dominant.re ? p : dominant, null),
    rightHalfPlaneCount: poles.filter(p => p.re > 0).length,
    stable: poles.every(p => p.re < 0),
  };
}
