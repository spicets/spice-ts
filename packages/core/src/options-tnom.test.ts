import { describe, expect, it } from 'vitest';
import { parse, parseControlOptions } from './parser/index.js';
import { simulate } from './simulate.js';
import { InvalidCircuitError, ParseError } from './errors.js';

const deck = (options: string, model = '', level = 1) => `JFET nominal temperature
Vd d 0 3
Vg g 0 -1
J1 d g 0 JM
.model JM NJF LEVEL=${level} IS=1e-10 ${model}
${options}
.op`;

describe('bounded circuit TNOM', () => {
  it.each([1, 2])('level %i model TNOM overrides circuit TNOM', async level => {
    const actual = await simulate(deck('.options TEMP=80 TNOM=40', 'TNOM=60', level));
    const explicit = await simulate(deck('.options TEMP=80', 'TNOM=60', level));
    expect(actual.dc!.current('Vg')).toBe(explicit.dc!.current('Vg'));
  });

  it.each(['tnom', 'tnom=', 'tnom=abc', 'tnom=-273.15', 'tnom=1e999'])(
    'rejects malformed or nonphysical nominal temperature: %s', field => {
      expect(() => parse(deck(`.options ${field}`))).toThrow(ParseError);
    },
  );

  it.each([NaN, Infinity, -Infinity, -273.15, -300])('rejects invalid setter value %s', value => {
    const circuit = parse(deck(''));
    expect(() => circuit.setNominalTemperature(value)).toThrow(InvalidCircuitError);
    expect(circuit.nominalTemperature).toBeUndefined();
  });

  it('permits R/C/L and independent and behavioral sources alongside JFETs', () => {
    const circuit = parse(deck('.options TNOM=40\nR1 d x 1k\nC1 x 0 1n\nL1 x y 1m\nI1 y 0 1u\nB1 z 0 V=1\nR2 z 0 1k'));
    expect(() => circuit.compile()).not.toThrow();
  });

  it('permits circuit TNOM for resistor temperature coefficients without a nominal override', () => {
    const circuit = parse(deck('.options TNOM=40\nR1 d 0 1k TC1=0.01'));
    expect(() => circuit.compile()).not.toThrow();
  });

  it('checks unsupported devices inside expanded subcircuits', () => {
    const circuit = parse('nested\nV1 d 0 1\nX1 d mos\n.subckt mos a\nM1 a a 0 0 MM\n.model MM NMOS LEVEL=2\n.ends\n.options TNOM=40\n.op');
    expect(() => circuit.compile()).toThrow(/TNOM=40/);
  });

  it.each([
    'M1 d d 0 0 MM\n.model MM NMOS LEVEL=2',
  ])('rejects unsupported devices at compile time: %s', cards => {
    const circuit = parse(`unsupported nominal\nV1 d 0 1\n${cards}\n.options TNOM=40\n.op`);
    expect(() => circuit.compile()).toThrow(InvalidCircuitError);
    expect(() => circuit.compile()).toThrow(/TNOM=40/);
    circuit.setNominalTemperature(27);
    expect(() => circuit.compile()).not.toThrow();
  });
  it('applies control option TNOM with last assignment winning', () => {
    const circuit = parse(deck(''));
    expect(parseControlOptions(['tnom=30', 'TNOM', '=', '40'], 1, 'option tnom', circuit)).toEqual({});
    expect(circuit.nominalTemperature).toBe(40);
  });
  it('preserves unset and explicit TNOM through control snapshots and serialization', () => {
    const circuit = parse(deck(''));
    expect(circuit.nominalTemperature).toBeUndefined();
    expect(parse(circuit.toNetlist()).nominalTemperature).toBeUndefined();
    const restoreUnset = circuit.snapshotControlState();
    circuit.setNominalTemperature(40);
    const restoreExplicit = circuit.snapshotControlState();
    expect(parse(circuit.toNetlist()).nominalTemperature).toBe(40);
    circuit.setNominalTemperature(60);
    restoreExplicit();
    expect(circuit.nominalTemperature).toBe(40);
    restoreUnset();
    expect(circuit.nominalTemperature).toBeUndefined();
  });
  it.each([1, 2])('level %i inherits circuit TNOM as model default', async level => {
    const inherited = parse(deck('.options TEMP=80 TNOM=40', '', level));
    expect(inherited.nominalTemperature).toBe(40);
    expect(inherited.simulationOptions).toEqual({});
    const actual = await simulate(inherited);
    const explicit = await simulate(deck('.options TEMP=80', 'TNOM=40', level));
    const defaultNominal = await simulate(deck('.options TEMP=80', '', level));
    expect(actual.dc!.current('Vg')).toBe(explicit.dc!.current('Vg'));
    expect(actual.dc!.current('Vg')).not.toBe(defaultNominal.dc!.current('Vg'));
  });
});
