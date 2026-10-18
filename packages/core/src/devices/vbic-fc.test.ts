import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../parser/index.js';
import type { StampContext } from './device.js';
import { resolveVBICParams, VBIC } from './vbic.js';

// Local nodes CX, CI, BX, BI, EI, BP, SI. Exercise the public AC and
// transient stamps, not a second implementation of the model evaluator.
function stamps(params: Record<string, number>, positive: number, negative: number, bias: number, polarity = 1) {
  const device = new VBIC('Q', [0, 1, 2, 3, 4, 5, 6], params, polarity);
  const voltage = new Float64Array(7);
  const capacitance = Array.from({ length: 7 }, () => new Float64Array(7));
  const conductance = Array.from({ length: 7 }, () => new Float64Array(7));
  const rhs = new Float64Array(7);
  const ctx: StampContext = {
    stampG: (r, c, value) => { conductance[r][c] += value; },
    stampC: (r, c, value) => { capacitance[r][c] += value; },
    stampB: (r, value) => { rhs[r] += value; },
    getVoltage: n => voltage[n], getCurrent: () => 0,
    time: 0, dt: 1, numNodes: 7, sourceScale: 1, useDcSourceValue: false,
  };
  device.acceptTransientStep(ctx); // q(0) = 0
  voltage[positive] = polarity * bias;
  device.stampDynamic(ctx);
  device.stampTransientCharge(ctx, { method: 'euler', dt: 1 });
  // With dt=1, B = C*V - (Q(V)-Q(0)).
  const charge = polarity * (conductance[positive][positive] * polarity * bias - rhs[positive]);
  return { charge, capacitance: -capacitance[positive][negative],
    all: [capacitance.map(row => [...row]), conductance.map(row => [...row]), [...rhs]] };
}

describe('VBIC forward-bias depletion coefficient FC', () => {
  it('preserves the omitted-FC main stamps bit for bit', () => {
    const results = [-0.3, 0, 0.375, 0.675, 0.9].map(bias =>
      stamps({ CJE: 1e-12, CJC: 2e-12, CJEP: 3e-12, CJCP: 4e-12, VEF: 50, VER: 30 }, 3, 4, bias).all);
    // Captured on main before adding FC support (RED run).
    expect(createHash('sha256').update(JSON.stringify(results)).digest('hex'))
      .toBe('6085642c9467251346d112a84a2a145586379e97d847dcac1e28fceb9bca63fa');
  });

  it('defaults to ngspice FC=0.9 and parses an explicit coefficient', () => {
    expect(resolveVBICParams({}, 1)).toHaveProperty('FC', 0.9);
    expect(resolveVBICParams({ FC: 0 }, 1)).toHaveProperty('FC', 0);
    expect(resolveVBICParams({ FC: 0.999 }, 1)).toHaveProperty('FC', 0.999);
    expect(() => parse(`FC model\nQ1 c b 0 qv\n.model qv NPN(LEVEL=4 FC=0.5)\n.op\n.end`).compile()).not.toThrow();
  });

  it.each([-0.1, 1, 1.1, NaN, Infinity])('rejects invalid bounded FC=%s', FC => {
    expect(() => resolveVBICParams({ FC }, 1)).toThrow("Invalid bounded VBIC DC model parameter: 'FC'");
  });

  // ngspice-47 vbicload.c:2238-2283 (BE), 2482-2543 (BC), at
  // a80f6e3e95d51534905b1f23410a951802666656. AJE/AJC/AJS=0.
  // Independently integrated C(V)=C0*(1-FC)^(-M)*
  // [1+M*(V-FC*P)/(P*(1-FC))] above the knee; P=.75, M=.33.
  for (const [parameter, positive, negative] of [
    ['CJE', 3, 4], ['CJC', 3, 1], ['CJEP', 2, 5], ['CJCP', 6, 5],
  ] as const) {
    for (const polarity of [1, -1]) {
      it(`${parameter} charge and capacitance follow FC above/below the knee, polarity ${polarity}`, () => {
        const FC = 0.5;
        const potential = 0.75;
        const grading = 0.33;
        const c0 = 2e-12;
        const knee = potential * FC;
        for (const bias of [-0.2, 0, knee - 1e-10, knee, knee + 1e-10, 0.6, 0.9]) {
          const delta = bias - knee;
          const ck = c0 * (1 - FC) ** -grading;
          const qk = c0 * potential / (1 - grading) * (1 - (1 - FC) ** (1 - grading));
          const expectedQ = delta > 0
            ? qk + ck * delta + ck * grading / (2 * potential * (1 - FC)) * delta ** 2
            : c0 * potential / (1 - grading) * (1 - (1 - bias / potential) ** (1 - grading));
          const expectedC = delta > 0
            ? ck * (1 + grading * delta / (potential * (1 - FC)))
            : c0 * (1 - bias / potential) ** -grading;
          const actual = stamps({ FC, [parameter]: c0 }, positive, negative, bias, polarity);
          if (expectedQ === 0) expect(actual.charge).toBe(0);
          else expect(Math.abs(actual.charge / expectedQ - 1)).toBeLessThan(1e-9);
          expect(Math.abs(actual.capacitance / expectedC - 1)).toBeLessThan(1e-9);
        }
      });
    }
  }

  it('compiles the byte-identical DFF deck with VTF and explicit RBP=0', () => {
    const deck = readFileSync('../../benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp');
    expect(createHash('sha256').update(deck).digest('hex'))
      .toBe('d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6');
    expect(() => parse(deck.toString('utf8')).compile()).not.toThrow();
  });
});
