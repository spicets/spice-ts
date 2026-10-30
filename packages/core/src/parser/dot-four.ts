import type { Circuit } from '../circuit.js';
import type { FourierResult, TransientResult } from '../results.js';
import type { SimulationWarning } from '../types.js';
import { ngspiceFourier } from './control/fourier.js';
import { realVector } from './control/vector.js';
import { evaluateVectorExpression, parseControlNumber, parseVectorExpression, splitVectorExpressions } from './control/vector-expression.js';

interface FourierCard { fundamental: number; outputs: string[]; line: number }
interface FourierCards { cards: FourierCard[]; nfreqs: number; fourgridsize: number }
const registry = new WeakMap<Circuit, FourierCards>();
function settings(circuit: Circuit): FourierCards {
  let value = registry.get(circuit);
  if (!value) {
    value = { cards: [], nfreqs: 10, fourgridsize: 200 };
    registry.set(circuit, value);
  }
  return value;
}

/** Keep frontend table options out of the solver options. */
export function takeFourierOptions(circuit: Circuit, tokens: string[]): string[] {
  return tokens.filter(token => {
    const match = /^(nfreqs|fourgridsize)=(.+)$/i.exec(token);
    if (!match) return true;
    const value = parseControlNumber(match[2]);
    const name = match[1].toLowerCase() as 'nfreqs' | 'fourgridsize';
    if (value !== undefined && Number.isFinite(value) && value >= 1) settings(circuit)[name] = Math.trunc(value);
    return false;
  });
}

export function addFourierCard(circuit: Circuit, text: string, line: number): void {
  const [, frequency = '', operands = ''] = /^\s*\.\S+\s*(\S*)\s*([\s\S]*)$/.exec(text) ?? [];
  const warn = (message: string) => circuit.addParseWarning(`.four: ${message}`, { code: 'FOURIER', line });
  const fundamental = parseControlNumber(frequency);
  if (!operands) { warn('no nodes given'); return; }
  if (fundamental === undefined || !Number.isFinite(fundamental) || fundamental <= 0) {
    warn('bad fundamental freq'); return;
  }
  try {
    const outputs = splitVectorExpressions(operands);
    if (!outputs.length) throw new Error('no nodes given');
    outputs.forEach(output => parseVectorExpression(output));
    settings(circuit).cards.push({ fundamental, outputs, line });
  } catch (error) { warn(error instanceof Error ? error.message : String(error)); }
}

/** Describe parsed Fourier work without evaluating or allocating any grids. */
export function fourierWork(circuit: Circuit): number {
  const config = registry.get(circuit);
  if (!config) return 0;
  const vectors = config.cards.reduce((sum, card) => sum + card.outputs.length, 0);
  // The extra row and column also bound grid and harmonic allocations.
  return Math.min(Number.MAX_SAFE_INTEGER, vectors * (config.nfreqs + 1) * (config.fourgridsize + 1));
}

/** Stepped runs bypass frontend Fourier evaluation; never silently discard cards. */
export function warnSteppedFourierCards(circuit: Circuit, warnings: SimulationWarning[]): void {
  for (const card of registry.get(circuit)?.cards ?? []) {
    warnings.push({
      type: 'parse', code: 'FOURIER', line: card.line,
      message: '.four with .step is not implemented; Fourier results are not computed for stepped runs',
    });
  }
}

export function evaluateFourierCards(circuit: Circuit, transient: TransientResult, warnings: SimulationWarning[]): void {
  const config = registry.get(circuit);
  if (!config?.cards.length) return;
  const time = Float64Array.from(transient.time);
  const scale = realVector('time', time);
  const vectors = new Map<string, ReturnType<typeof realVector>>();
  vectors.set('time', scale);
  vectors.set('0', realVector('0', new Float64Array(time.length), scale));
  for (const [node, values] of transient.voltages) vectors.set(node.toLowerCase(), realVector(node, values, scale));
  for (const [branch, values] of transient.currents) vectors.set(`${branch.toLowerCase()}#branch`, realVector(`${branch}#branch`, values, scale));
  const tables: FourierResult[] = [];
  for (const card of config.cards) for (const output of card.outputs) {
    try {
      const vector = evaluateVectorExpression(parseVectorExpression(output), {
        lookup(name) {
          const value = vectors.get(name.toLowerCase());
          if (!value) throw new Error(`no such vector ${name}`);
          return value;
        },
        userFunction: () => undefined,
        degrees: () => false,
        scale: () => scale,
      });
      if (vector.im || vector.re.length !== time.length) throw new Error('expected a real transient vector');
      tables.push(ngspiceFourier(output, time, vector.re, card.fundamental, config.nfreqs, config.fourgridsize, 1, 1));
    } catch (error) {
      warnings.push({ type: 'parse', code: 'FOURIER', line: card.line, message: `.four ${output}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  transient.fourier = tables;
}
