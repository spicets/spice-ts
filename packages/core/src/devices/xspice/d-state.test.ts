import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

const fixture = (name: string) => readFileSync(new URL(`../../../../../benchmarks/xspice/d-state/${name}`, import.meta.url), 'utf8');
interface Reference { deckSha256: string; stateSha256: string; samples: number[][] }
const references = JSON.parse(fixture('ngspice47.json')) as Record<string, Reference>;
function interpolate(rows: number[][], at: number, column: number): number {
  let i = 1;
  while (i < rows.length - 1 && rows[i][0] < at) i++;
  const a = rows[i - 1], b = rows[i];
  return a[column] + (b[column] - a[column]) * (at - a[0]) / (b[0] - a[0]);
}
describe('d_state (#1864)', () => {
  it.each(['counter', 'reset'])('%s matches unchanged ngspice-47 bridged waveforms on both time grids', async name => {
    const reference = references[name];
    const deck = fixture(`${name}.cir`), data = fixture('state.txt');
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(hash(deck)).toBe(reference.deckSha256);
    expect(hash(data)).toBe(reference.stateSha256);
    const tran = (await simulate(deck, { resolveInclude: async () => data })).transient!;
    const rows = tran.time.map((time, i) => [time, tran.voltage('out0')[i], tran.voltage('out1')[i]]);
    let maximum = 0;
    for (const [actual, expected] of [[rows, reference.samples], [reference.samples, rows]]) {
      for (const row of actual) for (const col of [1, 2]) maximum = Math.max(maximum, Math.abs(row[col] - interpolate(expected, row[0], col)));
    }
    console.log(`${name}: maxAbs=${maximum}, tsPoints=${rows.length}, ngPoints=${reference.samples.length}`);
    expect(maximum).toBeLessThan(5e-10); // Existing XSPICE digital DAC toBeCloseTo(..., 9).
  });
  it.each(['', '1 -> 0', '0 bad 0s x -> 0', '0 0s 0s 2 -> 0', '0 0s 0s x -> 9', '0 0s 0s x => 0'])('rejects malformed state data %s with a structured error', async data => {
    await expect(simulate(fixture('counter.cir'), { resolveInclude: async () => data }))
      .rejects.toMatchObject({ name: 'InvalidCircuitError', message: expect.stringContaining('d_state') });
  });
  it('allows null data/reset ports and retains all output strengths', async () => {
    const deck = fixture('counter.cir').replace('[enable] clock rst', 'null clock null');
    const data = '0 0s 1r -> 1\n1 Uz 0u -> 2\n2 1s Ur -> 0\n';
    const tran = (await simulate(deck, { resolveInclude: async () => data })).transient!;
    expect(tran.digital('q0').slice(0, 4).map(e => `${e.state}${e.strength}`)).toEqual(['0s', 'Uz', '1s', '0s']);
    expect(tran.digital('q1').slice(0, 4).map(e => `${e.state}${e.strength}`)).toEqual(['1r', '0u', 'Ur', '1r']);
  });
  it('matches wildcard rows before later specific rows and holds without a match', async () => {
    const data = '0 0s 0s X -> 1\n        1 -> 2\n1 1s 0s 0 -> 2\n2 0s 1s x -> 0\n';
    const tran = (await simulate(fixture('counter.cir'), { resolveInclude: async () => data })).transient!;
    expect(tran.digital('q0').slice(0, 3).map(e => e.state)).toEqual(['0', '1', '0']);
    // The second rising clock cannot leave state 1 while enable=1.
    expect(tran.digital('q0')[2].time).toBeGreaterThan(90e-9);
  });
  it('reports missing host file resolution', async () => {
    await expect(simulate(fixture('counter.cir'))).rejects.toMatchObject({ name: 'InvalidCircuitError' });
  });
  it('runs the file-driven two-bit sequencer through ADC/DAC bridges', async () => {
    const tran = (await simulate(fixture('counter.cir'), { resolveInclude: async () => fixture('state.txt') })).transient!;
    expect(tran.digital('q0').map(e => e.state)).toEqual(['0', '1', '0', '1', '0', '1', '0']);
  });
});
