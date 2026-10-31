import { describe, expect, it } from 'vitest';
import { parseTitleless } from '../parser/index.js';
import { simulate } from '../simulate.js';
import { mapProtocolErrorV1, simulateProtocolV1 } from './adapter.js';
import type { SimulationRequestV1 } from './types.js';

const rc = `V1 in 0 PULSE(0 1 0 1u 1u 10u 20u)
R1 in out 1k
C1 out 0 1n`;
const riv = `V1 in 0 0
R1 in out 1k
I1 out 0 1m`;
const request = (source: string): SimulationRequestV1 => ({ apiVersion: '1', input: { format: 'spice', source } });

async function compare(deck: string) {
  const direct = await simulate(parseTitleless(deck));
  const result = await simulateProtocolV1(request(deck));
  const expected = direct.measurements?.map(m => m.status === 'ok' && m.value !== undefined && Number.isFinite(m.value)
    ? { name: m.name, value: m.value }
    : { name: m.name, diagnostic: { code: 'MEASUREMENT_FAILED', message: m.error ?? 'Measurement failed' } });
  return { direct, result, expected };
}

describe('SPICE text measurements in the protocol', () => {
  it('exposes interpolated transient FIND AT voltage and current', async () => {
    const deck = `${rc}\n.tran 0.1u 3u\n.meas tran voltage find v(out) at=1.234u\n.meas tran current find i(v1) at=1.234u`;
    const { direct, result, expected } = await compare(deck);
    expect(direct.measurements?.map(m => m.status)).toEqual(['ok', 'ok']);
    expect(result.analyses[0]).toHaveProperty('measurements', expected);
  });

  it('exposes DC FIND AT values and individual failures in deck order, including duplicate names', async () => {
    const deck = `${riv}\n.dc V1 0 4 1\n.measure dc same find v(out) at=1.5\n.measure dc same find i(v1) at=2.5\n.measure dc missing find v(absent) at=1.5\n.measure dc outside find v(out) at=9`;
    const { direct, result, expected } = await compare(deck);
    expect(direct.measurements?.map(m => m.status)).toEqual(['ok', 'ok', 'failed', 'failed']);
    expect(result.analyses[0]).toHaveProperty('measurements', expected);
  });

  it('associates measurements with each analysis plot, not another directive', async () => {
    const cards = '.meas tran sample find v(out) at=2.5u\n.meas dc sweep find v(out) at=1.5';
    const multi = `${rc}\n.tran 0.1u 2u\n.dc V1 0 4 1\n.tran 0.1u 3u\n${cards}`;
    const result = await simulateProtocolV1(request(multi));
    const first = await compare(`${rc}\n.tran 0.1u 2u\n${cards}`);
    const dc = await compare(`${rc}\n.dc V1 0 4 1\n${cards}`);
    const last = await compare(`${rc}\n.tran 0.1u 3u\n${cards}`);
    expect(result.analyses.map(a => a.type)).toEqual(['tran', 'dc', 'tran']);
    expect(first.expected).not.toEqual(last.expected);
    expect(result.analyses.map(a => 'measurements' in a ? a.measurements : undefined)).toEqual([first.expected, dc.expected, last.expected]);
  });

  it('does not add measurements to decks without supported FIND AT cards', async () => {
    const result = await simulateProtocolV1(request(`${rc}\n.tran 0.1u 3u\n.meas tran peak max v(out)`));
    expect(result.analyses[0]).not.toHaveProperty('measurements');
    const empty = await simulateProtocolV1(request(`${rc}\n.tran 0.1u 3u`));
    expect(empty.analyses[0]).not.toHaveProperty('measurements');
  });

  it('checks cancellation while mapping measurements', async () => {
    const controller = new AbortController();
    const deck = `${rc}\n.tran 0.1u 3u\n.meas tran one find v(out) at=1u\n.meas tran two find v(out) at=2u`;
    let count = 0;
    await expect(simulateProtocolV1(request(deck), { signal: controller.signal, onSafePoint(point) {
      if (point === 'solve:measurement' && ++count === 2) controller.abort();
    } })).rejects.toMatchObject({ apiError: { code: 'CANCELLED', phase: 'solve' } });
    expect(count).toBe(2);
  });

  it('includes measurements in the serialized byte limit', async () => {
    const deck = `${riv}\n.dc V1 0 4 1\n.measure dc voltage find v(out) at=1.5`;
    const baseline = await simulateProtocolV1(request(deck));
    const bytes = new TextEncoder().encode(JSON.stringify(baseline)).length;
    const limited = request(deck);
    limited.options = { limits: { maxSerializedResultBytes: bytes - 1 } };
    try {
      await simulateProtocolV1(limited);
      throw new Error('expected byte limit failure');
    } catch (error) {
      expect(mapProtocolErrorV1(error)).toMatchObject({ code: 'RESOURCE_LIMIT', phase: 'serialize', details: { limit: 'maxSerializedResultBytes' } });
    }
  });
});
