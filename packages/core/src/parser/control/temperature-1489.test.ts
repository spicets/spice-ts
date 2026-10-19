import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../index.js';
import { readFileSync } from 'node:fs';

const deck = (script: string) => `runtime temperature
V1 n 0 0.6
R1 n 0 r={5000+50*TEMPER}
D1 n 0 dm
.model dm D(IS=1e-14 N=1)
.control
${script}
.endc
.end`;

describe('runtime control temperature (#1489)', () => {
  it('completes the unchanged dc_loop deck and writes all six transposed rows', async () => {
    const text = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/various/dc_loop.sp', import.meta.url), 'utf8');
    const result = await simulate(text);
    const output = result.control!.files!.find(file => file.path === 'dc_loop.out')!.contents;
    expect(output).toContain('No. Variables: 7');
    expect(output).toContain('No. Points: 5');
    for (let index = 0; index < 6; index++) expect(output).toContain(`result[${index}]`);
    expect(result.control!.runs).toHaveLength(5);
  });

  it('updates built-in diode temperature without a TEMPER expression', async () => {
    const result = await simulate(deck('set temp=100\nop').replace('R1 n 0 r={5000+50*TEMPER}\n', ''));
    // The same oracle current above with the parallel 10k resistor current removed.
    expect(result.dc!.current('V1')).toBeCloseTo(-1.08599093631139e-2 + 0.6 / 10000, 10);
  });

  it('re-evaluates TEMPER resistance and diode temperature for op and dc', async () => {
    const result = await simulate(deck(`foreach t 27 100 27
set temp = $t
op
print i(v1)
dc v1 0.6 0.6 0.1
print i(v1)
end`));
    const currents = result.control!.runs.map(run => run.result.dc?.current('V1') ?? run.result.dcSweep?.current('V1')[0]);
    // ngspice-47 printed i(v1), identical deck, numdgt=15.
    expect(currents).toHaveLength(6);
    expect(currents[0]).toBeCloseTo(-2.13207818535085e-4, 12);
    expect(currents[1]).toBeCloseTo(currents[0]!, 12);
    expect(currents[2]).toBeCloseTo(-1.08599093631139e-2, 10);
    expect(currents[3]).toBeCloseTo(currents[2]!, 12);
    expect(currents[4]).toBeCloseTo(currents[0]!, 12);
    expect(currents[5]).toBeCloseTo(currents[0]!, 12);
  });

  it('preserves alter, altermod and solver options across temperature evaluation', async () => {
    const result = await simulate(deck(`alter V1 0.5
altermod dm IS=2e-14
option gmin=1e-12
set temp=100
op
print i(v1)
set temp=27
op
print i(v1)`));
    expect(result.control!.runs.map(run => run.result.dc!.voltage('n'))).toEqual([0.5, 0.5]);
    expect(result.control!.runs[0].result.dc!.current('V1')).toBeCloseTo(-1.01348675008816e-3, 10);
  });

  it('restores the caller circuit after control execution', async () => {
    const circuit = parse(deck('set temp=100\nop'));
    await simulate(circuit);
    expect(circuit.temperature).toBeUndefined();
  });

  it.each(['-273.15', 'nan', ''])('rejects invalid temperature %s', async value => {
    await expect(simulate(deck(`set temp=${value}\nop`))).rejects.toThrow(/Invalid .options temp|Cannot parse number/);
  });
});
