import { describe, expect, it } from 'vitest';
import { MNAAssembler } from './assembler.js';
import { buildCompanionSystem } from './companion.js';
import type { ChargeIntegration, DeviceModel } from '../devices/device.js';

// q(t) = t^3: BDF3 differentiates this exactly, including unequal intervals.
describe('internal BDF3 linear companion', () => {
  it.each([false, true])('differentiates cubic history (fast=%s)', fast => {
    const asm = new MNAAssembler(1, 0);
    let integration: ChargeIntegration | undefined;
    const device: DeviceModel = {
      name: 'test', nodes: [0], branches: [], isNonlinear: false,
      stamp: ctx => ctx.stampG(0, 0, 2),
      stampDynamic: ctx => ctx.stampC(0, 0, 1),
    };
    const charged: DeviceModel = {
      name: 'charge', nodes: [0], branches: [], isNonlinear: false, integratesTransientCharge: true,
      stamp: () => {},
      stampTransientCharge: (_ctx, rule) => { integration = { ...rule }; },
    };
    const devices = [device, charged];
    if (fast) {
      buildCompanionSystem(asm, devices, 0.2, 'euler', new Float64Array([0]));
      asm.lockTopology();
    }
    const t = 1;
    const q = t ** 3;
    buildCompanionSystem(asm, devices, 0.2, 'gear2',
      new Float64Array([0.8 ** 3]), undefined, 0,
      new Float64Array([0.5 ** 3]), 0.3, false, 0.5,
      new Float64Array([0.1 ** 3]), 0.4, 3);
    const g = fast ? asm.gValues[asm.diagIdx[0]] : asm.G.get(0, 0);
    expect(g * q - asm.b[0]).toBeCloseTo(2 * q + 3 * t ** 2, 12);
    expect(integration).toMatchObject({ method: 'gear2', order: 3, dt: 0.2, prevDt: 0.3, prevPrevDt: 0.4 });
    // Reused integration scratch must not retain the old BDF3 rule on restart.
    buildCompanionSystem(asm, devices, 0.2, 'gear2', new Float64Array([0]));
    expect(integration).toMatchObject({ method: 'euler', order: undefined, prevPrevDt: undefined });
  });
});
