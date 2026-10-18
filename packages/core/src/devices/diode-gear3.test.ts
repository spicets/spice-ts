import { describe, expect, it } from 'vitest';
import { Diode } from './diode.js';
import type { ChargeIntegration, ChargeTruncation, StampContext } from './device.js';
import { gear3Coefficients } from './gear3.js';

function harness() {
  const diode = new Diode('D1', [0, -1], { CJO: 2, M: 0, VJ: 1 });
  let voltage = 0;
  let conductance = 0;
  let rhs = 0;
  const ctx: StampContext = {
    stampG: (_row, _col, value) => { conductance += value; },
    stampB: (_row, value) => { rhs += value; },
    stampC: () => {}, getVoltage: () => voltage, getCurrent: () => 0,
    time: 0, dt: 0, numNodes: 1, sourceScale: 1, useDcSourceValue: false,
  };
  return {
    diode, ctx,
    seed(v: number) { voltage = v; diode.acceptTransientStep(ctx); },
    trial(v: number, integration: ChargeIntegration) {
      voltage = v;
      ctx.dt = integration.dt;
      diode.stamp(ctx);
      conductance = 0;
      rhs = 0;
      diode.stampTransientCharge(ctx, integration);
      return { current: conductance * v - rhs, conductance };
    },
  };
}

const charge = (t: number) => -2 * (1 + t ** 4);
const voltage = (t: number) => charge(t) / 2;
const truncation: ChargeTruncation = {
  deltas: [1, 1, 1], olderDelta: 1, reltol: 1e-3, abstol: 1e-12, chgtol: 1e-14, trtol: 7,
};

function referenceCurrent(times: number[]): number {
  const [a, b, c, d] = gear3Coefficients(times[4] - times[3], times[3] - times[2], times[2] - times[1]);
  return a * charge(times[4]) + b * charge(times[3]) + c * charge(times[2]) + d * charge(times[1]);
}

function populate(times: number[]) {
  const h = harness();
  h.seed(voltage(times[0]));
  let acceptedCurrent = 0;
  for (let i = 1; i < 4; i++) {
    acceptedCurrent = h.trial(voltage(times[i]), { method: 'euler', dt: times[i] - times[i - 1] }).current;
    h.diode.acceptTransientStep(h.ctx);
  }
  const integration: ChargeIntegration = {
    method: 'gear2', order: 3, dt: times[4] - times[3],
    prevDt: times[3] - times[2], prevPrevDt: times[2] - times[1],
  };
  return { ...h, integration, acceptedCurrent };
}

describe('diode BDF3 charge companion (#1406)', () => {
  for (const times of [[0, 1, 2, 3, 4], [0, 0.5, 1.25, 2.5, 4]]) {
    it(`integrates charge and CKTterr on steps ${times.join(', ')}`, () => {
      const h = populate(times);
      const result = h.trial(voltage(times[4]), h.integration);
      const expectedCurrent = referenceCurrent(times);
      expect(result.current).toBeCloseTo(expectedCurrent, 10);
      expect(result.conductance).toBeCloseTo(2 * gear3Coefficients(
        h.integration.dt, h.integration.prevDt!, h.integration.prevPrevDt!,
      )[0], 12);
      const options: ChargeTruncation = {
        ...truncation,
        deltas: [times[4] - times[3], times[3] - times[2], times[2] - times[1]],
        olderDelta: times[1] - times[0],
      };
      // q(t)=-2*(1+t^4) has fourth divided difference -2 for any step sizes.
      const tolerance = Math.max(
        options.abstol + options.reltol * Math.max(Math.abs(expectedCurrent), Math.abs(h.acceptedCurrent)),
        options.reltol * Math.max(Math.abs(charge(times[4])), Math.abs(charge(times[3])), options.chgtol) / options.deltas[0],
      );
      expect(h.diode.truncateTransientStep(h.ctx, options))
        .toBeCloseTo(Math.cbrt(options.trtol * tolerance / (0.1363636364 * 2)), 10);
      expect(h.diode.truncateTransientStep(h.ctx, { ...options, olderDelta: undefined })).toBe(Infinity);
      h.diode.acceptTransientStep(h.ctx);
      let committed = 0;
      h.diode.stampAcceptedChargeCurrent({ ...h.ctx, stampB: (_row, value) => { committed -= value; } });
      expect(committed).toBeCloseTo(expectedCurrent, 10);
      const nextTimes = [...times.slice(1), times[4] + 0.75];
      expect(h.trial(voltage(nextTimes[4]), {
        ...h.integration, dt: 0.75, prevDt: h.integration.dt, prevPrevDt: h.integration.prevDt,
      }).current).toBeCloseTo(referenceCurrent(nextTimes), 10);
    });
  }

  it('does not commit rejected trials and resets all BDF3 history', () => {
    const times = [0, 1, 2, 3, 4];
    const h = populate(times);
    h.trial(-600, { ...h.integration, dt: 0.25 });
    expect(h.trial(voltage(4), h.integration).current).toBeCloseTo(referenceCurrent(times), 10);
    h.diode.resetTransient();
    h.seed(-1);
    const integration = { ...h.integration, dt: 1 };
    expect(h.trial(-2, integration).current).toBeCloseTo(-2, 12);
    expect(h.diode.truncateTransientStep(h.ctx, truncation)).toBe(Infinity);
    h.diode.acceptTransientStep(h.ctx);
    // Only two accepted points: fall back to BDF2, not stale BDF3 history.
    expect(h.trial(-4, integration).current).toBeCloseTo(-5, 12);
  });

  for (const method of ['euler', 'gear2', 'trapezoidal'] as const) {
    it(`preserves the exact ${method} arithmetic without order 3`, () => {
      const h = harness();
      h.seed(-1);
      h.trial(-2, { method: 'euler', dt: 0.5 });
      h.diode.acceptTransientStep(h.ctx);
      const dt = 0.5;
      const prevDt = 0.5;
      const result = h.trial(-4, { method, dt, prevDt });
      const alpha = prevDt / dt;
      const factor = method === 'trapezoidal' ? 2 / dt
        : method === 'gear2' ? (2 + alpha) / ((1 + alpha) * dt) : 1 / dt;
      const current = method === 'trapezoidal' ? factor * (-8 - -4) - -4
        : method === 'gear2' ? factor * -8 - (1 + alpha) / (alpha * dt) * -4
          + 1 / (alpha * (1 + alpha) * dt) * -2
          : (-8 - -4) / dt;
      expect(result.conductance).toBe(factor * 2);
      // Reconstructing the stamp uses the same final multiply/subtract.
      expect(result.current).toBe(result.conductance * -4 - -(current - result.conductance * -4));
    });
  }
});
