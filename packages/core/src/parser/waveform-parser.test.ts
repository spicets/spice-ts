import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CurrentSource } from '../devices/current-source.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { ParseError } from '../errors.js';
import { simulate } from '../simulate.js';
import { parse } from './index.js';
import { parseSourceWaveform } from './waveform-parser.js';

describe('independent-source waveform grammar', () => {
  it.each([
    ['voltage', 'V1', VoltageSource],
    ['current', 'I1', CurrentSource],
  ] as const)('defaults an AC-only %s source magnitude and phase', (_kind, name, Source) => {
    const source = parse(`AC-only source\n${name} in 0 AC\n.ac lin 1 1k 1k`).compile()
      .devices.find(device => device.name === name);

    expect(source).toBeInstanceOf(Source);
    expect((source as VoltageSource | CurrentSource).waveform).toEqual({
      type: 'ac', dc: 0, magnitude: 1, phase: 0,
    });
  });

  it.each([
    ['V1 in 0 AC nope', 'V1 in 0 AC nope'],
    ['I1 in 0 AC 1 nope', 'I1 in 0 AC 1 nope'],
  ])('reports malformed AC source values as structured parse errors', (card, context) => {
    try {
      parse(`Malformed AC source\n${card}`);
      expect.fail('expected malformed AC source to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({ line: 2, context });
      expect((error as Error).message).toMatch(/Cannot parse number/);
      expect((error as Error).message).not.toMatch(/TypeError|reading 'trim'/);
    }
  });

  it('parses a transient SIN waveform after an explicit DC value', () => {
    expect(parseSourceWaveform(
      ['V1', 'in', '0', 'DC', '1.5', 'SIN', '(', '2', '3', '4k', '5u', '6', '7', ')'],
      3,
    )).toEqual({
      type: 'sin',
      dc: 1.5,
      offset: 2,
      amplitude: 3,
      frequency: 4e3,
      // 5u is 5 * pow(10, -6) in ngspice-47 INPevaluate (#749).
      delay: 4.9999999999999996e-6,
      damping: 6,
      phase: 7,
    });
  });

  it("accepts ngspice's SINE alias", () => {
    expect(parseSourceWaveform(
      ['V1', 'in', '0', 'dc', '0', 'sine', '(', '0', '0.3', '440', '0', '0', ')'],
      3,
    )).toEqual({
      type: 'sin',
      dc: 0,
      offset: 0,
      // 0.3 is 3 * pow(10, -1) in ngspice-47 INPevaluate (#749).
      amplitude: 0.30000000000000004,
      frequency: 440,
      delay: 0,
      damping: 0,
      phase: undefined,
    });
  });

  it.each(['V1', 'I1'])('defaults only five-argument PULSE width to zero for %s (#1706)', (name) => {
    for (const [args, width] of [
      [['0', '1'], Infinity],
      [['0', '1', '2n', '1n'], Infinity],
      [['0', '1', '2n', '1n', '1n'], 0],
      [['0', '1', '2n', '1n', '1n', '3n'], 3.0000000000000004e-9],
    ] as const) {
      expect(parseSourceWaveform([name, '1', '0', 'PULSE', '(', ...args, ')'], 3))
        .toMatchObject({ type: 'pulse', width, period: Infinity });
    }
  });

  it('preserves standalone DC, PULSE, and PWL semantics', () => {
    expect(parseSourceWaveform(['V1', '1', '0', 'DC', '5'], 3)).toEqual({ type: 'dc', value: 5 });
    expect(parseSourceWaveform(
      ['V1', '1', '0', 'PULSE', '(', '0', '5', '1n', '2n', '3n', '4n', '5n', ')'],
      3,
    )).toEqual({
      type: 'pulse', v1: 0, v2: 5, delay: 1e-9, rise: 2e-9, fall: 3.0000000000000004e-9,
      width: 4e-9, period: 5e-9,
    });
    expect(parseSourceWaveform(
      ['V1', '1', '0', 'PWL', '(', '0', '0', '1u', '1', ')'],
      3,
    )).toEqual({ type: 'pwl', points: [{ time: 0, value: 0 }, { time: 1e-6, value: 1 }] });
  });

  it('uses explicit DC for .op and the SIN waveform for .tran', async () => {
    const result = await simulate(`
      V1 in 0 DC 1.5 SIN(2 3 1k 0 0 0)
      R1 in 0 1k
      .op
      .tran 50u 250u
      .end
    `);

    // ngspice-47: `ngspice -b composed-dc-sin.cir` reports v(in)=1.5 V
    // for .op, then 2 V at t=0 and 5 V at t=250 us for .tran.
    expect(result.dc!.voltage('in')).toBeCloseTo(1.5, 12);
    expect(result.transient!.voltage('in')[0]).toBeCloseTo(2, 12);
    expect(result.transient!.voltage('in').at(-1)).toBeCloseTo(5, 12);
  });

  it('preserves every term on the unchanged classic DISTOF source cards', () => {
    const fixtures = [
      {
        path: '../../../../benchmarks/corpus/classic/fixtures/spice3f5/diodisto.cir',
        sha256: '912c8cedf66aadbe78f17ceb28644cb8c39a2cb3442559be3219fbaac6d11de8',
        cards: ['vcc 1 3 5v ac 0.001 sin(5 0.01 1000) distof1 0.01 distof2 0.01'],
      },
      {
        path: '../../../../benchmarks/corpus/classic/fixtures/spice3f5/mixdisto.cir',
        sha256: '9f172a78faabd09f0b4e61d733b542e48380a452a4767b83e05617ab4642894e',
        cards: [
          'v1 1 0  0v ac 1.0 distof1 0.001',
          'v2 7 0 0v ac 1.0 distof1 0.001',
        ],
      },
    ] as const;

    const parsed = fixtures.flatMap((fixture) => {
      const bytes = readFileSync(resolve(import.meta.dirname, fixture.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      const lines = bytes.toString('utf8').split(/\r?\n/);
      return fixture.cards.map((card) => {
        expect(lines).toContain(card);
        const source = parse(`classic fixture source\n${card}`).compile().devices[0];
        expect(source).toBeInstanceOf(VoltageSource);
        return (source as VoltageSource).waveform;
      });
    });

    expect(parsed).toEqual([
      {
        type: 'sin',
        dc: 5,
        offset: 5,
        amplitude: 0.01,
        frequency: 1000,
        delay: undefined,
        damping: undefined,
        phase: undefined,
        ac: { magnitude: 0.001, phase: 0 },
        distortionF1: { magnitude: 0.01, phase: 0 },
        distortionF2: { magnitude: 0.01, phase: 0 },
      },
      {
        type: 'ac',
        dc: 0,
        magnitude: 1,
        phase: 0,
        distortionF1: { magnitude: 0.001, phase: 0 },
      },
      {
        type: 'ac',
        dc: 0,
        magnitude: 1,
        phase: 0,
        distortionF1: { magnitude: 0.001, phase: 0 },
      },
    ]);
  });
});

describe('jimi-fuzz source regression', () => {
  it('compiles the exact public fixture input as a 440 Hz sine excitation', () => {
    const fixture = readFileSync(resolve(
      import.meta.dirname,
      '../../../../benchmarks/corpus/ngspice/fixtures/examples/wave/jimi_fuzz.cir',
    ), 'utf8');
    const source = parse(fixture).compile().devices.find(device => device.name === 'V_V2');

    expect(source).toBeInstanceOf(VoltageSource);
    expect((source as VoltageSource).waveform).toEqual({
      type: 'sin',
      dc: 0,
      offset: 0,
      amplitude: 0.30000000000000004, // 3 * pow(10, -1), ngspice-47 INPevaluate (#749)
      frequency: 440,
      delay: 0,
      damping: 0,
      phase: undefined,
    });
    expect((source as VoltageSource).getVoltageAtTime(1 / (4 * 440))).toBeCloseTo(0.3, 12);
  });
});

// Cards copied byte-for-byte from the corpus-f batch-1 fixtures (ngspice tree
// 3ef069fb, BSD-3-Clause; see #484/#492). ngspice-47's INPgetUTok treats '('
// and ')' on a source card as separators, so every form below is a plain
// value list to ngspice.
describe('ngspice parenthesised and extended source waveforms (#492)', () => {
  const sourceOf = (card: string) => {
    const source = parse(`corpus-f source\n${card}\n.end`).compile().devices[0];
    expect(source).toBeInstanceOf(VoltageSource);
    return (source as VoltageSource).waveform;
  };

  it('accepts a whole parenthesised PWL after the DC value (cider/diode/pd1.cir)', () => {
    expect(sourceOf('VIN 1 0 0.0v (PWL 0ns 0.8v 1ns -50.0v)')).toEqual({
      type: 'pwl', dc: 0,
      points: [{ time: 0, value: 0.8 }, { time: 1e-9, value: -50 }],
    });
  });

  it('accepts parenthesised PWL and AC groups (cider/diode/diode.cir)', () => {
    expect(sourceOf('Vpp 1 0 0.7v (PWL 0ns 3.0v 0.01ns -6.0v) (AC 1v)')).toEqual({
      type: 'pwl', dc: 0.7000000000000001, ac: { magnitude: 1, phase: 0 },
      points: [{ time: 0, value: 3 }, { time: 0.01e-9, value: -6 }],
    });
  });

  it('accepts a whole parenthesised PULSE (cider/serial/recovery.cir)', () => {
    expect(sourceOf('VPP 1 0 0.0V (PULSE 1.0V -1.0V 1NS 1PS 1PS 20NS 40NS)')).toEqual({
      type: 'pulse', dc: 0, v1: 1, v2: -1, delay: 1e-9, rise: 1e-12, fall: 1e-12,
      width: 20e-9, period: 40e-9,
    });
  });

  it('accepts parenthesised PWL time/value pairs (xspice digital_models*.deck)', () => {
    expect(sourceOf('vdata1 100 0 DC PWL( (0 0.0) (2 0.0) (2.0000000001 1.0) (3 1.0) ) ')).toEqual({
      type: 'pwl',
      points: [
        { time: 0, value: 0 }, { time: 2, value: 0 },
        { time: 2.0000000001, value: 1 }, { time: 3, value: 1 },
      ],
    });
  });

  it('accepts bare parenthesised PWL pairs across a continuation (cider/mos/bootinv.cir)', () => {
    expect(sourceOf([
      'Vin 5 0 0.0v PWL (0.0ns 5.0v) (1ns 0.0v) (10ns 0.0v) (11ns 5.0v)',
      '+ (20ns 5.0v) (21ns 0.0v) (30ns 0.0v) (31ns 5.0v)',
    ].join('\n'))).toEqual({
      type: 'pwl', dc: 0,
      // mantissa * pow(10, -9), as ngspice-47 INPevaluate reads `11ns` (#749).
      points: [
        { time: 0, value: 5 }, { time: 1e-9, value: 0 },
        { time: 10e-9, value: 0 }, { time: 11 * 1e-9, value: 5 },
        { time: 20e-9, value: 5 }, { time: 21 * 1e-9, value: 0 },
        { time: 30 * 1e-9, value: 0 }, { time: 31e-9, value: 5 },
      ],
    });
  });

  it('reads the eighth PULSE field as ngspice NP (xspice arbitrary_phase.deck)', () => {
    expect(sourceOf('v2 2 0 0.0 pulse(-1 1 0 1e-5 1e-5 5e-4 1e-3 45.0)')).toEqual({
      type: 'pulse', dc: 0, v1: -1, v2: 1, delay: 0, rise: 1e-5, fall: 1e-5,
      width: 5e-4, period: 1e-3, pulses: 45,
    });
  });

  it.each([
    ['V1 1 0 PULSE(0 1 0 0.1 0.1 0.3 1 2 7)', /Unsupported PULSE source parameters: '7'/],
    ['V1 1 0 PWL(0 0 1 1) R=1u', /PWL repeat start time 0.000001 does not match any time point/],
    ['V1 1 0 PWL(0 0 1 1) X=1u', /Unsupported PWL source parameters: 'X=1u'/],
    ['V1 1 0 (PULSE 0 1 0 0.1 0.1 0.3 1) TD=1', /Unsupported PULSE source parameters: 'TD=1'/],
  ])('keeps strict structured diagnostics for %s', (card, diagnostic) => {
    try {
      parse(`strict source\n${card}`);
      expect.fail('expected the source card to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({ line: 2, context: card });
      expect((error as Error).message).toMatch(diagnostic);
    }
  });

  it('round-trips NP through netlist export', () => {
    const netlist = parse('np\nV3 3 0 PULSE(0 1 0 0.1 0.1 0.3 1 2)\nR3 3 0 1\n.end').toNetlist();
    expect(netlist).toContain('V3 3 0 PULSE(0 1 0 0.1 0.1 0.3 1 2)');
    expect(parse(netlist).compile().devices.find(d => d.name === 'V3'))
      .toMatchObject({ waveform: { pulses: 2 } });
  });

  it('stops a PULSE after NP periods in transient analysis', async () => {
    // ngspice-47 `ngspice -b`, identical card, R load, .tran 0.1 5:
    // v(3)=1 at t=1.1 (second pulse) and 0 at t=2.1 (no third pulse).
    const result = await simulate(`NP pulse
V3 3 0 0 PULSE(0 1 0 0.1 0.1 0.3 1 2)
R3 3 0 1
.tran 0.1 5
.end`);
    const time = result.transient!.time;
    const v = result.transient!.voltage('3');
    const at = (t: number) => v[time.findIndex(sample => Math.abs(sample - t) < 1e-9)];
    expect(at(1.1)).toBeCloseTo(1, 12);
    expect(at(2.1)).toBeCloseTo(0, 12);
    expect(Math.max(...v.filter((_, i) => time[i] > 2))).toBe(0);
  });
});
