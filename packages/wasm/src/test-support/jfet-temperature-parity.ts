// Original project-authored MIT common-source fixtures; core parity, not ngspice data.
import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import { createSpiceEngine } from '../index.js';

const temperatures = ['', '.temp 27', '.options TNOM=27', '.options TEMP=75 TNOM=27', '.options TEMP=-20 TNOM=27'];
const laws = ['TCV=0.002 BEX=-1.5', 'VTOTC=-0.003 BETATCE=-0.5'];

function circuit(polarity: string, analysis: 'ac' | 'tran', law: string): string {
  const sign = polarity === 'NJF' ? 1 : -1;
  const drive = analysis === 'ac' ? `DC ${sign * -0.5} AC 1` : `SIN(${sign * -0.5} ${sign * 0.05} 5Meg)`;
  return `VDD supply 0 ${sign * 5}
VG input 0 ${drive}
RG input gate 1k
RL supply out 1k
RE source 0 100
J1 out gate source channel 2
.model channel ${polarity}(LEVEL=1 VTO=-2 BETA=100u LAMBDA=0.02 IS=1e-14 N=1 RD=20 RS=30 CGS=10p CGD=5p PB=0.8 FC=0.4 ${law})
${analysis === 'ac' ? '.ac dec 10 1 1G' : '.tran 1n 200n'}`;
}

// Compare on the actual grid without requiring equal adaptive timesteps.
// Reject out-of-domain queries rather than extrapolating or clamping endpoints.
function interpolate(times: number[], values: number[], queries: number[]): number[] {
  expect(times.length).toBeGreaterThan(2);
  expect(values).toHaveLength(times.length);
  expect(queries.length).toBeGreaterThan(2);
  times.forEach((time, index) => {
    expect(Number.isFinite(time)).toBe(true);
    expect(Number.isFinite(values[index]!)).toBe(true);
    if (index > 0) expect(time).toBeGreaterThan(times[index - 1]!);
  });
  let left = 0;
  return queries.map((time, index) => {
    expect(Number.isFinite(time)).toBe(true);
    expect(time).toBeGreaterThanOrEqual(times[0]!);
    expect(time).toBeLessThanOrEqual(times.at(-1)!);
    if (index > 0) expect(time).toBeGreaterThan(queries[index - 1]!);
    while (left < times.length - 2 && times[left + 1]! < time) left++;
    const fraction = (time - times[left]!) / (times[left + 1]! - times[left]!);
    return values[left]! + fraction * (values[left + 1]! - values[left]!);
  });
}

export function describeJfetTemperatureParity(polarity: 'NJF' | 'PJF', analysis: 'ac' | 'tran'): void {
  const cases = temperatures.flatMap(temperature =>
    (temperature ? ['', ...laws] : ['']).map(law => ({ polarity, temperature, law, analysis })),
  );
  describe('WASM JFET TEMP/TNOM dynamic parity', () => {
    it.each(cases)('$polarity $analysis $temperature $law matches core v(out)', async ({ polarity, analysis, temperature, law }) => {
      const input = {
        apiVersion: '1' as const,
        input: { format: 'spice' as const, source: `${circuit(polarity, analysis, law)}\n${temperature}` },
      };
      const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
      try {
        const response = await engine.simulate(input, { requestId: 'jfet-temperature-dynamic' });
        expect(response.ok, JSON.stringify(response)).toBe(true);
        if (!response.ok) throw new Error(response.error.message);
        expect(response.metadata.backend).toBe('spice-ts-wasm');
        const actual = response.data.analyses[0];
        const expected = (await simulateProtocolV1(input)).analyses[0];
        const context = { polarity, analysis, temperature: temperature || 'default', law };
        if (analysis === 'ac' && actual?.type === 'ac' && expected?.type === 'ac') {
          expect(actual.frequencyHz).toEqual(expected.frequencyHz);
          expect(actual.frequencyHz.length).toBeGreaterThan(2);
          const output = actual.voltagePhasors.out!;
          expect(output).toHaveLength(actual.frequencyHz.length);
          expect(expected.voltagePhasors.out).toHaveLength(expected.frequencyHz.length);
          const lowFrequencyGain = output[0]!.magnitude;
          const highFrequencyGain = output.at(-1)!.magnitude;
          expect(lowFrequencyGain).toBeGreaterThan(0.1);
          expect(highFrequencyGain).toBeLessThan(lowFrequencyGain / 4);
          let maxRelativeError = 0;
          expected.voltagePhasors.out!.forEach((value, index) => {
            expect(value.magnitude).toBeGreaterThan(0);
            const error = Math.abs(output[index]!.magnitude - value.magnitude) / value.magnitude;
            maxRelativeError = Math.max(maxRelativeError, error);
          });
          process.stdout.write(`${JSON.stringify({ ...context, points: output.length, lowFrequencyGain, highFrequencyGain, maxRelativeError })}\n`);
          expect(maxRelativeError).toBeLessThanOrEqual(1e-9);
        } else if (analysis === 'tran' && actual?.type === 'tran' && expected?.type === 'tran') {
          const output = actual.voltagesV.out!;
          expect(output).toHaveLength(actual.timeS.length);
          expect(actual.timeS[0]).toBe(0);
          expect(expected.timeS[0]).toBe(0);
          expect(actual.timeS.at(-1)!).toBeGreaterThanOrEqual(199e-9);
          const reference = interpolate(expected.timeS, expected.voltagesV.out!, actual.timeS);
          const swingV = Math.max(...output) - Math.min(...output);
          expect(swingV).toBeGreaterThan(0.001);
          const maxAbsoluteErrorV = Math.max(...output.map((value, index) => Math.abs(value - reference[index]!)));
          process.stdout.write(`${JSON.stringify({ ...context, actualPoints: output.length, referencePoints: expected.timeS.length, swingV, maxAbsoluteErrorV })}\n`);
          expect(maxAbsoluteErrorV).toBeLessThanOrEqual(1e-9);
        } else {
          throw new Error(`Expected ${analysis} results`);
        }
      } finally { await engine.close(); }
    });
  });
}
