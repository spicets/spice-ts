import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from './parser/index.js';
import { simulate } from './simulate.js';
import { createTransientSim } from './analysis/transient-driver.js';
import { validateProtocolV1 } from './protocol/adapter.js';
import { ParseError } from './errors.js';

const minimal = 'print placeholder\n.print tran {v(drain)}_mean\n.tran 1n 1.5u\n';
const fixtures = [
  'EMBEDDED/printLine_for_embedded_cmosInverter.cir',
  'PCE/NI_REGRESSION/printLine_for_cmosInverter_regr.cir',
];

describe('element-free transient decks (#1192)', () => {
  it('does not drop devices after a brace-bearing output card', () => {
    const compiled = parse(`${minimal}V1 drain 0 1\nR1 drain 0 1k\n`).compile();
    expect(compiled.devices).toHaveLength(2);
    expect(compiled.nodeCount).toBe(1);
  });

  it.each(['minimal', ...fixtures])('runs the time-only transient for %s', async name => {
    const deck = name === 'minimal' ? minimal : readFileSync(new URL(
      `../../../benchmarks/corpus/corpus-g/fixtures/${name}`, import.meta.url,
    ), 'utf8');
    expect(parse(deck).compile().devices).toHaveLength(0);
    const result = await simulate(deck);
    expect(result.transient!.time).toHaveLength(1508);
    expect(result.transient!.time[0]).toBe(0);
    expect(result.transient!.time.at(-1)).toBeCloseTo(1.5e-6, 18);
    expect(result.transient!.voltages.size).toBe(0);
    expect(result.transient!.currents.size).toBe(0);
    expect(result.warnings.some(w => w.message.includes('not evaluated'))).toBe(true);
  });

  it('supports the incremental driver and protocol validation too', async () => {
    const driver = await createTransientSim(minimal);
    expect(driver.advance().voltages.size).toBe(0);
    driver.dispose();
    await expect(validateProtocolV1({
      apiVersion: '1', input: { format: 'spice', source: '.tran 1n 1.5u' },
    })).resolves.toMatchObject({ status: 'valid', nodeCount: 0 });
  });

  it('still names unsupported directives in a structured parse error', () => {
    try {
      parse(`${minimal}.sampling nonsense\n`);
      expect.fail('expected unsupported directive error');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({ context: '.sampling nonsense' });
      expect((error as Error).message).toMatch(/sampling/i);
    }
  });

  // ngspice-47 tests/regression/misc/empty-1.cir runs op on a 0x0 matrix.
  it('accepts an empty operating-point deck like ngspice-47', async () => {
    const result = await simulate('empty\n.op\n');
    expect(result.dc!.voltages.size).toBe(0);
    expect(result.dc!.currents.size).toBe(0);
    await expect(validateProtocolV1({
      apiVersion: '1', input: { format: 'spice', source: '.op' },
    })).resolves.toMatchObject({ status: 'valid', nodeCount: 0 });
  });
});
