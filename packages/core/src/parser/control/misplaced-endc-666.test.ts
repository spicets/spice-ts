import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParseError } from '../../errors.js';
import { simulate } from '../../simulate.js';
import { parse, parseTitleless } from '../index.js';
import { extractControlBlocks } from './source.js';
import { UnsupportedControlCommandError } from './errors.js';

// ngspice-47 src/frontend/inp.c (inp_spsource): a `.endc` card outside a
// `.control` section is removed from the deck after printing
// "Warning: misplaced .endc card"; reading continues.
const MISPLACED = 'misplaced .endc card';

const deck = `misplaced endc
V1 1 0 dc 2
R1 1 2 1k
R2 2 0 1k
.op
.endc
.end`;

describe('#666 misplaced .endc warns and continues like ngspice-47', () => {
  it('blanks a stray .endc and reports it instead of throwing', () => {
    const extracted = extractControlBlocks('R1 1 0 1k\n.endc\n.op', false, 1);
    expect(extracted.netlist).toBe('R1 1 0 1k\n\n.op');
    expect(extracted.blocks).toEqual([]);
    expect(extracted.warnings).toEqual([{ message: `${MISPLACED} (line 3)`, line: 3 }]);
  });

  it('parses a deck with a stray .endc and keeps its devices and analyses', () => {
    const circuit = parse(deck);
    expect(circuit.compile().devices.map(device => device.name)).toEqual(['V1', 'R1', 'R2']);
    expect(circuit.parseWarnings).toEqual([`${MISPLACED} (line 6)`]);
    expect(parseTitleless('V1 1 0 1\nR1 1 0 1k\n.op\n.endc').parseWarnings).toEqual([`${MISPLACED} (line 4)`]);
  });

  it('surfaces the warning from simulate() and solves the deck', async () => {
    const result = await simulate(deck);
    expect(result.dc!.voltage('2')).toBeCloseTo(1, 12);
    expect(result.warnings).toContainEqual({ type: 'parse', message: `${MISPLACED} (line 6)` });
  });

  it('accepts a second .endc after a closed .control block (ro_nand_digi.cir shape)', async () => {
    const result = await simulate(deck.replace('.endc\n', () => '.control\nlet gain = 2\necho gain is $&gain\n.endc\n\n.endc\n'));
    expect(result.control?.output).toContain('gain is 2');
    expect(result.dc!.voltage('2')).toBeCloseTo(1, 12);
    expect(result.warnings).toContainEqual({ type: 'parse', message: `${MISPLACED} (line 11)` });
  });

  it('still rejects an unterminated or nested .control block', () => {
    expect(() => parse(`${deck}\n.control\nrun`)).toThrow(ParseError);
    expect(() => parse(`${deck}\n.control\n.control\n.endc`)).toThrow(ParseError);
  });

  it('moves ro_nand_digi.cir past the stray .endc and scoped D_NAND to edisplay (#1283)', async () => {
    const netlist = readFileSync(new URL(
      '../../../../../benchmarks/corpus/corpus-f/fixtures/examples/xspice/various/ro_nand_digi.cir',
      import.meta.url,
    ), 'utf8');
    const error = await simulate(netlist).then(() => undefined, (caught: unknown) => caught);
    expect(String(error)).not.toContain('.endc');
    expect(error).toBeInstanceOf(UnsupportedControlCommandError);
    expect(String(error)).toContain("Unsupported .control command 'edisplay'");
  });
});
