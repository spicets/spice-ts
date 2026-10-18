import {
  complexVector, isComplex, isTrue, realVector, scalar, type ControlVector,
} from './vector.js';

/**
 * ngspice control-language vector expressions: the right-hand side of `let`,
 * `if`/`while`/`dowhile` conditions and `define` bodies.
 *
 * This is the front-end vector algebra of ngspice (`frontend/parse.c`), not the
 * numparam `{...}` evaluator used for `.param` cards: operands are whole real or
 * complex vectors, `(a, b)` builds a complex number, `v[i]` / `v[lo, hi]` index,
 * `v(node)` and `i(source)` name analysis vectors, and comparisons yield 0/1
 * vectors. Binary operators extend the shorter operand with its last element.
 */

/** Raised for an expression feature spice-ts does not evaluate (named in the message). */
export class UnsupportedExpressionFeature extends Error {
  constructor(public readonly feature: string, message: string) {
    super(message);
    this.name = 'UnsupportedExpressionFeature';
  }
}

/** Raised for an invalid expression or a failed evaluation. */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export type ExpressionNode =
  | { kind: 'number'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'probe'; fn: 'v' | 'i'; plot?: string; args: string[] }
  | { kind: 'call'; name: string; args: ExpressionNode[] }
  | { kind: 'unary'; op: '-' | '+' | 'not'; arg: ExpressionNode }
  | { kind: 'binary'; op: BinaryOperator; left: ExpressionNode; right: ExpressionNode }
  | { kind: 'ternary'; condition: ExpressionNode; whenTrue: ExpressionNode; whenFalse: ExpressionNode }
  | { kind: 'index'; target: ExpressionNode; index: ExpressionNode }
  | { kind: 'comma'; left: ExpressionNode; right: ExpressionNode };

type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'and' | 'or';

/** Evaluation context supplied by the interpreter. */
export interface ExpressionEnvironment {
  /** Resolve a vector by name (`out`, `vin#branch`, `dc1.time`, `@r1[resistance]`, `pi`). */
  lookup(name: string): ControlVector;
  /** A `define`d function, if one exists with this name and arity. */
  userFunction(name: string, arity: number): { params: string[]; body: ExpressionNode } | undefined;
  /** `set units=degrees` makes `ph()` return degrees. */
  degrees(): boolean;
}

type Token =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'probe'; fn: 'v' | 'i'; plot?: string; raw: string }
  | { type: 'op'; value: string };

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?([A-Za-z]*)/;
const NAME = /^[A-Za-z_@#][A-Za-z0-9_#.:@$]*/;
const WORD_OPERATORS: Record<string, string> = {
  eq: 'eq', ne: 'ne', gt: 'gt', lt: 'lt', ge: 'ge', le: 'le', and: 'and', or: 'or', not: 'not',
};
const SYMBOL_OPERATORS: [string, string][] = [
  ['>=', 'ge'], ['<=', 'le'], ['<>', 'ne'], ['><', 'ne'], ['!=', 'ne'], ['==', 'eq'],
  ['=', 'eq'], ['>', 'gt'], ['<', 'lt'], ['&', 'and'], ['|', 'or'], ['~', 'not'],
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'], ['^', '^'],
  ['(', '('], [')', ')'], ['[', '['], [']', ']'], [',', ','], ['?', '?'], [':', ':'],
];

/** SPICE scale suffixes accepted on control-language numbers (`1k`, `42mA`, `10Meg`). */
export function scaleSuffix(suffix: string): number {
  const lower = suffix.toLowerCase();
  if (lower.startsWith('meg')) return 1e6;
  if (lower.startsWith('mil')) return 25.4e-6;
  switch (lower[0]) {
    case undefined: return 1;
    case 't': return 1e12;
    case 'g': return 1e9;
    case 'k': return 1e3;
    case 'm': return 1e-3;
    case 'u': return 1e-6;
    case 'n': return 1e-9;
    case 'p': return 1e-12;
    case 'f': return 1e-15;
    case 'a': return 1e-18;
    default: return 1;
  }
}

/** Parse a control-language number (`1k`, `-2.5e-3`, `42mA`), or undefined. */
export function parseControlNumber(text: string): number | undefined {
  const trimmed = text.trim();
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const body = trimmed.replace(/^[+-]/, '');
  const match = NUMBER.exec(body);
  if (!match || match[0].length !== body.length) return undefined;
  const mantissa = Number(body.slice(0, body.length - match[1].length));
  return sign * mantissa * scaleSuffix(match[1]);
}

function tokenize(text: string, starts?: number[]): Token[] {
  const tokens: Token[] = [];
  let rest = text;
  while (rest.length > 0) {
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      rest = rest.slice(whitespace[0].length);
      continue;
    }
    starts?.push(text.length - rest.length);
    if (rest[0] === '"' || rest[0] === "'") {
      const end = rest.indexOf(rest[0], 1);
      if (end < 0) throw new ExpressionError(`unterminated string in '${text}'`);
      tokens.push({ type: 'string', value: rest.slice(1, end) });
      rest = rest.slice(end + 1);
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      const mantissa = Number(number[0].slice(0, number[0].length - number[1].length));
      tokens.push({ type: 'number', value: mantissa * scaleSuffix(number[1]) });
      rest = rest.slice(number[0].length);
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      let value = name[0];
      rest = rest.slice(value.length);
      // `@device[parameter]` keeps its bracket as part of the vector name.
      if (value.startsWith('@') && rest.startsWith('[')) {
        const close = rest.indexOf(']');
        if (close < 0) throw new ExpressionError(`unterminated '[' in '${text}'`);
        value += rest.slice(0, close + 1);
        rest = rest.slice(close + 1);
      }
      const lower = value.toLowerCase();
      if (WORD_OPERATORS[lower] && !value.includes('.')) {
        tokens.push({ type: 'op', value: WORD_OPERATORS[lower] });
        continue;
      }
      const dot = lower.lastIndexOf('.');
      const fn = lower.slice(dot + 1);
      if ((fn === 'v' || fn === 'i') && /^\s*\(/.test(rest)) {
        const open = rest.indexOf('(');
        const close = rest.indexOf(')', open);
        if (close < 0) throw new ExpressionError(`unterminated '(' in '${text}'`);
        tokens.push({
          type: 'probe',
          fn,
          ...(dot >= 0 ? { plot: lower.slice(0, dot) } : {}),
          raw: rest.slice(open + 1, close),
        });
        rest = rest.slice(close + 1);
        continue;
      }
      tokens.push({ type: 'name', value });
      continue;
    }
    const symbol = SYMBOL_OPERATORS.find(([operator]) => rest.startsWith(operator));
    if (!symbol) throw new ExpressionError(`unexpected character '${rest[0]}' in '${text}'`);
    tokens.push({ type: 'op', value: symbol[1] });
    rest = rest.slice(symbol[0].length);
  }
  return tokens;
}

const INFIX_POWER: Record<string, number> = {
  '?': 2, or: 3, and: 4,
  eq: 5, ne: 5, gt: 5, lt: 5, ge: 5, le: 5,
  ',': 7, '+': 8, '-': 8, '*': 9, '/': 9, '%': 9, '^': 11, '[': 12,
};
const PREFIX_POWER = 10;
// ngspice parse-bison.y: comparisons < NOT < comma < arithmetic.
const NOT_POWER = 6;

/** Parse a control-language vector expression into a syntax tree. */
export function parseVectorExpression(text: string): ExpressionNode {
  return parseExpressions(text, false)[0].tree;
}

/** Split a command's expression list at grammar boundaries, not whitespace. */
export function splitVectorExpressions(text: string): string[] {
  return parseExpressions(text, true).map(operand => operand.text);
}

function parseExpressions(text: string, multiple: boolean): { text: string; tree: ExpressionNode }[] {
  const starts: number[] = [];
  const tokens = tokenize(text, starts);
  if (tokens.length === 0) throw new ExpressionError('missing expression');
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const isOp = (token: Token | undefined, value: string): boolean =>
    token?.type === 'op' && token.value === value;
  const expect = (value: string): void => {
    if (!isOp(peek(), value)) throw new ExpressionError(`expected '${value}' in '${text}'`);
    position++;
  };

  function prefix(): ExpressionNode {
    const token = tokens[position++];
    if (!token) throw new ExpressionError(`unexpected end of expression '${text}'`);
    switch (token.type) {
      case 'number': return { kind: 'number', value: token.value };
      case 'string': return { kind: 'name', name: token.value };
      case 'probe': return {
        kind: 'probe', fn: token.fn, ...(token.plot ? { plot: token.plot } : {}),
        args: token.raw.split(',').map(arg => arg.trim()).filter(Boolean),
      };
      case 'name': {
        if (isOp(peek(), '(')) {
          position++;
          const args: ExpressionNode[] = [];
          if (!isOp(peek(), ')')) {
            args.push(expression(0));
          }
          expect(')');
          return { kind: 'call', name: token.value.toLowerCase(), args };
        }
        return { kind: 'name', name: token.value };
      }
      case 'op':
        if (token.value === '(') {
          const inner = expression(0);
          expect(')');
          return inner;
        }
        if (token.value === '-' || token.value === '+' || token.value === 'not') {
          return { kind: 'unary', op: token.value, arg: expression(token.value === 'not' ? NOT_POWER : PREFIX_POWER) };
        }
        throw new ExpressionError(`unexpected '${token.value}' in '${text}'`);
    }
  }

  function expression(rightPower: number): ExpressionNode {
    let left = prefix();
    for (;;) {
      const token = peek();
      if (token?.type !== 'op') {
        if (token === undefined || multiple) return left;
        throw new ExpressionError(`unexpected operand in '${text}'`);
      }
      const power = INFIX_POWER[token.value];
      if (power === undefined || power <= rightPower) return left;
      position++;
      switch (token.value) {
        case '[': {
          const index = expression(0);
          expect(']');
          left = { kind: 'index', target: left, index };
          break;
        }
        case '?': {
          const whenTrue = expression(INFIX_POWER['?']);
          expect(':');
          const whenFalse = expression(INFIX_POWER['?'] - 1);
          left = { kind: 'ternary', condition: left, whenTrue, whenFalse };
          break;
        }
        case ',':
          left = { kind: 'comma', left, right: expression(power) };
          break;
        case '^':
          left = { kind: 'binary', op: '^', left, right: expression(power - 1) };
          break;
        default:
          left = { kind: 'binary', op: token.value as BinaryOperator, left, right: expression(power) };
      }
    }
  }

  const operands: { text: string; tree: ExpressionNode }[] = [];
  do {
    const start = starts[position];
    const tree = expression(0);
    operands.push({ text: text.slice(start, starts[position] ?? text.length).trim(), tree });
    if (!multiple && position !== tokens.length) throw new ExpressionError(`unexpected trailing input in '${text}'`);
  } while (position < tokens.length);
  return operands;
}

// ---------------------------------------------------------------------------
// Evaluation

interface Complex { re: number; im: number }

/** Evaluate a parsed expression to a vector. */
export function evaluateVectorExpression(node: ExpressionNode, env: ExpressionEnvironment): ControlVector {
  switch (node.kind) {
    case 'number': return scalar(node.value);
    case 'name': return env.lookup(node.name);
    case 'probe': return evaluateProbe(node, env);
    case 'call': return evaluateCall(node, env);
    case 'unary': {
      const arg = evaluateVectorExpression(node.arg, env);
      if (node.op === '+') return arg;
      if (node.op === '-') return mapComplex(arg, value => ({ re: -value.re, im: -value.im }));
      return realVector('result', Array.from(arg.re, (value, index) =>
        value === 0 && (!arg.im || arg.im[index] === 0) ? 1 : 0));
    }
    case 'binary':
      return binary(node.op, evaluateVectorExpression(node.left, env), evaluateVectorExpression(node.right, env));
    case 'ternary':
      return isTrue(evaluateVectorExpression(node.condition, env))
        ? evaluateVectorExpression(node.whenTrue, env)
        : evaluateVectorExpression(node.whenFalse, env);
    case 'comma': {
      const re = evaluateVectorExpression(node.left, env);
      const im = evaluateVectorExpression(node.right, env);
      return combine(re, im, (a, b) => ({ re: a.re - b.im, im: a.im + b.re }), true);
    }
    case 'index': return evaluateIndex(evaluateVectorExpression(node.target, env), evaluateVectorExpression(node.index, env));
  }
}

function evaluateProbe(node: Extract<ExpressionNode, { kind: 'probe' }>, env: ExpressionEnvironment): ControlVector {
  const prefix = node.plot ? `${node.plot}.` : '';
  if (node.args.length === 0 || node.args.length > 2) {
    throw new ExpressionError(`${node.fn}() takes one or two arguments`);
  }
  if (node.fn === 'i') {
    if (node.args.length !== 1) throw new ExpressionError('i() takes one branch name');
    return env.lookup(`${prefix}${node.args[0]}#branch`);
  }
  const positive = env.lookup(`${prefix}${node.args[0]}`);
  if (node.args.length === 1) return positive;
  return binary('-', positive, env.lookup(`${prefix}${node.args[1]}`));
}

function evaluateIndex(target: ControlVector, index: ControlVector): ControlVector {
  const length = target.re.length;
  const at = (raw: number): number => {
    const position = Math.trunc(raw);
    if (!Number.isFinite(raw) || position < 0 || position >= length) {
      throw new ExpressionError(`index ${raw} out of range for vector '${target.name}' of length ${length}`);
    }
    return position;
  };
  const low = at(index.re[0]);
  const high = index.im ? at(index.im[0]) : low;
  const picks: number[] = [];
  for (let position = low; low <= high ? position <= high : position >= high; position += low <= high ? 1 : -1) {
    picks.push(position);
  }
  const re = picks.map(position => target.re[position]);
  return target.im
    ? complexVector(target.name, re, picks.map(position => target.im![position]))
    : realVector(target.name, re);
}

function element(vector: ControlVector, index: number): Complex {
  const position = Math.min(index, vector.re.length - 1);
  return { re: vector.re[position], im: vector.im ? vector.im[position] : 0 };
}

function combine(
  left: ControlVector,
  right: ControlVector,
  operation: (a: Complex, b: Complex) => Complex,
  forceComplex = false,
): ControlVector {
  if (left.re.length === 0 || right.re.length === 0) throw new ExpressionError('operand has zero length');
  const length = Math.max(left.re.length, right.re.length);
  const re = new Float64Array(length);
  const im = new Float64Array(length);
  let complex = forceComplex || isComplex(left) || isComplex(right);
  for (let index = 0; index < length; index++) {
    const value = operation(element(left, index), element(right, index));
    re[index] = value.re;
    im[index] = value.im;
    if (value.im !== 0) complex = true;
  }
  const scale = left.scale ?? right.scale;
  return complex ? complexVector('result', re, im, scale) : realVector('result', re, scale);
}

function compare(left: ControlVector, right: ControlVector, test: (a: Complex, b: Complex) => boolean): ControlVector {
  const result = combine(left, right, (a, b) => ({ re: test(a, b) ? 1 : 0, im: 0 }));
  return realVector('result', result.re, result.scale);
}

function binary(op: BinaryOperator, left: ControlVector, right: ControlVector): ControlVector {
  switch (op) {
    case '+': return combine(left, right, (a, b) => ({ re: a.re + b.re, im: a.im + b.im }));
    case '-': return combine(left, right, (a, b) => ({ re: a.re - b.re, im: a.im - b.im }));
    case '*': return combine(left, right, (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }));
    case '/': return combine(left, right, (a, b) => {
      const denominator = b.re * b.re + b.im * b.im;
      if (denominator === 0) throw new ExpressionError('divide by zero');
      return { re: (a.re * b.re + a.im * b.im) / denominator, im: (a.im * b.re - a.re * b.im) / denominator };
    });
    case '%': return combine(left, right, (a, b) => {
      if (a.im !== 0 || b.im !== 0) throw new ExpressionError("operator '%' needs real operands");
      const divisor = Math.floor(Math.abs(b.re));
      if (divisor === 0) throw new ExpressionError('argument out of range for mod');
      return { re: Math.floor(Math.abs(a.re)) % divisor, im: 0 };
    });
    case '^': return combine(left, right, power);
    case 'eq': return compare(left, right, (a, b) => a.re === b.re && a.im === b.im);
    case 'ne': return compare(left, right, (a, b) => a.re !== b.re || a.im !== b.im);
    case 'gt': return compare(left, right, (a, b) => a.re > b.re);
    case 'lt': return compare(left, right, (a, b) => a.re < b.re);
    case 'ge': return compare(left, right, (a, b) => a.re >= b.re);
    case 'le': return compare(left, right, (a, b) => a.re <= b.re);
    case 'and': return compare(left, right, (a, b) => (a.re !== 0 || a.im !== 0) && (b.re !== 0 || b.im !== 0));
    case 'or': return compare(left, right, (a, b) => a.re !== 0 || a.im !== 0 || b.re !== 0 || b.im !== 0);
  }
}

function power(base: Complex, exponent: Complex): Complex {
  if (base.im === 0 && exponent.im === 0) {
    const value = base.re ** exponent.re;
    if (!Number.isNaN(value)) return { re: value, im: 0 };
  }
  if (base.re === 0 && base.im === 0) return { re: 0, im: 0 };
  return complexExp(multiply(exponent, complexLog(base)));
}

function multiply(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function divide(a: Complex, b: Complex): Complex {
  const denominator = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / denominator, im: (a.im * b.re - a.re * b.im) / denominator };
}

function complexLog(value: Complex): Complex {
  return { re: Math.log(Math.hypot(value.re, value.im)), im: Math.atan2(value.im, value.re) };
}

function complexExp(value: Complex): Complex {
  const magnitude = Math.exp(value.re);
  return { re: magnitude * Math.cos(value.im), im: magnitude * Math.sin(value.im) };
}

function complexSqrt(value: Complex): Complex {
  const magnitude = Math.hypot(value.re, value.im);
  const re = Math.sqrt((magnitude + value.re) / 2);
  const im = Math.sign(value.im || 1) * Math.sqrt((magnitude - value.re) / 2);
  return { re, im: value.im === 0 && value.re >= 0 ? 0 : im };
}

const I: Complex = { re: 0, im: 1 };
const ONE: Complex = { re: 1, im: 0 };
const add = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const subtract = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });

const COMPLEX_FUNCTIONS: Record<string, (value: Complex) => Complex> = {
  exp: complexExp,
  sqrt: complexSqrt,
  sin: value => ({ re: Math.sin(value.re) * Math.cosh(value.im), im: Math.cos(value.re) * Math.sinh(value.im) }),
  cos: value => ({ re: Math.cos(value.re) * Math.cosh(value.im), im: -Math.sin(value.re) * Math.sinh(value.im) }),
  tan: value => divide(COMPLEX_FUNCTIONS.sin(value), COMPLEX_FUNCTIONS.cos(value)),
  sinh: value => ({ re: Math.sinh(value.re) * Math.cos(value.im), im: Math.cosh(value.re) * Math.sin(value.im) }),
  cosh: value => ({ re: Math.cosh(value.re) * Math.cos(value.im), im: Math.sinh(value.re) * Math.sin(value.im) }),
  tanh: value => divide(COMPLEX_FUNCTIONS.sinh(value), COMPLEX_FUNCTIONS.cosh(value)),
  // atan(z) = i/2 * ln((i + z) / (i - z))
  atan: value => multiply({ re: 0, im: 0.5 }, complexLog(divide(add(I, value), subtract(I, value)))),
  // asin(z) = -i ln(iz + sqrt(1 - z^2)), acos(z) = pi/2 - asin(z)
  asin: value => multiply({ re: 0, im: -1 }, complexLog(add(multiply(I, value), complexSqrt(subtract(ONE, multiply(value, value)))))),
  acos: value => subtract({ re: Math.PI / 2, im: 0 }, COMPLEX_FUNCTIONS.asin(value)),
  // asinh(z) = ln(z + sqrt(z^2 + 1)), acosh(z) = ln(z + sqrt(z + 1) sqrt(z - 1)), atanh(z) = ln((1 + z)/(1 - z)) / 2
  asinh: value => complexLog(add(value, complexSqrt(add(multiply(value, value), ONE)))),
  acosh: value => complexLog(add(value, multiply(complexSqrt(add(value, ONE)), complexSqrt(subtract(value, ONE))))),
  atanh: value => multiply({ re: 0.5, im: 0 }, complexLog(divide(add(ONE, value), subtract(ONE, value)))),
};

const REAL_FUNCTIONS: Record<string, (value: number) => number> = {
  exp: Math.exp, sqrt: Math.sqrt,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  atan: Math.atan, asin: Math.asin, acos: Math.acos, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
};

/**
 * ngspice-47 cx_log / cx_log10 (src/maths/cmaths/cmath1.c). A negative real
 * argument is an error named after the C function ("log" for ln too); a zero
 * real value or complex magnitude returns -log(HUGE), HUGE being FLT_MAX on the
 * reference build (ln(0) prints -88.7228, log10(0) -38.5318). The complex
 * branch takes atan2(im, re) as the imaginary part for log10 as well.
 */
const FLT_MAX = 3.4028234663852886e38;
interface Logarithm { readonly errorName: string; readonly real: (value: number) => number }
const LOGARITHMS: Record<string, Logarithm> = {
  ln: { errorName: 'log', real: Math.log },
  log: { errorName: 'log', real: Math.log },
  log10: { errorName: 'log10', real: Math.log10 },
};

function evaluateLogarithm(arg: ControlVector, { errorName, real }: Logarithm): ControlVector {
  const clamped = (value: number): number => (value === 0 ? -real(FLT_MAX) : real(value));
  if (!isComplex(arg)) {
    return mapReal(arg, value => {
      if (!(value >= 0)) throw new ExpressionError(`argument out of range for ${errorName}`);
      return clamped(value);
    });
  }
  return mapComplex(arg, value => {
    const magnitude = Math.hypot(value.re, value.im);
    if (magnitude === 0) return { re: clamped(0), im: 0 };
    return { re: real(magnitude), im: Math.atan2(value.im, value.re) };
  });
}

/** Functions of ngspice's front end that spice-ts deliberately does not evaluate. */
const UNSUPPORTED_FUNCTIONS = new Set([
  'deriv', 'integ', 'interpolate', 'fft', 'ifft', 'avg', 'group_delay', 'cph', 'unwrap',
  'sunif', 'sgauss', 'rnd', 'poisson', 'exponential', 'stddev', 'sum',
]);

function mapComplex(vector: ControlVector, operation: (value: Complex) => Complex): ControlVector {
  return combine(vector, vector, value => operation(value));
}

function mapReal(vector: ControlVector, operation: (value: number) => number, keepScale = true): ControlVector {
  return realVector('result', Array.from(vector.re, operation), keepScale ? vector.scale : undefined);
}

function magnitudes(vector: ControlVector): Float64Array {
  return Float64Array.from(vector.re, (value, index) => Math.hypot(value, vector.im ? vector.im[index] : 0));
}

function count(vector: ControlVector, name: string): number {
  const value = vector.re[0];
  if (!Number.isFinite(value) || value < 0) throw new ExpressionError(`${name}() needs a non-negative length`);
  return Math.trunc(value);
}

/** Round half to even, like C `nearbyint` in the default rounding mode (ngspice `nint`). */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function evaluateCall(node: Extract<ExpressionNode, { kind: 'call' }>, env: ExpressionEnvironment): ControlVector {
  // Built-ins consume the comma as complex construction; user-defined
  // functions use its leaves as their argument list, like ngspice's front end.
  const argumentsOf = (arg: ExpressionNode): ExpressionNode[] => arg.kind === 'comma'
    ? [...argumentsOf(arg.left), ...argumentsOf(arg.right)] : [arg];
  const userArgs = node.args.flatMap(argumentsOf);
  const user = env.userFunction(node.name, userArgs.length);
  if (user) {
    const bound = new Map(user.params.map((param, index) =>
      [param.toLowerCase(), evaluateVectorExpression(userArgs[index], env)]));
    return evaluateVectorExpression(user.body, {
      ...env,
      lookup: name => bound.get(name.toLowerCase()) ?? env.lookup(name),
    });
  }
  if (UNSUPPORTED_FUNCTIONS.has(node.name)) {
    throw new UnsupportedExpressionFeature(node.name, `vector function '${node.name}()' is not evaluated by spice-ts`);
  }
  if (node.args.length !== 1) {
    throw new ExpressionError(`unknown function '${node.name}' with ${node.args.length} arguments`);
  }
  const arg = evaluateVectorExpression(node.args[0], env);
  const logarithm = LOGARITHMS[node.name];
  if (logarithm) return evaluateLogarithm(arg, logarithm);
  const complexFunction = COMPLEX_FUNCTIONS[node.name];
  if (complexFunction) {
    const real = REAL_FUNCTIONS[node.name];
    if (!isComplex(arg) && Array.from(arg.re).every(value => !Number.isNaN(real(value)))) {
      return mapReal(arg, real);
    }
    return mapComplex(arg, complexFunction);
  }
  switch (node.name) {
    case 'mag':
    case 'abs':
    case 'magnitude':
      return realVector('result', magnitudes(arg), arg.scale);
    case 'ph':
    case 'phase': {
      const factor = env.degrees() ? 180 / Math.PI : 1;
      return realVector('result', Array.from(arg.re, (value, index) =>
        Math.atan2(arg.im ? arg.im[index] : 0, value) * factor), arg.scale);
    }
    case 'db':
      // ngspice-47 cx_db: rcheck(x > 0) on the real value or the magnitude.
      return realVector('result', Array.from(isComplex(arg) ? magnitudes(arg) : arg.re, value => {
        if (!(value > 0)) throw new ExpressionError('argument out of range for db');
        return 20 * Math.log10(value);
      }), arg.scale);
    case 'real':
    case 're':
      return realVector('result', arg.re, arg.scale);
    case 'imag':
    case 'im':
      return realVector('result', arg.im ?? new Float64Array(arg.re.length), arg.scale);
    case 'conj':
      return mapComplex(arg, value => ({ re: value.re, im: -value.im }));
    case 'j':
      return combine(arg, arg, value => multiply(I, value), true);
    case 'length':
      return scalar(arg.re.length);
    case 'vector':
      return realVector('result', Array.from({ length: count(arg, 'vector') }, (_, index) => index));
    case 'unitvec':
      return realVector('result', new Array<number>(count(arg, 'unitvec')).fill(1));
    case 'mean': {
      const length = arg.re.length;
      const re = arg.re.reduce((sum, value) => sum + value, 0) / length;
      if (!arg.im) return scalar(re);
      return complexVector('result', [re], [arg.im.reduce((sum, value) => sum + value, 0) / length]);
    }
    case 'vecmax':
    case 'vecmin': {
      const values = arg.im ? magnitudes(arg) : arg.re;
      if (values.length === 0) throw new ExpressionError(`${node.name}() of an empty vector`);
      return scalar(node.name === 'vecmax' ? Math.max(...values) : Math.min(...values));
    }
    case 'norm': {
      const largest = Math.max(...magnitudes(arg));
      if (largest === 0) throw new ExpressionError('norm() of a zero vector');
      return binary('/', arg, scalar(largest));
    }
    case 'floor': return mapComplex(arg, value => ({ re: Math.floor(value.re), im: Math.floor(value.im) }));
    case 'ceil': return mapComplex(arg, value => ({ re: Math.ceil(value.re), im: Math.ceil(value.im) }));
    case 'nint': return mapComplex(arg, value => ({ re: roundHalfEven(value.re), im: roundHalfEven(value.im) }));
    default:
      throw new UnsupportedExpressionFeature(node.name, `vector function '${node.name}()' is not evaluated by spice-ts`);
  }
}
