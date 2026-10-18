import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { ngspiceFourier } from './fourier.js';
import { parse } from '../index.js';

const directory = new URL('../../../../../benchmarks/control-fourier/', import.meta.url);
const deck = readFileSync(new URL('harmonics.cir', directory), 'utf8');
const reference = readFileSync(new URL('ngspice-47.txt', directory), 'utf8');
const tables = reference.split('Fourier analysis for ').slice(1).map(block => ({
  thd: Number(/THD: ([\deE+.-]+)/.exec(block)![1]),
  rows: block.split('\n').filter(line => /^ \d+\s/.test(line)).map(line => line.trim().split(/\s+/).map(Number)),
}));

describe('fourier (#1334)', () => {
  it('matches ngspice-47 for spaced expressions on the identical expression deck', async () => {
    const expressionDeck = readFileSync(new URL('expressions.cir', directory), 'utf8');
    const oracle = readFileSync(new URL('expressions-ngspice-47.txt', directory), 'utf8')
      .split('Fourier analysis for ').slice(1);
    const actual = (await simulate(expressionDeck)).control!.fourier!;
    expect(actual).toHaveLength(oracle.length);
    oracle.forEach((block, i) => {
      expect(Math.abs(actual[i].thd - Number(/THD: ([\deE+.-]+)/.exec(block)![1]))).toBeLessThan(1e-3);
      const rows = block.split('\n').filter(line => /^ \d+\s/.test(line)).map(line => line.trim().split(/\s+/).map(Number));
      expect(actual[i].harmonics).toHaveLength(rows.length);
      rows.forEach((row, j) => {
        if (Math.abs(row[2]) > rows[1][2] * 1e-6) {
          expect(Math.abs(actual[i].harmonics[j].magnitude - row[2]) / Math.abs(row[2])).toBeLessThan(1e-3);
          expect(Math.abs(actual[i].harmonics[j].phase - row[3])).toBeLessThan(1e-3);
        }
      });
    });
  });

  it.each([
    ['v(out) + v(a)', ['v(out)+v(a)']],
    ['v(out) + v(a) v(a) v(out) - 2 * v(a)', ['v(out)+v(a)', 'v(a)', 'v(out)-2*v(a)']],
    ['(v(out) + v(a)) / 2 v(out)', ['(v(out)+v(a))/2', 'v(out)']],
  ])('parses spaced Fourier expressions and mixed operands: %s', async (operands, compact) => {
    const run = (args: string) => simulate(deck.replace('fourier 10k v(out) v(a)', `fourier 10k ${args}`));
    const actual = (await run(operands)).control!.fourier!;
    const expected = (await run(compact.join(' '))).control!.fourier!;
    expect(actual).toHaveLength(compact.length + 1);
    actual.forEach((table, i) => {
      expect(table.harmonics).toEqual(expected[i].harmonics);
      expect(table.thd).toBe(expected[i].thd);
    });
    expect(actual[0].thd).toBeCloseTo(11.1797, 3);
  });

  it('accepts the unchanged corpus-f 100W deck past its former fourier parser blocker', () => {
    const original = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-f/fixtures/examples/vdmos/100W.sp', import.meta.url), 'utf8');
    expect(() => parse(original)).not.toThrow();
  });

  it('interpolates a cubic over only the last period and honours degree zero', () => {
    const time = Float64Array.from({ length: 25 }, (_, i) => i / 4);
    const values = time.map(t => t ** 3 - t);
    const grid = Float64Array.from({ length: 200 }, (_, i) => 5 + i / 200);
    const expected = ngspiceFourier('polynomial', grid, grid.map(t => t ** 3 - t), 1, 10, 200, 0, 1);
    const result = ngspiceFourier('polynomial', time, values, 1, 10, 200, 3, 1);
    result.harmonics.forEach((row, i) => {
      expect(row.magnitude).toBeCloseTo(expected.harmonics[i].magnitude, 10);
      expect(row.phase).toBeCloseTo(expected.harmonics[i].phase, 10);
    });
  });

  it('honours nperiods, saves THD, and fournosave suppresses saved vectors without suppressing output', async () => {
    const result = await simulate(deck.replace('fourier 10k v(out) v(a)', () => 'set nperiods=2\nfourier 10k v(out)\necho $&thd11\nset fournosave'));
    expect(result.control!.fourier![0].gridSize).toBe(400);
    expect(result.control!.fourier![0].periods).toBe(2);
    expect(result.control!.output.some(line => Math.abs(Number(line) - result.control!.fourier![0].thd) < 1e-3)).toBe(true);
    await expect(simulate(deck.replace('fourier 10k v(out) v(a)', () => 'set fournosave\nfourier 10k v(out)\necho $&thd11'))).rejects.toThrow('thd11');
  });

  it.each([
    'v(out)+v(a)',
    'v(out) + v(a)',
    'v(out)\t+\tv(a)',
  ])('treats %s as one Fourier expression regardless of whitespace', async operand => {
    const result = await simulate(deck.replace('fourier 10k v(out) v(a)', `fourier 10k ${operand}`));
    expect(result.control!.fourier).toHaveLength(2);
    // ngspice-47 on the identical deck with this sum reports THD 11.1797%.
    expect(result.control!.fourier![0].thd).toBeCloseTo(11.1797, 3);
    expect(result.control!.output).toContain(`Fourier analysis for ${operand}:`);
  });

  it('preserves separate vectors alongside arithmetic and nested calls', async () => {
    const operands = ['v(out) + v(a)', 'v(out)', '(v(out) - v(a)) * 2', 'abs(v(a) + v(out))'];
    const result = await simulate(deck.replace('fourier 10k v(out) v(a)', () => `fourier 10k ${operands.join(' ')}\necho $&thd12`));
    expect(result.control!.fourier).toHaveLength(5);
    expect(result.control!.fourier![0].thd).toBeCloseTo(11.1797, 3);
    expect(result.control!.fourier![1].thd).toBeCloseTo(tables[0].thd, 3);
    expect(result.control!.fourier![2].harmonics[1].magnitude).toBeLessThan(1e-10);
    for (const operand of operands) expect(result.control!.output).toContain(`Fourier analysis for ${operand}:`);
    expect(result.control!.output.some(line => Math.abs(Number(line) - result.control!.fourier![1].thd) < 1e-3)).toBe(true);
  });

  it('matches ngspice-47 harmonic magnitudes, phases, normalization and THD on the identical six-period deck', async () => {
    const result = await simulate(deck);
    expect(result.control!.fourier).toHaveLength(3);
    result.control!.fourier!.forEach((analysis, index) => {
      const expected = tables[index];
      expect(analysis.harmonics).toHaveLength(expected.rows.length);
      expect(Math.abs(analysis.thd - expected.thd)).toBeLessThan(1e-3);
      analysis.harmonics.forEach((row, harmonic) => {
        const values = expected.rows[harmonic];
        expect(row.frequency).toBe(values[1]);
        if (Math.abs(values[2]) > expected.rows[1][2] * 1e-6) {
          expect(Math.abs(row.magnitude - values[2]) / Math.abs(values[2])).toBeLessThan(1e-3);
          expect(Math.abs(row.phase - values[3])).toBeLessThan(1e-3);
          expect(Math.abs(row.normalizedMagnitude - values[4])).toBeLessThan(1e-3);
          expect(Math.abs(row.normalizedPhase - values[5])).toBeLessThan(1e-3);
        }
      });
    });
    expect(result.control!.output.join('\n')).toContain('Fourier analysis for v(out)');
    expect(result.control!.output.join('\n')).toContain('THD:');
  });

  it.each([
    ['fourier 0 v(out)', 'bad fundamental'],
    ['fourier 1 v(out)', 'longer than time span'],
    ['fourier 10k v(missing)', 'no such vector'],
    ['fourier 10k', 'missing vector'],
  ])('rejects invalid input: %s', async (command, message) => {
    await expect(simulate(deck.replace(/fourier 10k v\(out\) v\(a\)/, command))).rejects.toThrow(message);
  });
});
