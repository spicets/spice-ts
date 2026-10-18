/** Numparam strings stay distinct from numbers, including digit-only LUT tables. */
export type ParameterScope = Record<string, number | string>;

/** Resolve string atoms and .param concatenation; undefined means a numeric expression. */
export function stringParameter(expression: string, scope: ParameterScope): string | undefined {
  const text = expression.trim();
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
