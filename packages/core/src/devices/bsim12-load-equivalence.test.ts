import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { simulate } from '../index.js';
import { ClassicBsimMosfet } from './bsim12-load.js';

// Full sweep outputs captured before removing per-load closures (#1134).
// Keep all voltage/current bits, not just the ngspice reference sample points.
it.each([
  ['bsim1tst', '29ab73c06131c74e5abacaedb78f14d1879894c51c426e1e249bd25cca48f385'],
  ['bsim2tst', 'ec1071b47b54077bc95ac2e05c4acbbc3768de7e61876ad3f06f4c5f1341524c'],
])('%s retains every sweep output bit', async (fixture, hash) => {
  const deck = readFileSync(new URL(`../../../../benchmarks/corpus/classic/fixtures/spice3f5/${fixture}.cir`, import.meta.url), 'utf8');
  const sweep = (await simulate(deck)).dcSweep!;
  const data = JSON.stringify([sweep.sweepValues, [...sweep.voltages], [...sweep.currents]],
    (_, value) => ArrayBuffer.isView(value) ? Array.from(value as Float64Array) : value);
  expect(createHash('sha256').update(data).digest('hex')).toBe(hash);
});

it('binds BSIM1 sweep slots once and releases them after the sweep', async () => {
  const bind = vi.spyOn(ClassicBsimMosfet.prototype, 'bindDCSweepStamp');
  const deck = readFileSync(new URL('../../../../benchmarks/corpus/classic/fixtures/spice3f5/bsim1tst.cir', import.meta.url), 'utf8');
  try {
    await simulate(deck);
    const bindings = bind.mock.calls.filter(call => call[0] !== undefined);
    const releases = bind.mock.calls.filter(call => call[0] === undefined);
    expect(bindings.length).toBeGreaterThan(0);
    expect(releases.length).toBe(bindings.length);
  } finally {
    bind.mockRestore();
  }
});

it.each([false, true])('matches generic stamps through inverse mode (aliased terminals: %s)', async alias => {
  let deck = readFileSync(new URL('../../../../benchmarks/bsim12-657/fixtures/bsim1-output-inverse.cir', import.meta.url), 'utf8');
  // Remove series nodes, exercise the multiplier and optionally tie gate to drain.
  deck = deck.replace('RSH = 35.0', 'RSH = 0').replaceAll(' L=', ' M=3 L=');
  if (alias) deck = deck.replace('MN1 13 2 0 4', 'MN1 13 13 0 0');
  const fast = (await simulate(deck)).dcSweep!;
  const bind = vi.spyOn(ClassicBsimMosfet.prototype, 'bindDCSweepStamp').mockImplementation(() => {});
  try {
    const generic = (await simulate(deck)).dcSweep!;
    expect(fast.sweepValues).toEqual(generic.sweepValues);
    expect([...fast.voltages]).toEqual([...generic.voltages]);
    expect([...fast.currents]).toEqual([...generic.currents]);
  } finally {
    bind.mockRestore();
  }
});
