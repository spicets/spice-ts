import { simulateProtocolV1, validateProtocolV1 } from '@spice-ts/core';
import type {
  ResolvedOptionsV1,
  SimulationReadDataV1,
  SimulationRequestV1,
  SimulationResultV1,
} from '@spice-ts/core/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createToolExecutor, DEFAULT_MCP_LIMITS, executeTool } from './server.js';

const RC_PULSE = 'V1 a 0 PULSE(0 1 0 1n 1n 5u 10u)\nR1 a b 1k\nC1 b 0 1n';

describe('MCP resolvedOptions match what core actually runs (#407)', () => {
  it('reports effective request and netlist circuit temperatures', async () => {
    const source = 'V1 a 0 1\nR1 a 0 1k\n.temp 40\n.options TNOM=35\n.op';
    const first = await streamedRun(spice(source));
    expect(first.resolvedOptions).toMatchObject({ temperature: 40, nominalTemperature: 35 });
    const second = await streamedRun({ ...spice(source), options: { temperature: 85, nominalTemperature: 27 } });
    expect(second.resolvedOptions).toMatchObject({ temperature: 85, nominalTemperature: 27 });
  });
  it('reports the core-effective transient timestep cap when none is requested', async () => {
    const request = spice(`${RC_PULSE}\n.tran 1u 20u`);
    const { resolvedOptions, result } = await streamedRun(request);

    // Core caps each transient step at min(tstep, tstop/50) = 0.4 us.
    expect(resolvedOptions.maxTimestep).toBeCloseTo(0.4e-6, 15);
    expect(resolvedOptions.maxTimestep).toBeCloseTo(largestTransientStep(result), 15);
  });

  it('reports the .tran TMAX the transient analysis actually uses', async () => {
    const request = spice(`${RC_PULSE}\n.tran 1u 20u 0 0.1u`);
    const { resolvedOptions, result } = await streamedRun(request);

    expect(resolvedOptions.maxTimestep).toBeCloseTo(0.1e-6, 15);
    expect(largestTransientStep(result)).toBeLessThanOrEqual(resolvedOptions.maxTimestep * (1 + 1e-9));
  });

  it('reports a requested maxTimestep that core applies when .tran has no TMAX (#415)', async () => {
    const request = { ...spice(`${RC_PULSE}\n.tran 1u 20u`), options: { maxTimestep: 1e-8 } };
    const { resolvedOptions, result } = await streamedRun(request);

    expect(resolvedOptions.maxTimestep).toBeCloseTo(1e-8, 15);
    expect(largestTransientStep(result)).toBeLessThanOrEqual(resolvedOptions.maxTimestep * (1 + 1e-9));
  });

  it('reports .tran TMAX over a requested maxTimestep (#415)', async () => {
    const request = { ...spice(`${RC_PULSE}\n.tran 1u 20u 0 0.1u`), options: { maxTimestep: 1e-8 } };
    const { resolvedOptions, result } = await streamedRun(request);

    expect(resolvedOptions.maxTimestep).toBeCloseTo(0.1e-6, 15);
    expect(largestTransientStep(result)).toBeCloseTo(0.1e-6, 12);
  });

  it('reports the default cap for a requested maxTimestep of 0, which core treats as unset (#415)', async () => {
    const request = { ...spice(`${RC_PULSE}\n.tran 1u 20u`), options: { maxTimestep: 0 } };
    const { resolvedOptions, result } = await streamedRun(request);

    expect(resolvedOptions.maxTimestep).toBeCloseTo(0.4e-6, 15);
    expect(resolvedOptions.maxTimestep).toBeCloseTo(largestTransientStep(result), 15);
  });

  it.each(['spice_simulate', 'spice_simulation_start'])(
    '%s rejects a negative maxTimestep as INVALID_REQUEST before running (#415)',
    async (tool) => {
      const simulate = vi.fn();
      const request = { ...spice(`${RC_PULSE}\n.tran 1u 20u`), options: { maxTimestep: -1e-7 } };
      const response = await createToolExecutor({ simulate })(tool, { request });

      expect(simulate).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: 'INVALID_REQUEST', phase: 'validation', details: { option: 'maxTimestep' } },
        },
      });
    },
  );

  it('reports the largest cap across several transient analyses', async () => {
    const request = spice(`${RC_PULSE}\n.tran 1u 20u\n.tran 1u 10u 0 0.1u`);
    const { resolvedOptions } = await streamedRun(request);

    expect(resolvedOptions.maxTimestep).toBeCloseTo(0.4e-6, 15);
  });

  it('keeps the unbounded sentinel for runs without a transient analysis', async () => {
    const { resolvedOptions } = await streamedRun(spice('V1 a 0 1\nR1 a 0 1k\n.op'));

    expect(resolvedOptions.maxTimestep).toBe(Number.MAX_VALUE);
  });

  it('honours netlist .options and lets request options override them', async () => {
    const source = [
      'V1 a 0 1', 'R1 a b 1k', 'R2 b 0 1k',
      '.options reltol=2e-3 abstol=1p vntol=2u gmin=1e-9 itl1=150 itl4=20 trtol=5 method=gear',
      '.op',
    ].join('\n');
    const { resolvedOptions } = await streamedRun({ ...spice(source), options: { reltol: 5e-3 } });

    expect(resolvedOptions).toMatchObject({
      reltol: 5e-3,
      abstol: 1e-12,
      vntol: 2e-6,
      // The diagonal API option stays zero; netlist gmin is junction-only (#1068).
      gmin: 0,
      maxIterations: 150,
      maxTransientIterations: 20,
      trtol: 5,
      integrationMethod: 'gear2',
    });
  });
});

describe('MCP point preflight reuses core parsing and estimates (#408)', () => {
  it('counts SI-suffixed transient steps with unit letters instead of treating them as zero', async () => {
    const simulate = vi.fn();
    const response = await executeTool('spice_simulate', {
      request: { ...spice('V1 a 0 1\nR1 a 0 1k\n.tran 1us 10ms'), options: { limits: { maxResultPoints: 1000 } } },
    }, { simulate });

    expect(simulate).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'RESOURCE_LIMIT', phase: 'validation',
          details: { limit: 'maxResultPoints', maximum: 1000, actual: 10001 },
        },
      },
    });
  });

  it.each([
    ['unit-suffixed transient', '.tran 1us 10ms'],
    ['transient with start time and TMAX', '.tran 10ns 1ms 0.5ms 1ns'],
    ['linear AC sweep', '.ac lin 10 1 10'],
    ['decade AC sweep', '.ac dec 10 1 1meg'],
    ['nested DC sweep', '.dc V1 0 1 1m V2 0 1 0.1'],
    ['several analyses', '.op\n.tran 1u 1m\n.ac oct 3 1k 1meg'],
    ['stretched multi-decade AC sweep', '.ac dec 10 1 5k'],
    ['AC sweep whose stop tolerance follows netlist reltol', '.options reltol=1e-4\n.ac dec 10 1 9.99'],
    ['AC sensitivity sweep', '.sens v(b) ac dec 10 1 9.98'],
  ])('rejects %s with the same point count core computes', async (_name, analyses) => {
    const request: SimulationRequestV1 = {
      ...spice(`V1 a 0 1\nV2 b 0 1\nR1 a b 1k\nR2 b 0 1k\n${analyses}`),
      options: { limits: { maxResultPoints: 1 } },
    };
    const coreObserved = await coreEstimatedPoints(request);

    const response = await executeTool('spice_validate', { request }, { validate: vi.fn() });

    expect(response.structuredContent).toMatchObject({
      error: {
        code: 'RESOURCE_LIMIT', phase: 'validation',
        details: { limit: 'maxResultPoints', maximum: 1, actual: coreObserved },
      },
    });
  });

  it('counts every analysis directive core counts against maxAnalyses', async () => {
    const request = spice('V1 a 0 AC 1\nR1 a 0 1k\n.op\n.noise v(a) V1 dec 10 1 1k');
    const response = await executeTool('spice_validate', { request }, {
      limits: { ...DEFAULT_MCP_LIMITS, maxAnalyses: 1 },
      validate: vi.fn(),
    });

    expect(response.structuredContent).toMatchObject({
      error: { code: 'RESOURCE_LIMIT', details: { limit: 'maxAnalyses', maximum: 1, actual: 2 } },
    });
  });
});

function spice(source: string): SimulationRequestV1 {
  return { apiVersion: '1', input: { format: 'spice', source } };
}

async function streamedRun(request: SimulationRequestV1): Promise<{
  resolvedOptions: ResolvedOptionsV1;
  result: SimulationResultV1;
}> {
  const execute = createToolExecutor({
    simulate: simulateProtocolV1,
    streamLimits: { maxUnreadEvents: 100_000, maxUnreadBytes: 64 * 1024 * 1024 },
  });
  const started = await execute('spice_simulation_start', { request });
  const { jobId } = started.structuredContent as { jobId: string };
  let cursor = (started.structuredContent as { cursor: string }).cursor;
  for (let read = 0; read < 10_000; read++) {
    const response = await execute('spice_simulation_read', { jobId, cursor, maxPoints: 1024 });
    const data = response.structuredContent as unknown as SimulationReadDataV1;
    if (data.status === 'complete') {
      return { resolvedOptions: data.terminal.metadata.resolvedOptions, result: data.terminal.data };
    }
    if (data.status !== 'running') throw new Error(`Stream ended with ${JSON.stringify(data.terminal)}`);
    cursor = data.nextCursor;
    if (data.events.length === 0) await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Stream did not complete');
}

function largestTransientStep(result: SimulationResultV1): number {
  let largest = 0;
  for (const analysis of result.analyses) {
    if (analysis.type !== 'tran') continue;
    for (let index = 1; index < analysis.timeS.length; index++) {
      largest = Math.max(largest, analysis.timeS[index]! - analysis.timeS[index - 1]!);
    }
  }
  return largest;
}

async function coreEstimatedPoints(request: SimulationRequestV1): Promise<number> {
  try {
    await validateProtocolV1(request);
  } catch (error) {
    const details = (error as { apiError?: { details?: { limit?: string; observed?: number } } }).apiError?.details;
    if (details?.limit === 'maxResultPoints' && typeof details.observed === 'number') return details.observed;
    throw error;
  }
  throw new Error('core accepted the request');
}
