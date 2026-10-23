import { ParseError } from '../errors.js';
import { parseNumber } from './tokenizer.js';

/** Per-instance JFET parameters spice-ts accepts. */
export interface JFETInstanceParams {
  AREA?: number;
  M?: number;
  /** Instance temperature in degrees Celsius (ngspice jfet/jfet2 `temp`). */
  TEMP?: number;
}

export interface ParsedJFETInstance {
  drain: string;
  gate: string;
  source: string;
  modelName: string;
  /** Instance parameters; absent when the card has none. */
  params?: JFETInstanceParams;
}

/**
 * Parse the J card `Jname d g s model [area] [AREA=val] [M=val] [TEMP=val]`.
 *
 * `TEMP` is the ngspice-47 jfet/jfet2 instance temperature. spice-ts has no
 * JFET temperature law, so the circuit accepts only the nominal 27 C (where
 * ngspice applies no temperature scaling) and rejects any other value with a
 * typed error. Other instance keywords (OFF, IC, DTEMP, ...) are
 * still rejected rather than ignored.
 */
export function parseJFETInstance(tokens: string[], lineNumber: number): ParsedJFETInstance {
  const line = tokens.join(' ');
  const unsupported = (): never => {
    throw new ParseError(
      `Unsupported JFET instance parameter: '${tokens.slice(5).join(' ')}'`, lineNumber, line,
    );
  };
  if (tokens.length < 5) {
    throw new ParseError(`JFET card needs drain, gate, source and model: '${line}'`, lineNumber, line);
  }
  const params: JFETInstanceParams = {};
  for (const [index, token] of tokens.slice(5).entries()) {
    const match = /^(TEMP|AREA|M)=(.+)$/i.exec(token);
    const positional = index === 0 && !token.includes('=');
    if (!match && !positional) unsupported();
    const key = (match ? match[1].toUpperCase() : 'AREA') as keyof JFETInstanceParams;
    if (params[key] !== undefined) unsupported();
    const value = parseNumber(match ? match[2] : token);
    if (!Number.isFinite(value) || (key !== 'TEMP' && value <= 0)) unsupported();
    params[key] = value;
  }
  return {
    drain: tokens[1],
    gate: tokens[2],
    source: tokens[3],
    modelName: tokens[4],
    ...(Object.keys(params).length === 0 ? {} : { params }),
  };
}
