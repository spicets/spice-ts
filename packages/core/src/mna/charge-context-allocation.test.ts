import { expect, it } from 'vitest';
import type { ChargeIntegration, DeviceModel } from '../devices/device.js';
import { MNAAssembler } from './assembler.js';
import { buildCompanionSystem } from './companion.js';

it('reuses one charge integration context per assembler while refreshing every field', () => {
  const contexts = new Set<ChargeIntegration>();
  const snapshots: ChargeIntegration[] = [];
  const device: DeviceModel = {
    name: 'charge-probe', nodes: [0], branches: [], isNonlinear: false, integratesTransientCharge: true,
    stamp(ctx) { ctx.stampG(0, 0, 1); },
    stampTransientCharge(_ctx, integration) {
      contexts.add(integration);
      snapshots.push({ ...integration });
    },
  };
  const devices = [device];
  const a = new MNAAssembler(1, 0);
  const b = new MNAAssembler(1, 0);
  for (const asm of [a, b]) {
    asm.getStampContext().stampG(0, 0, 1);
    asm.lockTopology();
  }
  const prev = new Float64Array([1]);
  for (let i = 0; i < 10; i++) {
    buildCompanionSystem(a, devices, 1, 'trapezoidal', prev);
    buildCompanionSystem(a, devices, 2, 'gear2', prev, prev, 0, prev, 3, false, 0.4);
    buildCompanionSystem(b, devices, 4, 'trapezoidal', prev, prev, 0, undefined, undefined, false, 0.3);
    buildCompanionSystem(a, devices, 5, 'euler', prev);
  }
  expect(snapshots.slice(0, 4)).toEqual([
    { method: 'euler', dt: 1, prevDt: undefined, xmu: 0.5 },
    { method: 'gear2', dt: 2, prevDt: 3, xmu: 0.4 },
    { method: 'trapezoidal', dt: 4, prevDt: undefined, xmu: 0.3 },
    { method: 'euler', dt: 5, prevDt: undefined, xmu: 0.5 },
  ]);
  // Identity counts the actual objects delivered to devices, not a mock factory.
  expect(contexts.size).toBe(2);
});
