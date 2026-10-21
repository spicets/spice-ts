import { ParseError } from '../errors.js';
import { parseNumber } from './tokenizer.js';
import {
  NGSPICE_XSPICE_CODE_MODELS,
  XSPICE_CODE_MODEL_SPECS,
  type XspiceParamSpec,
  type XspiceParamValue,
} from '../devices/xspice/spec.js';

/** Token kinds of the XSPICE MIF tokenizer (ngspice mifutil.c MIFget_token). */
export type XspiceTokenKind =
  | 'string' | 'null' | 'percent' | 'tilde' | 'larray' | 'rarray' | 'lcomplex' | 'rcomplex';

export interface XspiceToken {
  readonly kind: XspiceTokenKind;
  readonly text: string;
}

/** An A-card whose connections are resolved at compile time against its model's port table. */
export interface XspiceInstanceCard {
  readonly name: string;
  /** Connection tokens between the instance name and the model name. */
  readonly connectionTokens: readonly XspiceToken[];
  readonly modelName: string;
  /** The logical card text, kept for round-trip netlist output. */
  readonly raw: string;
  readonly line: number;
}

/** A `.model` card of an implemented XSPICE code model with its values typed by the parameter table. */
export interface XspiceModelCard {
  /** Host-resolved bytes of a file-driven code model; never a filesystem handle. */
  readonly fileData?: string;
  readonly name: string;
  /** Lower-case code model name (ngspice Spice_Model_Name). */
  readonly codeModel: string;
  /** Parameters given on the card, by lower-case name; every value is an element list. */
  readonly params: ReadonlyMap<string, readonly XspiceParamValue[]>;
  /** ngspice-47 MIF warnings: unrecognized parameters (ignored) and clamped limits. */
  readonly warnings: readonly string[];
  readonly raw: string;
  /**
   * Translated from a PSpice `VSWITCH` (`'S'`, a pswitch) or `ISWITCH` (`'W'`,
   * an aswitch) model by ngspice-47 inpcompat.c: only instances of that switch
   * letter use it, each compiled to the code-model device.
   */
  readonly pspiceSwitch?: 'S' | 'W';
}

/**
 * Thrown for a `.model` card whose type is an ngspice XSPICE code model that
 * spice-ts does not implement (for example `d_osc` or `hyst`). The card is
 * rejected instead of being stored, so an A instance can never simulate
 * without its code model.
 */
export class UnsupportedCodeModelError extends ParseError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_XSPICE_CODE_MODEL';

  constructor(
    /** Model name as written on the `.model` card */
    public readonly modelName: string,
    /** Lower-case XSPICE code model type */
    public readonly codeModel: string,
    line: number,
    context: string,
  ) {
    super(
      `XSPICE code model '${codeModel}' (.model '${modelName}') is not supported`
        + ` (supported: ${[...XSPICE_CODE_MODEL_SPECS.keys()].join(', ')})`,
      line,
      context,
    );
    this.name = 'UnsupportedCodeModelError';
  }
}

const SKIPPED = /[\s=(),]/;
const SINGLE = new Set(['<', '>', '[', ']', '~', '%']);
const DELIMITER = /[\s=%(),[\]<>~]/;

/**
 * ngspice MIFget_token: whitespace, '=', '(', ')' and ',' separate tokens;
 * '[', ']', '<', '>', '~' and '%' are tokens of their own; a double-quoted
 * string is one token.
 */
export function tokenizeXspice(text: string): XspiceToken[] {
  const tokens: XspiceToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (SKIPPED.test(ch)) { i++; continue; }
    if (SINGLE.has(ch)) {
      tokens.push({ kind: singleKind(ch), text: ch });
      i++;
      continue;
    }
    let token: string;
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      token = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      i = end < 0 ? text.length : end + 1;
    } else {
      const start = i;
      while (i < text.length && !DELIMITER.test(text[i])) i++;
      token = text.slice(start, i);
    }
    tokens.push({ kind: token.toLowerCase() === 'null' ? 'null' : 'string', text: token });
  }
  return tokens;
}

function singleKind(ch: string): XspiceTokenKind {
  switch (ch) {
    case '[': return 'larray';
    case ']': return 'rarray';
    case '<': return 'lcomplex';
    case '>': return 'rcomplex';
    case '~': return 'tilde';
    default: return 'percent';
  }
}

/**
 * Parse an XSPICE A-card. ngspice reads the connections against the model's
 * port table, which may be declared after the instance, so only the token
 * stream is kept here; {@link resolveXspiceConnections} interprets it.
 */
export function parseXspiceInstance(raw: string, line: number): XspiceInstanceCard {
  const tokens = tokenizeXspice(raw);
  if (tokens.length < 2 || tokens[tokens.length - 1].kind !== 'string') {
    throw new ParseError('Missing model on A type device', line, raw);
  }
  return {
    name: tokens[0].text,
    connectionTokens: tokens.slice(1, -1),
    modelName: tokens[tokens.length - 1].text,
    raw,
    line,
  };
}

/** The lower-case type of a `.model` card when it names an ngspice XSPICE code model. */
export function xspiceModelType(tokens: readonly string[]): string | undefined {
  const type = tokens[2]?.toLowerCase();
  return type !== undefined && NGSPICE_XSPICE_CODE_MODELS.has(type) ? type : undefined;
}

/**
 * Parse a `.model` card of an XSPICE code model the way ngspice MIFgetMod
 * does: each parameter name is followed by a value typed by the code model's
 * parameter table (vectors in `[ ]`, booleans as t/true/f/false/1/0). An
 * unknown name is ignored with ngspice's warning and the scan continues with
 * the next token as a name.
 *
 * @throws {@link UnsupportedCodeModelError} when the code model is not implemented
 */
export function parseXspiceModelCard(raw: string, line: number): XspiceModelCard {
  const tokens = tokenizeXspice(raw);
  // tokens[0] is '.model'.
  const name = tokens[1]?.text;
  const codeModel = tokens[2]?.text.toLowerCase();
  if (!name || !codeModel) throw new ParseError('.model card is missing its name or type', line, raw);
  const spec = XSPICE_CODE_MODEL_SPECS.get(codeModel);
  if (!spec) throw new UnsupportedCodeModelError(name, codeModel, line, raw);

  const params = new Map<string, XspiceParamValue[]>();
  const warnings: string[] = [];
  let i = 3;
  while (i < tokens.length) {
    const token = tokens[i++];
    const param = spec.params.find(candidate => candidate.name === token.text.toLowerCase());
    if (!param) {
      warnings.push(`MIF: unrecognized parameter (${token.text}) - ignored`);
      continue;
    }
    // Numparam string substitution retains quotes through subcircuit calls.
    // Only a declared vector consumer interprets the bracketed payload.
    if (param.vector && tokens[i]?.kind === 'string' && tokens[i].text.trim().startsWith('[')) {
      tokens.splice(i, 1, ...tokenizeXspice(tokens[i].text));
    }
    const read = readParamValue(param, tokens, i, line, raw, name);
    i = read.next;
    params.set(param.name, clampToLimits(param, read.values, name, warnings));
  }
  return { name, codeModel, params, warnings, raw };
}

function readParamValue(
  param: XspiceParamSpec,
  tokens: readonly XspiceToken[],
  start: number,
  line: number,
  raw: string,
  modelName: string,
): { values: XspiceParamValue[]; next: number } {
  const fail = (message: string): never => {
    throw new ParseError(`MIF-ERROR - model: ${modelName} - ${message}`, line, raw);
  };
  let i = start;
  if (!param.vector) {
    const token = tokens[i++];
    if (token === undefined) fail('Unexpected end of model card');
    return { values: [convertValue(param, token!, fail)], next: i };
  }
  if (tokens[i]?.kind !== 'larray') fail('Array parameter expected - No array delimiter found');
  i++;
  const values: XspiceParamValue[] = [];
  for (;;) {
    const token = tokens[i++];
    if (token === undefined) fail('Unexpected end of model card');
    if (token!.kind === 'rarray') break;
    values.push(convertValue(param, token!, fail));
  }
  if (values.length === 0) fail('Array parameter must have at least one value');
  const [min, max] = param.vectorBounds ?? [undefined, undefined];
  if (min !== undefined && values.length < min) {
    fail(`Too few values for parameter '${param.name}' of model '${modelName}'`);
  }
  return { values: max !== undefined ? values.slice(0, max) : values, next: i };
}

function convertValue(
  param: XspiceParamSpec,
  token: XspiceToken,
  fail: (message: string) => never,
): XspiceParamValue {
  if (token.kind !== 'string') return fail(`Bad ${param.type} value '${token.text}'`);
  const text = token.text.toLowerCase();
  switch (param.type) {
    case 'boolean': {
      if (text === 't' || text === 'true') return true;
      if (text === 'f' || text === 'false') return false;
      const value = tryNumber(text);
      if (value === 0 || value === 1) return value === 1;
      return fail('Bad boolean value');
    }
    case 'int': {
      const value = tryNumber(text);
      return value === undefined ? fail('Bad integer, octal, or hex value') : Math.floor(value + 0.5);
    }
    case 'real': {
      const value = tryNumber(text);
      return value === undefined ? fail('Bad real value') : value;
    }
    case 'string':
      return token.text;
  }
}

function tryNumber(text: string): number | undefined {
  try {
    return parseNumber(text);
  } catch {
    return undefined;
  }
}

/** ngspice MIFmParam check_double: clamp to the parameter's limits and warn. */
function clampToLimits(
  param: XspiceParamSpec,
  values: XspiceParamValue[],
  modelName: string,
  warnings: string[],
): XspiceParamValue[] {
  if (!param.limits || param.type !== 'real') return values;
  const [lower, upper] = param.limits;
  return values.map(value => {
    const v = value as number;
    if (lower !== undefined && v < lower) {
      warnings.push(`Value ${v} below limit ${lower} for parameter '${param.name}' of model '${modelName}'.`);
      return lower;
    }
    if (upper !== undefined && v > upper) {
      warnings.push(`Value ${v} exceeds limit ${upper} for parameter '${param.name}' of model '${modelName}'.`);
      return upper;
    }
    return v;
  });
}
