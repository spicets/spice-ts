import { ParseError } from '../errors.js';
import { parseNumber } from './tokenizer.js';

/** Per-instance BJT scaling; ngspice-47 bjtsetup.c/vbicsetup.c default AREA and M to 1. */
export interface BJTInstanceParams {
  /** Emitter area factor (ngspice `area`, positional or keyword). */
  AREA?: number;
  /** Base area factor (ngspice `areab`); bjtsetup.c defaults it to AREA. */
  AREAB?: number;
  /** Collector area factor (ngspice `areac`); bjtsetup.c defaults it to AREA. */
  AREAC?: number;
  /** Parallel multiplier (ngspice `m`). */
  M?: number;
  /** Absolute Celsius temperature, overriding circuit TEMP and DTEMP. */
  TEMP?: number;
  /** Celsius offset from circuit temperature when TEMP is absent. */
  DTEMP?: number;
  /** Initial physical base-emitter voltage, used only with transient UIC. */
  ICVBE?: number;
  /** Initial physical collector-emitter voltage, used only with transient UIC. */
  ICVCE?: number;
}

export interface ParsedBJTInstance {
  collector: string;
  base: string;
  emitter: string;
  modelName: string;
  /** Fourth terminal; absent for the three-terminal card. */
  substrate?: string;
  /** Fifth (thermal) terminal; only VBIC/HICUM accept it in ngspice-47. */
  thermal?: string;
  /** Instance scaling; absent when the card gives neither AREA nor M. */
  params?: BJTInstanceParams;
}

/**
 * A complete SPICE number with an optional scale/unit suffix. Trailing digits
 * after letters are not a number, so `2N3904` stays a model name.
 */
const STRICT_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-z]*$/i;

const INSTANCE_KEYWORDS: readonly (keyof BJTInstanceParams)[] = ['AREA', 'AREAB', 'AREAC', 'M', 'TEMP', 'DTEMP'];

const isKeywordOrFlag = (token: string): boolean =>
  token.includes('=') || token.toUpperCase() === 'OFF';

/**
 * Parse the ngspice-47 Q-card forms used by the public benchmark corpora:
 *
 *   Qname c b e [s [t]] model [area] [AREA=val] [AREAB=val] [AREAC=val] [M=val] [OFF]
 *
 * As in ngspice-47, a grounded substrate (`Qx c b e 0 MODEL`) is a node like
 * any other: the model is the last positional token (before an optional
 * positional area), never the substrate itself. A positional area is
 * recognised only when it is a complete number following a non-numeric model
 * name, so `Q1 c b e QMOD 2` is area 2 while `Q1 c b e 0 2` keeps model `2`.
 *
 * AREA, AREAB, AREAC and M are returned in `params`; the circuit scales the
 * device exactly as ngspice bjttemp.c/bjtload.c and vbicload.c (SCALE = area
 * * m) do. AREAB/AREAC are Gummel-Poon only (bjt.c); VBIC rejects them. OFF
 * (or OFF=0/1) is consumed as an initial-state hint: the solver already starts
 * nonlinear devices from its zero solution, so it must not disable the
 * transistor at the converged operating point. Every other instance keyword
 * is rejected rather than ignored. TEMP/DTEMP select instance temperature. IC=vbe[,vce] is
 * returned separately from scaling and used only with transient UIC.
 *
 * The substrate and thermal terminals are returned to the circuit, which
 * knows the model: bounded VBIC (LEVEL=4) stamps the substrate, the bounded
 * Gummel-Poon BJT has no substrate-junction parameters (such parameters remain
 * explicit model errors), and a thermal terminal is rejected with a typed
 * error until self-heating exists.
 */
export function parseBJTInstance(
  tokens: string[],
  lineNumber: number,
): ParsedBJTInstance {
  const line = tokens.join(' ');
  const fail = (message: string): never => {
    throw new ParseError(message, lineNumber, line);
  };
  const unsupported = (): never => fail(`Unsupported BJT Q-card form: '${line}'`);

  let firstTrailing = tokens.findIndex((token, index) => index > 0 && isKeywordOrFlag(token));
  if (firstTrailing < 0) firstTrailing = tokens.length;
  const positional = tokens.slice(1, firstTrailing);

  const params: BJTInstanceParams = {};
  const last = positional[positional.length - 1];
  const beforeLast = positional[positional.length - 2];
  if (
    positional.length >= 5
    && STRICT_NUMBER.test(last)
    && !STRICT_NUMBER.test(beforeLast)
  ) {
    params.AREA = parseNumber(last);
    positional.pop();
  }
  // c b e model | c b e s model | c b e s t model
  if (positional.length < 4 || positional.length > 6) unsupported();

  const trailing = tokens.slice(firstTrailing);
  for (let index = 0; index < trailing.length; index++) {
    const token = trailing[index];
    const eqIdx = token.indexOf('=');
    const key = (eqIdx < 0 ? token : token.slice(0, eqIdx)).toUpperCase();
    const value = eqIdx < 0 ? undefined : token.slice(eqIdx + 1);
    if (key === 'OFF') {
      if (value !== undefined && value !== '0' && value !== '1') unsupported();
      continue;
    }
    if (value === undefined) {
      fail(`Unsupported BJT instance token after the model: '${token}' in '${line}'`);
    }
    if (key === 'IC') {
      if (params.ICVBE !== undefined) fail(`Duplicate BJT instance parameter: 'IC' in '${line}'`);
      const values = value!.split(',');
      // The netlist tokenizer splits commas; direct parser callers may not.
      if (values.length === 1 && STRICT_NUMBER.test(trailing[index + 1] ?? '')) {
        values.push(trailing[++index]);
      }
      if (values.length > 2 || values.some(v => !STRICT_NUMBER.test(v) || !Number.isFinite(parseNumber(v)))) {
        fail(`Invalid BJT instance IC: '${line}'`);
      }
      params.ICVBE = parseNumber(values[0]);
      if (values.length === 2) params.ICVCE = parseNumber(values[1]);
      continue;
    }
    if (!INSTANCE_KEYWORDS.includes(key as keyof BJTInstanceParams)) {
      fail(`Unsupported BJT instance parameter: '${token}' in '${line}'`);
    }
    const name = key as keyof BJTInstanceParams;
    if (params[name] !== undefined) {
      fail(`Duplicate BJT instance parameter: '${key}' in '${line}'`);
    }
    if (!STRICT_NUMBER.test(value!)) {
      fail(`Invalid BJT instance parameter value: '${token}' in '${line}'`);
    }
    params[name] = parseNumber(value!);
  }
  for (const name of INSTANCE_KEYWORDS) {
    const value = params[name];
    if (name === 'TEMP' || name === 'DTEMP') {
      if (value !== undefined && !Number.isFinite(value)) fail(`BJT ${name} must be finite: '${line}'`);
      if (name === 'TEMP' && value !== undefined && value <= -273.15) {
        fail(`BJT TEMP must be above absolute zero: '${line}'`);
      }
      continue;
    }
    if (value !== undefined && !(value > 0 && Number.isFinite(value))) {
      fail(`BJT ${name} must be a finite number greater than zero: '${line}'`);
    }
  }

  const [collector, base, emitter] = positional;
  const modelName = positional[positional.length - 1];
  const substrate = positional.length >= 5 ? positional[3] : undefined;
  const thermal = positional.length === 6 ? positional[4] : undefined;

  return {
    collector,
    base,
    emitter,
    modelName,
    ...(substrate !== undefined ? { substrate } : {}),
    ...(thermal !== undefined ? { thermal } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}
