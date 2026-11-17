import { ParseError } from '../errors.js';
import { parseInstanceParams } from './waveform-parser.js';

export interface ParsedZInstance {
  nodes: [string, string, string];
  modelName: string;
  params: Record<string, number>;
}

/**
 * Z-card instance parameters of the supported families: L/W (HFET1, MESA),
 * TEMP/DTEMP (HFET1), TS/TD/DTEMP (MESA) and AREA (MES). Each model
 * family rejects the ones it does not define when the circuit is compiled.
 */
const Z_INSTANCE_PARAMETERS = new Set(['L', 'W', 'AREA', 'TS', 'TD', 'TEMP', 'DTEMP']);

/** Parse `Zname drain gate source model [name=value ...]`. */
export function parseZInstance(
  tokens: string[],
  lineNumber: number,
  context: string,
): ParsedZInstance {
  if (tokens.length < 5) {
    throw new ParseError('Z-card requires drain, gate, source, and model', lineNumber, context);
  }
  const params = parseInstanceParams(tokens, 5);
  for (const name of Object.keys(params)) {
    if (!Z_INSTANCE_PARAMETERS.has(name)) {
      throw new ParseError(`Unsupported Z-card instance parameter: '${name}'`, lineNumber, context);
    }
  }
  return {
    nodes: [tokens[1], tokens[2], tokens[3]],
    modelName: tokens[4],
    params,
  };
}
