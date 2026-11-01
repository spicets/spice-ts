import { describe, expect, it } from 'vitest';
import { parseTitleless, simulate } from '@spice-ts/core';
import { createSpiceEngine } from './index.js';

const base = `V1 in 0 0
I1 out 0 0
R1 in out 1k
R2 out 0 1k
.dc V1 0 2 1`;
const run = async (source: string, limits?: { maxSerializedResultBytes?: number }) => {
  const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
  try {
    return await engine.simulate({ apiVersion: '1', input: { format: 'spice', source }, options: { limits } }, { requestId: 'dc-measure' });
  } finally { await engine.close(); }
};

describe('WASM DC measurements', () => {
  it('matches the core text evaluator for sampled, interpolated and failed measurements', async () => {
    const source = `${base}
.meas dc sample FIND v(out) AT=1
.MEASURE DC midpoint find V(OUT) at=500m
.meas dc current find i(V1) at=1.5
.meas dc repeated find v(out) at=0
.meas dc repeated find v(out) at=2
.meas dc outside find v(out) at=3
.meas dc missing find v(nope) at=1`;
    const core = await simulate(parseTitleless(source));
    const result = await run(source);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || result.data.analyses[0]?.type !== 'dc') throw new Error('expected DC');
    expect(result.metadata.backend).toBe('spice-ts-wasm');
    const actual = result.data.analyses[0].measurements!;
    expect(actual).toHaveLength(core.measurements!.length);
    core.measurements!.forEach((m, i) => {
      expect(actual[i]!.name).toBe(m.name);
      if (m.status === 'ok') {
        expect(actual[i]).toHaveProperty('value');
        expect((actual[i] as { value: number }).value).toBeCloseTo(m.value!, 12);
      } else expect(actual[i]).toMatchObject({ diagnostic: { code: 'MEASUREMENT_FAILED', message: m.error } });
    });
    expect(actual[0]).toMatchObject({ name: 'sample', value: 0.5, unit: 'V' });
    expect(actual[2]).toMatchObject({ name: 'current', unit: 'A' });
  });

  it('matches core for a current-source sweep', async () => {
    const source = `${base.replace('.dc V1 0 2 1', '.dc I1 0 2m 1m')}\n.meas dc voltage find v(out) at=500u`;
    const core = await simulate(parseTitleless(source));
    const result = await run(source);
    if (!result.ok || result.data.analyses[0]?.type !== 'dc') throw new Error(JSON.stringify(result));
    const measurement = result.data.analyses[0].measurements![0]!;
    expect(measurement).toHaveProperty('value');
    expect((measurement as { value: number }).value).toBeCloseTo(core.measurements![0]!.value!, 12);
  });

  it.each([
    '.meas dc x find v(out) at=1 extra', '.meas dc x find v(out) at=1e999',
    '.meas dc x when v(out)=1', '.meas dc x avg v(out) from=0 to=1',
    '.meas ac x find v(out) at=1', '.meas dc x find v(out)+v(in) at=1',
  ])('rejects unsupported form %s', async card => {
    expect(await run(`${base}\n${card}`)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
  });

  it('rejects nested sweeps and capacitor measurement decks', async () => {
    const card = '.meas dc x find v(out) at=1';
    for (const source of [base.replace('.dc V1 0 2 1', '.dc V1 0 2 1 I1 0 1 1'), `${base}\nC1 out 0 1u`]) {
      expect(await run(`${source}\n${card}`)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE' } });
    }
  });

  it('honours cancellation for a DC measurement request', async () => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const pending = engine.simulate({ apiVersion: '1', input: { format: 'spice', source: `${base}\n.meas dc x find v(out) at=1` } }, { requestId: 'cancel-dc' });
      expect(await engine.cancel('cancel-dc')).toMatchObject({ status: 'cancelling' });
      expect(await pending).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    } finally { await engine.close(); }
  });

  it('bounds DC point count before measurement work', async () => {
    const source = `${base.replace('.dc V1 0 2 1', '.dc V1 0 4096 1')}\n.meas dc x find v(out) at=1`;
    expect(await run(source)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxResultPoints' } } });
  });

  it('limits measurement count and serialized results', async () => {
    const card = '.meas dc sample find v(out) at=1';
    const many = Array.from({ length: 129 }, (_, i) => `.meas dc m${i} find v(out) at=1`).join('\n');
    expect(await run(`${base}\n${many}`)).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxMeasurements' } } });
    const plain = await run(base);
    if (!plain.ok) throw new Error('expected DC');
    const bytes = new TextEncoder().encode(JSON.stringify(plain.data)).length;
    expect(await run(`${base}\n${card}`, { maxSerializedResultBytes: bytes })).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxSerializedResultBytes' } } });
  });
});
