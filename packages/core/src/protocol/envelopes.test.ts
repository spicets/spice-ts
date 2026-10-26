import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapProtocolErrorV1 } from './adapter.js';
import { executeProtocolV1, protocolCapabilitiesV1 } from './envelopes.js';
import type { ProtocolTerminalEnvelopeV1, SimulationRequestV1 } from './types.js';

const divider = (analyses = '.op'): SimulationRequestV1 => ({
  apiVersion: '1',
  input: { format: 'spice', source: `V1 in 0 2\nR1 in out 1k\nR2 out 0 1k\n${analyses}` },
});

function scriptedClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function canonicalHash(value: unknown): string {
  const canonical = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(canonical);
    if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
    }
    return Object.is(current, -0) ? 0 : current;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function assertWireSafe(value: unknown, permitNativeFormat = false): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  const serialized = permitNativeFormat
    ? JSON.stringify(value).replaceAll('input:spice-ts', 'input:native').replaceAll('"spice-ts"', '"native"')
    : JSON.stringify(value);
  expect(serialized).not.toMatch(/\bspice-ts\b(?!-(?:js|wasm))/);
}

function crossWorkerBoundary(terminal: ProtocolTerminalEnvelopeV1): ProtocolTerminalEnvelopeV1 {
  const crossed = structuredClone(terminal);
  return crossed.ok ? crossed : { ...crossed, error: mapProtocolErrorV1(crossed.error) };
}

async function cancelledSecondAnalysis(): Promise<ProtocolTerminalEnvelopeV1> {
  const controller = new AbortController();
  let serializations = 0;
  return executeProtocolV1(divider('.op\n.op'), {
    requestId: 'req-cancelled',
    now: scriptedClock(10, 10, 14),
    signal: controller.signal,
    onSafePoint(safePoint) {
      if (safePoint === 'serialize:analysis' && ++serializations === 1) controller.abort();
    },
  });
}

describe('protocol-v1 capability and terminal envelopes', () => {
  it('publishes a stable, engine-neutral capability envelope', () => {
    const capabilities = protocolCapabilitiesV1();

    expect(capabilities.analyses.map(entry => entry.id)).toEqual([
      'analysis:op', 'analysis:dc', 'analysis:tran', 'analysis:ac', 'analysis:tf',
    ]);
    expect(capabilities.limits.map(entry => entry.name)).toEqual([
      'maxSourceBytes', 'maxVirtualFiles', 'maxIncludeDepth', 'maxComponents',
      'maxSubcircuitDepth', 'maxAnalyses', 'maxResultPoints',
      'maxSerializedResultBytes', 'maxWallTimeMs',
    ]);
    expect(capabilities.completions).toEqual(['complete', 'failed', 'limited', 'cancelled']);
    expect(canonicalHash(capabilities)).toBe('e35e05d2d32ca4257e5de04c389dd0159cbe51731d5f54e1b4e2510388cd3c80');
    assertWireSafe(capabilities, true);
  });

  it('returns deterministic success metadata and result hashes', async () => {
    const request = divider();
    const terminal = await executeProtocolV1(request, {
      requestId: 'req-success', now: scriptedClock(100, 100, 107),
    });

    expect(terminal).toMatchObject({
      apiVersion: '1', kind: 'terminal', ok: true, requestId: 'req-success',
      metadata: {
        completion: 'complete', partial: false,
        timing: { startedAtMs: 100, finishedAtMs: 107, durationMs: 7 },
        counts: { requestedAnalyses: 1, completedAnalyses: 1, resultPoints: 1 },
      },
    });
    expect(terminal.metadata.inputId).toBe(`input:${canonicalHash(request)}`);
    expect(terminal.ok && terminal.metadata.resultId).toBe(
      terminal.ok ? `result:${canonicalHash(terminal.data)}` : false,
    );
    expect(canonicalHash(terminal)).toBe('760207cd917eaa46fb3bbbb6050e6ea4548b323201b002668f5849180a6e810e');
    assertWireSafe(terminal);
  });

  it('returns scalar results and counts for transfer-function analysis', async () => {
    const terminal = await executeProtocolV1(divider('.tf v(out) V1'), {
      requestId: 'req-tf', now: scriptedClock(20, 20, 23),
    });

    expect(terminal).toMatchObject({
      ok: true,
      data: { analyses: [{ type: 'tf', transferFunction: 0.5 }] },
      metadata: { completion: 'complete', partial: false, counts: { requestedAnalyses: 1, completedAnalyses: 1, resultPoints: 1 } },
    });
    assertWireSafe(terminal);
  });

  it('returns stable validation-failure metadata', async () => {
    const terminal = await executeProtocolV1({
      apiVersion: '1', input: { format: 'spice', source: 'R1 a b 1k\n.op' },
    }, { requestId: 'req-invalid', now: scriptedClock(30, 30, 35) });

    expect(terminal).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CIRCUIT', phase: 'validation' },
      metadata: { completion: 'failed', partial: false },
    });
    expect(canonicalHash(terminal)).toBe('491caa4d099d742bb773f5c74e4a06aaa74f17f5071c3c4c18d607e6c4e7aedb');
    expect(crossWorkerBoundary(terminal)).toEqual(terminal);
    assertWireSafe(terminal);
  });

  it('reports a deterministic resource-limit termination', async () => {
    const request = divider();
    request.options = { limits: { maxComponents: 1 } };
    const terminal = await executeProtocolV1(request, {
      requestId: 'req-limited', now: scriptedClock(40, 40, 46),
    });

    expect(terminal).toMatchObject({
      ok: false,
      error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxComponents', configured: 1, observed: 2 } },
      metadata: { completion: 'limited', partial: false },
    });
    expect(canonicalHash(terminal)).toBe('c0fb4e8010133a3f69fa4c012ab49bbb5ec5a85e472ac0d0d6477f8187caf4fd');
    assertWireSafe(terminal);
  });

  it('preserves completed analyses on deterministic cancellation', async () => {
    const terminal = await cancelledSecondAnalysis();

    expect(terminal).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED', phase: 'serialize' },
      partial: { status: 'partial', analyses: [{ type: 'op', analysisIndex: 0 }] },
      metadata: {
        completion: 'cancelled', partial: true,
        counts: { requestedAnalyses: 2, completedAnalyses: 1, resultPoints: 1 },
      },
    });
    expect(canonicalHash(terminal)).toBe('9e5f72957de9f6b838bc91c6cbcc86c6e891e35610105702fc7360e63f065f31');
    expect(crossWorkerBoundary(terminal)).toEqual(terminal);
    assertWireSafe(terminal);
  });

  it.each([
    ['spice-ts first', 'V1 spice-ts 0 1\nR1 spice-ts 0 1k\nV2 spice-ts-js 0 2\nR2 spice-ts-js 0 1k\n.op'],
    ['spice-ts-js first', 'V2 spice-ts-js 0 2\nR2 spice-ts-js 0 1k\nV1 spice-ts 0 1\nR1 spice-ts 0 1k\n.op'],
  ])('preserves colliding caller identifiers with %s', async (_ordering, source) => {
    const success = await executeProtocolV1({
      apiVersion: '1', input: { format: 'spice', source },
    }, { requestId: 'spice-ts', now: scriptedClock(0, 0, 1) });

    expect(success.requestId).toBe('spice-ts');
    expect(success.ok).toBe(true);
    if (!success.ok || success.data.analyses[0]?.type !== 'op') return;
    expect(success.data.analyses[0].voltagesV).toMatchObject({
      'spice-ts': 1,
      'spice-ts-js': 2,
    });
    expect(canonicalHash(success.data)).toBe('b232bd63fde198019d973bcddf515612df4090e243132df074796b51225cc452');
  });

  it('recursively sanitizes backend-origin failure details', async () => {
    const failure = await executeProtocolV1(divider(), {
      requestId: 'caller-id', now: scriptedClock(0, 0, 1),
      signal: { aborted: true, reason: { backend: 'spice-ts' } },
    });

    assertWireSafe(failure);
  });

  it('returns a terminal INVALID_REQUEST envelope for non-canonical input', async () => {
    const request = divider();
    request.options = { reltol: Number.NaN };

    const terminal = await executeProtocolV1(request, {
      requestId: 'req-non-canonical', now: scriptedClock(50, 51),
    });

    expect(terminal).toMatchObject({
      ok: false,
      requestId: 'req-non-canonical',
      error: {
        code: 'INVALID_REQUEST',
        phase: 'validation',
        details: { reason: 'NON_FINITE_NUMBER', path: '/options/reltol' },
      },
      metadata: {
        completion: 'failed', partial: false,
        timing: { startedAtMs: 50, finishedAtMs: 51, durationMs: 1 },
        counts: { requestedAnalyses: 1, completedAnalyses: 0, resultPoints: 0 },
      },
    });
    expect(canonicalHash(terminal)).toBe('38a70c0373d56a264948bd3fec3e9d7db1df4eafd5f5c193c5adcea5f785ef67');
    assertWireSafe(terminal);
  });
});
