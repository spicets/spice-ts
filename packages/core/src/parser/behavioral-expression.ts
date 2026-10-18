import { ParseError } from '../errors.js';
import { DEVICE_GMIN } from '../devices/device.js';
import { evaluateExpression } from './expression.js';
import { parseNumber } from './tokenizer.js';

/**
 * ngspice-47 B-source (`ASRC`) expressions: parse tree, evaluation and
 * derivatives, ported from `inpptree-parser.y`, `inpptree.c`, `ifeval.c` and
 * `ptfuncs.c`.
 *
 * Supported: numbers with SPICE scale factors, the constants `pi` and `e`,
 * `time`, `temper`, `hertz`, `v(node)`, `v(node1,node2)`, the branch current
 * `i(vsource)` of a branch-carrying source, unary `+ - !`, binary
 * `+ - * / ^ **`, comparisons `== != <> < <= > >=`, `&&`, `||` (also `|`), the ternary
 * `c ? a : b` / `ternary_fcn(c, a, b)`, every function listed in
 * {@link BEHAVIORAL_FUNCTIONS}, and the PSpice `if`, `limit`, `pwrs`, `stp`
 * and `int` (see {@link PSPICE_FUNCTIONS}). `.param` names, `{expr}` and `'expr'` are
 * substituted before parsing, as ngspice's numparam front end does (see
 * {@link substituteBehavioralParameters}). `pwl(x, x1, y1, ...)` interpolates
 * literal points and extrapolates the end segments. The PSPICE
 * logic operators `~ &` are rejected explicitly. Single `|` is the boolean
 * OR alias ngspice translates in included PSpice libraries (#903).
 */
export type BehavioralFunction =
  | 'abs' | 'acos' | 'acosh' | 'asin' | 'asinh' | 'atan' | 'atanh'
  | 'cos' | 'cosh' | 'exp' | 'ln' | 'log' | 'log10' | 'sgn' | 'sin' | 'sinh'
  | 'sqrt' | 'tan' | 'tanh' | 'u' | 'uramp' | 'ceil' | 'floor' | 'nint' | 'u2'
  | 'eq0' | 'ne0' | 'gt0' | 'lt0' | 'ge0' | 'le0'
  | 'pow' | 'pwr' | 'min' | 'max' | 'ddt' | 'pwl';

export type BehavioralBinaryOperator = '+' | '-' | '*' | '/' | '^';
export type BehavioralComparison = '==' | '!=' | '<' | '<=' | '>' | '>=';
export type BehavioralVariable = 'time' | 'temper' | 'hertz';

export type BehavioralExpression =
  | { kind: 'number'; value: number }
  | { kind: 'voltage'; positive: string; negative?: string }
  /** ngspice PT_CURRENT: the MNA branch current of the named source (`i(vsource)`). */
  | { kind: 'current'; source: string }
  | { kind: 'variable'; name: BehavioralVariable }
  | { kind: 'negate'; operand: BehavioralExpression }
  | { kind: 'not'; operand: BehavioralExpression }
  | { kind: 'binary'; op: BehavioralBinaryOperator; left: BehavioralExpression; right: BehavioralExpression }
  | { kind: 'compare'; op: BehavioralComparison; left: BehavioralExpression; right: BehavioralExpression }
  | { kind: 'logical'; op: '&&' | '||'; left: BehavioralExpression; right: BehavioralExpression }
  | {
      kind: 'ternary';
      condition: BehavioralExpression;
      whenTrue: BehavioralExpression;
      whenFalse: BehavioralExpression;
    }
  | { kind: 'call'; name: BehavioralFunction; args: BehavioralExpression[] };

const BINARY_FUNCTIONS: readonly BehavioralFunction[] = ['pow', 'pwr', 'min', 'max'];

export const BEHAVIORAL_FUNCTIONS: readonly BehavioralFunction[] = [
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh',
  'cos', 'cosh', 'exp', 'ln', 'log', 'log10', 'sgn', 'sin', 'sinh',
  'sqrt', 'tan', 'tanh', 'u', 'uramp', 'ceil', 'floor', 'nint', 'u2',
  'eq0', 'ne0', 'gt0', 'lt0', 'ge0', 'le0',
  ...BINARY_FUNCTIONS, 'ddt', 'pwl',
];

/** ASRC instance parameters (ngspice `asrc.c`); temperatures in Celsius. */
export interface BehavioralInstanceParams {
  tc1?: number;
  tc2?: number;
  /** Instance temperature; replaces the circuit temperature and `dtemp`. */
  temp?: number;
  dtemp?: number;
  /** ngspice `reciproctc=1`: divide by the temperature factor instead. */
  reciproctc?: boolean;
  /**
   * spice-ts `spice2poly=1`: the source is a SPICE2 POLY(n) card, which
   * ngspice-47 runs as an XSPICE 'A' device (enhtrans.c), so the circuit takes
   * the XSPICE trtol of cktdojob.c (#862). The POLY translation sets it.
   */
  spice2poly?: boolean;
}

export type BehavioralSourceKind = 'current' | 'voltage';

export interface BehavioralSourceCard {
  name: string;
  nodes: [string, string];
  kind: BehavioralSourceKind;
  expression: BehavioralExpression;
  params: BehavioralInstanceParams;
}

const GROUND = '0';
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[a-zA-Z]*/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const NODE_NAME = /^[^\s(),]+/;
const B_CARD = /^(\S+)\s+([^\s(),=]+)\s+([^\s(),=]+)\s*(.*)$/;
const B_CARD_HEAD = /^(\s*[bB]\S*\s+[^\s(),=]+\s+[^\s(),=]+\s*)([iIvV]\s*=)([\s\S]*)$/;
const ASSIGNMENT = /^([iv])\s*=\s*([\s\S]+)$/i;
const INSTANCE_PARAMETER = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)\s*/;
const INSTANCE_PARAMETERS = new Set(['tc1', 'tc2', 'temp', 'dtemp', 'reciproctc', 'spice2poly']);

class ExpressionError extends Error {}

const call = (name: BehavioralFunction, ...args: BehavioralExpression[]): BehavioralExpression => ({
  kind: 'call',
  name,
  args,
});

const ARITY_WORDS: Record<number, string> = { 1: 'one argument', 2: 'two arguments', 3: 'three arguments' };

/**
 * PSpice functions ngspice-47 defines in compatibility mode
 * (frontend/inpcompat.c pspice_compat prepends these `.func` cards, which
 * numparam expands textually into every B-source expression):
 *
 *   .func limit(x, a, b) { ternary_fcn(a > b, max(min(x, a), b), max(min(x, b), a)) }
 *   .func pwrs(x, a) { sgn(x) * pow(x, a) }
 *   .func stp(x) { u(x) }
 *   .func if(a, b, c) {ternary_fcn( a , b , c )}
 *   .func int(x) { sgn(x)*floor(abs(x)) }
 *
 * Each call expands into the same parse tree, so values and the
 * PTdifferentiate derivatives (Newton Jacobian) follow ngspice's tree.
 * A repeated argument compiles once per occurrence, as in the textual
 * expansion (a `ddt()` argument keeps one history per occurrence). Default-mode ngspice
 * rejects these names ("no such function"), so accepting them always only
 * widens the accepted decks. The sixth inpcompat.c function,
 * `.func pwr(x, a) { pow(x, a) }`, is not applied: `pwr` is a native
 * default-mode ngspice function (sign-preserving PTpwr) that spice-ts keeps.
 */
interface PspiceFunction {
  arity: number;
  expand(args: BehavioralExpression[]): BehavioralExpression;
}

const PSPICE_FUNCTIONS = new Map<string, PspiceFunction>(Object.entries({
  limit: {
    arity: 3,
    expand: ([x, a, b]) => ({
      kind: 'ternary',
      condition: { kind: 'compare', op: '>', left: a, right: b },
      whenTrue: call('max', call('min', x, a), b),
      whenFalse: call('max', call('min', x, b), a),
    }),
  },
  pwrs: {
    arity: 2,
    expand: ([x, a]) => ({ kind: 'binary', op: '*', left: call('sgn', x), right: call('pow', x, a) }),
  },
  stp: { arity: 1, expand: ([x]) => call('u', x) },
  if: {
    arity: 3,
    expand: ([condition, whenTrue, whenFalse]) => ({ kind: 'ternary', condition, whenTrue, whenFalse }),
  },
  int: {
    arity: 1,
    expand: ([x]) => ({ kind: 'binary', op: '*', left: call('sgn', x), right: call('floor', call('abs', x)) }),
  },
} satisfies Record<string, PspiceFunction>));

export function parseBehavioralSourceCard(raw: string, lineNumber: number): BehavioralSourceCard {
  const card = B_CARD.exec(raw.trim());
  if (!card || card[4] === '') {
    throw new ParseError('B-card requires two nodes and an I= or V= expression', lineNumber, raw);
  }
  const assignment = ASSIGNMENT.exec(card[4]);
  if (!assignment) {
    throw new ParseError(
      "Unsupported behavioral source form: expected 'I=<expression>' or 'V=<expression>'",
      lineNumber,
      raw,
    );
  }
  try {
    const parser = new Parser(assignment[2]);
    const expression = parser.parseExpression();
    return {
      name: card[1],
      nodes: [card[2], card[3]],
      kind: assignment[1].toLowerCase() === 'v' ? 'voltage' : 'current',
      expression,
      params: parseInstanceParameters(parser.rest()),
    };
  } catch (error) {
    if (error instanceof ExpressionError) throw new ParseError(error.message, lineNumber, raw);
    throw error;
  }
}

/**
 * ngspice's lexer stops at `tc1=`, `tc2=`, `temp=`, `dtemp=` and `reciproctc=`;
 * spice-ts adds `spice2poly=` for translated POLY cards.
 */
function parseInstanceParameters(text: string): BehavioralInstanceParams {
  const params: BehavioralInstanceParams = {};
  let rest = text;
  while (rest !== '') {
    const match = INSTANCE_PARAMETER.exec(rest);
    if (!match) throw unexpectedTail(rest);
    const name = match[1].toLowerCase();
    if (!INSTANCE_PARAMETERS.has(name)) {
      throw new ExpressionError(`Unsupported behavioral source parameter '${match[1]}'`);
    }
    let value: number;
    try {
      value = parseNumber(match[2]);
    } catch {
      throw new ExpressionError(`Behavioral source parameter '${match[1]}' needs a number, got '${match[2]}'`);
    }
    if (name === 'reciproctc') params.reciproctc = value === 1;
    else if (name === 'spice2poly') params.spice2poly = value === 1;
    else params[name as 'tc1' | 'tc2' | 'temp' | 'dtemp'] = value;
    rest = rest.slice(match[0].length);
  }
  return params;
}

function unexpectedTail(rest: string): ExpressionError {
  const token = IDENTIFIER.exec(rest);
  if (token) return new ExpressionError(`Unsupported behavioral expression token '${token[0]}'`);
  if (rest[0] === ')') return new ExpressionError("Unbalanced ')' in behavioral expression");
  return new ExpressionError(`Unsupported behavioral expression operator '${rest[0]}'`);
}

export function parseBehavioralExpression(text: string): BehavioralExpression {
  const parser = new Parser(text);
  const expression = parser.parseExpression();
  const rest = parser.rest();
  if (rest !== '') throw unexpectedTail(rest);
  return expression;
}

/**
 * Recursive-descent form of the ngspice bison grammar. Precedence, lowest
 * first: `?:` (right), `||` / `|`, `&&`, `== !=`, `< <= > >=`, `+ -`, `* /`, unary
 * `- + !`, `^` (left). Unary minus binds looser than `^`: `-a^2` is `-(a^2)`.
 */
class Parser {
  private position = 0;

  constructor(private readonly source: string) {}

  /** Unparsed remainder (instance parameters such as `tc1=`). */
  rest(): string {
    return this.source.slice(this.position).trim();
  }

  parseExpression(): BehavioralExpression {
    const condition = this.parseOr();
    if (!this.accept('?')) return condition;
    const whenTrue = this.parseExpression();
    this.expect(':');
    const whenFalse = this.parseExpression();
    return { kind: 'ternary', condition, whenTrue, whenFalse };
  }

  private parseOr(): BehavioralExpression {
    let left = this.parseAnd();
    // Consume || first; both spellings use the same tree, truthiness and slopes.
    while (this.accept('||') || this.accept('|')) {
      left = { kind: 'logical', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): BehavioralExpression {
    let left = this.parseEquality();
    while (this.accept('&&')) left = { kind: 'logical', op: '&&', left, right: this.parseEquality() };
    return left;
  }

  private parseEquality(): BehavioralExpression {
    let left = this.parseRelational();
    for (;;) {
      let op: BehavioralComparison;
      if (this.accept('==')) op = '==';
      else if (this.accept('!=') || this.accept('<>')) op = '!=';
      else return left;
      left = { kind: 'compare', op, left, right: this.parseRelational() };
    }
  }

  private parseRelational(): BehavioralExpression {
    let left = this.parseSum();
    for (;;) {
      let op: BehavioralComparison;
      if (this.peekText('<>')) return left;
      if (this.accept('<=')) op = '<=';
      else if (this.accept('>=')) op = '>=';
      else if (this.accept('<')) op = '<';
      else if (this.accept('>')) op = '>';
      else return left;
      left = { kind: 'compare', op, left, right: this.parseSum() };
    }
  }

  private parseSum(): BehavioralExpression {
    let left = this.parseProduct();
    for (;;) {
      const op = this.peek();
      if (op !== '+' && op !== '-') return left;
      this.position++;
      left = { kind: 'binary', op, left, right: this.parseProduct() };
    }
  }

  private parseProduct(): BehavioralExpression {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek();
      if ((op !== '*' || this.peekText('**')) && op !== '/') return left;
      this.position++;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
  }

  private startsUnary(): boolean {
    const op = this.peek();
    return op === '-' || op === '+' || (op === '!' && !this.peekText('!='));
  }

  private parseUnary(): BehavioralExpression {
    if (!this.startsUnary()) return this.parsePower();
    const op = this.source[this.position++];
    const operand = this.parseUnary();
    if (op === '-') return { kind: 'negate', operand };
    if (op === '!') return { kind: 'not', operand };
    return operand;
  }

  private parsePower(): BehavioralExpression {
    let left = this.parsePrimary();
    while (this.accept('^') || this.accept('**')) {
      // bison shifts a unary operator after '^' (`a^-b` is `a^(-b)`), while a
      // plain operand keeps '^' left-associative.
      const right = this.startsUnary() ? this.parseUnary() : this.parsePrimary();
      left = { kind: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parsePrimary(): BehavioralExpression {
    const next = this.peek();
    if (next === undefined) throw new ExpressionError('Unexpected end of behavioral expression');
    if (next === '(') {
      this.position++;
      const inner = this.parseExpression();
      this.expect(')');
      return inner;
    }
    const rest = this.source.slice(this.position);
    const number = NUMBER.exec(rest);
    if (number) {
      this.position += number[0].length;
      return { kind: 'number', value: parseNumber(number[0]) };
    }
    const identifier = IDENTIFIER.exec(rest);
    if (!identifier) throw new ExpressionError(`Unsupported behavioral expression operator '${next}'`);
    this.position += identifier[0].length;
    const name = identifier[0].toLowerCase();
    if (!this.accept('(')) return this.parseName(identifier[0], name);
    if (name === 'v') return this.parseVoltage();
    if (name === 'i') return this.parseCurrent();
    return this.parseCall(identifier[0], name);
  }

  private parseName(original: string, name: string): BehavioralExpression {
    switch (name) {
      case 'time':
      case 'temper':
      case 'hertz':
        return { kind: 'variable', name };
      case 'pi':
        return { kind: 'number', value: Math.PI };
      case 'e':
        return { kind: 'number', value: Math.E };
      default:
        throw new ExpressionError(`Unsupported behavioral expression token '${original}'`);
    }
  }

  private parseCall(original: string, name: string): BehavioralExpression {
    const args = [this.parseExpression()];
    while (this.accept(',')) args.push(this.parseExpression());
    this.expect(')');
    if (name === 'pwl') {
      if (args.length < 5 || args.length % 2 !== 1) {
        throw new ExpressionError('pwl() needs at least two pairs of literal points');
      }
      const literal = (arg: BehavioralExpression): number => {
        if (arg.kind === 'number') return arg.value;
        if (arg.kind === 'negate' && arg.operand.kind === 'number') return -arg.operand.value;
        throw new ExpressionError('pwl() points must be literal constants');
      };
      for (let i = 1; i < args.length; i++) {
        const value = literal(args[i]);
        if (i > 2 && i % 2 === 1 && literal(args[i - 2]) >= value) {
          throw new ExpressionError('pwl() point abscissas must be strictly ascending');
        }
        args[i] = { kind: 'number', value };
      }
      return { kind: 'call', name, args };
    }
    if (name === 'ternary_fcn') {
      if (args.length !== 3) throw new ExpressionError('ternary_fcn() takes three arguments');
      return { kind: 'ternary', condition: args[0], whenTrue: args[1], whenFalse: args[2] };
    }
    const pspice = PSPICE_FUNCTIONS.get(name);
    if (pspice) {
      if (args.length !== pspice.arity) {
        throw new ExpressionError(`${name}() takes ${ARITY_WORDS[pspice.arity]}`);
      }
      return pspice.expand(args);
    }
    if (!(BEHAVIORAL_FUNCTIONS as readonly string[]).includes(name)) {
      throw new ExpressionError(`Unsupported behavioral expression function '${original}'`);
    }
    const binary = BINARY_FUNCTIONS.includes(name as BehavioralFunction);
    if (args.length !== (binary ? 2 : 1)) {
      throw new ExpressionError(`${name}() takes ${binary ? 'two arguments' : 'one argument'}`);
    }
    return { kind: 'call', name: name as BehavioralFunction, args };
  }

  private parseVoltage(): BehavioralExpression {
    const nodes: string[] = [];
    for (;;) {
      this.skipWhitespace();
      const node = NODE_NAME.exec(this.source.slice(this.position));
      if (!node) throw new ExpressionError('v() takes one or two node names');
      nodes.push(node[0]);
      this.position += node[0].length;
      if (this.accept(',')) continue;
      if (this.accept(')')) break;
      throw new ExpressionError('v() takes one or two node names');
    }
    if (nodes.length > 2) throw new ExpressionError('v() takes one or two node names');
    return nodes.length === 1
      ? { kind: 'voltage', positive: nodes[0] }
      : { kind: 'voltage', positive: nodes[0], negative: nodes[1] };
  }

  /** `i(vsource)`: ngspice accepts exactly one source name. */
  private parseCurrent(): BehavioralExpression {
    this.skipWhitespace();
    const source = NODE_NAME.exec(this.source.slice(this.position));
    if (!source) throw new ExpressionError('i() takes one source name');
    this.position += source[0].length;
    if (!this.accept(')')) throw new ExpressionError('i() takes one source name');
    return { kind: 'current', source: source[0] };
  }

  private accept(text: string): boolean {
    if (!this.peekText(text)) return false;
    this.position += text.length;
    return true;
  }

  private peekText(text: string): boolean {
    this.skipWhitespace();
    return this.source.startsWith(text, this.position);
  }

  private expect(char: string): void {
    if (!this.accept(char)) throw new ExpressionError(`Expected '${char}' in behavioral expression`);
  }

  private peek(): string | undefined {
    this.skipWhitespace();
    return this.position < this.source.length ? this.source[this.position] : undefined;
  }

  private skipWhitespace(): void {
    while (this.position < this.source.length && /\s/.test(this.source[this.position])) {
      this.position++;
    }
  }
}

/**
 * ngspice's numparam front end for a B-card: replace `{expr}` and `'expr'`
 * with their values and every bare `.param` name with its value (negative
 * values parenthesised so they keep their precedence). Function names,
 * `v()`/`i()` node lists and `name=` instance parameters are left alone.
 * A `{...}`/`'...'` that reads `v()`/`i()` cannot be a number: as in
 * ngspice-47 (`inp_modify_exp`), it stays part of the ASRC expression as a
 * parenthesised sub-expression, with its parameters substituted.
 * `params` is keyed by upper-case name. Other cards are returned unchanged.
 */
export function substituteBehavioralParameters(raw: string, params: Record<string, number | string>): string {
  const card = B_CARD_HEAD.exec(raw);
  if (!card) return raw;
  return card[1] + card[2] + substituteBehavioralText(card[3], params);
}

/** Matches `v(` / `i(` (node voltage or branch current access). */
export const NODE_DEPENDENT_EXPRESSION = /(?<![A-Za-z0-9_])[vi]\s*\(/i;

/** Keep ASRC functions out of the narrower numparam constant evaluator. */
export const BEHAVIORAL_RUNTIME_EXPRESSION = new RegExp(
  `\\b(?:${BEHAVIORAL_FUNCTIONS.join('|')})\\s*\\(|\\bhertz\\b`, 'i',
);

function substituteBehavioralText(body: string, params: Record<string, number | string>): string {
  const format = (value: number) => (value < 0 ? `(${value})` : String(value));
  let out = '';
  let i = 0;
  while (i < body.length) {
    const char = body[i];
    if (char === '{' || char === "'") {
      const close = char === '{' ? matchingBrace(body, i) : body.indexOf("'", i + 1);
      if (close < 0) throw new Error(`Unterminated ${char} expression in B-card`);
      const inner = body.slice(i + 1, close);
      out += NODE_DEPENDENT_EXPRESSION.test(inner) || BEHAVIORAL_RUNTIME_EXPRESSION.test(inner)
        ? `(${substituteBehavioralText(inner, params)})`
        : format(evaluateExpression(inner, params));
      i = close + 1;
      continue;
    }
    const rest = body.slice(i);
    const startsToken = !IDENTIFIER_CHAR.test(body[i - 1] ?? '');
    const number = startsToken ? NUMBER.exec(rest) : null;
    const identifier = startsToken && !number ? IDENTIFIER.exec(rest) : null;
    if (number) {
      out += number[0];
      i += number[0].length;
    } else if (identifier) {
      const after = body.slice(i + identifier[0].length);
      if (/^[iv]$/i.test(identifier[0]) && /^\s*\(/.test(after)) {
        const close = body.indexOf(')', i);
        const end = close < 0 ? body.length : close + 1;
        out += body.slice(i, end);
        i = end;
        continue;
      }
      const key = identifier[0].toUpperCase();
      if (key !== 'HERTZ' && !/^\s*[(=]/.test(after) && key in params) {
        const value = params[key];
        if (typeof value !== 'number') throw new Error(`String parameter '${key}' used in a numeric expression`);
        out += format(value);
      } else out += identifier[0];
      i += identifier[0].length;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Rename every node referenced by `v()` (ground stays ground) and every
 * source referenced by `i()` (ngspice subckt.c qualifies both inside a
 * subcircuit instance).
 */
export function mapBehavioralNodes(
  expression: BehavioralExpression,
  mapNode: (node: string) => string,
  mapSource: (source: string) => string = source => source,
): BehavioralExpression {
  const map = (node: string) => (node === GROUND ? GROUND : mapNode(node));
  const recurse = (node: BehavioralExpression) => mapBehavioralNodes(node, mapNode, mapSource);
  switch (expression.kind) {
    case 'number':
    case 'variable':
      return expression;
    case 'current':
      return { kind: 'current', source: mapSource(expression.source) };
    case 'voltage':
      return expression.negative === undefined
        ? { kind: 'voltage', positive: map(expression.positive) }
        : { kind: 'voltage', positive: map(expression.positive), negative: map(expression.negative) };
    case 'negate':
    case 'not':
      return { ...expression, operand: recurse(expression.operand) };
    case 'binary':
      return { ...expression, left: recurse(expression.left), right: recurse(expression.right) };
    case 'compare':
      return { ...expression, left: recurse(expression.left), right: recurse(expression.right) };
    case 'logical':
      return { ...expression, left: recurse(expression.left), right: recurse(expression.right) };
    case 'ternary':
      return {
        kind: 'ternary',
        condition: recurse(expression.condition),
        whenTrue: recurse(expression.whenTrue),
        whenFalse: recurse(expression.whenFalse),
      };
    case 'call':
      return { ...expression, args: expression.args.map(recurse) };
  }
}

/** Render an expression back to ngspice syntax (used by netlist serialisation). */
export function formatBehavioralExpression(expression: BehavioralExpression): string {
  const format = formatBehavioralExpression;
  switch (expression.kind) {
    case 'number':
      return expression.value < 0 ? `(${expression.value})` : String(expression.value);
    case 'variable':
      return expression.name;
    case 'voltage':
      return expression.negative === undefined
        ? `v(${expression.positive})`
        : `v(${expression.positive},${expression.negative})`;
    case 'current':
      return `i(${expression.source})`;
    case 'negate':
      return `(-${format(expression.operand)})`;
    case 'not':
      return `(!${format(expression.operand)})`;
    case 'binary':
    case 'compare':
    case 'logical':
      return `(${format(expression.left)}${expression.op}${format(expression.right)})`;
    case 'ternary':
      return `(${format(expression.condition)}?${format(expression.whenTrue)}:${format(expression.whenFalse)})`;
    case 'call':
      return `${expression.name}(${expression.args.map(format).join(',')})`;
  }
}

/** Distinct non-ground `v()` nodes of an expression, in first-reference order. */
export function behavioralControlNodes(expression: BehavioralExpression): string[] {
  return behavioralControls(expression).nodes;
}

function behavioralControls(expression: BehavioralExpression): { nodes: string[]; sources: string[] } {
  const nodes: string[] = [];
  const sources: string[] = [];
  const add = (node: string | undefined) => {
    if (node !== undefined && node !== GROUND && !nodes.includes(node)) nodes.push(node);
  };
  const visit = (node: BehavioralExpression): void => {
    switch (node.kind) {
      case 'voltage':
        add(node.positive);
        add(node.negative);
        return;
      case 'current':
        if (!sources.includes(node.source)) sources.push(node.source);
        return;
      case 'negate':
      case 'not':
        visit(node.operand);
        return;
      case 'binary':
      case 'compare':
      case 'logical':
        visit(node.left);
        visit(node.right);
        return;
      case 'ternary':
        visit(node.condition);
        visit(node.whenTrue);
        visit(node.whenFalse);
        return;
      case 'call':
        node.args.forEach(visit);
        return;
      case 'number':
      case 'variable':
        return;
    }
  };
  visit(expression);
  return { nodes, sources };
}

/** Simulator state a B-source expression reads besides node voltages. */
export interface BehavioralEnvironment {
  /** Analysis frequency in Hz; zero outside AC. */
  frequency?: number;
  /** Junction gmin used by ngspice's PTfudge_factor. Default: 1e-12 S. */
  gmin?: number;
  /** Simulation time in seconds (0 outside transient analysis). */
  time: number;
  /** True during the Newton iterations of a transient timepoint (ngspice MODETRAN). */
  transient: boolean;
  /** Circuit temperature in Celsius (`temper`). */
  temperature: number;
}

const DEFAULT_ENVIRONMENT: BehavioralEnvironment = { time: 0, transient: false, temperature: 27 };

/** A B-source expression evaluated out of range (ngspice `E_PARMVAL`, which aborts the analysis). */
export class BehavioralRangeError extends Error {}

export interface CompiledBehavioralExpression {
  readonly frequencyDependent?: boolean;
  /** Distinct non-ground controlling nodes, in first-reference order. */
  readonly nodes: readonly string[];
  /** Distinct controlling `i()` sources, in first-reference order. */
  readonly sources: readonly string[];
  /**
   * Evaluate at the given control values: the node voltages (indexed like
   * {@link nodes}) followed by the branch currents (indexed like
   * {@link sources}). Writes d(value)/d(control) into `gradient`, indexed the
   * same way, and returns the value.
   */
  evaluate(voltages: ArrayLike<number>, gradient: Float64Array, environment?: BehavioralEnvironment): number;
}

type Evaluator = (voltages: ArrayLike<number>, gradient: Float64Array, environment: BehavioralEnvironment) => number;

// ngspice ifeval.c: PTfudge_factor = CKTgmin * 1e-20.
function divideFudge(environment: BehavioralEnvironment): number {
  return (environment.gmin ?? DEVICE_GMIN) * 1e-20;
}
const EXP_LIMIT_ARGUMENT = 227.9559242;
const TWO_PI = 2 * Math.PI;

/** ngspice MODULUS(NUM, LIMIT): NUM - (int)(NUM / LIMIT) * LIMIT. */
function modulus(value: number, limit: number): number {
  return value - Math.trunc(value / limit) * limit;
}

/**
 * ngspice's HUGE: ngspice.h only defines it as HUGE_VAL when <math.h> lacks
 * it (CYGWIN); glibc and macOS define HUGE as FLT_MAX. ptfuncs.c returns it
 * as its range-error sentinel, so an IEEE +Infinity (pow(0, -0.5), an
 * overflowing product) is an ordinary value, not an error (#891).
 */
const HUGE = 3.4028234663852886e38;

/** ngspice PTeval reports E_PARMVAL when a node evaluates to exactly HUGE. */
function checked(value: number, what: string, ...args: number[]): number {
  if (value === HUGE) {
    throw new BehavioralRangeError(`Behavioral expression: ${args.join(', ')} out of range for ${what}`);
  }
  return value;
}

/** ngspice PTdivide. */
function ptDivide(a: number, b: number, fudge: number): number {
  const d = b >= 0 ? b + fudge : b - fudge;
  return d === 0 ? HUGE : a / d;
}

const ulpView = new DataView(new ArrayBuffer(16));

/** ngspice AlmostEqualUlps(nearbyint(x), x, 10). */
function almostInteger(value: number): boolean {
  const rounded = roundHalfEven(value);
  if (rounded === value) return true;
  if (!Number.isFinite(value)) return false;
  ulpView.setFloat64(0, rounded);
  ulpView.setFloat64(8, value);
  const a = ulpView.getBigInt64(0);
  const b = ulpView.getBigInt64(8);
  if ((a < 0n) !== (b < 0n)) return false;
  return (a > b ? a - b : b - a) <= 10n;
}

/** C round(): halves away from zero. */
function roundAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** ngspice PTpower (`pow()` and the derivative trees). */
function ptPower(a: number, b: number): number {
  if (a === 0) return 0;
  if (a > 0) return Math.pow(a, b);
  return almostInteger(b) ? Math.pow(a, roundAway(b)) : 0;
}

/** ngspice PTpowerH (the `^` operator in the default compatibility mode). */
function ptPowerH(a: number, b: number): number {
  if (a >= 0) return Math.pow(a, b);
  return almostInteger(b) ? Math.pow(a, roundAway(b)) : 0;
}

/** ngspice PTpwr (`pwr()`): sign-preserving power. */
function ptPwr(a: number, b: number): number {
  return a < 0 ? -Math.pow(-a, b) : Math.pow(a, b);
}

/**
 * PTpwr inside the `pow()`/`^` derivative tree. ngspice-47 PTpwr moves a zero
 * base off the pole when the exponent is negative (`arg1 += PTfudge_factor`,
 * gmin*1e-20) so the Jacobian stays finite; it applies that guard in PSpice
 * compatibility mode, the mode whose `pwrs()` spice-ts always expands. In
 * default mode ngspice-47 evaluates the slope as +Infinity, so `pow(V, 0.5)`
 * starting from V = 0 relies on its sparse solver's Inf/NaN handling
 * (converges when V moves off 0, aborts the .op when V stays at 0; #886).
 * spice-ts applies the guard everywhere: only the Jacobian at a = 0 exactly
 * changes, never a value or a slope ngspice computes finitely.
 */
function ptPwrSlope(a: number, b: number, fudge: number): number {
  return ptPwr(a === 0 && b < 0 ? fudge : a, b);
}

/** ngspice PTlog / PTlog10: -1e99 at 0, HUGE below. */
function ptLog(x: number, log: (x: number) => number): number {
  if (x < 0) return HUGE;
  if (x === 0) return -1e99;
  return log(x);
}

/** ngspice PTsqrt: HUGE below 0. */
function ptSqrt(x: number): number {
  return x < 0 ? HUGE : Math.sqrt(x);
}

function ptExp(value: number): number {
  return value > EXP_LIMIT_ARGUMENT ? 1e99 : Math.exp(value);
}

/** C nearbyint() in the default rounding mode: halves to even. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const fraction = x - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const ustep = (x: number) => (x < 0 ? 0 : x > 0 ? 1 : 0.5);

/** Square root inside a derivative tree, with PTsqrt's range check. */
const derivativeSqrt = (x: number) => checked(ptSqrt(x), 'sqrt', x);

/** ptfuncs.c value and the inpptree.c PTdifferentiate slope of a one-argument function. */
function unaryFunction(name: BehavioralFunction, x: number, fudge: number): [value: number, slope: number] {
  switch (name) {
    case 'abs': return [Math.abs(x), sgn(x)];
    case 'acos': return [Math.acos(x), ptDivide(-1, derivativeSqrt(1 - ptPowerH(x, 2)), fudge)];
    case 'acosh': return [Math.acosh(x), ptDivide(1, derivativeSqrt(ptPowerH(x, 2) - 1), fudge)];
    case 'asin': return [Math.asin(x), ptDivide(1, derivativeSqrt(1 - ptPowerH(x, 2)), fudge)];
    case 'asinh': return [Math.asinh(x), ptDivide(1, derivativeSqrt(ptPowerH(x, 2) + 1), fudge)];
    case 'atan': return [Math.atan(x), ptDivide(1, ptPowerH(x, 2) + 1, fudge)];
    case 'atanh': return [Math.atanh(x), ptDivide(1, 1 - ptPowerH(x, 2), fudge)];
    case 'cos': return [Math.cos(modulus(x, TWO_PI)), -Math.sin(modulus(x, TWO_PI))];
    case 'cosh': return [Math.cosh(x), Math.sinh(x)];
    case 'exp': {
      const value = ptExp(x);
      return [value, value];
    }
    case 'ln':
    case 'log': return [ptLog(x, Math.log), ptDivide(1, x, fudge)];
    case 'log10': return [ptLog(x, Math.log10), ptDivide(Math.LOG10E, x, fudge)];
    case 'sgn': return [sgn(x), 0];
    case 'sin': return [Math.sin(modulus(x, TWO_PI)), Math.cos(modulus(x, TWO_PI))];
    case 'sinh': return [Math.sinh(x), Math.cosh(x)];
    case 'sqrt': return [ptSqrt(x), ptDivide(1, 2 * derivativeSqrt(x), fudge)];
    case 'tan': {
      const value = Math.tan(modulus(x, Math.PI));
      return [value, 1 + ptPowerH(value, 2)];
    }
    case 'tanh': {
      const value = Math.tanh(x);
      return [value, 1 - ptPowerH(value, 2)];
    }
    case 'u': return [ustep(x), 0];
    case 'uramp': return [x < 0 ? 0 : x, ustep(x)];
    case 'ceil': return [Math.ceil(x), 0];
    case 'floor': return [Math.floor(x), 0];
    case 'nint': return [roundHalfEven(x), 0];
    case 'u2': return [x <= 0 ? 0 : x <= 1 ? x : 1, ustep(x) - ustep(x - 1)];
    case 'eq0': return [x === 0 ? 1 : 0, 0];
    case 'ne0': return [x !== 0 ? 1 : 0, 0];
    case 'gt0': return [x > 0 ? 1 : 0, 0];
    case 'lt0': return [x < 0 ? 1 : 0, 0];
    case 'ge0': return [x >= 0 ? 1 : 0, 0];
    case 'le0': return [x <= 0 ? 1 : 0, 0];
    default: throw new Error(`internal: ${name}() is not a one-argument function`);
  }
}

/**
 * Whether ngspice's parse tree holds `node` as a PT_CONSTANT, the test of
 * PTdifferentiate's literal-exponent and literal-base power rules. Only a
 * plain number is: the bison actions PT_mkfnode/PT_mkbnode never fold, so
 * `-0.5` stays PTF_UMINUS(0.5) and `(0-0.5)` a PT_MINUS node (inpptree.c
 * notes "we can meet a PTF_UMINUS->PTF_CONSTANT instead of a plain
 * PTF_CONSTANT"; only the derivative builders mkf/mkb fold constants).
 * Instrumented ngspice-47 confirms it: d/dV of `V^-0.5`, `V^(-0.5)` and
 * `V^(0-0.5)` at V = 0 is -0, the general rule pow(a,b)*(b*da/a + ...), not
 * the literal rule's -0.5*pwr(0, -1.5) = -inf (#891).
 */
function isConstantTree(node: BehavioralExpression): boolean {
  return node.kind === 'number';
}

/** ngspice rewrites `a OP b` as OP0(a - b) (eq0, ne0, gt0, lt0, ge0, le0). */
function compare(op: BehavioralComparison, difference: number): number {
  switch (op) {
    case '==': return difference === 0 ? 1 : 0;
    case '!=': return difference !== 0 ? 1 : 0;
    case '<': return difference < 0 ? 1 : 0;
    case '<=': return difference <= 0 ? 1 : 0;
    case '>': return difference > 0 ? 1 : 0;
    case '>=': return difference >= 0 ? 1 : 0;
  }
}

/**
 * Compile an expression into an evaluator returning its value and the
 * ngspice `PTdifferentiate` derivative with respect to each control node.
 * Each compiled expression owns its `ddt()` history: compile once per device
 * instance.
 */
export function compileBehavioralExpression(expression: BehavioralExpression): CompiledBehavioralExpression {
  const { nodes, sources } = behavioralControls(expression);
  const size = nodes.length + sources.length;
  let frequencyDependent = false;

  /**
   * d(base^exponent) as ngspice builds it for `^` and `pow()`: a literal
   * exponent c gives c*pwr(a, c-1)*da (ngspice-47 keeps the sign of a here),
   * a literal base gives pow(a,b)*db*log|a|, otherwise
   * pow(a,b)*(b*da/a + db*log|a|).
   *
   * At a = 0 with c < 1, pwr(0, c-1) is +Infinity: Newton's very first
   * iterate (all node voltages 0) would put an infinite entry in the
   * Jacobian. The derivative uses {@link ptPwrSlope}, ngspice's own guard
   * for this pole (PTpwr's PSpice-mode PTfudge_factor base, #886).
   */
  const powerGradient = (
    gradient: Float64Array,
    baseGradient: Float64Array,
    a: number,
    b: number,
    literalExponent: boolean,
    literalBase: boolean,
    fudge: number,
  ): void => {
    if (literalExponent) {
      const slope = b * ptPwrSlope(a, b - 1, fudge);
      for (let i = 0; i < size; i++) gradient[i] = slope * baseGradient[i];
      return;
    }
    const power = ptPower(a, b);
    const logAbs = ptLog(Math.abs(a), Math.log);
    if (literalBase) {
      for (let i = 0; i < size; i++) gradient[i] = power * (gradient[i] * logAbs);
      return;
    }
    for (let i = 0; i < size; i++) {
      gradient[i] = power * (b * ptDivide(baseGradient[i], a, fudge) + gradient[i] * logAbs);
    }
  };

  const build = (node: BehavioralExpression): Evaluator => {
    switch (node.kind) {
      case 'number': {
        const { value } = node;
        return (_voltages, gradient) => {
          gradient.fill(0);
          return value;
        };
      }
      case 'variable': {
        const time = node.name === 'time';
        const hertz = node.name === 'hertz';
        if (hertz) frequencyDependent = true;
        return (_voltages, gradient, environment) => {
          gradient.fill(0);
          return hertz ? environment.frequency ?? 0 : time ? environment.time : environment.temperature;
        };
      }
      case 'voltage': {
        const positive = node.positive === GROUND ? -1 : nodes.indexOf(node.positive);
        const negative = node.negative === undefined || node.negative === GROUND
          ? -1
          : nodes.indexOf(node.negative);
        return (voltages, gradient) => {
          gradient.fill(0);
          let value = 0;
          if (positive >= 0) {
            value += voltages[positive];
            gradient[positive] += 1;
          }
          if (negative >= 0) {
            value -= voltages[negative];
            gradient[negative] -= 1;
          }
          return value;
        };
      }
      case 'current': {
        // ngspice PT_CURRENT reads the branch unknown: d/d(branch) = 1.
        const index = nodes.length + sources.indexOf(node.source);
        return (values, gradient) => {
          gradient.fill(0);
          gradient[index] = 1;
          return values[index];
        };
      }
      case 'negate': {
        const operand = build(node.operand);
        return (voltages, gradient, environment) => {
          const value = operand(voltages, gradient, environment);
          for (let i = 0; i < size; i++) gradient[i] = -gradient[i];
          return -value;
        };
      }
      case 'not': {
        const operand = build(node.operand);
        return (voltages, gradient, environment) => {
          const value = operand(voltages, gradient, environment);
          gradient.fill(0);
          return value === 0 ? 1 : 0;
        };
      }
      case 'compare': {
        const left = build(node.left);
        const right = build(node.right);
        const { op } = node;
        return (voltages, gradient, environment) => {
          const a = left(voltages, gradient, environment);
          const b = right(voltages, gradient, environment);
          gradient.fill(0);
          return compare(op, a - b);
        };
      }
      case 'logical': {
        // ngspice: a && b -> eq0(eq0(a) + eq0(b)), a || b -> ne0(ne0(a) + ne0(b));
        // both operands are always evaluated.
        const left = build(node.left);
        const right = build(node.right);
        const and = node.op === '&&';
        return (voltages, gradient, environment) => {
          const a = left(voltages, gradient, environment) !== 0;
          const b = right(voltages, gradient, environment) !== 0;
          gradient.fill(0);
          return (and ? a && b : a || b) ? 1 : 0;
        };
      }
      case 'ternary': {
        // Only the selected branch is evaluated (ifeval.c PT_TERN), which
        // matters for ddt() histories inside the branches.
        const condition = build(node.condition);
        const whenTrue = build(node.whenTrue);
        const whenFalse = build(node.whenFalse);
        return (voltages, gradient, environment) => {
          const selected = condition(voltages, gradient, environment) !== 0 ? whenTrue : whenFalse;
          return selected(voltages, gradient, environment);
        };
      }
      case 'call':
        if (node.name === 'pwl') return buildPwl(node.args);
        if (node.name === 'ddt') return buildDdt(node.args[0]);
        return node.args.length === 2
          ? buildBinaryFunction(node.name, node.args[0], node.args[1])
          : buildUnaryFunction(node.name, node.args[0]);
      case 'binary':
        return buildBinary(node.op, node.left, node.right);
    }
  };

  // ngspice PTpwl/PTpwl_derivative: right-hand segment at an interior knot;
  // outside the table, extend the first/last segment (do not clamp).
  const buildPwl = (args: BehavioralExpression[]): Evaluator => {
    const argument = build(args[0]);
    const points = args.slice(1).map(arg => {
      if (arg.kind !== 'number') throw new Error('internal: nonliteral pwl point');
      return arg.value;
    });
    return (voltages, gradient, environment) => {
      const x = argument(voltages, gradient, environment);
      let low = 0;
      let high = points.length / 2 - 1;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (points[2 * middle] > x) high = middle;
        else low = middle;
      }
      const slope = (points[2 * high + 1] - points[2 * low + 1]) / (points[2 * high] - points[2 * low]);
      for (let i = 0; i < size; i++) gradient[i] *= slope;
      return checked(points[2 * low + 1] + slope * (x - points[2 * low]), 'pwl', x);
    };
  };

  const buildUnaryFunction = (name: BehavioralFunction, argumentNode: BehavioralExpression): Evaluator => {
    const argument = build(argumentNode);
    return (voltages, gradient, environment) => {
      const x = argument(voltages, gradient, environment);
      const [value, slope] = unaryFunction(name, x, divideFudge(environment));
      checked(value, name, x);
      for (let i = 0; i < size; i++) gradient[i] *= slope;
      return value;
    };
  };

  /**
   * ngspice PTddt: the backward difference of the argument values seen at
   * the first evaluation of each new transient time, lagged one timepoint;
   * 0 at time 0 and outside transient analysis, with a zero derivative.
   */
  const buildDdt = (argumentNode: BehavioralExpression): Evaluator => {
    const argument = build(argumentNode);
    // ngspice ddtdata vals: [t0, v0, t1, v1, t2, v2, slope].
    const vals = new Float64Array(7);
    let count = 0;
    return (voltages, gradient, environment) => {
      const arg = argument(voltages, gradient, environment);
      gradient.fill(0);
      const { time } = environment;
      if (time === 0) {
        // Each run starts from a clean history (ngspice keeps it across runs).
        vals.fill(0);
        count = 0;
        vals[3] = arg;
        return 0;
      }
      if (!environment.transient) return 0;
      if (time > vals[0]) {
        vals[4] = vals[2];
        vals[5] = vals[3];
        vals[2] = vals[0];
        vals[3] = vals[1];
        vals[0] = time;
        vals[1] = arg;
        if (count > 1) {
          vals[6] = (vals[1] - vals[3]) / (vals[2] - vals[4]);
        } else {
          vals[6] = 0;
          vals[3] = arg;
        }
        count++;
      }
      return vals[6];
    };
  };

  const buildBinaryFunction = (
    name: BehavioralFunction,
    leftNode: BehavioralExpression,
    rightNode: BehavioralExpression,
  ): Evaluator => {
    const left = build(leftNode);
    const right = build(rightNode);
    const leftGradient = new Float64Array(size);
    const literalExponent = isConstantTree(rightNode);
    const literalBase = isConstantTree(leftNode);
    return (voltages, gradient, environment) => {
      const a = left(voltages, leftGradient, environment);
      const b = right(voltages, gradient, environment);
      switch (name) {
        case 'min':
        case 'max': {
          // PTmin/PTmax; derivative (lt0|gt0)(a - b) ? da : db.
          const value = name === 'min' ? (a > b ? b : a) : (a > b ? a : b);
          if (name === 'min' ? a - b < 0 : a - b > 0) gradient.set(leftGradient);
          return value;
        }
        case 'pow': {
          const value = checked(ptPower(a, b), name, a, b);
          powerGradient(gradient, leftGradient, a, b, literalExponent, literalBase, divideFudge(environment));
          return value;
        }
        case 'pwr': {
          // d pwr(a,c) = c*pow(a, c-1)*da; otherwise pwr(a,b)*(b*da/a + db*log|a|).
          const value = checked(ptPwr(a, b), name, a, b);
          if (literalExponent) {
            const slope = b * ptPower(a, b - 1);
            for (let i = 0; i < size; i++) gradient[i] = slope * leftGradient[i];
          } else {
            const logAbs = ptLog(Math.abs(a), Math.log);
            for (let i = 0; i < size; i++) {
              gradient[i] = value * (b * ptDivide(leftGradient[i], a, divideFudge(environment)) + gradient[i] * logAbs);
            }
          }
          return value;
        }
        default:
          throw new Error(`internal: ${name}() is not a two-argument function`);
      }
    };
  };

  const buildBinary = (
    op: BehavioralBinaryOperator,
    leftNode: BehavioralExpression,
    rightNode: BehavioralExpression,
  ): Evaluator => {
    const left = build(leftNode);
    const right = build(rightNode);
    const leftGradient = new Float64Array(size);
    const literalExponent = isConstantTree(rightNode);
    const literalBase = isConstantTree(leftNode);
    const denominatorControls = op === '/' ? behavioralControls(rightNode) : undefined;
    const fixedDenominator = denominatorControls !== undefined
      && denominatorControls.nodes.length === 0 && denominatorControls.sources.length === 0;
    return (voltages, gradient, environment) => {
      const a = left(voltages, leftGradient, environment);
      const b = right(voltages, gradient, environment);
      switch (op) {
        case '+':
          for (let i = 0; i < size; i++) gradient[i] += leftGradient[i];
          return checked(a + b, op, a, b);
        case '-':
          for (let i = 0; i < size; i++) gradient[i] = leftGradient[i] - gradient[i];
          return checked(a - b, op, a, b);
        case '*':
          for (let i = 0; i < size; i++) gradient[i] = leftGradient[i] * b + a * gradient[i];
          return checked(a * b, op, a, b);
        case '/': {
          // PTdifferentiate simplifies a control-independent denominator to
          // da / b. Multiplying by b first would erase the slope at HERTZ=0.
          if (fixedDenominator) {
            for (let i = 0; i < size; i++) {
              gradient[i] = ptDivide(leftGradient[i], b, divideFudge(environment));
            }
            return checked(ptDivide(a, b, divideFudge(environment)), op, a, b);
          }
          // d(a/b) = (da*b - a*db) / b^2, with PTdivide's fudge on b^2.
          const denominator = ptPowerH(b, 2);
          for (let i = 0; i < size; i++) {
            gradient[i] = ptDivide(leftGradient[i] * b - a * gradient[i], denominator, divideFudge(environment));
          }
          return checked(ptDivide(a, b, divideFudge(environment)), op, a, b);
        }
        case '^': {
          const value = checked(ptPowerH(a, b), op, a, b);
          powerGradient(gradient, leftGradient, a, b, literalExponent, literalBase, divideFudge(environment));
          return value;
        }
      }
    };
  };

  const root = build(expression);
  return {
    nodes,
    sources,
    frequencyDependent,
    evaluate(voltages, gradient, environment = DEFAULT_ENVIRONMENT) {
      return root(voltages, gradient, environment);
    },
  };
}
