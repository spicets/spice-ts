import { describe, expect, it } from 'vitest';
import { parse, parseAsync } from './index.js';
import { simulate, simulateStream } from '../simulate.js';

const deck = (cards: string, analysis = '.op') => `temperature directive #871
V1 a 0 1
R1 a 0 {1000+temper}
B1 b 0 V=temper
R2 b 0 1k
${cards}
${analysis}
.end`;

// Identical ngspice-47 controls and source references: benchmarks/temp-directive-871/.
describe('.temp single circuit temperature (#871)', () => {
  it.each([
    ['.temp 77', 77],
    ['.TEMP -40', -40],
    ['.temp=77', 77],
    ['.temp = 77', 77],
    ['.temp 7.7e1', 77],
    ['.temp 77\n.options temp=127', 77],
    ['.options temp=127\n.temp 77', 77],
    ['.temp 77\n.temp 127', 127],
    ['.temp', 0],
    ['.temp abc', 27],
    ['.temp 77C', 27],
    ['.temp 77k', 27],
    ['.param t=77\n.temp {t}', 77],
    [".temp '77'", 77],
  ])('%s sets circuit, numparam and behavioral temperatures to %s C', async (cards, temperature) => {
    for (const circuit of [parse(deck(cards)), await parseAsync(deck(cards))]) {
      expect(circuit.temperature).toBe(temperature);
      expect(parse(circuit.toNetlist()).temperature).toBe(temperature);
    }
    const result = await simulate(deck(cards));
    expect(result.dc!.voltage('b')).toBeCloseTo(temperature, 10);
    expect(result.dc!.current('V1')).toBeCloseTo(-1 / (1000 + temperature), 12);
  });

  it('warns when a malformed numeric card falls back to 27 C like ngspice-47', () => {
    expect(parse(deck('.temp abc')).parseWarnings.join('\n')).toContain('27 C');
  });

  it.each(['.temp 27 77', '.temp -300', '.temp abc', '.temp {missing}', '.temp {temper+1}'])(
    'ignores overwritten temperature cards before validation: %s', async obsolete => {
      const cards = `${obsolete}\n.temp 77`;
      for (const circuit of [parse(deck(cards)), await parseAsync(deck(cards))]) {
        expect(circuit.temperature).toBe(77);
        expect(circuit.parseWarnings).toEqual([]);
      }
      const netlist = deck(cards, '.tran 1u 5u');
      const batch = await simulate(netlist);
      const streamed = [];
      for await (const point of simulateStream(netlist)) {
        if ('time' in point) streamed.push(point);
      }
      expect(streamed.length).toBeGreaterThan(0);
      expect(Array.from(batch.transient!.voltage('b'))).toEqual(streamed.map(point => point.voltages.get('b')));
      expect(Array.from(batch.transient!.voltage('b')).every(value => value === 77)).toBe(true);
      expect(Array.from(batch.transient!.current('V1'))).toEqual(streamed.map(point => point.currents.get('V1')));
    },
  );

  it.each(['.temp 27 77', '.temp -300', '.temp {temper+1}'])(
    'retains limitations of the final effective card: %s', async final => {
      const netlist = deck(`.temp 77\n${final}`);
      expect(() => parse(netlist)).toThrow();
      await expect(parseAsync(netlist)).rejects.toThrow();
      await expect(simulate(netlist)).rejects.toThrow();
      await expect(async () => {
        for await (const point of simulateStream(netlist)) void point;
      }).rejects.toThrow();
    },
  );

  it('diagnoses a temperature-dependent parameter instead of freezing a circular temperature', () => {
    expect(() => parse(deck('.param t=temper+1\n.temp {t}'))).toThrow(/\.temp expressions depending on TEMPER are not supported/);
  });

  it.each(['.temp 27 77', '.temp=27 77', '.temp {27} {77}'])('explicitly rejects unsupported multiple temperatures: %s', async cards => {
    expect(() => parse(deck(cards))).toThrow(/Unsupported multi-temperature \.temp/);
    await expect(simulate(deck(cards))).rejects.toThrow(/Unsupported multi-temperature \.temp/);
  });

  it.each(['.temp -273.15', '.temp 1e999'])('rejects nonphysical/nonfinite circuit temperatures: %s', cards => {
    expect(() => parse(deck(cards))).toThrow();
  });

  it('preserves options while .temp takes temperature precedence', () => {
    const circuit = parse(deck('.temp 77\n.options temp=127 reltol=1e-4 gmin=1e-12 method=gear'));
    expect(circuit.temperature).toBe(77);
    expect(circuit.simulationOptions).toEqual({ reltol: 1e-4, deviceGmin: 1e-12, integrationMethod: 'gear2' });
  });

  it('reuses existing instance temperature and resistor TC semantics', async () => {
    const result = await simulate(`device temperature\nV1 a 0 1\nR1 a 0 1k tc1=0.001\nB2 c 0 V=1 temp=27 tc1=0.01\nR2 c 0 1k\n.temp 127\n.op\n.end`);
    expect(result.dc!.current('V1')).toBeCloseTo(-1 / 1100, 12);
    expect(result.dc!.voltage('c')).toBeCloseTo(1, 12);
  });

  it('keeps resistor instance TEMP fixed under .temp and .options TEMP (#1808)', async () => {
    const netlist = `instance temp\nV1 a 0 1\nR1 a 0 1k temp=27 tc1=0.01\n.temp 127\n.op\n.end`;
    for (const directive of ['.temp 127', '.options temp=127']) {
      const result = await simulate(netlist.replace('.temp 127', directive));
      expect(result.dc!.current('V1')).toBeCloseTo(-0.001, 12);
    }
  });

  it('uses identical temperature in batch and streaming transient APIs', async () => {
    const netlist = deck('.temp 77\n.options temp=127', '.tran 1u 5u');
    const batch = await simulate(netlist);
    const streamed = [];
    for await (const point of simulateStream(netlist)) {
      if ('time' in point) streamed.push(point);
    }
    expect(streamed.length).toBeGreaterThan(0);
    expect(Array.from(batch.transient!.voltage('b'))).toEqual(streamed.map(point => point.voltages.get('b')));
    expect(Array.from(batch.transient!.current('V1'))).toEqual(streamed.map(point => point.currents.get('V1')));
  });
});
