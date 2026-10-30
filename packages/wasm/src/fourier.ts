import { evaluateFourierCards, TransientResult, type Circuit, type FourierResult } from '@spice-ts/core';
import type { FourierResultV1, TransientResultV1 } from '@spice-ts/core/protocol';

function serialize(result: FourierResult): FourierResultV1 {
  const finite = (value: number): number | null => Number.isFinite(value) ? value : null;
  return { vector: result.vector, fundamental: finite(result.fundamental), gridSize: result.gridSize, degree: result.degree, periods: result.periods, thd: finite(result.thd), harmonics: result.harmonics.map(h => ({ harmonic: h.harmonic, frequency: finite(h.frequency), magnitude: finite(h.magnitude), phase: finite(h.phase), normalizedMagnitude: finite(h.normalizedMagnitude), normalizedPhase: finite(h.normalizedPhase) })) };
}

export function addFourier(result: TransientResultV1, circuit: Circuit): void {
  const transient = new TransientResult(result.timeS, new Map(Object.entries(result.voltagesV)), new Map(Object.entries(result.currentsA)));
  evaluateFourierCards(circuit, transient, []);
  if (transient.fourier) result.fourier = transient.fourier.map(serialize);
}
