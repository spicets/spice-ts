// Original project-authored fixtures and test source, MIT.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source }, options: { reltol: 1e-10, abstol: 1e-18, vntol: 1e-12 } });
const diode = 'V1 in 0 2\nR1 in out 1k\nD1 out 0 junction\n.model junction D(IS=1e-14 N=1.2 RS=10)';

async function parity(source: string, defaults = false): Promise<void> {
  const input = request(source);
  const simulationRequest = defaults ? { apiVersion: input.apiVersion, input: input.input } : input;
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    const response = await engine.simulate(simulationRequest, { requestId: 'temperature' });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.metadata.backend).toBe('spice-ts-wasm');
    const actual = response.data.analyses[0];
    const reference = (await simulateProtocolV1(simulationRequest)).analyses[0];
    let maximum = 0;
    for (const field of ['voltagesV', 'currentsA'] as const) {
      if ((actual?.type !== 'op' && actual?.type !== 'dc') || (reference?.type !== 'op' && reference?.type !== 'dc')) throw new Error('Expected OP/DC');
      expect(actual.type).toBe(reference.type);
      expect(Object.keys(actual[field]).sort()).toEqual(Object.keys(reference[field]).sort());
      for (const [name, signal] of Object.entries(reference[field])) {
        const expected: number[] = typeof signal === 'number' ? [signal] : signal;
        const observed = actual[field][name]!;
        const values = typeof observed === 'number' ? [observed] : observed;
        expect(values).toHaveLength(expected.length);
        expected.forEach((value, index) => {
          // Pointwise relative error; zero reference samples must match exactly.
          const delta = Math.abs(values[index]! - value);
          const error = value === 0 ? (delta === 0 ? 0 : Infinity) : delta / Math.abs(value);
          maximum = Math.max(maximum, error);
        });
      }
    }
    expect(maximum).toBeLessThanOrEqual(1e-9);
    process.stdout.write(`temperature parity maxRelativeError=${maximum}\n`);
  } finally { await engine.close(); }
}

describe('WASM circuit temperature OP/DC', () => {
  it.each([false, true])('matches reverse-leakage DC samples at TEMP127/TNOM27 (default options=%s)', async defaults => {
    await parity(`${diode}\n.options TEMP=127 TNOM=27\n.dc V1 -2 2 0.5`, defaults);
  });

  it('matches core diode OP at 127 C', async () => {
    await parity(`${diode}\n.temp 127\n.op`);
  });

  it.each([-40, 27, 127])('matches diode OP/DC and model TNOM50 at %s C', async temperature => {
    for (const control of ['.op', '.dc V1 -2 2 0.5']) {
      for (const tnom of [27, 50]) {
        await parity(`${diode.replace('RS=10)', `RS=10 EG=1.11 XTI=3 TNOM=${tnom} BV=5 IBV=1m TBV1=0.00013)`)}\n.options TEMP=${temperature}\n${control}`);
      }
    }
  });

  it.each([-40, 27, 127])('matches circuit TNOM50 diode OP/DC at %s C', async temperature => {
    for (const control of ['.op', '.dc V1 -2 2 0.5']) {
      await parity(`${diode}\n.options TEMP=${temperature} TNOM=50\n${control}`);
    }
  });

  it('uses circuit TNOM as fallback and preserves model overrides', async () => {
    const implicit = `${diode}\n.options TEMP=127 TNOM=50\n.op`;
    const explicit = implicit.replace('RS=10)', 'RS=10 TNOM=50)');
    expect((await simulateProtocolV1(request(implicit))).analyses).toEqual((await simulateProtocolV1(request(explicit))).analyses);
    const resistor = 'V1 in 0 2\nR1 in out 1k TC1=0.001 TC2=1u\nR2 out 0 2k\n.options TEMP=127 TNOM=50\n.op';
    await parity(resistor);
    expect((await simulateProtocolV1(request(resistor))).analyses).toEqual((await simulateProtocolV1(request(resistor.replace('TC2=1u', 'TC2=1u TNOM=50')))).analyses);
    const override = explicit.replace('TNOM=50)', 'TNOM=27)');
    expect((await simulateProtocolV1(request(override))).analyses).toEqual((await simulateProtocolV1(request(override.replace('TEMP=127 TNOM=50', 'TEMP=127 TNOM=27')))).analyses);
  });

  it.each([-40, 27, 127])('matches temperature-dependent breakdown at %s C', async temperature => {
    await parity(`V1 out 0 -6\nD1 out 0 dm\n.model dm D(IS=1e-14 BV=5 IBV=1m TBV1=0.001)\n.temp ${temperature}\n.op`);
  });

  it.each([-40, 27, 127])('matches resistor instance/model TC1/TC2 at %s C', async temperature => {
    for (const control of ['.op', '.dc V1 1 3 0.5']) {
      await parity(`V1 in 0 2\nR1 in out 1k TC1=0.001 TC2=1u TNOM=50\nR2 out 0 thermal 2k\n.model thermal R(TC1=0.002 TC2=2u TNOM=50)\n.options TEMP=${temperature} TNOM=50\n${control}`);
    }
  });

  it.each([
    'J1 out in 0 model\n.model model NJF(VTO=-2 BETA=1m)',
  ])('matches nonnominal JFET temperature: %s', async device => {
    for (const temperature of ['.temp -40', '.options TEMP=127', '.options TNOM=50']) {
      for (const control of ['.op', '.dc V1 1 2 0.5']) {
        await parity(`V1 in 0 1\nR1 out 0 1k\n${device}\n${temperature}\n${control}`);
      }
    }
  });

  it.each(['.ac lin 2 1 10', '.tran 1u 10u'])('rejects temperature outside OP/DC: %s', async control => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const temperature of ['.temp 127', '.options TEMP=27 TNOM=27']) {
        expect(await engine.simulate(request(`${diode}\n${temperature}\n${control}`), { requestId: 'guard' })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'circuit-temperature' } },
        });
      }
    } finally { await engine.close(); }
  });

  it('uses effective parsed temperatures after overrides and hierarchy expansion', async () => {
    await parity('V1 in 0 2\nX1 in out divider\nR2 out 0 1k\n.subckt divider a b\nR1 a b 1k TC1=0.001\n.ends\n.options TEMP=-40\n.temp 127\n.op');
    await parity('V1 in 0 1\nR1 out 0 1k\nQ1 out in 0 qmod\n.model qmod NPN(IS=1e-15 BF=100)\n.options TEMP=127 TNOM=50\n.options TEMP=27 TNOM=27\n.op');
  });

  it.each(['.temp -40 127', '.options TEMP=127 RELTOL=1m', '.options TEMP={T}', '.options TEMP=127 junk', '.model bad R(TC1=1m TCE=1)', '.model bad D(IKF=1m)'])('preserves strict validation: %s', async card => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(`${diode}\n${card}\n.op`), { requestId: 'strict' })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
    } finally { await engine.close(); }
  });
});
