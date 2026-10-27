import { afterAll, describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored fixtures; reference is the real core protocol path.
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});
const circuit = (control = 0, vh = 0.2, state = '', model = `VT=1 VH=${vh} RON=1 ROFF=1e6`) =>
  `VDD vdd 0 5\nV1 c 0 DC ${control}\nS1 a 0 c 0 sw1${state ? ` ${state}` : ''}\nR1 vdd a 1k\n.model sw1 SW(${model})`;
const fixtures = [
  ...[0, 2, 0.8, 1, 1.2].flatMap(control => ['', 'ON', 'OFF'].map(state => ({
    name: `positive VH OP ${control} ${state || 'default'}`, source: `${circuit(control, 0.2, state)}\n.op`,
  }))),
  ...[0, -0.2].flatMap(vh => [0, 0.8, 1, 1.2, 2].map(control => ({
    name: `VH=${vh} OP ${control}`, source: `${circuit(control, vh)}\n.op`,
  }))),
  ...[0.2, 0, -0.2].flatMap(vh => [false, true].map(descending => ({
    name: `VH=${vh} ${descending ? 'descending' : 'ascending'} DC`,
    source: `${circuit(0, vh)}\n.dc V1 ${descending ? '2 0 -0.1' : '0 2 0.1'}`,
  }))),
  ...['ON', 'OFF'].map(state => ({
    name: `in-window DC ${state}`, source: `${circuit(1, 0.2, state)}\n.dc V1 0.9 1.1 0.1`,
  })),
  { name: 'default SW model', source: `${circuit(2, 0, '', '')}\n.op` },
  { name: 'numeric suffixes and case', source: `${circuit(2, 0, '', 'vt=1 vh=200m ron=1 roff=1meg')}\n.op` },
  ...[0, 2].map(control => ({
    name: `differential control ${control}`,
    source: `${circuit(control + 3).replace('S1 a 0 c 0', 'S1 a 0 c cn')}\nVN cn 0 3\n.op`,
  })),
  { name: 'two switches init/float', source: `${circuit(2)}\nS2 b 0 c 0 sw1\nR2 vdd b 2k\n.op` },
];
const metrics = { fixtures: 0, samples: 0, maxAbsoluteError: 0, maxRelativeError: 0 };

describe('bounded voltage-controlled SW WASM OP/DC', () => {
  afterAll(() => process.stdout.write(`SW parity ${JSON.stringify(metrics)}\n`));
  it.each(fixtures)('matches every core node and source current: $name', async ({ source }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(request(source), { requestId: 'switch-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const reference = await simulateProtocolV1(request(source));
      const a = actual.data.analyses[0];
      const b = reference.analyses[0];
      expect(a?.type).toBe(b?.type);
      const compare = (value: number, expected: number, label: string) => {
        const error = Math.abs(value - expected);
        metrics.samples++;
        metrics.maxAbsoluteError = Math.max(metrics.maxAbsoluteError, error);
        metrics.maxRelativeError = Math.max(metrics.maxRelativeError, error / Math.max(Math.abs(expected), 1e-12));
        expect(error, label).toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
      };
      if (a?.type === 'op' && b?.type === 'op') {
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
          for (const [key, value] of Object.entries(b[field])) compare(a[field][key]!, value, `${field}.${key}`);
        }
      } else if (a?.type === 'dc' && b?.type === 'dc') {
        expect(a.axis).toEqual(b.axis);
        for (const field of ['voltagesV', 'currentsA'] as const) {
          expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
          for (const [key, values] of Object.entries(b[field])) {
            expect(a[field][key]).toHaveLength(values.length);
            values.forEach((value, index) => compare(a[field][key]![index]!, value, `${field}.${key}[${index}]`));
          }
        }
      } else throw new Error('Expected matching OP/DC results');
      metrics.fixtures++;
    } finally { await wasm.close(); }
  });

  it.each(['.op', '.dc V1 0 2 1'].flatMap(analysis =>
    ['RON', 'ROFF'].flatMap(parameter =>
      ['0', '1e-999', '1e-308mil', '1e309'].map(value => ({ analysis, parameter, value }))),
  ))('rejects invalid resolved $parameter=$value for $analysis', async ({ analysis, parameter, value }) => {
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const control = parameter === 'RON' ? 2 : 0;
      const source = `${circuit(control, 0.2, '', `VT=1 VH=0.2 ${parameter}=${value}`)}\n${analysis}`;
      expect(await wasm.simulate(request(source), { requestId: 'switch-resistance' }))
        .toMatchObject({ ok: false, error: {
          code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: 'switch-model-parameter' },
        } });
    } finally { await wasm.close(); }
  });

  it.each(['VON=1', 'VOFF=0', 'IT=1', 'LEVEL=1', 'VT={1}', 'VH=nope', 'RON=1 garbage', 'ROFF=1e999'])(
    'rejects unsupported SW model parameter %s', async model => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await wasm.simulate(request(`${circuit(0, 0.2, '', model)}\n.op`), { requestId: 'switch-model' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'switch-model-parameter' } } });
      } finally { await wasm.close(); }
    },
  );
  it.each(['S1 a 0 c sw1', 'S1 a 0 c 0 sw1 MAYBE', 'S1 a 0 c 0 sw1 ON OFF', 'S1 a 0 c 0 sw1 IC=1', 'S1 a 0 c 0 sw1 2'])(
    'rejects unsupported instance %s', async instance => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const source = `${circuit().replace('S1 a 0 c 0 sw1', instance)}\n.op`;
        expect(await wasm.simulate(request(source), { requestId: 'switch-instance' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'switch-form' } } });
      } finally { await wasm.close(); }
    },
  );
});
