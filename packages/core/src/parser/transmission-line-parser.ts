import { ParseError } from '../errors.js';
import { parseUrcParams } from '../devices/urc.js';
import type { ModelParams } from '../types.js';
import { parseNumber } from './tokenizer.js';
import type { TransmissionLineInitialConditions } from '../devices/transmission-line.js';

export interface ParsedTransmissionLine {
  impedance: number;
  delay: number;
  initialConditions?: TransmissionLineInitialConditions;
  relativeTolerance?: number;
  absoluteTolerance?: number;
}

export interface ParsedLossyTransmissionLine {
  modelName: string;
}

const LTRA_NUMERIC_PARAMETERS = new Set([
  'R', 'L', 'G', 'C', 'LEN', 'REL', 'COMPACTREL', 'COMPACTABS',
]);
const LTRA_FLAG_PARAMETERS = new Set([
  'STEPLIMIT', 'NOSTEPLIMIT', 'NOCONTROL', 'NOPRINT', 'QUADINTERP',
  'LININTERP', 'MIXEDINTERP', 'TRUNCNR', 'TRUNCDONTCUT',
]);

/** Parse the bounded O-card: four nodes and one LTRA model name. */
export function parseLossyTransmissionLine(
  tokens: string[],
  lineNumber: number,
): ParsedLossyTransmissionLine {
  if (tokens.length !== 6) {
    throw new ParseError(
      "Unsupported LTRA O-card; expected 'Oname p1+ reference p2+ reference model' without instance parameters",
      lineNumber,
      tokens.join(' '),
    );
  }
  if (tokens[2].toUpperCase() !== tokens[4].toUpperCase()) {
    throw new ParseError(
      'Unsupported LTRA O-card: both ports must use a common reference node',
      lineNumber,
      tokens.join(' '),
    );
  }
  return { modelName: tokens[5] };
}

/** Parse and validate the benchmark-bounded RLC LTRA model card. */
export function parseLtraModelCard(tokens: string[], lineNumber: number): ModelParams {
  const params: Record<string, number> = {};
  for (const token of tokens.slice(3)) {
    if (token === '(' || token === ')') continue;
    const separator = token.indexOf('=');
    const key = (separator < 0 ? token : token.slice(0, separator)).toUpperCase();
    if (LTRA_FLAG_PARAMETERS.has(key)) {
      // ngspice ltrampar.c selectors act on presence, including flag=0.
      if (separator >= 0) parseNumber(token.slice(separator + 1));
      const selectors = key === 'STEPLIMIT' || key === 'NOSTEPLIMIT'
        ? ['STEPLIMIT', 'NOSTEPLIMIT']
        : ['LININTERP', 'QUADINTERP', 'MIXEDINTERP'].includes(key)
          ? ['LININTERP', 'QUADINTERP', 'MIXEDINTERP'] : [];
      for (const selector of selectors) delete params[selector];
      params[key] = 1;
      continue;
    }
    if (!LTRA_NUMERIC_PARAMETERS.has(key) || separator <= 0 || separator === token.length - 1) {
      throw new ParseError(`Unsupported LTRA model parameter: '${token}'`, lineNumber, tokens.join(' '));
    }
    if (params[key] !== undefined) {
      throw new ParseError(`Duplicate LTRA model parameter: '${key}'`, lineNumber, tokens.join(' '));
    }
    params[key] = parseNumber(token.slice(separator + 1));
  }
  return { name: tokens[1], type: 'LTRA', params };
}

/** Parse lossless T-card delay as TD or electrical length NL/F. */
export function parseTransmissionLine(
  tokens: string[],
  lineNumber: number,
): ParsedTransmissionLine {
  if (tokens.length < 6) {
    throw new ParseError(
      "Unsupported lossless transmission line form; expected 'Tname p1+ p1- p2+ p2- Z0=value [TD=value | F=value NL=value]'",
      lineNumber,
      tokens.join(' '),
    );
  }

  const params = new Map<string, number>();
  let initialConditions: TransmissionLineInitialConditions | undefined;
  for (let index = 5; index < tokens.length; index++) {
    const token = tokens[index];
    const separator = token.indexOf('=');
    const key = separator > 0 ? token.slice(0, separator).toUpperCase() : '';
    if (key === 'IC') {
      const values = [token.slice(separator + 1)];
      while (index + 1 < tokens.length && !tokens[index + 1].includes('=')) values.push(tokens[++index]);
      if (initialConditions || values.length !== 4 || values.some(value => value === '')) {
        throw new ParseError('Lossless transmission line IC requires exactly four values V1,I1,V2,I2', lineNumber, tokens.join(' '));
      }
      const parsed = values.map(value => parseNumber(value));
      if (parsed.some(value => !Number.isFinite(value))) {
        throw new ParseError('Lossless transmission line IC values must be finite', lineNumber, tokens.join(' '));
      }
      initialConditions = [parsed[0], parsed[1], parsed[2], parsed[3]];
      continue;
    }
    if (!['Z0', 'TD', 'F', 'NL', 'REL', 'ABS'].includes(key) || params.has(key)) {
      throw new ParseError(
        'Unsupported lossless transmission line parameter; only Z0, TD, F, NL, IC, REL and ABS are supported',
        lineNumber,
        tokens.join(' '),
      );
    }
    const value = parseNumber(token.slice(separator + 1));
    if (!Number.isFinite(value)) {
      throw new ParseError('Lossless transmission line parameters must be finite', lineNumber, tokens.join(' '));
    }
    params.set(key, value);
  }

  const impedance = params.get('Z0');
  // ngspice-47 trasetup.c defaults F=1GHz and NL=.25; tratemp.c
  // computes NL/F only when TD was not explicitly given, regardless of order.
  const delay = params.get('TD') ?? (params.get('NL') ?? 0.25) / (params.get('F') ?? 1e9);
  if (
    impedance === undefined
    || delay === undefined
    || !Number.isFinite(impedance)
    || !Number.isFinite(delay)
    || impedance <= 0
    || delay <= 0
  ) {
    throw new ParseError(
      'Lossless transmission line requires positive Z0 and TD values',
      lineNumber,
      tokens.join(' '),
    );
  }

  return { impedance, delay, initialConditions, relativeTolerance: params.get('REL'), absoluteTolerance: params.get('ABS') };
}

/** A parsed Y-element (ngspice TXL single lossy line). */
export interface ParsedTxlLine {
  /** Signal nodes of the two ports; ngspice ignores the reference nodes. */
  input: string;
  output: string;
  modelName: string;
  /** Instance `len` override of the model length. */
  length?: number;
}

/** A parsed P-element (ngspice CPL coupled multiconductor lossy lines). */
export interface ParsedCplLines {
  /** Signal nodes of the input side, one per conductor. */
  inputs: string[];
  /** Signal nodes of the output side, one per conductor. */
  outputs: string[];
  modelName: string;
  /** Instance `len`/`length` override of the model length. */
  length?: number;
}

/** ngspice CPL keeps per-instance history in fixed arrays of this many lines (swec.h). */
export const MAX_CPL_LINES = 8;

function isLengthKeyword(token: string, keywords: readonly string[]): boolean {
  const lower = token.toLowerCase();
  return keywords.some(keyword => lower === keyword || lower.startsWith(`${keyword}=`));
}

/**
 * ngspice reads an instance length as `len value` or `len=value` directly
 * after the model name and ignores anything else on the card.
 */
function parseInstanceLength(
  tokens: string[],
  index: number,
  keywords: readonly string[],
  lineNumber: number,
): number | undefined {
  const token = tokens[index];
  if (token === undefined || !isLengthKeyword(token, keywords)) return undefined;
  const separator = token.indexOf('=');
  const text = separator >= 0 ? token.slice(separator + 1) : tokens[index + 1];
  if (text === undefined || text === '') {
    throw new ParseError('Transmission-line length keyword has no value', lineNumber, tokens.join(' '));
  }
  const value = parseNumber(text);
  if (!Number.isFinite(value)) {
    throw new ParseError(`Transmission-line length must be finite, got '${text}'`, lineNumber, tokens.join(' '));
  }
  return value;
}

/**
 * Parse `Yname n1 ref1 n2 ref2 model [len=value]` (ngspice inp2y.c). As in
 * ngspice, both ports are referenced to ground and the reference node tokens
 * are not connected to the line.
 */
export function parseTxlLine(tokens: string[], lineNumber: number): ParsedTxlLine {
  if (tokens.length < 6) {
    throw new ParseError(
      "TXL Y-card requires 'Yname n1 ref1 n2 ref2 model [len=value]'",
      lineNumber,
      tokens.join(' '),
    );
  }
  return {
    input: tokens[1],
    output: tokens[3],
    modelName: tokens[5],
    length: parseInstanceLength(tokens, 6, ['len'], lineNumber),
  };
}

/**
 * Parse `Pname in1 .. inN ref1 out1 .. outN ref2 model [len=value]`
 * (ngspice inp2p.c): the conductor count follows from the tokens before an
 * optional `len`/`length` keyword. The reference nodes are not connected.
 */
export function parseCplLines(tokens: string[], lineNumber: number): ParsedCplLines {
  let count = 0;
  while (1 + count < tokens.length && !isLengthKeyword(tokens[1 + count], ['length', 'len'])) count++;
  const lines = Math.floor((count - 2) / 2);
  if (count < 5 || count % 2 === 0) {
    throw new ParseError(
      "CPL P-card requires 'Pname in1..inN ref1 out1..outN ref2 model [len=value]'",
      lineNumber,
      tokens.join(' '),
    );
  }
  if (lines > MAX_CPL_LINES) {
    throw new ParseError(
      `CPL P-card couples ${lines} lines; ngspice-47 supports at most ${MAX_CPL_LINES}`,
      lineNumber,
      tokens.join(' '),
    );
  }
  const inputs = tokens.slice(1, 1 + lines);
  const outputs = tokens.slice(2 + lines, 2 + 2 * lines);
  return {
    inputs,
    outputs,
    modelName: tokens[3 + 2 * lines],
    length: parseInstanceLength(tokens, 4 + 2 * lines, ['length', 'len'], lineNumber),
  };
}

const CPL_MATRIX_PARAMETERS = new Set(['R', 'L', 'G', 'C']);

/** Model-parameter key of element `index` of a CPL upper-triangular matrix. */
export function cplMatrixKey(name: string, index: number): string {
  return `${name}[${index}]`;
}

/**
 * Parse `.model name CPL R=r11 r12 .. rNN L=.. G=.. C=.. length=..`: each
 * matrix is given as its upper triangle, row by row (ngspice IF_REALVEC).
 * Element k of matrix X is stored as parameter `X[k]`.
 */
export function parseCplModelCard(tokens: string[], lineNumber: number): ModelParams {
  const params: Record<string, number> = {};
  const counts = new Map<string, number>();
  let current: string | undefined;
  for (const token of tokens.slice(3)) {
    if (token === '(' || token === ')') continue;
    const separator = token.indexOf('=');
    if (separator < 0) {
      const flag = token.toUpperCase();
      if (current === undefined && (flag === 'CPL' || flag === 'TXL')) continue;
      if (current === undefined) {
        throw new ParseError(`Unsupported CPL model parameter: '${token}'`, lineNumber, tokens.join(' '));
      }
      const index = counts.get(current)!;
      params[cplMatrixKey(current, index)] = parseCplNumber(token, lineNumber, tokens);
      counts.set(current, index + 1);
      continue;
    }
    const key = token.slice(0, separator).toUpperCase();
    const value = token.slice(separator + 1);
    if (key === 'LENGTH') {
      params.LENGTH = parseCplNumber(value, lineNumber, tokens);
      current = undefined;
      continue;
    }
    if (!CPL_MATRIX_PARAMETERS.has(key)) {
      throw new ParseError(`Unsupported CPL model parameter: '${token}'`, lineNumber, tokens.join(' '));
    }
    for (const existing of Object.keys(params)) {
      if (existing.startsWith(`${key}[`)) delete params[existing];
    }
    current = key;
    counts.set(key, 0);
    if (value !== '') {
      params[cplMatrixKey(key, 0)] = parseCplNumber(value, lineNumber, tokens);
      counts.set(key, 1);
    }
  }
  return { name: tokens[1], type: 'CPL', params };
}

function parseCplNumber(text: string, lineNumber: number, tokens: string[]): number {
  try {
    return parseNumber(text);
  } catch {
    throw new ParseError(`Invalid CPL model value: '${text}'`, lineNumber, tokens.join(' '));
  }
}

/** Upper-triangular CPL matrix `name` from model parameters, or undefined if not given. */
export function cplMatrixValues(model: ModelParams, name: string): number[] | undefined {
  const values: number[] = [];
  while (model.params[cplMatrixKey(name, values.length)] !== undefined) {
    values.push(model.params[cplMatrixKey(name, values.length)]);
  }
  return values.length > 0 ? values : undefined;
}

/** Serialize a CPL model in the ngspice vector form accepted by {@link parseCplModelCard}. */
export function formatCplModelCard(model: ModelParams): string {
  const parts = [`.model ${model.name} CPL`];
  for (const name of ['R', 'L', 'G', 'C']) {
    const values = cplMatrixValues(model, name);
    if (values) parts.push(`${name}=${values.join(' ')}`);
  }
  if (model.params.LENGTH !== undefined) parts.push(`length=${model.params.LENGTH}`);
  return parts.join(' ');
}

/**
 * Model cards whose parameter syntax differs from the generic `key=value`
 * form: LTRA (validated subset) and CPL (vector parameters). Returns
 * undefined for every other model type.
 */
export function parseTransmissionLineModelCard(tokens: string[], lineNumber: number): ModelParams | undefined {
  const type = tokens[2]?.toUpperCase();
  if (type === 'URC') return { name: tokens[1], type, params: parseUrcParams(tokens.slice(3), lineNumber, true) };
  if (type === 'LTRA') return parseLtraModelCard(tokens, lineNumber);
  if (type === 'CPL') return parseCplModelCard(tokens, lineNumber);
  return undefined;
}
