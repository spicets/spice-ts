import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from './index.js';
import { readFileSync } from 'node:fs';

// Self-authored half-wave rectifier. Identical deck is run with ngspice-47 -b.
export const deck = `Half-wave Fourier regression
V1 in 0 SIN(0 2 1k)
D1 in out DM
R1 out 0 1k
.model DM D(IS=1e-14 N=1)
.tran 0.1u 3m 0 0.1u
.four 1k v(out)
.end
`;

describe('.four (#1871)', () => {
  it('attaches the last-period Fourier table to the transient result', async () => {
    const result = await simulate(deck);
    expect(result.transient).toHaveProperty('fourier');
    const table = result.transient!.fourier![0];
    // ngspice-47 -b half-four.cir. Printed table, harmonics 0 through 9.
    const magnitudes = [0.347228, 0.592851, 0.351024, 0.107499, 0.0287632, 0.0454973, 0.00700343, 0.0187371, 0.0120047, 0.00530902];
    const phases = [0, 0, -90, -180, -90, -180, 90, -180, 90, -180];
    expect(table.harmonics).toHaveLength(10);
    table.harmonics.forEach((row, i) => {
      expect(Math.abs(row.magnitude / magnitudes[i] - 1)).toBeLessThanOrEqual(1e-3);
      const delta = ((row.phase - phases[i] + 540) % 360) - 180;
      expect(Math.abs(delta)).toBeLessThanOrEqual(0.1);
    });
    expect(Math.abs(table.thd / 62.7158 - 1)).toBeLessThanOrEqual(1e-3);
    expect(result.warnings.filter(w => /four/i.test(w.message))).toEqual([]);
  });

  it('honours frontend options and multiple voltage/current outputs', async () => {
    const input = deck.replace('.four 1k v(out)', '.options nfreqs = 6 fourgridsize = 400\n.four 1k v(out) v(in,out) i(V1)\n.fourier 1k v(in)');
    const result = await simulate(input);
    const tables = result.transient!.fourier!;
    expect(tables).toHaveLength(4);
    tables.forEach(table => {
      expect(table.harmonics).toHaveLength(6);
      expect(table.gridSize).toBe(400);
    });
    expect(tables[1].harmonics[1].magnitude).toBeGreaterThan(1);
    expect(tables[2].harmonics[1].magnitude).toBeCloseTo(tables[0].harmonics[1].magnitude / 1000, 10);
    expect(result.warnings.filter(w => /four/i.test(w.message))).toEqual([]);
  });

  it('returns a structured diagnostic for a missing vector and insufficient time span', async () => {
    const result = await simulate(deck.replace('.four 1k v(out)', '.four 1k v(missing)\n.four 1 v(out)'));
    expect(result.transient!.fourier).toEqual([]);
    expect(result.warnings.filter(w => w.code === 'FOURIER')).toEqual([
      expect.objectContaining({ line: 7, message: expect.stringContaining('no such vector') }),
      expect.objectContaining({ line: 8, message: expect.stringContaining('longer than time span') }),
    ]);
  });

  it.each([
    ['string', false], ['string', true], ['parsed', false], ['parsed', true],
  ] as const)('warns instead of silently dropping .four with .step (%s, workers=%s)', async (inputType, workers) => {
    const input = `Stepped Fourier request
V1 in 0 SIN(0 2 1k)
R1 in out 1k
R2 out 0 1k
.tran 10u 2m
.four 1k v(out)
.step R1 list 1k 2k
.end`;
    let workerRuns = 0;
    const result = await simulate(inputType === 'string' ? input : parse(input), {
      stepWorkers: workers ? {
        maxWorkers: 2,
        workerFactory: async () => ({
          run: async task => {
            workerRuns++;
            return simulate(task.netlist, { ...task.options, stepWorkers: false });
          },
          terminate: () => undefined,
        }),
      } : false,
    });
    expect(result.steps).toHaveLength(2);
    expect(workerRuns).toBe(workers && inputType === 'string' ? 2 : 0);
    const warnings = result.warnings.filter(w => w.code === 'FOURIER');
    expect(warnings.length).toBeGreaterThan(0);
    // Worker results also carry their own per-run unsupported diagnostic.
    for (const warning of warnings) {
      expect(warning).toEqual(expect.objectContaining({
        type: 'parse', code: 'FOURIER', line: 6,
        message: expect.stringContaining('.four with .step is not implemented'),
      }));
    }
  });

  it('keeps malformed corpus-g .four cards diagnostic rather than silently dropping them', () => {
    const input = readFileSync(new URL('../../../../benchmarks/corpus/corpus-g/fixtures/FOURIER/bad_dot_four_line1.cir', import.meta.url), 'utf8');
    const circuit = parse(input);
    expect(circuit.parseDiagnostics.filter(w => w.code === 'FOURIER')).toHaveLength(9);
  });
});
