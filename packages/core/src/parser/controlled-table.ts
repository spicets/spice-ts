import { ParseError } from '../errors.js';
import { endOfLineCommentStart } from './end-of-line-comment.js';
import { parseNumber } from './tokenizer.js';

/** Lower logical cards while retaining preprocessing scopes and source locations. */
export function lowerControlledTables<T extends { text: string; line: number; control?: boolean }>(statements: readonly T[]): T[] {
  const logical: T[] = [];
  let previous: T | undefined;
  for (const statement of statements) {
    if (previous && !statement.control && /^\s*\+/.test(statement.text) && /^\s*[eg]\S*\s+.*\btable\s*[={']/i.test(previous.text)) {
      previous.text = previous.text.slice(0, endOfLineCommentStart(previous.text)) + ` ${statement.text.replace(/^\s*\+\s*/, '')}`;
      logical.push({ ...statement, text: '' });
    } else {
      const copy = { ...statement };
      logical.push(copy);
      if (copy.text.trim() !== '' && !/^\s*\*/.test(copy.text)) previous = copy;
    }
  }
  const occupied = new Set(logical.flatMap(statement => statement.text.toLowerCase().split(/[\s(),={}\[\]]+/)));
  let serial = 0;
  return logical.flatMap(statement => {
    if (statement.control) return [statement];
    const raw = statement.text;
    const code = raw.slice(0, endOfLineCommentStart(raw));
    const head = /^\s*([eg]\S*)\s+\(?\s*([^\s()]+)\s+([^\s()]+)\s*\)?\s+table\s*(?==|\{|')/i.exec(code);
    if (!head) return [statement];
    const fail = (message: string): never => { throw new ParseError(`TABLE source '${head[1]}': ${message}`, statement.line, raw); };
    const tail = code.slice(head[0].length);
    const leadingAssignment = /^\s*=/.test(tail);
    const body = tail.replace(/^\s*=\s*/, '');
    const expression = /^(?:\{([^{}]+)\}|'([^']+)')\s*(=?)\s*/.exec(body);
    if (!expression) return fail('expected a braced or quoted input expression');
    // Also retain ngspice's compatibility spelling TABLE = {expr} (pairs).
    if (!leadingAssignment && !expression[3]) return fail('expected = between the input expression and table pairs');
    let rest = body.slice(expression[0].length);
    const xs: string[] = [];
    const ys: string[] = [];
    const value = '(\\{[^{}]+\\}|[^\\s(),]+)';
    const pair = new RegExp(`^\\s*\\(\\s*${value}\\s*(?:,\\s*|\\s+)${value}\\s*\\)`);
    while (true) {
      const match = pair.exec(rest);
      if (!match) break;
      xs.push(match[1]);
      ys.push(match[2]);
      rest = rest.slice(match[0].length);
    }
    const multiplier = /^\s*m\s*=\s*(\{[^{}]+\}|\S+)\s*$/i.exec(rest);
    if (xs.length < 2 || (rest.trim() !== '' && !multiplier)) return fail('expected at least two (x,y) pairs and optional m=');
    try {
      for (let i = 0; i < xs.length; i++) {
        if (!xs[i].startsWith('{')) {
          const x = parseNumber(xs[i]);
          if (!Number.isFinite(x) || (i > 0 && !xs[i - 1].startsWith('{') && x <= parseNumber(xs[i - 1]))) return fail('x values must be finite and strictly increasing');
        }
        if (!ys[i].startsWith('{') && !Number.isFinite(parseNumber(ys[i]))) return fail('y values must be finite');
      }
    } catch (error) {
      if (error instanceof ParseError) throw error;
      return fail((error as Error).message);
    }
    let names: string[];
    do {
      const stem = `__table917_${serial++}`;
      names = [`b${stem}`, `a${stem}`, `${stem}_in`, `${stem}_out`, `${stem}_model`];
    } while (names.some(name => occupied.has(name)));
    names.forEach(name => occupied.add(name));
    const [b, a, input, output, model] = names;
    // Fold G's multiplier into the output gain, also evaluated per X instance.
    const gain = /^g/i.test(head[1]) && multiplier ? multiplier[1] : '1';
    return [
      `${b} ${input} 0 v=${expression[1] ?? expression[2]}`,
      `${a} ${input} ${output} ${model}`,
      `.model ${model} pwl (x_array=[${xs.join(' ')}] y_array=[${ys.join(' ')}] input_domain=.1 fraction=TRUE limit=TRUE)`,
      `${head[1]} ${head[2]} ${head[3]} ${output} 0 ${gain}`,
    ].map(text => ({ ...statement, text }));
  });
}

/**
 * Reject an unlowered PSpice E/G TABLE card before it can become a linear
 * source. ngspice-47 inpcom.c lowers these to an ASRC input, a smoothed and
 * input-limited XSPICE PWL transfer, and an E/G output. Hard interpolation
 * alone is not equivalent. The preprocessor lowers supported cards; direct
 * tokenizer/linear-parser callers must still fail closed (#917).
 *
 * Parentheses are separators here, including paired output/control nodes.
 * A genuine linear control node named `table` remains legal: it has exactly
 * two control nodes and a gain, with no expression or assignment syntax.
 */
export function assertNoControlledTable(tokens: readonly string[], lineNumber: number, raw: string): void {
  if (!/^[eg]/i.test(tokens[0] ?? '')) return;
  const fields = tokens.filter(token => token !== '(' && token !== ')');
  if (!/^table(?:=|$)/i.test(fields[3] ?? '')) return;
  const linearControls = fields.length >= 6 && !/[{}=]/.test(fields[4])
    && !fields.slice(3, 6).some(token => token.includes('='))
    && fields.slice(6).every(token => /^m=/i.test(token));
  if (linearControls) return;
  throw new ParseError(
    `Controlled source '${tokens[0]}': TABLE syntax is not supported; `
      + 'ngspice-compatible smoothed, clamped transfer lowering is required',
    lineNumber, raw,
  );
}
