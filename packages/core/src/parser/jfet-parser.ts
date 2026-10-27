import { ParseError } from '../errors.js';
import { parseNumber } from './tokenizer.js';

/** Per-instance JFET parameters spice-ts accepts. */
export interface JFETInstanceParams {
  AREA?: number;
  M?: number;
  OFF?: boolean;
  ICVDS?: number;
  ICVGS?: number;
  /** Instance temperature in degrees Celsius (ngspice jfet/jfet2 `temp`). */
  TEMP?: number;
  /** Offset from circuit temperature, ignored when TEMP is given. */
  DTEMP?: number;
}

export interface ParsedJFETInstance {
  drain: string;
  gate: string;
  source: string;
  modelName: string;
  /** Instance parameters; absent when the card has none. */
  params?: JFETInstanceParams;
}

/** Device descriptors store numeric parameters (including boolean flags). */
export function jfetInstanceDescriptorParams(params: JFETInstanceParams): Record<string, number> {
  const { OFF, ...numeric } = params;
  return { ...numeric, ...(OFF === undefined ? {} : { OFF: Number(OFF) }) };
}

/**
 * Parse `Jname d g s model [area] [AREA=val] [M=val] [OFF] [IC=vds,vgs] [TEMP=val] [DTEMP=val]`.
 *
 * `TEMP` overrides circuit temperature for ngspice-47 JFET/JFET2 laws.
 * Otherwise `DTEMP` adds to circuit temperature. Unknown keywords are rejected.
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
  for (let index = 5; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.toUpperCase() === 'OFF') {
      if (params.OFF !== undefined) unsupported();
      params.OFF = true;
      continue;
    }
    if (/^IC=/i.test(token)) {
      if (params.ICVDS !== undefined || index + 1 >= tokens.length) unsupported();
      // The shared tokenizer separates commas, so consume the second value
      // here; any third value is rejected as an unknown token below.
      const vds = parseNumber(token.slice(3));
      const vgs = parseNumber(tokens[++index]);
      if (!Number.isFinite(vds) || !Number.isFinite(vgs)) unsupported();
      params.ICVDS = vds;
      params.ICVGS = vgs;
      continue;
    }
    const match = /^(TEMP|DTEMP|AREA|M)=(.+)$/i.exec(token);
    const positional = index === 5 && !token.includes('=');
    if (!match && !positional) unsupported();
    const key = (match ? match[1].toUpperCase() : 'AREA') as 'TEMP' | 'DTEMP' | 'AREA' | 'M';
    if (params[key] !== undefined) unsupported();
    const value = parseNumber(match ? match[2] : token);
    if (!Number.isFinite(value) || ((key === 'AREA' || key === 'M') && value <= 0)) unsupported();
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
