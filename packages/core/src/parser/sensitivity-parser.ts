import { ParseError } from '../errors.js';
import type { SensitivityAnalysis } from '../types.js';
import {
  assertSupportedSensitivity,
  BOUNDED_SENSITIVITY_FORMS,
} from '../validation/sensitivity.js';
import { parseNumber } from './tokenizer.js';

/** Parse voltage/current output DC or DEC/OCT/LIN AC `.sens` forms. */
export function parseSensitivity(tokens: string[], lineNumber: number): SensitivityAnalysis {
  // The shared tokenizer treats commas as whitespace, as in other node lists.
  const close = tokens.indexOf(')', 3);
  const isVoltageOutput = tokens[1]?.toUpperCase() === 'V'
    && tokens[2] === '('
    && (close === 4 || close === 5);
  const isCurrentOutput = tokens[1]?.toUpperCase() === 'I'
    && tokens[2] === '(' && close === 4;
  if (!isVoltageOutput && !isCurrentOutput) throw unsupported(tokens, lineNumber);
  const output = {
    outputNode: tokens[3],
    ...(isCurrentOutput ? { outputType: 'current' as const } : {}),
    ...(close === 5 ? { outputReferenceNode: tokens[4] } : {}),
  };
  const rest = tokens.slice(close + 1);

  let analysis: SensitivityAnalysis;
  // `.sens v(node) dc` (the control-language form) is the same DC analysis.
  if (rest.length === 0 || (rest.length === 1 && rest[0]?.toUpperCase() === 'DC')) {
    analysis = { type: 'sens', ...output, mode: 'dc' };
  } else if (
    rest.length === 5
    && rest[0]?.toUpperCase() === 'AC'
    && ['DEC', 'OCT', 'LIN'].includes(rest[1]?.toUpperCase())
  ) {
    analysis = {
      type: 'sens',
      ...output,
      mode: 'ac',
      variation: rest[1].toLowerCase() as 'dec' | 'oct' | 'lin',
      points: Number.parseInt(rest[2], 10),
      startFreq: parseNumber(rest[3]),
      stopFreq: parseNumber(rest[4]),
    };
  } else {
    throw unsupported(tokens, lineNumber);
  }

  try {
    assertSupportedSensitivity(analysis);
  } catch {
    throw unsupported(tokens, lineNumber);
  }
  return analysis;
}

function unsupported(tokens: string[], lineNumber: number): ParseError {
  return new ParseError(
    `Unsupported .sens form; expected ${BOUNDED_SENSITIVITY_FORMS}`,
    lineNumber,
    tokens.join(' '),
  );
}
