/**
 * `.meas`/`.measure` cards: ngspice-47 `do_measure()` (src/frontend/measure.c)
 * on top of the {@link getMeasure2} port.
 */
import type { AnalysisDirective } from '../types.js';
import type { MeasurementResult, SimulationResult } from '../results.js';
import { complexVector, realVector, type ControlVector } from '../parser/control/vector.js';
import { evaluateExpression } from '../parser/expression.js';
import { getMeasure2, type MeasurePlot } from './measure2.js';
import { inpEvaluate } from './numparse.js';
import { UnsupportedMeasureError } from './errors.js';

/** A `.meas` card as the netlist parser stores it. */
export interface MeasureCard {
  /** 1-based netlist line. */
  line: number;
  /** The card after numparam substitution, lower-cased like ngspice reads it. */
  text: string;
  /**
   * B-sources ngspice adds for the card's `par('expr')` operands, which `text`
   * reads as `v(pa_xx)`: `bpa_xx pa_xx 0 v = expr`.
   */
  parSources: string[];
}

/** Analysis types ngspice evaluates `.meas` cards for (measure.c chkAnalysisType). */
const MEASURE_ANALYSES = new Set(['tran', 'ac', 'dc', 'sp']);

/** gettok (misc/string.c): whitespace-separated, a `,` outside parentheses also ends a word. */
export function gettokWords(text: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && (/\s/.test(text[index]) || text[index] === ',')) index++;
    if (index >= text.length) break;
    let depth = 0;
    const start = index;
    while (index < text.length && !/\s/.test(text[index])) {
      const character = text[index];
      if (character === '(') depth++;
      else if (character === ')') depth--;
      else if (character === ',' && depth < 1) break;
      index++;
    }
    words.push(text.slice(start, index));
  }
  return words;
}

/** measure_parse_line (measure.c): drop `.meas`, glue a word ending in `=` to the next word. */
function measureWords(text: string): string[] {
  const words = gettokWords(text).slice(1);
  const glued: string[] = [];
  for (let index = 0; index < words.length; index++) {
    let word = words[index];
    if (word.endsWith('=')) {
      if (index + 1 >= words.length) break;
      word += words[++index];
    }
    glued.push(word);
  }
  return glued;
}

const PAR_OPERAND = /(^|[\s=])par\(\s*(?:'([^']*)'|\{([^{}]*)\})\s*\)/gi;

/**
 * Normalize a preprocessed `.meas` card: lower-case it (ngspice reads decks
 * lower-cased), drop the blanks around `=` as inpcom.c does, and replace each
 * `par('expr')` operand that follows a blank or `=` by `v(pa_xx)`, the output
 * of the B-source inpcom.c adds for it. Throws {@link UnsupportedMeasureError}
 * for forms ngspice evaluates and spice-ts does not.
 */
export function measureCard(raw: string, line: number, firstParIndex: number): MeasureCard {
  const parSources: string[] = [];
  let text = raw.replace(/\s*=\s*/g, '=');
  text = text.replace(PAR_OPERAND, (_match, lead: string, quoted?: string, braced?: string) => {
    const node = `pa_${String(firstParIndex + parSources.length).padStart(2, '0')}`;
    parSources.push(`b${node} ${node} 0 v = ${quoted ?? braced ?? ''}`);
    return `${lead}v(${node})`;
  });
  const card: MeasureCard = { line, text: text.toLowerCase(), parSources };
  if (cardHead(card).analysis === 'sp') {
    throw new UnsupportedMeasureError('measurements of .sp (S-parameter) analyses are not implemented', line, raw);
  }
  return card;
}

/** The `.meas` analysis word, result name and function word of a card. */
function cardHead(card: MeasureCard): { analysis?: string; name?: string; function?: string } {
  const [, analysis, name, fn] = gettokWords(card.text);
  return { analysis, name, function: fn };
}

/** Whether `.meas` evaluates this card in its second, numparam pass (measure.c lines 341-347). */
function isParamCard(fn: string): boolean {
  return fn.startsWith('param') || fn.startsWith('expr');
}

/** The analysis types the cards ask for that ngspice evaluates. */
export function measuredAnalyses(cards: readonly MeasureCard[]): Set<string> {
  const types = new Set<string>();
  for (const card of cards) {
    const { analysis } = cardHead(card);
    if (analysis && MEASURE_ANALYSES.has(analysis)) types.add(analysis);
  }
  return types;
}

/**
 * Evaluate the cards of one analysis run, like ngspice `do_measure(analysis)`.
 * `values` carries ngspice's numparam dictionary of earlier results
 * (`nupa_add_param`); successful measurements are added to it.
 */
export function evaluateMeasureCards(
  cards: readonly MeasureCard[],
  analysis: string,
  plot: MeasurePlot,
  values: Map<string, number>,
): MeasurementResult[] {
  const results = new Map<MeasureCard, MeasurementResult>();
  const failed = (card: MeasureCard, head: ReturnType<typeof cardHead>, error: string): MeasurementResult => ({
    name: head.name ?? '', analysis: head.analysis ?? '', function: head.function ?? '', line: card.line,
    status: 'failed', error,
  });

  // First pass: everything except param/expr.
  for (const card of cards) {
    const head = cardHead(card);
    if (head.analysis === undefined || head.name === undefined || head.function === undefined) {
      results.set(card, failed(card, head, 'Incomplete measurement statement ignored'));
      continue;
    }
    if (!MEASURE_ANALYSES.has(head.analysis)) {
      results.set(card, failed(card, head, `unrecognized analysis type '${head.analysis}'`));
      continue;
    }
    if (isParamCard(head.function) || head.analysis !== analysis) continue;
    const outcome = getMeasure2(measureWords(card.text), plot);
    if (!outcome.ok) {
      results.set(card, failed(card, head, outcome.error));
      continue;
    }
    const { ok: _ok, value, ...details } = outcome;
    values.set(head.name, value);
    results.set(card, { name: head.name, analysis, function: head.function, line: card.line, status: 'ok', value, ...details });
  }

  // Second pass: param/expr, which may read the results above.
  for (const card of cards) {
    const head = cardHead(card);
    if (results.has(card) || head.analysis !== analysis || !isParamCard(head.function!)) continue;
    const value = evaluateParamCard(card, head.function!, values);
    if (value === undefined) {
      results.set(card, failed(card, head, 'failed'));
      continue;
    }
    values.set(head.name!, value);
    results.set(card, { name: head.name!, analysis, function: head.function!, line: card.line, status: 'ok', value });
  }
  return cards.filter(card => results.has(card)).map(card => results.get(card)!);
}

/**
 * `param='expr'` / `expr='expr'`: numparam evaluates the expression with the
 * `.param` values (substituted by the preprocessor) and earlier results.
 */
function evaluateParamCard(card: MeasureCard, fn: string, values: Map<string, number>): number | undefined {
  const keyword = fn.startsWith('param') ? 'param' : 'expr';
  const at = card.text.indexOf(keyword, card.text.indexOf(fn));
  const assignment = /^[a-z]*=\s*(?:'([^']*)'|\{([^{}]*)\}|(\S+))/.exec(card.text.slice(at));
  if (!assignment) return undefined;
  const expression = assignment[1] ?? assignment[2] ?? assignment[3];
  const vars: Record<string, number> = {};
  for (const [name, value] of values) vars[name.toUpperCase()] = value;
  try {
    const value = evaluateExpression(withPlainNumbers(expression), vars);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * numparam reads `100ps` or `2.5ns` as numbers: rewrite each such literal as a
 * plain number so the shared expression evaluator accepts it.
 */
function withPlainNumbers(expression: string): string {
  return expression.replace(
    /(^|[^\w.])((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]\w*)?/gi,
    (match, lead: string, literal: string, letters?: string) => {
      if (letters === undefined) return match;
      const parsed = inpEvaluate(literal + letters);
      return parsed ? `${lead}(${parsed.value})` : match;
    },
  );
}

/**
 * The plot ngspice makes for one analysis result: node voltages by node name,
 * branch currents as `<device>#branch`, and the scale (`time`, `frequency`,
 * `v-sweep`/`i-sweep`/`temp-sweep`/`res-sweep`). Names resolve like `vec_get`:
 * `v(n)` is node `n`, `i(dev)` is `dev#branch`, case-insensitively.
 */
export function measurePlot(directive: AnalysisDirective, result: SimulationResult): MeasurePlot | undefined {
  const vectors = new Map<string, ControlVector>();
  let scale: ControlVector;
  const add = (name: string, vector: ControlVector) => vectors.set(name.toLowerCase(), vector);
  switch (directive.type) {
    case 'tran': {
      if (!result.transient) return undefined;
      scale = realVector('time', result.transient.time);
      for (const [node, values] of result.transient.voltages) add(node, realVector(node, values, scale));
      for (const [branch, values] of result.transient.currents) add(`${branch}#branch`, realVector(`${branch}#branch`, values, scale));
      break;
    }
    case 'ac': {
      if (!result.ac) return undefined;
      scale = realVector('frequency', result.ac.frequencies);
      const phasors = (name: string, values: { magnitude: number; phase: number }[]) => complexVector(
        name,
        values.map(value => value.magnitude * Math.cos((value.phase * Math.PI) / 180)),
        values.map(value => value.magnitude * Math.sin((value.phase * Math.PI) / 180)),
        scale,
      );
      for (const [node, values] of result.ac.voltages) add(node, phasors(node, values));
      for (const [branch, values] of result.ac.currents) add(`${branch}#branch`, phasors(`${branch}#branch`, values));
      break;
    }
    case 'dc': {
      if (!result.dcSweep) return undefined;
      const source = directive.source.toLowerCase();
      const scaleName = source === 'temp' ? 'temp-sweep' : `${source[0] === 'i' ? 'i' : source[0] === 'r' ? 'res' : 'v'}-sweep`;
      scale = realVector(scaleName, result.dcSweep.sweepValues);
      for (const [node, values] of result.dcSweep.voltages) add(node, realVector(node, values, scale));
      for (const [branch, values] of result.dcSweep.currents) add(`${branch}#branch`, realVector(`${branch}#branch`, values, scale));
      break;
    }
    default:
      return undefined;
  }
  vectors.set(scale.name, scale);
  return {
    type: directive.type,
    scale,
    vector(name) {
      const lower = name.toLowerCase();
      const direct = vectors.get(lower);
      if (direct) return direct;
      const differential = /^v\(([^(),]+),([^(),]+)\)$/.exec(lower);
      if (directive.type === 'tran' && differential) {
        const node = (name: string) => {
          const key = name.trim();
          return key === '0' || key === 'gnd' ? scale.re.map(() => 0) : vectors.get(key)?.re;
        };
        const positive = node(differential[1]);
        const negative = node(differential[2]);
        if (!positive || !negative) return undefined;
        const result = realVector(lower, positive.map((value, i) => value - negative[i]), scale);
        vectors.set(lower, result);
        return result;
      }
      const voltage = /^v\(([^(),]+)\)$/.exec(lower);
      if (voltage) return vectors.get(voltage[1].trim());
      const current = /^i\(([^(),]+)\)$/.exec(lower);
      if (current) return vectors.get(`${current[1].trim()}#branch`);
      return undefined;
    },
  };
}
