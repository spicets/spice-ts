import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';

interface ReferencePlot { analysis: 'op' | 'dc'; variables: string[]; points: number[][] }
interface ReferenceCase { deck: string; sha256: string; plots: ReferencePlot[] }
const base = new URL('../../../../../benchmarks/bsim4-diomod/', import.meta.url);
const reference = JSON.parse(readFileSync(new URL('ngspice-47.json', base), 'utf8')) as { cases: ReferenceCase[] };

describe('BSIM4 DIOMOD identical-deck ngspice-47 parity', () => {
  for (const item of reference.cases) it(`${item.deck}: NMOS/PMOS OP and forward/reverse DC`, async () => {
    const deck = readFileSync(new URL(item.deck, base), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(item.sha256);
    const result = await simulate(deck);
    for (const plot of item.plots) {
      const errors: Record<string, { abs: number; rel: number; rms: number }> = {};
      for (const [column, signal] of plot.variables.entries()) {
        if (signal === 'v(v-sweep)') continue;
        const name = signal.slice(2, -1);
        const actual = plot.analysis === 'op'
          ? [signal.startsWith('i(') ? result.dc!.current(name) : result.dc!.voltage(name)]
          : signal.startsWith('i(') ? result.dcSweep!.current(name) : result.dcSweep!.voltage(name);
        expect(actual).toHaveLength(plot.points.length);
        const error = { abs: 0, rel: 0, rms: 0 };
        plot.points.forEach((point, index) => {
          const abs = Math.abs(actual[index] - point[column]);
          const rel = abs / Math.max(Math.abs(point[column]), Number.MIN_VALUE);
          error.abs = Math.max(error.abs, abs);
          error.rel = Math.max(error.rel, rel);
          error.rms += rel * rel / plot.points.length;
          // Existing BSIM4 gate-current parity criterion, unchanged.
          expect(abs <= 1e-15 || rel <= 1e-6, `${signal} ${plot.analysis} point ${index}: ${abs}, ${rel}`).toBe(true);
        });
        error.rms = Math.sqrt(error.rms);
        errors[signal] = error;
      }
      console.info(`${item.deck} ${plot.analysis} ${JSON.stringify(errors)}`);
    }
  });
});
