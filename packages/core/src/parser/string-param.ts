import { parseNumber } from './tokenizer.js';

/** Numparam strings stay distinct from numbers, including LUT tables and vector text. */
export type ParameterScope = Record<string, number | string>;

/** Resolve string atoms and .param concatenation; undefined means a numeric expression. */
export function stringParameter(expression: string, scope: ParameterScope): string | undefined {
  const text = expression.trim();
  // ngspice vector parameters are bracketed text, passed through string
  // aliases and subcircuit actuals until a vector-valued consumer reads them.
  const vector = text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1).trim() : text;
  if (vector.startsWith('[')) {
    if (!/^\[[^\[\]]+\]$/.test(vector)) throw new Error('Unsupported vector parameter form');
    const elements = vector.slice(1, -1).trim().split(/\s+/);
    if (!elements[0]) throw new Error('Empty vector parameter');
    for (const element of elements) parseNumber(element);
    return vector;
  }
  const atoms = text.match(/"[^"]*"|\{[^{}]*\}|[A-Za-z_]\w*/g);
  // xpressn.c string_expr: adjacent atoms only, with no intervening space.
  if (!atoms || atoms.join('') !== text) return undefined;
  let result = '';
  for (const atom of atoms) {
    if (atom.startsWith('"')) result += atom.slice(1, -1);
    else {
      const name = atom.replace(/^\{|\}$/g, '').trim().toUpperCase();
      if (!/^[A-Z_]\w*$/.test(name)) return undefined;
      const value = scope[name];
      if (typeof value !== 'string') return undefined;
      result += value;
    }
  }
  return result;
}

/** Replace bare string RHS names, without touching model names, ports or quoted literals. */
export function substituteStringAssignments(text: string, scope: ParameterScope): string {
  return text.replace(/("[^"]*")|(=\s*)([A-Za-z_]\w*)(?=\s|$|\))/g,
    (match, quoted: string | undefined, equals: string, name: string) => {
      if (quoted) return match;
      const value = scope[name.toUpperCase()];
      return typeof value === 'string' ? `${equals}${JSON.stringify(value)}` : match;
    });
}
