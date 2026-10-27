import { afterAll, describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored fixtures. Positive VCTRL drives positive VSENSE current.
const circuit = (control = 'DC 2', model = 'IT=1m IH=200u RON=10 ROFF=1gig', state = '') => `VDD supply 0 5
VCTRL control 0 ${control}
RCTRL control sense 1k
VSENSE sense 0 0
W1 supply out VSENSE sw ${state}
R1 out 0 1k
.model sw CSW(${model})`;
const request = (source: string): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice', source } });
const metrics = { fixtures: 0, samples: 0, maxAbsoluteError: 0 };

// The same tolerance as SW OP/DC; transient voltages use SW's absolute 1e-9 bound.
function compare(actual: number, expected: number, transient = false) {
  const error = Math.abs(actual - expected);
  metrics.samples++;
  metrics.maxAbsoluteError = Math.max(metrics.maxAbsoluteError, error);
  expect(error).toBeLessThanOrEqual(transient ? 1e-9 : Math.max(1e-12, 1e-9 * Math.abs(expected)));
}

describe('WASM current-controlled CSW', () => {
  afterAll(() => process.stdout.write(`CSW parity ${JSON.stringify(metrics)}\n`));
  it.each([0, 2])('matches static OP at control %s V', async control => {
    const input = request(`${circuit(`DC ${control}`)}\n.op`);
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(input, { requestId: 'csw-op' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'op' || b?.type !== 'op') throw new Error('Expected OP');
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [name, value] of Object.entries(b[field])) compare(a[field][name]!, value);
      }
      expect(a.voltagesV.out!).toBe(control ? 5 * 1000 / 1010 : 5 * 1000 / (1e9 + 1000));
      metrics.fixtures++;
    } finally { await wasm.close(); }
  });

  it.each([false, true])('matches DC hysteresis sweep descending=%s', async descending => {
    const input = request(`${circuit()}\n.dc VCTRL ${descending ? '2 0 -0.1' : '0 2 0.1'}`);
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(input, { requestId: 'csw-dc' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'dc' || b?.type !== 'dc') throw new Error('Expected DC');
      expect(a.axis).toEqual(b.axis);
      for (const field of ['voltagesV', 'currentsA'] as const) {
        expect(Object.keys(a[field]).sort()).toEqual(Object.keys(b[field]).sort());
        for (const [name, values] of Object.entries(b[field])) {
          expect(a[field][name]).toHaveLength(values.length);
          values.forEach((value, i) => compare(a[field][name]![i]!, value));
        }
      }
      metrics.fixtures++;
    } finally { await wasm.close(); }
  });

  it('matches transient hysteresis with RC history through both transitions', async () => {
    const input = request(`${circuit('PULSE(0 2 1u 2u 2u 4u 12u)')}\nC1 out 0 1n\n.tran 100n 24u`);
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await wasm.simulate(input, { requestId: 'csw-tran' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      const a = actual.data.analyses[0];
      const b = (await simulateProtocolV1(input)).analyses[0];
      if (a?.type !== 'tran' || b?.type !== 'tran') throw new Error('Expected TRAN');
      expect(a.timeS).toEqual(b.timeS);
      expect(Object.keys(a.voltagesV).sort()).toEqual(Object.keys(b.voltagesV).sort());
      for (const [node, values] of Object.entries(b.voltagesV)) {
        expect(a.voltagesV[node]).toHaveLength(values.length);
        values.forEach((value, i) => compare(a.voltagesV[node]![i]!, value, true));
      }
      const output = a.voltagesV.out!;
      const control = a.voltagesV.control!;
      const band = (i: number) => control[i]! > 0.9 && control[i]! < 1.1;
      const rising = a.timeS.map((_, i) => i).filter(i => band(i) && a.timeS[i]! < 3e-6);
      const falling = a.timeS.map((_, i) => i).filter(i => band(i) && a.timeS[i]! > 7e-6 && a.timeS[i]! < 9e-6);
      expect(rising.length).toBeGreaterThan(0);
      expect(falling.length).toBeGreaterThan(0);
      expect(rising.every(i => output[i]! < 0.01)).toBe(true);
      expect(falling.every(i => output[i]! > 4)).toBe(true);
      expect(output.some((v, i) => v < 0.1 && a.timeS[i]! > 11e-6 && a.timeS[i]! < 13e-6)).toBe(true);
      metrics.fixtures++;
    } finally { await wasm.close(); }
  });

  it.each(['VT=1', 'VH=1', 'LEVEL=1', 'IT={1}', 'IH=nope', 'IT=1e309', 'RON=1e-999', 'ROFF=1e-308mil', 'RON=0', 'ROFF=1e999', 'RON=1 garbage'])(
    'rejects unsupported model %s', async model => {
      const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        expect(await wasm.simulate(request(`${circuit('DC 0', model)}\n.op`), { requestId: 'csw-reject' }))
          .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'switch-model-parameter' } } });
      } finally { await wasm.close(); }
    },
  );
  it.each([false, true])('rejects AC with model first=%s', async modelFirst => {
    const cards = circuit().split('\n');
    if (modelFirst) cards.unshift(cards.pop()!);
    const wasm = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await wasm.simulate(request(`${cards.join('\n')}\n.ac dec 1 1 10`), { requestId: 'csw-ac' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'switch-analysis' } } });
    } finally { await wasm.close(); }
  });
});
