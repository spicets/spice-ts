/**
 * Recursive-descent expression evaluator for SPICE .param (ngspice numparam)
 * expressions.
 *
 * Grammar (lowest to highest precedence, following ngspice numparam):
 *   ternary  → or ('?' ternary ':' ternary)?
 *   or       → and ('||' and)*
 *   and      → equality ('&&' equality)*
 *   equality → relation (('==' | '!=' | '<>') relation)*
 *   relation → expr (('<' | '<=' | '>' | '>=') expr)*
 *   expr     → ('+' | '-')? term (('+' | '-') term)*   (leading sign = 0 ± term)
 *   term     → exp (('*' | '/' | '%') exp)*
 *   exp      → unary (('**' | '^') unary)*             (left-associative, |base|)
 *   unary    → '-' unary | '!' unary | call            (after an operator)
 *   call     → IDENT '(' formula (',' formula)* ')' | primary
 *   primary  → NUMBER | IDENT | '(' formula ')'
 *
 * Comparisons and logical operators yield 1 or 0, as in ngspice.
 *
 * A minus directly after another operator follows ngspice-47 formula()
 * (xpressn.c): it does not negate the operand that follows but sets a pending
 * `negate` flag that the next number literal of the same (sub-)formula
 * consumes. So `3*-2^2` = (-2)^2*3 = 12, `3*-x^2` = 3*x^-2 and `3*-x*2` =
 * 3*x*-2, while `3*-x` (no literal left in its formula) fails with ngspice's
 * "wrongly determined negation". Parentheses and function arguments are
 * separate formulas with their own flag. A `+` after an operator, or a sign
 * after `!`, is ngspice's "Misplaced operator".
 */

// SI suffix exponents — case-sensitive for m (milli) vs M (mega)
const SI_EXPONENTS: Record<string, string> = {
  T: 'e12', t: 'e12', G: 'e9', g: 'e9',
  K: 'e3', k: 'e3', M: 'e6', m: 'e-3',
  U: 'e-6', u: 'e-6', N: 'e-9', n: 'e-9',
  P: 'e-12', p: 'e-12', F: 'e-15', f: 'e-15',
};

/** Round half to even, like C `nearbyint` in ngspice's `nint`. */
function nint(x: number): number {
  const rounded = Math.round(x);
  return Math.abs(x % 1) === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
}

/**
 * ngspice numparam built-in functions (xpressn.c). `log` is the natural
 * logarithm in ngspice numparam, as in its B-source expressions.
 */
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  sqr: x => x * x,
  abs: Math.abs,
  log: Math.log,
  ln: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  // ngspice-47 numparam: pwr(-2,3) = 8, pwr(-4,0.5) = 2.
  pwr: (x, y) => Math.abs(x) ** y,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  sgn: Math.sign,
  // B-expression functions (ptfuncs.c), also accepted by the shared scalar
  // evaluator when preprocessing constant quoted B-source expressions.
  u: x => x < 0 ? 0 : x > 0 ? 1 : 0.5,
  u2: x => x <= 0 ? 0 : x <= 1 ? x : 1,
  uramp: x => x < 0 ? 0 : x,
  pwl,
  int: Math.trunc,
  nint,
  floor: Math.floor,
  ceil: Math.ceil,
  ternary_fcn: (condition, whenTrue, whenFalse) => (condition !== 0 ? whenTrue : whenFalse),
  limit,
};

/**
 * `limit(x, lo, hi)`: x clamped between the two bounds, in either order, as
 * ngspice-47's compatibility `.func limit(x, a, b) { ternary_fcn(a > b,
 * max(min(x, a), b), max(min(x, b), a)) }` (inpcompat.c). Native ngspice-47
 * numparam `limit(nominal, variation)` is a random Monte-Carlo draw that also
 * silently drops a third argument (ngspice-bugs #505); spice-ts has no random
 * parameter functions, so any arity but three is reported (#870).
 */
function limit(...args: number[]): number {
  if (args.length !== 3) {
    throw new Error(
      `limit() takes 3 arguments (x, lo, hi), got ${args.length}: the random ngspice `
      + 'limit(nominal, variation) Monte-Carlo function is not supported',
    );
  }
  const [x, a, b] = args;
  return a > b ? Math.max(Math.min(x, a), b) : Math.max(Math.min(x, b), a);
}

/**
 * Scalar counterpart of the B-source evaluator's ascending-point pwl table.
 * ngspice 3ef069fb (47 corpus): inpptree.c:1032-1110 prepares the table;
 * ptfuncs.c:342-401 selects the right segment at knots and extrapolates both
 * ends, rather than clamping. The Newton derivative lives in the behavioral
 * evaluator; this path also accepts evaluated parameter expressions as points.
 */
function pwl(x: number, ...points: number[]): number {
  if (points.length < 4 || points.length % 2 !== 0) {
    throw new Error('pwl() needs at least two pairs of points');
  }
  for (let i = 2; i < points.length; i += 2) {
    if (!(points[i] > points[i - 2])) {
      throw new Error('pwl() point abscissas must be strictly ascending');
    }
  }
  let low = 0;
  let high = points.length / 2 - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (points[2 * middle] > x) high = middle;
    else low = middle;
  }
  const slope = (points[2 * high + 1] - points[2 * low + 1]) / (points[2 * high] - points[2 * low]);
  return points[2 * low + 1] + slope * (x - points[2 * low]);
}

export function evaluateExpression(input: string, vars: Record<string, number | string>): number {
  const parser = new ExprParser(input.trim(), vars);
  const result = parser.parseFormula();
  parser.skipWhitespace();
  if (parser.pos < parser.src.length) {
    throw new Error(`Unexpected character '${parser.src[parser.pos]}' at position ${parser.pos} in expression: ${input}`);
  }
  return result;
}

const truth = (value: boolean): number => (value ? 1 : 0);

class ExprParser {
  pos = 0;
  /** ngspice formula() `negate`: a minus after an operator awaiting a number literal. */
  private negatePending = false;

  constructor(
    public readonly src: string,
    private readonly vars: Record<string, number | string>,
  ) {}

  /**
   * One ngspice (sub-)formula: the whole expression, a parenthesised group or
   * a function argument. Each has its own pending negation, which must be
   * consumed by a number literal before the formula ends.
   */
  parseFormula(): number {
    const outer = this.negatePending;
    this.negatePending = false;
    const value = this.parseTernary();
    if (this.negatePending) {
      throw new Error(`Problem with formula eval -- wrongly determined negation in expression: ${this.src}`);
    }
    this.negatePending = outer;
    return value;
  }

  private parseTernary(): number {
    const condition = this.parseOr();
    if (!this.accept('?')) return condition;
    const whenTrue = this.parseTernary();
    if (!this.accept(':')) throw new Error(`Expected ':' in conditional expression`);
    const whenFalse = this.parseTernary();
    return condition !== 0 ? whenTrue : whenFalse;
  }

  private parseOr(): number {
    let left = this.parseAnd();
    while (this.accept('||')) {
      const right = this.parseAnd();
      left = truth(left !== 0 || right !== 0);
    }
    return left;
  }

  private parseAnd(): number {
    let left = this.parseEquality();
    while (this.accept('&&')) {
      const right = this.parseEquality();
      left = truth(left !== 0 && right !== 0);
    }
    return left;
  }

  private parseEquality(): number {
    let left = this.parseRelation();
    for (;;) {
      if (this.accept('==')) left = truth(left === this.parseRelation());
      else if (this.accept('!=') || this.accept('<>')) left = truth(left !== this.parseRelation());
      else return left;
    }
  }

  private parseRelation(): number {
    let left = this.parseExpr();
    for (;;) {
      if (this.accept('<=')) left = truth(left <= this.parseExpr());
      else if (this.accept('>=')) left = truth(left >= this.parseExpr());
      else if (this.peekIs('<') && !this.peekIs('<>')) { this.pos++; left = truth(left < this.parseExpr()); }
      else if (this.accept('>')) left = truth(left > this.parseExpr());
      else return left;
    }
  }

  private parseExpr(): number {
    // ngspice numparam has no prefix minus at the start of a (sub-)formula: a
    // leading sign is the binary operator applied to an empty accumulator, so
    // `-2^2` is `0 - 2^2` = -4 and `-3^2+1` is -8 (ngspice-47).
    this.skipWhitespace();
    const ch = this.src[this.pos];
    let left = (ch === '+' || ch === '-') && this.atFormulaStart() ? 0 : this.parseTerm();
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      const ch = this.src[this.pos];
      if (ch === '+') { this.pos++; left = left + this.parseTerm(); }
      else if (ch === '-') { this.pos++; left = left - this.parseTerm(); }
      else break;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseExp();
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      const ch = this.src[this.pos];
      if (ch === '*' && this.src[this.pos + 1] !== '*') { this.pos++; left = left * this.parseExp(); }
      else if (ch === '/') { this.pos++; left = left / this.parseExp(); }
      else if (ch === '%') { this.pos++; left = left % this.parseExp(); }
      else break;
    }
    return left;
  }

  private parseExp(): number {
    // ngspice numparam accumulates `^`/`**` left to right like every other
    // binary level: `2^3^2` is (2^3)^2 = 64 (ngspice-47). Its default power is
    // pow(fabs(x), y), so `(-2)^3` is 8.
    let left = this.parseUnary();
    while (this.accept('**') || this.accept('^')) {
      left = Math.abs(left) ** this.parseUnary();
    }
    return left;
  }

  /** True when only whitespace, '(' or ',' precede the cursor in this formula. */
  private atFormulaStart(): boolean {
    let i = this.pos - 1;
    while (i >= 0 && (this.src[i] === ' ' || this.src[i] === '\t')) i--;
    return i < 0 || this.src[i] === '(' || this.src[i] === ',';
  }

  private parseUnary(afterNot = false): number {
    // Only reached after a binary operator, a pending negation or `!`; a sign
    // at the start of a formula is handled by parseExpr.
    this.skipWhitespace();
    const ch = this.src[this.pos];
    if (ch === '+' || (ch === '-' && afterNot)) {
      throw new Error(`Misplaced operator '${ch}' at position ${this.pos} in expression: ${this.src}`);
    }
    if (ch === '-') {
      // ngspice-47 formula(): `negate = 1`, consumed by the next number literal.
      this.pos++;
      this.negatePending = true;
      return this.parseUnary();
    }
    if (ch === '!' && this.src[this.pos + 1] !== '=') {
      this.pos++;
      return truth(this.parseUnary(true) === 0);
    }
    return this.parseCall();
  }

  private parseCall(): number {
    this.skipWhitespace();
    const identMatch = this.src.slice(this.pos).match(/^([a-zA-Z_]\w*)/);
    if (identMatch) {
      const name = identMatch[1];
      const afterIdent = this.pos + name.length;
      let peek = afterIdent;
      while (peek < this.src.length && this.src[peek] === ' ') peek++;
      if (this.src[peek] === '(') {
        const fn = FUNCTIONS[name.toLowerCase()];
        if (!fn) throw new Error(`Unknown function '${name}'`);
        this.pos = peek + 1;
        const args: number[] = [this.parseFormula()];
        this.skipWhitespace();
        while (this.src[this.pos] === ',') {
          this.pos++;
          args.push(this.parseFormula());
          this.skipWhitespace();
        }
        if (this.src[this.pos] !== ')') {
          throw new Error(`Expected ')' after function arguments in expression`);
        }
        this.pos++;
        return fn(...args);
      }
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWhitespace();

    if (this.src[this.pos] === '(') {
      this.pos++;
      const val = this.parseFormula();
      this.skipWhitespace();
      if (this.src[this.pos] !== ')') {
        throw new Error(`Expected ')' in expression`);
      }
      this.pos++;
      return val;
    }

    const literal = this.parseNumberLiteral();
    if (literal !== undefined) {
      if (!this.negatePending) return literal;
      this.negatePending = false;
      return -literal;
    }

    const varMatch = this.src.slice(this.pos).match(/^([a-zA-Z_]\w*)/);
    if (varMatch) {
      const name = varMatch[1];
      this.pos += name.length;
      const upper = name.toUpperCase();
      if (upper in this.vars || name in this.vars) {
        const value = this.vars[upper in this.vars ? upper : name];
        if (typeof value !== 'number') throw new Error(`String parameter '${name}' used in a numeric expression`);
        return value;
      }
      throw new Error(`Undefined variable '${name}'`);
    }

    throw new Error(`Unexpected character '${this.src[this.pos] ?? 'EOF'}' at position ${this.pos}`);
  }

  /** A number literal with optional SI suffix at the cursor, or undefined. */
  private parseNumberLiteral(): number | undefined {
    const numMatch = this.src.slice(this.pos).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    if (!numMatch) return undefined;
    this.pos += numMatch[0].length;
    const numStr = numMatch[0];
    // Check for SI suffix immediately after the number (no space)
    // Case-sensitive: m = milli, M = mega; MEG/meg = mega
    const suffixMatch = this.src.slice(this.pos).match(/^([Mm][Ee][Gg]|[TtGgKkMmUuNnPpFf])/);
    if (suffixMatch) {
      const suffix = suffixMatch[0];
      const afterSuffix = this.pos + suffix.length;
      // Check for embedded fractional digits (e.g., 3k3 = 3.3k = 3300)
      const fracMatch = this.src.slice(afterSuffix).match(/^(\d+)/);
      let fullNumStr = numStr;
      let endPos = afterSuffix;
      if (fracMatch && !numStr.includes('.') && !numMatch[2]) {
        fullNumStr = numStr + '.' + fracMatch[1];
        endPos = afterSuffix + fracMatch[1].length;
      }
      // fetchnumber swallows alphabetic unit text after the scale. Defaults
      // and numeric X actuals must retain this previously supported syntax.
      endPos += this.src.slice(endPos).match(/^[a-zA-Z]*/)![0].length;
      // Only consume if not followed by alphanumeric (not part of an identifier)
      const nextChar = this.src[endPos];
      if (!nextChar || !/[a-zA-Z0-9_]/.test(nextChar)) {
        const exp = suffix.length === 3 ? 'e6' : SI_EXPONENTS[suffix];
        this.pos = endPos;
        // xpressn.c fetchnumber: sscanf("%lG") rounds the decimal first,
        // then parseunit supplies a separately rounded scale multiplier.
        // Concatenating the exponent instead changes the last bits (0.05n).
        return Number(fullNumStr) * Number(`1${exp}`);
      }
    }
    // Unknown alphabetic units have scale 1 in parseunit.
    this.pos += this.src.slice(this.pos).match(/^[a-zA-Z]*/)![0].length;
    return Number(numStr);
  }

  private peekIs(token: string): boolean {
    this.skipWhitespace();
    return this.src.startsWith(token, this.pos);
  }

  private accept(token: string): boolean {
    if (!this.peekIs(token)) return false;
    this.pos += token.length;
    return true;
  }

  skipWhitespace(): void {
    while (this.pos < this.src.length && (this.src[this.pos] === ' ' || this.src[this.pos] === '\t')) this.pos++;
  }
}
