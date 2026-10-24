import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored MIT fixtures; no external simulator data.
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});
const circuit = (polarity: string, parameters = '', area = '', gate = -0.5, drain = 5) => {
  const sign = polarity === 'NJF' ? 1 : -1;
  return `VDD supply 0 ${sign * drain}\nVG gate 0 ${sign * gate}\nRL supply drain 1k\nRS source 0 100\nJ1 drain gate source channel${area}\n.model channel ${polarity}(${parameters})`;
};
const fixtures = ['NJF', 'PJF'].flatMap(polarity => [
  { name: `${polarity} defaults OP`, source: `${circuit(polarity)}\n.op` },
  ...[
    { label: 'saturation', gate: -0.5, drain: 5, parameters: 'LEVEL=1 VTO=-2 BETA=100u LAMBDA=0.02 IS=1e-14 N=1 RD=20 RS=30', area: ' 2' },
    { label: 'linear', gate: -0.5, drain: 0.1, parameters: 'VTO=-2 BETA=100u RD=20', area: '' },
    { label: 'cutoff', gate: -4, drain: 5, parameters: 'VTO=-2 BETA=100u RS=30', area: '' },
    { label: 'reverse', gate: -1, drain: -0.5, parameters: 'VTO=-2 BETA=100u RD=20 RS=30', area: ' 0.5' },
    { label: 'forward gate', gate: 0.6, drain: 2, parameters: 'VTO=-2 BETA=100u IS=1e-14 N=1', area: '' },
  ].map(({ label, gate, drain, parameters, area }) => ({
    name: `${polarity} ${label} OP`, source: `${circuit(polarity, parameters, area, gate, drain)}\n.op`,
  })),
  ...['', 'LEVEL=1 VTO=-2 BETA=100u LAMBDA=0.02 IS=1e-14 N=1 RD=20 RS=30'].map(parameters => ({
    name: `${polarity} ${parameters ? 'series/area' : 'defaults'} VDS DC`,
    source: `${circuit(polarity, parameters, parameters ? ' 2' : '')}\n.dc VDD 0 ${polarity === 'NJF' ? 5 : -5} ${polarity === 'NJF' ? 0.25 : -0.25}`,
  })),
]);

describe('bounded JFET WASM OP/DC', () => {
  it.each(fixtures)('matches every core node and source current: $name', async ({ name, source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'jfet-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const reference = await simulateProtocolV1(request(source));
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      expect(a?.type).toBe(b?.type);
      let samples = 0;
      let maxAbsoluteError = 0;
      let maxRelativeError = 0;
      const compare = (value: number, expected: number, label: string, floor: number) => {
        const error = Math.abs(value - expected);
        samples++;
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        maxRelativeError = Math.max(maxRelativeError, error / Math.max(Math.abs(expected), floor));
        expect(error, label).toBeLessThanOrEqual(Math.max(floor, 1e-9 * Math.abs(expected)));
      };
      if (a?.type === 'op' && b?.type === 'op') {
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
          for (const [key, value] of Object.entries(b[field])) {
            compare(a[field][key]!, value, `${field}.${key}`, 1e-15);
          }
        }
      } else if (a?.type === 'dc' && b?.type === 'dc') {
        expect(a.axis).toEqual(b.axis);
        expect(a.axis.values).toHaveLength(21);
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
          for (const [key, values] of Object.entries(b[field])) {
            expect(a[field][key]).toHaveLength(values.length);
            values.forEach((value, index) => compare(a[field][key]![index]!, value, `${field}.${key}[${index}]`, 1e-15));
          }
        }
      } else throw new Error('Expected matching OP/DC results');
      expect(samples).toBeGreaterThan(0);
      process.stdout.write(`JFET parity ${JSON.stringify({ name, samples, maxAbsoluteError, maxRelativeError })}\n`);
    } finally { await wasm.close(); }
  });

  it.each(['LEVEL=2', 'LEVEL=1.1', 'LEVEL=2 LEVEL=1', 'LEVEL=1 LEVEL=2', 'TNOM=27', 'BETA={1}', 'VTO=-2 garbage'])(
    'rejects unsupported model parameter %s', async parameters => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await wasm.simulate(request(`${circuit('NJF', parameters)}\n.op`), { requestId: 'jfet-model' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'jfet-model-parameter' } } });
      } finally { await wasm.close(); }
    },
  );

  it.each([' 0', ' -1', ' nope', ' AREA=2', ' OFF', ' IC=1', ' 2 3', ' 1e999'])(
    'rejects unsupported instance form %s', async area => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await wasm.simulate(request(`${circuit('NJF', '', area)}\n.op`), { requestId: 'jfet-instance' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'jfet-form' } } });
      } finally { await wasm.close(); }
    },
  );

  it.each(['.tran 1u 10u', '.ac dec 1 1 10'].flatMap(analysis => [
    { analysis, source: `${circuit('NJF')}\n${analysis}` },
    { analysis, source: `V1 node 0 1\nR1 node 0 1k\n.model unused PJF\n${analysis}` },
  ]))('accepts default JFET instances or unused models in $analysis', async ({ source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(source), { requestId: 'jfet-analysis' }))
        .toMatchObject({ ok: true, metadata: { backend: 'spice-ts-wasm' } });
    } finally { await wasm.close(); }
  });
});
