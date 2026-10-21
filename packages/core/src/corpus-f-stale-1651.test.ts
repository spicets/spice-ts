import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from './simulate.js';

const root = new URL('../../../benchmarks/corpus/corpus-f/', import.meta.url);
const cases = [
  ['examples/Monte_Carlo/MC_ring.sp', /unexpected character '\$'/],
  ['examples/Monte_Carlo/MonteCarlo.sp', /sunif\(\).*not evaluated/],
  ['examples/Monte_Carlo/rand_numb_test.cir', /Unknown function 'agauss'/],
  ['examples/probe/mos-test.cir', /Unsupported saved device vector/],
  ['examples/xspice/transmission_lines/cpline_tran.cir', /cpline transient analysis is not supported/],
] as const;

describe('corpus-f stale unsupported rows (#1651)', () => {
  for (const [sourcePath, oldError] of cases) {
    it(`${sourcePath} no longer stops at the pre-merge error`, async () => {
      const report = JSON.parse(readFileSync(new URL('outcomes.json', root), 'utf8'));
      const row = report.fixtures.find((fixture: { sourcePath: string }) => fixture.sourcePath === sourcePath);
      expect(row).toBeDefined();
      expect(row.spiceTs.firstErrorLine ?? '').not.toMatch(oldError);
      const text = readFileSync(new URL(`fixtures/${sourcePath}`, root), 'utf8');
      // A new numerical failure is not success, but must not resurrect a removed syntax blocker.
      try {
        await simulate(text);
      } catch (error) {
        expect(String(error)).not.toMatch(oldError);
        expect(sourcePath).toBe('examples/Monte_Carlo/MC_ring.sp');
        expect(String(error)).toMatch(/Convergence failed/);
      }
    }, 120_000);
  }
});
