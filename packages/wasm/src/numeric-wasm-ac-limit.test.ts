import { describe, expect, it, vi } from 'vitest';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';

// Spy on core's grid builder so the test can prove the point limit is enforced before any
// frequency array is materialised (#409 review: `lin 3e7` used to allocate ~240 MB first).
const { frequencyGridSpy } = vi.hoisted(() => ({ frequencyGridSpy: vi.fn() }));
vi.mock('@spice-ts/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@spice-ts/core')>();
  frequencyGridSpy.mockImplementation(core.frequencyGrid);
  return { ...core, frequencyGrid: frequencyGridSpy };
});

const { validateLinearOpWasmV1 } = await import('./numeric-wasm.js');

function acRequest(sweep: string): SimulationRequestV1 {
  return {
    apiVersion: '1',
    input: { format: 'spice', source: `V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac ${sweep}` },
  };
}

function validationError(sweep: string): unknown {
  try {
    validateLinearOpWasmV1(acRequest(sweep));
  } catch (error) {
    return error;
  }
  throw new Error(`expected '.ac ${sweep}' to be rejected`);
}

describe('numeric-wasm .ac point limit', () => {
  it.each([
    ['lin 30000000 1 10', 30_000_000],
    ['lin 5000000000 1 10', 5_000_000_000],
    // ngspice keeps points up to stop + ratio*stop*reltol, hence more than N*decades+1 here.
    ['dec 100000000 1 10', 100_043_408],
  ])('rejects .ac %s with RESOURCE_LIMIT before building the frequency grid', (sweep, observed) => {
    frequencyGridSpy.mockClear();
    const error = validationError(sweep);
    expect(error).toMatchObject({
      error: {
        code: 'RESOURCE_LIMIT',
        phase: 'validation',
        details: { limit: 'maxResultPoints', configured: 1_025, observed },
      },
    });
    expect(frequencyGridSpy).not.toHaveBeenCalled();
  });

  it('still builds the grid for an in-limit sweep', () => {
    frequencyGridSpy.mockClear();
    expect(validateLinearOpWasmV1(acRequest('dec 10 1 5k'))).toMatchObject({ status: 'valid' });
    expect(frequencyGridSpy).toHaveBeenCalledTimes(1);
  });
});
