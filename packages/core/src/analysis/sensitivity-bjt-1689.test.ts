import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../errors.js';
import { simulate } from '../simulate.js';

function deck(is = 1e-16, bf = 80, vaf = 50, m = 1, analysis = '.sens v(out)'): string {
  return `BJT DC sensitivity
Vcc supply 0 5
Vb input 0 0.65
Rb input base 10k
R1 supply out 2k
Q1 out base 0 test m=${m}
.model test npn(is=${is} bf=${bf} vaf=${vaf} rb=100 rc=10 re=2)
.options reltol=1e-12 abstol=1e-18 vntol=1e-12
${analysis}
.end`;
}

describe('bounded BJT DC sensitivity', () => {
  it('matches independent public-API finite differences including tiny IS', async () => {
    const result = (await simulate(deck())).sensitivity!;
    for (const [parameter, nominal, index] of [
      ['bjt:is', 1e-16, 0], ['bjt:bf', 80, 1], ['bjt:vaf', 50, 2], ['multiplier', 1, 3],
    ] as const) {
      const step = nominal * 2e-4;
      const high = [1e-16, 80, 50, 1];
      const low = [...high];
      high[index] += step;
      low[index] -= step;
      const voltage = async (values: number[]) => (await simulate(deck(
        values[0], values[1], values[2], values[3], '.op',
      ))).dc!.voltage('out');
      const expected = ((await voltage(high)) - (await voltage(low))) / (2 * step);
      const actual = result.entries.find(entry => entry.device === 'Q1' && entry.parameter === parameter)!.dc!;
      expect(Math.abs((actual - expected) / expected), parameter).toBeLessThanOrEqual(1e-6);
    }
    // Supported model subset follows ngspice-47 bjt.c parameter-table order.
    expect(result.entries.filter(entry => entry.device === 'Q1').map(entry => entry.parameter))
      .toEqual(['bjt:is', 'bjt:bf', 'bjt:nf', 'bjt:vaf', 'bjt:br', 'bjt:nr', 'multiplier']);
    expect(result.entries.some(entry => /^Q1\./.test(entry.device))).toBe(false);
    expect((await simulate(deck())).sensitivity).toEqual(result);
  });

  it('keeps unsupported nonlinear devices as typed errors', async () => {
    await expect(simulate(`Unsupported diode sensitivity
V1 a 0 1
R1 a b 1k
D1 b 0 test
.model test d
.sens v(b)
.end`)).rejects.toBeInstanceOf(InvalidCircuitError);
  });

  it('exports distinct control vectors in ngspice-47 BJT table order', async () => {
    const names = ['q1:is', 'q1:bf', 'q1:nf', 'q1:vaf', 'q1:br', 'q1:nr', 'q1_m'];
    const result = await simulate(deck(1e-16, 80, 50, 1,
      '.control\nsens v(out)\nwrite bjt.raw all\n.endc'));
    const raw = result.control!.files!.find(file => file.path === 'bjt.raw')!.contents;
    const exported = raw.split(/\r?\n/).filter(line => /^\s*\d+\s+q1/.test(line))
      .map(line => line.trim().split(/\s+/)[1]);
    expect(exported).toEqual(names);
  });
});
