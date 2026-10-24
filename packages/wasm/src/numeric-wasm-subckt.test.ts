import { describe, expect, it } from 'vitest';
import { simulateProtocolV1 } from '@spice-ts/core';
import type { SimulationRequestV1 } from '@spice-ts/core/protocol';
import { createSpiceEngine } from './index.js';

// Original project-authored fixtures, released under the project's MIT license.
// No external simulator decks or relaxed, device-specific tolerance policies.
const drive = 'VIN in 0 DC 0.4';
const fixtures = [
  { name: 'two independent resistor dividers', source: `${drive}
Xone in out1 divider
Xtwo in out2 divider
.subckt divider a z
Rtop a middle 1k
Rbottom middle z 2k
Rload z 0 3k
.ends divider` },
  { name: 'two-level hierarchy with global leaf definition', source: `${drive}
Xone in out1 outer
Xtwo in out2 outer
.subckt leaf a z
R1 a z 1k
R2 z 0 2k
.ends leaf
.subckt outer a z
Xchild a middle leaf
Rtail middle z 500
Rload z 0 2k
.ends outer` },
  { name: 'nested definitions and case-insensitive lookup', source: `${drive}
Xone in out1 OUTER
Xtwo in out2 outer
.subckt Outer a z
.subckt Inner p q
R1 p q 2k
R2 q 0 3k
.ends Inner
Xchild a z iNnEr
.ends Outer` },
  { name: 'two RC low-pass instances', dynamic: true, source: `${drive}
Xone in out1 lowpass
Xtwo in out2 lowpass
.subckt lowpass a z
R1 a z 1k
C1 z 0 1u
.ends lowpass` },
  { name: 'two diode clamps', source: `${drive}
.model clamp D(IS=1e-14 N=1)
Xone in out1 limiter
Xtwo in out2 limiter
.subckt limiter a z
R1 a z 1k
D1 z 0 clamp
R2 z 0 10k
.ends limiter` },
  { name: 'two BJT inverters', source: `${drive}
VDD supply 0 3
.model np NPN(IS=1e-15 BF=100 VAF=100)
Xone in out1 supply inv
Xtwo in out2 supply inv
.subckt inv a z vdd
RB a base 10k
RC vdd z 2k
Q1 z base 0 np
.ends inv` },
  { name: 'two MOS1 inverters', source: `${drive}
VDD supply 0 3
.model nch NMOS(LEVEL=1 VTO=0.7 KP=100u LAMBDA=0.02)
.model pch PMOS(LEVEL=1 VTO=-0.7 KP=50u LAMBDA=0.02)
Xone in out1 supply inv
Xtwo in out2 supply inv
.subckt inv a z vdd
MN z a 0 0 nch W=10u L=1u
MP z a vdd vdd pch W=20u L=1u
.ends inv` },
  { name: 'F and H controls resolve local voltage-source names', source: `${drive}
Xone in out1 controls
Xtwo in out2 controls
.subckt controls a z
VSENSE a sense 0
Rin sense 0 1k
Fcopy fnode 0 VSENSE 2
Rf fnode 0 1k
Hcopy z 0 VSENSE 500
Rout z 0 2k
.ends controls` },
  { name: 'sibling-local models shadow a global model', source: `${drive}
.model local D(IS=1e-12 N=1)
Xone in out1 first
Xtwo in out2 second
.subckt first a z
.model local D(IS=1e-14 N=1)
R1 a z 1k
D1 z 0 local
.ends first
.subckt second a z
.model local D(IS=1e-10 N=1)
R1 a z 2k
D1 z 0 local
.ends second` },
];
const analyses = [
  { name: 'op', directive: '.op' },
  { name: 'dc', directive: '.dc VIN 0 1 0.2' },
  { name: 'tran', directive: '.tran 1u 10u' },
  { name: 'ac', directive: '.ac dec 3 10 10k' },
] as const;
const cases = fixtures.flatMap(fixture => analyses
  .filter(analysis => !fixture.dynamic || analysis.name === 'tran' || analysis.name === 'ac')
  .map(analysis => ({
    name: `${fixture.name}: ${analysis.name}`,
    source: `${fixture.source.replace(drive, analysis.name === 'ac' ? `${drive} AC 1` : analysis.name === 'tran' ? 'VIN in 0 PULSE(0.4 0.8 2u 1u 1u 3u 8u)' : drive)}\n${analysis.directive}`,
    analysis: analysis.name,
  })));
const request = (source: string): SimulationRequestV1 => ({
  apiVersion: '1', input: { format: 'spice', source },
});

// Compare every exported node, branch, and phasor component (not just outputs).
// Analysis result payloads have no solver timing/iteration metadata.
function compare(actual: unknown, expected: unknown, path = 'analysis'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(Number.isFinite(actual), path).toBe(true);
    expect(Math.abs((actual as number) - expected), path)
      .toBeLessThanOrEqual(Math.max(1e-12, 1e-9 * Math.abs(expected)));
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    const values = actual as unknown[];
    expect(values, path).toHaveLength(expected.length);
    expected.forEach((value, index) => compare(values[index], value, `${path}[${index}]`));
  } else if (expected !== null && typeof expected === 'object') {
    expect(actual, path).not.toBeNull();
    const fields = actual as Record<string, unknown>;
    expect(Object.keys(fields).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) compare(fields[key], value, `${path}.${key}`);
  } else {
    expect(actual, path).toEqual(expected);
  }
}

describe('bounded numeric WASM subcircuit expansion (#1726)', () => {
  it.each(cases)('matches simulateProtocolV1: $name', async ({ source, analysis }) => {
    // Run the independent reference first: malformed fixtures must not count as RED.
    const reference = await simulateProtocolV1(request(source));
    expect(reference.analyses).toHaveLength(1);
    expect(reference.analyses[0]?.type).toBe(analysis);
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await engine.simulate(request(source), { requestId: 'subckt-parity' });
      expect(actual.ok, JSON.stringify(actual)).toBe(true);
      if (!actual.ok) throw new Error(actual.error.message);
      expect(actual.metadata).toMatchObject({ backend: 'spice-ts-wasm' });
      expect(actual.data.analyses).toHaveLength(1);
      const a = actual.data.analyses[0]!;
      const b = reference.analyses[0]!;
      // No interpolation, resampling, or approximate accepted-time-grid equality.
      if (a.type === 'tran' && b.type === 'tran') expect(a.timeS).toEqual(b.timeS);
      if (a.type === 'ac' && b.type === 'ac') expect(a.frequencyHz).toEqual(b.frequencyHz);
      if (a.type === 'dc' && b.type === 'dc') expect(a.axis).toEqual(b.axis);
      compare(a, b);
    } finally { await engine.close(); }
  });

  it.each([
    { name: 'local .param', source: 'X1 in out cell\n.subckt cell a z\n.param r=1k\nR1 a z 1k\n.ends' },
  ])('rejects $name with structured parameter feature', async ({ source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(`${drive}\nRload out 0 1k\n${source}\n.op`), { requestId: 'subckt-params' }))
        .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_FEATURE', details: { feature: 'subcircuit-parameters' } } });
    } finally { await engine.close(); }
  });

  it.each([
    { name: 'missing subcircuit', source: 'X1 in out missing' },
    { name: 'wrong port count', source: 'X1 in cell\n.subckt cell a z\nR1 a z 1k\n.ends' },
    { name: 'direct recursion', source: 'X1 in out cell\n.subckt cell a z\nXagain a z cell\n.ends' },
    { name: 'indirect recursion', source: 'X1 in out first\n.subckt first a z\nXagain a z second\n.ends\n.subckt second a z\nXagain a z first\n.ends' },
  ])('rejects $name as INVALID_CIRCUIT', async ({ source }) => {
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      expect(await engine.simulate(request(`${drive}\nRload out 0 1k\n${source}\n.op`), { requestId: 'subckt-invalid' }))
        .toMatchObject({ ok: false, error: { code: 'INVALID_CIRCUIT' } });
    } finally { await engine.close(); }
  });

  it.each([64, 65])('applies the unknown limit after flattening: %i unknowns', async unknowns => {
    // One source node + one voltage-source branch + (unknowns - 2) internal nodes.
    const nodes = unknowns - 2;
    const resistors = Array.from({ length: nodes }, (_, i) => `R${i} ${i === 0 ? 'a' : `n${i - 1}`} n${i} 1k`);
    const source = `VIN in 0 1\nX1 in ladder\n.subckt ladder a\n${resistors.join('\n')}\nRend n${nodes - 1} 0 1k\n.ends\n.op`;
    const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
    try {
      const actual = await engine.simulate(request(source), { requestId: 'subckt-limit' });
      if (unknowns === 65) {
        expect(actual).toMatchObject({ ok: false, error: { code: 'RESOURCE_LIMIT' } });
      } else {
        expect(actual.ok, JSON.stringify(actual)).toBe(true);
        if (!actual.ok) throw new Error(actual.error.message);
        compare(actual.data.analyses[0], (await simulateProtocolV1(request(source))).analyses[0]);
      }
    } finally { await engine.close(); }
  });
});
