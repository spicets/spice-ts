import { InvalidCircuitError } from '../errors.js';
import type { SensitivityAnalysis } from '../types.js';

export const BOUNDED_SENSITIVITY_FORMS =
  "'.sens v(node[,reference])' or '.sens i(vsource)', optionally followed by 'ac {dec|oct|lin} points start stop'";

/** Validate the native sensitivity slice for parsed and programmatic circuits. */
export function assertSupportedSensitivity(analysis: SensitivityAnalysis): void {
  if (
    !analysis.outputNode
    || (analysis.outputType !== undefined && analysis.outputType !== 'voltage' && analysis.outputType !== 'current')
    || (analysis.outputType === 'current' && analysis.outputReferenceNode !== undefined)
    || (analysis.outputReferenceNode !== undefined && !analysis.outputReferenceNode)
    || analysis.mode !== 'dc' && analysis.mode !== 'ac'
  ) {
    throw unsupported();
  }
  if (analysis.mode === 'dc') {
    if (
      'variation' in analysis || 'points' in analysis
      || 'startFreq' in analysis || 'stopFreq' in analysis
    ) {
      throw unsupported();
    }
    return;
  }
  if (
    (analysis.variation !== 'dec' && analysis.variation !== 'oct' && analysis.variation !== 'lin')
    || !Number.isInteger(analysis.points)
    || analysis.points < 1
    || !Number.isFinite(analysis.startFreq)
    || !Number.isFinite(analysis.stopFreq)
    || analysis.startFreq <= 0
    || analysis.stopFreq < analysis.startFreq
  ) {
    throw unsupported();
  }
}

function unsupported(): InvalidCircuitError {
  return new InvalidCircuitError(
    `Unsupported .sens form; expected ${BOUNDED_SENSITIVITY_FORMS}`,
  );
}
