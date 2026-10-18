import { describe, expect, it } from 'vitest';
import { parseTitleless as parse } from './index.js';
import { simulate } from '../simulate.js';
import { ParseError, InvalidCircuitError } from '../errors.js';
import { savedCurrentVectors } from '../control-device-output.js';

describe('.option savecurrents and autostop (#1273)', () => {
  it('parses bare boolean flags, preserves them through compilation and serialization', () => {
    const circuit = parse('.option SAVECURRENTS AUTOSTOP\nV1 n 0 1\nR1 n 0 1k\n.op');
    expect(circuit.simulationOptions).toMatchObject({ savecurrents: true, autostop: true });
    expect(circuit.compile().simulationOptions).toMatchObject({ savecurrents: true, autostop: true });
    expect(parse(circuit.toNetlist()).simulationOptions).toMatchObject({ savecurrents: true, autostop: true });
  });

  it.each(['savecurrents=1', 'savecurrents=true', 'savecurrents=', 'autostop=0', 'autostop=false', 'autostop=wat'])('rejects non-boolean-flag syntax %s', field => {
    expect(() => parse(`.option ${field}\n.op`)).toThrow(ParseError);
    expect(() => parse(`.options output ${field}\n.op`)).toThrow(ParseError);
  });

  it('samples complete DC vectors for all supported current readouts', async () => {
    const result = await simulate(`saved currents
.option savecurrents
V1 n 0 0
R1 n 0 1k
I1 n 0 1m
B1 n 0 I=v(n)*0.002
D1 n 0 DM
.model DM D
.dc v1 0 0.2 0.1
.control
run
let count = length(@r1[i])
let error = vecmax(abs(@r1[i] + @i1[current] + @b1[i] + @d1[id] + @v1[i]))
echo count $&count
echo error $&error
.endc
.end`);
    const vectors = result.dcSweep!.deviceVectors;
    expect([...vectors.keys()].sort()).toEqual(['@b1[i]', '@d1[id]', '@i1[current]', '@r1[i]', '@v1[i]']);
    expect([...vectors.get('@r1[i]')!]).toEqual([0, 0.0001, 0.0002]);
    for (const values of vectors.values()) expect(values).toHaveLength(3);
    expect(result.control!.output[0]).toBe('count 3');
    expect(Number(result.control!.output[1].split(' ')[1])).toBeLessThan(1e-10);
  });

  it('rejects automatic current saving for unsupported device types explicitly', async () => {
    await expect(simulate('unsupported saved current\n.option savecurrents\nV1 n 0 1\nC1 n 0 1n\n.dc v1 0 1 1\n.end'))
      .rejects.toThrow(InvalidCircuitError);
    await expect(simulate('unsupported saved current\n.option savecurrents\nV1 n 0 1\nC1 n 0 1n\n.dc v1 0 1 1\n.end'))
      .rejects.toThrow(/savecurrents.*C1/i);
  });

  it('merges explicit saves case-insensitively and does not enable saving by default', () => {
    const circuit = parse('V1 n 0 1\nR1 n 0 1k\n.op');
    expect(savedCurrentVectors(circuit.compile())).toEqual([]);
    circuit.setSimulationOptions({ savecurrents: true });
    expect(savedCurrentVectors(circuit.compile(), ['@R1[I]', '@v1[dc]']))
      .toEqual(['@r1[i]', '@v1[dc]', '@v1[i]']);
  });

  it('records changing currents at each accepted transient point, not just final device state', async () => {
    const result = await simulate(`saved transient
.option savecurrents
V1 n 0 PWL(0 0 1m 1)
R1 n 0 1k
I1 n 0 PWL(0 0 1m 2m)
B1 n 0 I=v(n)*0.002
.tran 10u 1m
.control
run
let count = length(@r1[i])
echo count $&count
.endc
.end`);
    const transient = result.transient!;
    expect(Number(result.control!.output[0].split(' ')[1])).toBe(transient.time.length);
    expect(transient.time.length).toBeGreaterThan(10);
    for (const values of transient.deviceVectors.values()) expect(values.length).toBe(transient.time.length);
    transient.voltage('n').forEach((v, i) => {
      expect(transient.deviceVectors.get('@r1[i]')![i]).toBeCloseTo(v / 1000, 15);
    });
    expect(transient.deviceVectors.get('@i1[current]')!.at(-1)).toBeCloseTo(0.002, 12);
    for (let i = 1; i < transient.time.length; i++) {
      const sum = [...transient.deviceVectors.values()].reduce((total, values) => total + values[i], 0);
      expect(Math.abs(sum)).toBeLessThan(1e-10);
    }
  });

  it('keeps other unsupported ngspice option fields typed unsupported', () => {
    expect(() => parse('.option noinit=1\n.op')).toThrow(ParseError);
    expect(() => parse('.option noinit=1\n.op')).toThrow("Unsupported .options field: 'noinit'");
  });

  it('returns full vectors through the API without a control script', async () => {
    const result = await simulate('saved sweep\nV1 n 0 0\nR1 n 0 1k\n.option savecurrents\n.dc v1 0 2 1\n.end');
    expect([...result.dcSweep!.deviceVectors.get('@r1[i]')!]).toEqual([0, 0.001, 0.002]);
  });

  it('honors API overrides and rejects unimplemented analysis saving explicitly', async () => {
    const deck = 'api flags\nV1 n 0 0\nR1 n 0 1k\n.dc v1 0 2 1\n.end';
    expect((await simulate(deck, { savecurrents: true })).dcSweep!.deviceVectors.size).toBe(2);
    expect((await simulate(deck.replace('V1', '.option savecurrents\nV1'), { savecurrents: false }))
      .dcSweep!.deviceVectors.size).toBe(0);
    await expect(simulate(deck.replace('.dc v1 0 2 1', '.op'), { savecurrents: true }))
      .rejects.toThrow(/savecurrents.*op/);
  });
});
