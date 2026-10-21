import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';
import { diodeAcSource } from './test-support/diode-ac.js';

// Original project-authored fixtures, MIT. Use identical netlists and default options.
const model = 'IS=1e-14 N=1.2 RS=10 CJO=20p VJ=0.7 M=0.4 FC=0.5 TT=2n BV=5 IBV=1m';
const clamp = `V1 in 0 2\nR1 in out 1k\nD1 out 0 junction\n.model junction D(${model})`;
const fixtures = [
  ['op', `${clamp}\n.op`],
  ['breakdown DC', `${clamp}\n.dc V1 -8 1 0.1`],
  ['forward AC', diodeAcSource.replace(/IS=1e-14.*TT=2n/, model)],
  ['rectifier transient', `V1 in 0 SIN(0 2 1k)\nR1 in a 100\nD1 a out junction\nR2 out 0 1k\nC1 out 0 100n\n.model junction D(${model})\n.tran 1u 2m`],
] as const;
const request = (source: string) => ({ apiVersion: '1' as const, input: { format: 'spice' as const, source } });

function compareSignals(actual: Record<string, number[]>, reference: Record<string, number[]>, limit: number): number {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(reference).sort());
  let maxDelta = 0;
  for (const [name, values] of Object.entries(reference)) {
    expect(actual[name]).toHaveLength(values.length);
    values.forEach((value, index) => { maxDelta = Math.max(maxDelta, Math.abs(actual[name]![index]! - value)); });
  }
  expect(maxDelta).toBeLessThanOrEqual(limit);
  return maxDelta;
}

// Compare complex voltages/currents, not phase angles in voltage/current units.
function cartesian(signals: Record<string, { magnitude: number; phaseDegrees: number }[]>): Record<string, number[]> {
  return Object.fromEntries(Object.entries(signals).map(([name, values]) => [name, values.flatMap(value => {
    const angle = value.phaseDegrees * Math.PI / 180;
    return [value.magnitude * Math.cos(angle), value.magnitude * Math.sin(angle)];
  })]));
}

describe('WASM diode charge and breakdown parameters', () => {
  it.each(fixtures)('accepts CJO/VJ/M/FC/TT/BV/IBV and matches core: %s', async (name, source) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const result = await engine.simulate(request(source), { requestId: name });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.metadata.backend).toBe('spice-ts-wasm');
      const a = result.data.analyses[0];
      const b = (await simulateProtocolV1(request(source))).analyses[0];
      let voltageDelta: number;
      let currentDelta: number;
      let points: number;
      if (a?.type === 'ac' && b?.type === 'ac') {
        expect(a.frequencyHz).toEqual(b.frequencyHz);
        points = a.frequencyHz.length;
        voltageDelta = compareSignals(cartesian(a.voltagePhasors), cartesian(b.voltagePhasors), 1e-9);
        currentDelta = compareSignals(cartesian(a.currentPhasors), cartesian(b.currentPhasors), 1e-12);
      } else if ((a?.type === 'dc' && b?.type === 'dc') || (a?.type === 'tran' && b?.type === 'tran')) {
        if (a.type === 'dc' && b.type === 'dc') {
          // Core accumulates the step; WASM evaluates start + index * step.
          compareSignals({ axis: a.axis.values }, { axis: b.axis.values }, 1e-12);
          points = a.axis.values.length;
          // The sweep must actually reach breakdown, not merely accept BV.
          expect(a.voltagesV.out![0]).toBeLessThan(-5);
          expect(Math.abs(a.currentsA.V1![0]!)).toBeGreaterThan(1e-3);
        } else if (a.type === 'tran' && b.type === 'tran') {
          expect(a.timeS).toEqual(b.timeS);
          points = a.timeS.length;
        } else throw new Error('Mismatched analysis');
        voltageDelta = compareSignals(a.voltagesV, b.voltagesV, 1e-9);
        currentDelta = compareSignals(a.currentsA, b.currentsA, 1e-12);
      } else if (a?.type === 'op' && b?.type === 'op') {
        points = 1;
        const arrays = (signals: Record<string, number>) => Object.fromEntries(Object.entries(signals).map(([key, value]) => [key, [value]]));
        voltageDelta = compareSignals(arrays(a.voltagesV), arrays(b.voltagesV), 1e-9);
        currentDelta = compareSignals(arrays(a.currentsA), arrays(b.currentsA), 1e-12);
      } else throw new Error('Mismatched analysis');
      process.stdout.write(`${name}: points=${points}, max voltage delta=${voltageDelta} V, max current delta=${currentDelta} A\n`);
    } finally { await engine.close(); }
  });

  it.each(['.op', '.dc V1 -8 1 0.1', '.ac lin 2 1 10', '.tran 1u 10u'])('names unsupported diode parameters for %s', async analysis => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      for (const parameter of ['IKF', 'CJSW', 'XTI', 'XCJO']) {
        const source = `${clamp.replace('IBV=1m)', `IBV=1m ${parameter.toLowerCase()}=1p)`)}\n${analysis}`;
        expect(await engine.simulate(request(source), { requestId: parameter })).toMatchObject({
          ok: false, error: { code: 'UNSUPPORTED_FEATURE', phase: 'validation', details: { feature: `diode-model-parameter:${parameter}` } },
        });
      }
    } finally { await engine.close(); }
  });
});
