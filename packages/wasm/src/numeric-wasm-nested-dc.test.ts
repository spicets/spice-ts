import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original MIT fixtures: outer-source nodes expose the second coordinate even
// though protocol-v1 DC results serialize only the primary axis.
const diode = `V1 in 0 0
V2 outer 0 0
R1 in out 1k
R2 outer out 2k
D1 out 0 diode
.model diode D(IS=1e-14 N=1)`;
const bjt = `V1 supply 0 0
V2 outer 0 0
RC supply collector 1k
RB outer base 100k
Q1 collector base 0 transistor
.model transistor NPN(IS=1e-14 BF=120 BR=3 NF=1.1 NR=1.2 VAF=80)`;
const fixtures = [
  { name: 'linear accumulated endpoint', source: 'V1 in 0 0\nV2 outer 0 0\nR1 in 0 1k\nR2 outer 0 1k\n.dc V1 0 1p 0.6p V2 0 1 1', inner: 3, outer: [0, 1] },
  { name: 'diode ascending', source: `${diode}\n.dc V1 0 1 0.1 V2 0 2 0.5`, inner: 11, outer: [0, 0.5, 1, 1.5, 2] },
  { name: 'BJT descending outer', source: `${bjt}\n.dc V1 0 5 0.25 V2 1.2 0 -0.3`, inner: 21, outer: [1.2, 0.9, 0.6, 0.3, 0] },
  { name: 'diode current-source outer', source: `${diode.replace('V2 outer 0 0', 'I2 0 outer 0\nR3 outer 0 1k')}\n.dc V1 0 1 0.1 I2 0 1m 0.25m`, inner: 11, outer: undefined, points: 55 },
];
const request = (source: string, options?: SimulationRequestV1['options']): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source }, options,
});

describe('WASM two-source nested DC sweeps', () => {
  it.each(fixtures)('matches core at every point: $name', async ({ name, source, inner, outer, points }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'nested-dc' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const reference = await simulateProtocolV1(request(source));
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      if (a?.type !== 'dc' || b?.type !== 'dc') throw new Error('Expected DC results');
      expect(a.axis.values).toHaveLength(outer ? inner * outer.length : points!);
      expect(a.axis.name).toBe(b.axis.name);
      expect(a.axis.unit).toBe(b.axis.unit);
      expect(a.axis.values).toHaveLength(b.axis.values.length);
      a.axis.values.forEach((value, i) => expect(Math.abs(value - b.axis.values[i]!)).toBeLessThanOrEqual(1e-12));
      if (outer) outer.forEach((value, row) => {
        for (let i = 0; i < inner; i++) expect(a.voltagesV.outer![row * inner + i]).toBeCloseTo(value, 12);
      });
      let samples = 0;
      let maxAbsoluteError = 0;
      let maxRelativeError = 0;
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [signal, values] of Object.entries(b[field])) {
          expect(a[field][signal]).toHaveLength(values.length);
          values.forEach((value, i) => {
            const error = Math.abs(a[field][signal]![i]! - value);
            samples++;
            maxAbsoluteError = Math.max(maxAbsoluteError, error);
            if (value !== 0) maxRelativeError = Math.max(maxRelativeError, error / Math.abs(value));
            expect(error, `${field}.${signal}[${i}]`).toBeLessThanOrEqual(1e-12 + 1e-9 * Math.abs(value));
          });
        }
      }
      process.stdout.write(`Nested DC parity ${JSON.stringify({ name, points: a.axis.values.length, samples, maxAbsoluteError, maxRelativeError })}\n`);
    } finally { await wasm.close(); }
  });

  it.each([
    ['three sources', '.dc V1 0 1 1 V2 0 1 1 V3 0 1 1', 'dc-nested-sweep'],
    ['TEMP outer', '.dc V1 0 1 1 TEMP 0 100 50', 'dc-nested-sweep'],
    ['step-style outer', '.dc V1 0 1 1 V2 LIST 0 1', 'dc-nested-sweep'],
    ['.step directive', '.dc V1 0 1 1\n.step V2 0 1 1', 'device-or-directive'],
  ])('rejects unsupported %s without fallback', async (_name, control, feature) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(`${diode}\n${control}`), { requestId: 'nested-unsupported' })).toMatchObject({
        ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature } },
      });
    } finally { await wasm.close(); }
  });

  it.each([
    ['missing outer source', `${diode}\n.dc V1 0 1 1 Vmissing 0 1 1`, undefined, 'INVALID_CIRCUIT', { feature: 'dc-source' }],
    ['repeated source', `${diode}\n.dc V1 0 1 1 v1 0 1 1`, undefined, 'INVALID_CIRCUIT', {}],
    ['outer zero step', `${diode}\n.dc V1 0 1 1 V2 0 1 0`, undefined, 'INVALID_CIRCUIT', { feature: 'dc-grid' }],
    ['outer wrong direction', `${diode}\n.dc V1 0 1 1 V2 1 0 1`, undefined, 'INVALID_CIRCUIT', { feature: 'dc-grid' }],
    ['outer waveform', `${diode.replace('V2 outer 0 0', 'V2 outer 0 PULSE(0 1 0 1n 1n 1m 2m)')}\n.dc V1 0 1 1 V2 0 1 1`, undefined, 'UNSUPPORTED_FEATURE', { feature: 'source-waveform' }],
    ['product point budget', `${diode}\n.dc V1 0 1 0.1 V2 0 2 0.5`, { limits: { maxResultPoints: 54 } }, 'RESOURCE_LIMIT', { limit: 'maxResultPoints' }],
  ] as const)('validates %s before solving', async (_name, source, options, code, details) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(source, options), { requestId: 'nested-invalid' })).toMatchObject({
        ok: false, error: { code, details },
      });
    } finally { await wasm.close(); }
  });
});
