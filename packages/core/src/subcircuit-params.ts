import { ParseError } from './errors.js';
import { evaluateExpression } from './parser/expression.js';
import { toParseError } from './parser/preprocessor.js';
import { parseNumber } from './parser/tokenizer.js';
import { stringParameter, type ParameterScope } from './parser/string-param.js';

const ASSIGNMENT = /([A-Za-z_]\w*)\s*=\s*(\{[^}]*\}|"[^"]*"|\S+)/g;
/** An identifier not preceded by a word character or a dot (so not the `k` of `3k` or `e3` of `1e3`). */
const IDENTIFIER = /(?<![\w.])[A-Za-z_]\w*/g;

/** One `.param` card of a subcircuit body. */
export interface SubcircuitParamCard {
  /** Text after `.param` (`a=1 b={a*2}`) */
  content: string;
  /** Deck line number of the card */
  line: number;
  /** Raw text of the card */
  raw: string;
}

interface BodyParam {
  name: string;
  expression: string;
  card: SubcircuitParamCard;
}

/** The assignments of one subcircuit `.param` card. */
function paramAssignments(card: SubcircuitParamCard): BodyParam[] {
  const { content } = card;
  const assignments = [...content.matchAll(ASSIGNMENT)];
  if (assignments.length === 0) return [];
  // A single assignment reads the whole rest of the card, as at the top level.
  const pairs = assignments.length === 1
    ? [[assignments[0][1], content.slice(content.indexOf('=') + 1).trim()]]
    : assignments.map(match => [match[1], match[2]]);
  return pairs.map(([name, value]) => ({
    name: name.toUpperCase(),
    expression: value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value,
    card,
  }));
}

/** Evaluates one parameter; a failure is a ParseError at its `.param` card. */
function evaluateParam(param: BodyParam, scope: ParameterScope): number | string {
  try {
    return stringParameter(param.expression, scope) ?? evaluateExpression(param.expression, scope);
  } catch (error) {
    if (error instanceof ParseError) throw error;
    // A bare SPICE number (e.g. `1meg`) is not an expression.
    try {
      return parseNumber(param.expression);
    } catch {
      throw toParseError(error, param.card.line, param.card.raw);
    }
  }
}

/**
 * Evaluates the `.param` cards of one subcircuit body into `scope`, before any
 * element of that body, in dependency order.
 *
 * ngspice-47 inpcom.c `inp_reorder_params_subckt` moves every `.param` card of
 * a subcircuit body to the top of the body and `inp_sort_params` orders them
 * so each follows the parameters it references; a `.param` below the element
 * using it, or one referencing a later `.param`, is therefore valid (#857).
 * A name defined twice takes its last definition, as sequential evaluation of
 * the reordered cards gives.
 *
 * @param cards - The body's `.param` cards, in deck order
 * @param scope - Instance scope (subcircuit parameters, enclosing scopes via the prototype)
 * @throws ParseError at the defining card for a circular dependency or an undefined name
 */
export function evaluateSubcircuitParams(
  cards: readonly SubcircuitParamCard[],
  scope: ParameterScope,
  overrides: ReadonlyMap<string, number | string>,
): void {
  const pending = new Map<string, BodyParam>();
  for (const card of cards) {
    for (const param of paramAssignments(card)) {
      // Body .params are overridable from X cards too (ngspice alterparam.sp).
      if (overrides.has(param.name)) continue;
      pending.delete(param.name);
      pending.set(param.name, param);
    }
  }
  const visiting: string[] = [];
  const resolve = (param: BodyParam): void => {
    if (visiting.includes(param.name)) {
      const cycle = [...visiting.slice(visiting.indexOf(param.name)), param.name].join(' -> ');
      throw new ParseError(`Circular .param dependency: ${cycle}`, param.card.line, param.card.raw);
    }
    visiting.push(param.name);
    for (const [identifier] of param.expression.matchAll(IDENTIFIER)) {
      const dependency = pending.get(identifier.toUpperCase());
      if (dependency !== undefined && dependency !== param) resolve(dependency);
    }
    visiting.pop();
    if (!pending.has(param.name)) return;
    pending.delete(param.name);
    scope[param.name] = evaluateParam(param, scope);
  };
  for (const param of [...pending.values()]) {
    if (pending.has(param.name)) resolve(param);
  }
}
