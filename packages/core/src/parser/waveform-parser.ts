import { parseNumber } from './tokenizer.js';
import { ParseError } from '../errors.js';
import type {
  ACExcitation, DistortionExcitation, SourceWaveform, PulseSource, SinSource, PWLSource, RFPort,
  ExpSource, SffmSource, AmSource, TransientNoiseSource, TransientRandomSource,
} from '../types.js';

const UNSUPPORTED_WAVEFORMS = new Set(['EXTERNAL']);
const TRANSIENT_WAVEFORMS = new Set([
  'PULSE', 'SIN', 'SINE', 'PWL', 'EXP', 'SFFM', 'AM', 'TRNOISE', 'TRRANDOM', ...UNSUPPORTED_WAVEFORMS,
]);

/** Why each unsupported source waveform keyword is rejected. */
const UNSUPPORTED_WAVEFORM_REASONS: Record<string, string> = {
  EXTERNAL: 'ngspice-47 accepts EXTERNAL only in its shared-library build, where the host supplies'
    + ' the value through a callback; the ngspice executable rejects it as an unknown parameter',
};

/**
 * Thrown while parsing a V/I card whose waveform keyword spice-ts does not
 * implement. {@link UnsupportedSourceWaveformError} adds the card's line.
 */
export class UnsupportedWaveformKeyword extends Error {
  constructor(readonly keyword: string) {
    const reason = UNSUPPORTED_WAVEFORM_REASONS[keyword];
    super(`Unsupported source waveform '${keyword}'${reason ? `: ${reason}` : ''}`);
    this.name = 'UnsupportedWaveformKeyword';
  }
}

/** A V/I card uses a source waveform keyword (`EXTERNAL`) spice-ts does not implement. */
export class UnsupportedSourceWaveformError extends ParseError {
  /** Stable machine-readable error code. */
  readonly code = 'UNSUPPORTED_SOURCE_WAVEFORM';

  constructor(
    /** Upper-cased waveform keyword, e.g. `EXTERNAL`. */
    readonly keyword: string,
    message: string,
    line: number,
    context: string,
  ) {
    super(message, line, context);
    this.name = 'UnsupportedSourceWaveformError';
  }
}

/** {@link parseSourceWaveform} for a netlist card: unsupported keywords become {@link UnsupportedSourceWaveformError}. */
export function parseSourceCardWaveform(
  tokens: string[], startIdx: number, line: number, context: string,
): SourceWaveform {
  try {
    return parseSourceWaveform(tokens, startIdx);
  } catch (error) {
    if (error instanceof UnsupportedWaveformKeyword) {
      throw new UnsupportedSourceWaveformError(error.keyword, error.message, line, context);
    }
    throw error;
  }
}
const RF_PORT_KEYWORDS = new Set(['PORTNUM', 'Z0', 'PWR', 'FREQ', 'PHASE']);

/**
 * Split ngspice-47 RF port parameters (`portnum`, `z0`, `pwr`, `freq`, `phase`,
 * as `key value` or `key=value`) off a voltage-source card.
 *
 * ngspice vsrctemp.c makes the source a port only when `portnum > 0` and
 * `z0 > 0` (z0 defaults to 50); otherwise it stays a plain source. `pwr`/`freq`
 * switch the transient function to the port's cosine (defaults 1 mW, 1 GHz);
 * `phase` is stored by ngspice but never used, so it has no effect here either.
 *
 * Port parameters without `portnum`, and `pwr`/`freq` next to a transient
 * waveform (whose precedence ngspice decides by card order), are rejected.
 */
export function extractRFPort(tokens: string[], startIdx: number): { tokens: string[]; port?: RFPort } {
  const rest: string[] = tokens.slice(0, startIdx);
  const values = new Map<string, number>();
  for (let index = startIdx; index < tokens.length; index++) {
    const token = tokens[index];
    const assignment = token.match(/^([A-Za-z0-9]+)=(.*)$/);
    const key = (assignment ? assignment[1] : token).toUpperCase();
    if (!RF_PORT_KEYWORDS.has(key)) {
      rest.push(token);
      continue;
    }
    const raw = assignment ? assignment[2] : tokens[++index];
    if (raw === undefined || raw === '') throw new Error(`RF port parameter '${key.toLowerCase()}' requires a value`);
    if (values.has(key)) throw new Error(`Duplicate RF port parameter '${key.toLowerCase()}'`);
    values.set(key, parseNumber(raw));
  }
  if (values.size === 0) return { tokens: rest };

  const portNumber = values.get('PORTNUM');
  if (portNumber === undefined) {
    throw new Error(`RF port parameters (${[...values.keys()].map(key => key.toLowerCase()).join(', ')}) require portnum`);
  }
  if (!Number.isInteger(portNumber)) throw new Error(`RF port number must be an integer, got ${portNumber}`);
  const z0 = values.get('Z0') ?? 50;
  const hasPower = values.has('PWR') || values.has('FREQ');
  if (hasPower && rest.slice(startIdx).some(token => TRANSIENT_WAVEFORMS.has(token.toUpperCase()))) {
    throw new Error('RF port pwr/freq cannot be combined with a transient source waveform');
  }
  if (!(portNumber > 0 && z0 > 0)) {
    if (hasPower) throw new Error('RF port pwr/freq require portnum > 0 and z0 > 0');
    return { tokens: rest };
  }
  const port: RFPort = { number: portNumber, z0 };
  if (hasPower) {
    const dc = explicitDcValue(rest, startIdx);
    port.power = {
      watts: values.get('PWR') ?? 0.001,
      frequency: values.get('FREQ') ?? 1e9,
      ...(dc === undefined ? {} : { dc }),
    };
  }
  return { tokens: rest, port };
}

/**
 * Split the `m` instance multiplier (`m=2`, `m 2`; the last one wins) off an
 * independent source card, as ngspice-47 inpdomod/INPdevParse reads ISRC_M.
 * isrcload.c and isrcacld.c scale the source by it; vsrc has no `m`.
 */
export function extractSourceMultiplier(
  tokens: string[], startIdx: number,
): { tokens: string[]; multiplier?: number } {
  const rest: string[] = tokens.slice(0, startIdx);
  let multiplier: number | undefined;
  for (let index = startIdx; index < tokens.length; index++) {
    const token = tokens[index];
    const assignment = token.match(/^m=(.*)$/i);
    if (!assignment && token.toUpperCase() !== 'M') {
      rest.push(token);
      continue;
    }
    const raw = assignment ? assignment[1] : tokens[++index];
    // ngspice-47 reads a bare trailing `m` as m=0; reject it rather than zero the source.
    if (raw === undefined || raw === '') throw new Error("Source parameter 'm' requires a value");
    multiplier = parseNumber(raw);
  }
  return multiplier === undefined ? { tokens: rest } : { tokens: rest, multiplier };
}

/** ngspice-47 vsrc has no `m` instance parameter and stops with "unknown parameter (m)". */
export const VOLTAGE_SOURCE_MULTIPLIER_ERROR = "Unsupported voltage source parameter 'm': ngspice-47 voltage sources have no m multiplier";

/** Whether a source card carries an `m` instance parameter (`m=2` or `m 2`). */
export function hasSourceMultiplier(tokens: string[], startIdx: number): boolean {
  return tokens.slice(startIdx).some(token => /^m(=.*)?$/i.test(token));
}

/** The DC value a source card states explicitly (`DC v`, `DC=v` or a leading value), if any. */
function explicitDcValue(tokens: string[], startIdx: number): number | undefined {
  const normalized = normalizeSourceAssignments(tokens, startIdx);
  const dcIdx = normalized.findIndex((token, index) => index >= startIdx && token.toUpperCase() === 'DC');
  if (dcIdx >= 0) return parseNumber(normalized[dcIdx + 1]);
  const first = normalized[startIdx];
  if (first === undefined || SOURCE_KEYWORDS.has(first.toUpperCase())) return undefined;
  return parseNumber(first);
}

export function parseSourceWaveform(tokens: string[], startIdx: number): SourceWaveform {
  const normalizedTokens = normalizeSourceAssignments(tokens, startIdx);
  const { baseTokens, distortionF1, distortionF2 } = extractDistortionTerms(
    normalizedTokens,
    startIdx,
  );
  return {
    ...parseBaseSourceWaveform(baseTokens, startIdx),
    ...(distortionF1 ? { distortionF1 } : {}),
    ...(distortionF2 ? { distortionF2 } : {}),
  } as SourceWaveform;
}

function parseBaseSourceWaveform(cardTokens: string[], startIdx: number): SourceWaveform {
  if (startIdx >= cardTokens.length) return { type: 'dc', value: 0 };
  // PWL `TD=`/`R=` are instance parameters anywhere after the PWL keyword.
  const pwlIdx = cardTokens.findIndex((token, index) => index >= startIdx && token.toUpperCase() === 'PWL');
  const { tokens, delay, repeat } = pwlIdx >= 0
    ? extractPwlOptions(cardTokens, pwlIdx)
    : { tokens: cardTokens, delay: undefined, repeat: undefined };

  // Scan for AC keyword anywhere in the remaining tokens (e.g. "DC 1.5 AC 1").
  // In SPICE syntax the DC operating-point value and AC small-signal
  // excitation coexist; the DC bias must still be used for .op/.tran and as
  // the linearization point for .ac.
  const upper = tokens.slice(startIdx).map(t => t.toUpperCase());
  const dcIdx = upper.indexOf('DC');
  const acIdx = upper.indexOf('AC');
  const waveformOffset = upper.findIndex(token => TRANSIENT_WAVEFORMS.has(token));
  const ac = acIdx >= 0 ? parseACExcitation(tokens, startIdx + acIdx) : undefined;
  const dc = parseOperatingPoint(tokens, startIdx, dcIdx, acIdx, waveformOffset);

  if (ac && waveformOffset < 0) {
    return { type: 'ac', dc: dc ?? 0, ...ac };
  }

  // A transient waveform may follow operating-point and AC terms. Prefer that
  // waveform for transient evaluation while retaining every coexisting term.
  const waveformIdx = waveformOffset >= 0 ? startIdx + waveformOffset : startIdx;
  const keyword = tokens[waveformIdx].toUpperCase();

  if (keyword === 'DC') {
    return { type: 'dc', value: parseNumber(tokens[startIdx + 1]) };
  }

  if (keyword === 'AC') {
    const magnitude = parseNumber(tokens[startIdx + 1]);
    const phase = tokens[startIdx + 2] ? parseNumber(tokens[startIdx + 2]) : 0;
    return { type: 'ac', magnitude, phase };
  }

  if (keyword === 'PULSE') {
    // ngspice-47 reads up to eight PULSE fields; the eighth is NP, the number
    // of pulses (vsrcload.c, outside the `ngbehavior=xs` phase mode).
    const args = parseWaveformArguments(
      tokens, waveformIdx, acIdx >= 0 ? startIdx + acIdx : -1, 8, 'PULSE',
    );
    return {
      ...(dc !== undefined ? { dc } : {}),
      ...(ac ? { ac } : {}),
      type: 'pulse', v1: args[0] ?? 0, v2: args[1] ?? 0,
      // ngspice vsrcload.c: an omitted TR/TF defaults like an explicit 0, to
      // TSTEP in transient analysis (see effectivePulse).
      delay: args[2] ?? 0, rise: args[3] ?? 0, fall: args[4] ?? 0,
      // ngspice-47 vsrcload.c/isrcload.c: exactly five arguments (through TF)
      // mean a triangular pulse (PW=0); fewer arguments retain the long pulse.
      width: args[5] ?? (args.length === 5 ? 0 : Infinity), period: args[6] ?? Infinity,
      ...(args[7] !== undefined ? { pulses: args[7] } : {}),
    } satisfies PulseSource;
  }

  if (keyword === 'SIN' || keyword === 'SINE') {
    const args = parseWaveformArguments(
      tokens, waveformIdx, acIdx >= 0 ? startIdx + acIdx : -1, 6, keyword,
    );
    return {
      ...(dc !== undefined ? { dc } : {}),
      ...(ac ? { ac } : {}),
      type: 'sin', offset: args[0] ?? 0, amplitude: args[1] ?? 0,
      frequency: args[2] ?? 0, delay: args[3], damping: args[4], phase: args[5],
    } satisfies SinSource;
  }

  if (keyword === 'PWL') {
    const args = parseWaveformArguments(
      tokens, waveformIdx, acIdx >= 0 ? startIdx + acIdx : -1, Infinity, 'PWL',
    );
    if (args.length < 2 || args.length % 2 !== 0) {
      throw new Error('PWL source requires one or more complete time/value pairs');
    }
    const points: PWLSource['points'] = [];
    for (let i = 0; i < args.length; i += 2) {
      const point = { time: args[i], value: args[i + 1] };
      if (points.length > 0 && point.time < points[points.length - 1].time) {
        throw new Error('PWL source times must be non-decreasing');
      }
      points.push(point);
    }
    if (repeat !== undefined) validatePwlRepeat(points, repeat);
    return {
      ...(dc !== undefined ? { dc } : {}),
      ...(ac ? { ac } : {}),
      type: 'pwl',
      points,
      ...(delay !== undefined ? { delay } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
    } satisfies PWLSource;
  }

  if (keyword === 'EXP' || keyword === 'SFFM' || keyword === 'AM') {
    const args = parseWaveformArguments(
      tokens, waveformIdx, acIdx >= 0 ? startIdx + acIdx : -1, keyword === 'EXP' ? 6 : 8, keyword,
    );
    // ngspice-47 vsrcpar.c/isrcpar.c: fewer than two values is E_BADPARM.
    if (args.length < 2) throw new Error(`${keyword} source requires at least two values, got ${args.length}`);
    return {
      ...(dc !== undefined ? { dc } : {}),
      ...(ac ? { ac } : {}),
      ...(keyword === 'EXP' ? expWaveform(args) : keyword === 'SFFM' ? sffmWaveform(args) : amWaveform(args)),
    };
  }

  if (keyword === 'TRNOISE' || keyword === 'TRRANDOM') {
    const args = parseWaveformArguments(
      tokens, waveformIdx, acIdx >= 0 ? startIdx + acIdx : -1, keyword === 'TRNOISE' ? 7 : 5, keyword,
    );
    return {
      ...(dc !== undefined ? { dc } : {}),
      ...(ac ? { ac } : {}),
      ...(keyword === 'TRNOISE' ? transientNoiseWaveform(args) : transientRandomWaveform(args)),
    };
  }

  if (UNSUPPORTED_WAVEFORMS.has(keyword)) {
    throw new UnsupportedWaveformKeyword(keyword);
  }

  return { type: 'dc', value: parseNumber(tokens[startIdx]) };
}

/** Assign the given coefficients to their fields, leaving omitted ones undefined. */
function given<T extends object>(base: T, fields: readonly string[], args: readonly number[]): T {
  const result = { ...base } as Record<string, unknown>;
  fields.forEach((field, index) => {
    if (field !== '' && args[index] !== undefined) result[field] = args[index];
  });
  return result as T;
}

/** EXP coefficients `V1 V2 [TD1 [TAU1 [TD2 [TAU2]]]]` (ngspice-47 vsrcload.c order). */
function expWaveform(args: readonly number[]): ExpSource {
  return given<ExpSource>({ type: 'exp', v1: args[0], v2: args[1] }, ['', '', 'td1', 'tau1', 'td2', 'tau2'], args);
}

/** SFFM coefficients `VO VA [FC [MDI [FM [TD [PHASEM [PHASEC]]]]]]` (ngspice-47 vsrcload.c order). */
function sffmWaveform(args: readonly number[]): SffmSource {
  return given<SffmSource>(
    { type: 'sffm', offset: args[0], amplitude: args[1] },
    ['', '', 'carrierFrequency', 'modulationIndex', 'signalFrequency', 'delay', 'signalPhase', 'carrierPhase'],
    args,
  );
}

/** AM coefficients `VO VMO [VMA [FM [FC [TD [PHASEM [PHASEC]]]]]]` (ngspice-47 vsrcload.c order). */
function amWaveform(args: readonly number[]): AmSource {
  return given<AmSource>(
    { type: 'am', offset: args[0], carrierAmplitude: args[1] },
    ['', '', 'modulationAmplitude', 'modulationFrequency', 'carrierFrequency', 'delay', 'modulationPhase', 'carrierPhase'],
    args,
  );
}

/**
 * Split the PWL instance parameters `TD=` (delay) and `R=` (repeat start)
 * off the tokens after the PWL keyword (ngspice-47 VSRC_TD/VSRC_R; the last
 * one given wins). `R` below -0.5 means no repetition, as in vsrcpar.c.
 */
function extractPwlOptions(
  tokens: string[], waveformIdx: number,
): { tokens: string[]; delay?: number; repeat?: number } {
  const rest = tokens.slice(0, waveformIdx + 1);
  let delay: number | undefined;
  let repeat: number | undefined;
  let repeatGiven = false;
  for (let index = waveformIdx + 1; index < tokens.length; index++) {
    const assignment = tokens[index].match(/^(TD|R)=(.*)$/i);
    if (!assignment) {
      rest.push(tokens[index]);
      continue;
    }
    if (assignment[2] === '') throw new Error(`PWL parameter '${assignment[1].toLowerCase()}' requires a value`);
    const value = parseNumber(assignment[2]);
    if (assignment[1].toUpperCase() === 'TD') {
      delay = value;
    } else {
      repeatGiven = true;
      repeat = value < -0.5 ? undefined : value;
    }
  }
  return {
    tokens: rest,
    ...(delay !== undefined ? { delay } : {}),
    ...(repeatGiven && repeat !== undefined ? { repeat } : {}),
  };
}

/** ngspice-47 vsrcpar.c: `R=` must match a PWL time point before the last one (E_PARMVAL otherwise). */
function validatePwlRepeat(points: PWLSource['points'], repeat: number): void {
  const end = points[points.length - 1].time;
  if (repeat >= end) {
    throw new Error(`PWL repeat start time ${repeat} must be smaller than the final time point ${end}`);
  }
  if (!points.some(point => point.time === repeat)) {
    throw new Error(`PWL repeat start time ${repeat} does not match any time point`);
  }
}

/**
 * TRNOISE coefficients `NA TS [NALPHA [NAMP [RTSAM [RTSCAPT [RTSEMT]]]]]`
 * as ngspice-47 vsrcpar.c/isrcpar.c read them: NAMP only counts with a
 * nonzero NALPHA, RTSCAPT/RTSEMT only with a nonzero RTSAM.
 */
export function transientNoiseWaveform(args: readonly number[]): TransientNoiseSource {
  if (args.length < 2 || args.length > 7) {
    throw new Error(`TRNOISE source needs 2 to 7 values (NA TS [NALPHA NAMP RTSAM RTSCAPT RTSEMT]), got ${args.length}`);
  }
  const [amplitude, ts, alpha = 0] = args;
  const rtsAmplitude = args[4] ?? 0;
  if (!(ts >= 0)) throw new Error(`TRNOISE TS must be non-negative, got ${ts}`);
  return {
    type: 'trnoise',
    amplitude,
    ts,
    alpha,
    oneOverFAmplitude: alpha !== 0 ? args[3] ?? 0 : 0,
    rtsAmplitude,
    rtsCaptureTime: rtsAmplitude !== 0 ? args[5] ?? 0 : 0,
    rtsEmissionTime: rtsAmplitude !== 0 ? args[6] ?? 0 : 0,
  };
}

/** TRRANDOM coefficients `TYPE TS [TD [PARAM1 [PARAM2]]]` as ngspice-47 vsrcpar.c/isrcpar.c read them. */
export function transientRandomWaveform(args: readonly number[]): TransientRandomSource {
  if (args.length < 2 || args.length > 5) {
    throw new Error(`TRRANDOM source needs 2 to 5 values (TYPE TS [TD PARAM1 PARAM2]), got ${args.length}`);
  }
  const ts = args[1];
  // ngspice divides by TS (isrcacct.c) or never advances (vsrcacct.c) when TS <= 0.
  if (!(ts > 0)) throw new Error(`TRRANDOM TS must be positive, got ${ts}`);
  return {
    type: 'trrandom',
    // ngspice: (int)coeffs[0].
    distribution: Math.trunc(args[0]),
    ts,
    td: args[2] ?? 0,
    param1: args[3] ?? 1,
    param2: args[4] ?? 0,
  };
}

function parseWaveformArguments(
  tokens: string[],
  waveformIdx: number,
  acIdx: number,
  maximum: number,
  keyword: string,
): number[] {
  // Arguments run to the next source keyword. A `KEY=value` token not
  // consumed by the waveform (PWL `TD=`/`R=` are split off first) ends the
  // list and is rejected.
  let end = waveformIdx + 1;
  while (
    end < tokens.length
    && !SOURCE_KEYWORDS.has(tokens[end].toUpperCase())
    && !tokens[end].includes('=')
  ) end++;
  const args = tokens.slice(waveformIdx + 1, end);
  if (args.length > maximum || (end !== tokens.length && end !== acIdx)) {
    const trailing = args.length > maximum ? args.slice(maximum) : tokens.slice(end);
    throw new Error(`Unsupported ${keyword} source parameters: '${trailing.join(' ')}'`);
  }
  return args.map(parseNumber);
}

function parseACExcitation(tokens: string[], acIdx: number): ACExcitation {
  let end = acIdx + 1;
  while (end < tokens.length && !SOURCE_KEYWORDS.has(tokens[end].toUpperCase())) end++;
  const values = tokens.slice(acIdx + 1, end);
  if (values.length > 2) {
    throw new Error(`Unsupported AC source parameters: '${values.slice(2).join(' ')}'`);
  }
  const magnitude = values[0] === undefined ? 1 : parseNumber(values[0]);
  const phase = values[1] === undefined ? 0 : parseNumber(values[1]);
  return { magnitude, phase };
}

function parseOperatingPoint(
  tokens: string[],
  startIdx: number,
  dcIdx: number,
  acIdx: number,
  waveformOffset: number,
): number | undefined {
  if (dcIdx >= 0) {
    if (waveformOffset === dcIdx + 1) return undefined;
    return parseNumber(tokens[startIdx + dcIdx + 1]);
  }
  if (acIdx > 0 || waveformOffset > 0) {
    try {
      return parseNumber(tokens[startIdx]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const SOURCE_KEYWORDS = new Set(['DC', 'AC', 'DISTOF1', 'DISTOF2', ...TRANSIENT_WAVEFORMS]);

/**
 * Normalize the value part of a source card the way ngspice-47 reads it:
 * `DC=`/`AC=` split into keyword and value, and every '(' or ')' dropped.
 * ngspice's INPgetUTok skips parentheses (and commas) as separators, so
 * `0.7v (PWL 0 3 1n -6) (AC 1v)` and `PWL( (0 0) (1 1) )` are flat value lists.
 */
function normalizeSourceAssignments(tokens: string[], startIdx: number): string[] {
  return tokens.flatMap((token, index) => {
    if (index < startIdx) return token;
    if (token === '(' || token === ')') return [];
    const match = token.match(/^(DC|AC)=(.*)$/i);
    return match ? [match[1], match[2]] : token;
  });
}

function extractDistortionTerms(
  tokens: string[],
  startIdx: number,
): {
  baseTokens: string[];
  distortionF1?: DistortionExcitation;
  distortionF2?: DistortionExcitation;
} {
  const baseTokens = tokens.slice();
  let distortionF1: DistortionExcitation | undefined;
  let distortionF2: DistortionExcitation | undefined;
  for (let index = tokens.length - 1; index >= startIdx; index--) {
    const keyword = tokens[index].toUpperCase();
    if (keyword !== 'DISTOF1' && keyword !== 'DISTOF2') continue;
    const target = keyword === 'DISTOF1' ? distortionF1 : distortionF2;
    if (target) throw new Error(`Duplicate ${keyword} specification`);
    let end = index + 1;
    while (end < tokens.length && !SOURCE_KEYWORDS.has(tokens[end].toUpperCase())) end++;
    const valueTokens = tokens.slice(index + 1, end);
    if (valueTokens.length === 0) throw new Error(`${keyword} requires a magnitude`);
    if (valueTokens.length > 2) {
      throw new Error(`Unsupported ${keyword} parameters: '${valueTokens.slice(2).join(' ')}'`);
    }
    const values = valueTokens.map(parseNumber);
    const excitation = { magnitude: values[0], phase: values[1] ?? 0 };
    if (keyword === 'DISTOF1') distortionF1 = excitation;
    else distortionF2 = excitation;
    baseTokens.splice(index, end - index);
  }
  return { baseTokens, distortionF1, distortionF2 };
}

/**
 * Parse key=value instance parameters such as W=10u L=1u.
 * Returns a map of uppercase keys to numeric values.
 */
export function parseInstanceParams(tokens: string[], startIdx: number): Record<string, number> {
  const params: Record<string, number> = {};
  for (let i = startIdx; i < tokens.length; i++) {
    const eqIdx = tokens[i].indexOf('=');
    if (eqIdx > 0) {
      const key = tokens[i].slice(0, eqIdx).toUpperCase();
      const val = parseNumber(tokens[i].slice(eqIdx + 1));
      params[key] = val;
    }
  }
  return params;
}
