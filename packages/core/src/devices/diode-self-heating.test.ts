import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from '../parser/index.js';


// ngspice-47, identical deck, `op; print v(tj) i(v1)` at numdgt=15.
const deck = `Self heating diode reference
V1 in 0 0.7
D1 in 0 tj DM thermal
.model DM D (RS=0.2 RTH0=100 TNOM=25)
.options reltol=1e-10 abstol=1e-14 vntol=1e-12
.op
.end`;

describe('diode self-heating (#1261)', () => {
  it.each(['{a}', '{a * 1}'])('preserves positional AREA %s inside subcircuits', async area => {
    const result = await simulate(`Area regression
V1 in 0 0.6
X1 in cell a=2
.subckt cell in params: a=1
D1 in 0 DM ${area}
.model DM D
.ends
.op
.end`);
    const reference = await simulate(`Literal area reference
V1 in 0 0.6
D1 in 0 DM 2
.model DM D
.op
.end`);
    expect(result.dc!.current('V1')).toBeCloseTo(-0.00023743925851741482, 12);
    expect(result.dc!.current('V1')).toBe(reference.dc!.current('V1'));
  });

  it('evaluates positional AREA without losing a subcircuit thermal node', async () => {
    const result = await simulate(deck.replace('D1 in 0 tj DM thermal', `X1 in tj cell a=2
.subckt cell in t params: a=1
D1 in 0 t DM {a} thermal
.ends`));
    const reference = await simulate(deck.replace('DM thermal', 'DM 2 thermal'));
    expect(result.dc!.voltage('tj')).toBe(reference.dc!.voltage('tj'));
    expect(result.dc!.current('V1')).toBe(reference.dc!.current('V1'));
  });

  it.each(['1N4148', '2N_model'])('accepts digit-prefixed thermal model %s at top level and in subcircuits', async model => {
    const namedDeck = deck.replaceAll('DM', model);
    const topLevel = await simulate(namedDeck);
    const nested = await simulate(namedDeck.replace(`D1 in 0 tj ${model} thermal`, `X1 in tj cell
.subckt cell a t
D1 a 0 t ${model} thermal
.ends`));
    for (const result of [topLevel, nested]) {
      expect(Math.abs(result.dc!.voltage('tj') / 0.5266979962662843 - 1)).toBeLessThan(1e-6);
      expect(Math.abs(result.dc!.current('V1') / -0.00752425708951854 - 1)).toBeLessThan(1e-6);
    }
  });

  it('matches ngspice-47 OP temperature rise and current within 1 ppm', async () => {
    const result = await simulate(deck);
    expect(Math.abs(result.dc!.voltage('tj') / 0.5266979962662843 - 1)).toBeLessThan(1e-6);
    expect(Math.abs(result.dc!.current('V1') / -0.00752425708951854 - 1)).toBeLessThan(1e-6);
  });

  it('maps the third node inside a subcircuit and survives netlist serialization', async () => {
    const circuit = parse(deck.replace('D1 in 0 tj DM thermal', `X1 in tj cell
.subckt cell a t
D1 a 0 t DM thermal
.ends`));
    const result = await simulate(circuit);
    expect(Math.abs(result.dc!.voltage('tj') / 0.5266979962662843 - 1)).toBeLessThan(1e-6);
    const roundtrip = await simulate(parse(deck).toNetlist());
    expect(roundtrip.dc!.voltage('tj')).toBeCloseTo(result.dc!.voltage('tj'), 9);
  });

  it('integrates CTH0 with the thermal RC time constant', async () => {
    const result = await simulate(`thermal RC
V1 in 0 0
Iheat 0 tj PULSE(0 1 1m 1u 1u 1 2)
D1 in 0 tj DM thermal
.model DM D (RTH0=100 CTH0=1m)
.tran 100u 0.201 0 100u
.end`);
    const final = result.transient!.voltage('tj').at(-1)!;
    expect(Math.abs(final / (100 * (1 - Math.exp(-2))) - 1)).toBeLessThan(0.001);
  });


  it('runs pulsed junction and diffusion charge with thermal capacitance (#1801)', async () => {
    const { readFileSync } = await import('node:fs');
    const reference = JSON.parse(readFileSync(new URL('./fixtures/diode-selfheat-1801.json', import.meta.url), 'utf8')) as number[][];
    const netlist = readFileSync(new URL('../../../../benchmarks/circuits/diode-selfheat-tran-1801.cir', import.meta.url), 'utf8');
    const result = await simulate(netlist);
    expect(result.transient!.time.at(-1)).toBeCloseTo(40e-6, 12);
    expect(Math.max(...result.transient!.voltage('tj'))).toBeGreaterThan(1);
    expect(result.transient!.voltage('anode').every(Number.isFinite)).toBe(true);
    const transient = result.transient!;
    const vectors = [transient.voltage('anode'), transient.current('V1'), transient.voltage('tj')];
    for (const [column, values] of vectors.entries()) {
      const peak = Math.max(...reference.map(row => Math.abs(row[column + 1])));
      let index = 1;
      for (const row of reference) {
        while (index < transient.time.length - 1 && transient.time[index] < row[0]) index++;
        const weight = (row[0] - transient.time[index - 1]) / (transient.time[index] - transient.time[index - 1]);
        const actual = values[index - 1] + weight * (values[index] - values[index - 1]);
        expect(Math.abs(actual - row[column + 1]) / peak).toBeLessThan(0.01);
      }
    }
  });

  it('rejects the unimplemented thermal RS plus junction-charge path', async () => {
    await expect(simulate(deck.replace('RTH0=100', 'RTH0=100 CJO=1p'))).rejects.toThrow('junction charge');
  });
});
