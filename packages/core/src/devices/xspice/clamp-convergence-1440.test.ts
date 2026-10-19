import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { MNAAssembler } from '../../mna/assembler.js';
import { XspiceDevice } from './xspice-device.js';
import { STATIC } from './models.js';

it.each(['voltage', 'current'] as const)('checks predicted %s outputs using global current-input branch indices', kind => {
  const assembler = new MNAAssembler(3, 5);
  const device = new XspiceDevice('a1', 'test',
    [{ kind: 'current', positive: 0, negative: -1, branch: 2 }],
    [{ kind, positive: 1, negative: -1, ...(kind === 'voltage' ? { branch: 4 } : {}) }],
    { stateful: false, ac: STATIC, load(call) { call.outputs[0] = 0; call.partials[0] = 2; } });
  device.stamp(assembler.getStampContext());
  const tolerances = { reltol: 1e-3, abstol: 1e-12, vntol: 1e-6 };
  const solution = new Float64Array(assembler.solution);
  expect(device.convergenceTest(solution, tolerances)).toBe(true);
  solution[3 + 2] = 1e-4;
  expect(device.convergenceTest(solution, tolerances)).toBe(false);
  solution[3 + 2] = 0;
  solution[3 + 4] = 1;
  expect(device.convergenceTest(solution, tolerances)).toBe(true);
  solution[3 + 2] = Number.NaN;
  expect(device.convergenceTest(solution, tolerances)).toBe(false);
});

it('keeps the current-driven clamp settled across oscillator corners (#1440)', async () => {
  const deck = readFileSync(new URL('../../../../../benchmarks/corpus/corpus-h/fixtures/kicad/qa/data/eeschema/issue13431.spice', import.meta.url), 'utf8');
  const tran = (await simulate(deck)).transient!;
  const softStart = tran.voltage('/soft_start');
  const settled = softStart.filter((_, i) => tran.time[i] >= 0.0105);
  // ngspice-47: the 50 uA source holds the clamp at approximately 5.1 V.
  expect(Math.min(...settled)).toBeGreaterThan(5.09);
  expect(Math.max(...settled)).toBeLessThan(5.11);
});
