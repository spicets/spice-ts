import { parseNumber } from './tokenizer.js';

export interface DiodeInstanceParams {
  AREA?: number;
  PJ?: number;
  M?: number;
  THERMAL?: number;
}

/** Optional third node precedes the model; geometry/flags follow it. */
export function diodeModelIndex(tokens: string[]): number {
  const next = tokens[4];
  // Match the entire positional SPICE number, not just its initial digit.
  // A model such as 1N4148 is a name, not an AREA starting with "1".
  const isArea = next !== undefined
    && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:meg|mil|[tgkmunpfa])?[a-z]*$/i.test(next);
  return next !== undefined && !next.includes('=')
    && !['THERMAL', 'OFF'].includes(next.toUpperCase())
    && !isArea ? 4 : 3;
}

const GEOMETRY_PARAMETERS = new Set(['AREA', 'PJ', 'M']);

/** Parse the supported ngspice diode geometry fields without ignoring tokens. */
export function parseDiodeInstanceParams(
  tokens: string[],
  startIdx: number,
): DiodeInstanceParams {
  const params: DiodeInstanceParams = {};

  for (let i = startIdx; i < tokens.length; i++) {
    const token = tokens[i];
    const eqIdx = token.indexOf('=');

    if (eqIdx < 0) {
      if (token.toUpperCase() === 'THERMAL') {
        params.THERMAL = 1;
        continue;
      }
      if (i === startIdx && token.toUpperCase() !== 'OFF' && !/^[+-]?(?:\d|\.\d)/.test(token)) {
        // ngspice-47 `Dname n+ n- tj model ...`: a bare name after the third
        // token means that token was a thermal node and this is the model.
        throw new Error(
          `Unsupported diode thermal node '${tokens[startIdx - 1]}' (model '${token}'): `
          + 'diode self-heating is not implemented',
        );
      }
      if (
        i !== startIdx
        || params.AREA !== undefined
        || !/^[+-]?(?:\d+\.?\d*|\.\d+)/.test(token)
      ) {
        throw new Error(`Unsupported diode parameter: '${token}'`);
      }
      params.AREA = parseNumber(token);
      continue;
    }

    const key = token.slice(0, eqIdx).toUpperCase();
    if (!GEOMETRY_PARAMETERS.has(key)) {
      throw new Error(`Unsupported diode parameter: '${token}'`);
    }
    params[key as keyof DiodeInstanceParams] = parseNumber(token.slice(eqIdx + 1));
  }

  if (params.AREA !== undefined && params.AREA <= 0) {
    throw new Error('Diode AREA must be greater than zero');
  }
  if (params.PJ !== undefined && params.PJ < 0) {
    throw new Error('Diode PJ must be non-negative');
  }
  if (params.M !== undefined && params.M <= 0) {
    throw new Error('Diode M must be greater than zero');
  }

  return params;
}
