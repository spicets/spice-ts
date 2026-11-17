import type { SimulationRequestV1, SpiceApiErrorV1 } from '@spice-ts/core/protocol';

/** MCP-only extension; the protocol-v1 request and error-code set are unchanged. */
export type ParameterOverrideApiError = Omit<SpiceApiErrorV1, 'code'> & {
  code: 'UNKNOWN_PARAMETER' | 'INVALID_REQUEST';
};

export class ParameterOverrideError extends Error {
  constructor(readonly apiError: ParameterOverrideApiError) {
    super(apiError.message);
  }
}

export const parameterOverrides = {
  tools: ['spice_simulate', 'spice_simulation_start', 'spice_noise_metrics'],
  input: 'params',
  valueType: 'Record<string, number> (finite numbers)',
  scope: 'top-level .param in spice source only',
  caseSensitive: false,
  unknownParameterCode: 'UNKNOWN_PARAMETER',
} as const;

export const paramsSchema = {
  type: 'object',
  description: 'Case-insensitive top-level .param overrides, applied before elaboration. Finite numbers only. Unknown names return UNKNOWN_PARAMETER with available names. SPICE text only.',
  additionalProperties: { type: 'number' },
};

export function overrideParameters(request: SimulationRequestV1, params: unknown): SimulationRequestV1 {
  if (params === undefined) return request;
  const invalid = (message: string): never => {
    throw new ParameterOverrideError({ code: 'INVALID_REQUEST', message, phase: 'validation', retryable: false, details: {} });
  };
  if (params === null || typeof params !== 'object' || Array.isArray(params)) invalid('params must be a record of finite numbers');
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value !== 'number' || !Number.isFinite(value))) invalid('params values must be finite numbers');
  if (request.input.format !== 'spice') return invalid('params requires SPICE text input');
  const input = request.input;
  if (typeof input.source !== 'string') invalid('params requires SPICE text input');

  // Inspect logical cards, not elaborated values: an override can repair an invalid
  // default, and dependent .param/.if expressions must see it on their first pass.
  const cards: string[] = [];
  for (const line of input.source.split(/\r?\n/)) {
    const text = line.replace(/(?:;|\$|\/\/).*$/, '').trim();
    if (!text || text.startsWith('*')) continue;
    if (text.startsWith('+') && cards.length) cards[cards.length - 1] += ' ' + text.slice(1);
    else cards.push(text);
  }
  const available = new Set<string>();
  let depth = 0;
  let control = false;
  for (const card of cards) {
    if (/^\.control\b/i.test(card)) { control = true; continue; }
    if (/^\.endc\b/i.test(card)) { control = false; continue; }
    if (control) continue;
    if (/^\.subckt\b/i.test(card)) { depth++; continue; }
    if (/^\.ends\b/i.test(card)) { depth--; continue; }
    if (depth !== 0 || !/^\.param\s/i.test(card)) continue;
    // Quoted/braced expressions cannot introduce parameter declarations.
    const declarations = card.replace(/\{[^}]*\}|'[^']*'|"[^"]*"/g, '');
    for (const match of declarations.matchAll(/\b([A-Za-z_]\w*)\s*=/g)) available.add(match[1]!.toLowerCase());
  }
  const unknown = entries.map(([name]) => name).filter(name => !available.has(name.toLowerCase())).sort();
  if (unknown.length) {
    throw new ParameterOverrideError({ code: 'UNKNOWN_PARAMETER', message: 'Unknown top-level parameter',
      phase: 'validation', retryable: false, details: { unknown, available: [...available].sort() } });
  }
  const names = entries.map(([name]) => name.toLowerCase());
  if (new Set(names).size !== names.length) invalid('params contains duplicate case-insensitive names');
  if (!entries.length) return request;
  // Numparam resolves the last top-level definition lazily, including forward
  // references. Insert before .end so the resulting deck is also valid SPICE.
  const overrides = entries.map(([name, value]) => `.param ${name}=${value}`).join('\n');
  const end = /^\s*\.end\s*(?:[;$].*)?$/im.exec(input.source);
  const index = end?.index ?? input.source.length;
  const source = input.source.slice(0, index) + '\n' + overrides + '\n' + input.source.slice(index);
  return { ...request, input: { ...input, source } };
}
