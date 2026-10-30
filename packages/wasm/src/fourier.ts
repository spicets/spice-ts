import { ngspiceFourier, type FourierResult } from '@spice-ts/core';
import type { FourierResultV1, TransientResultV1 } from '@spice-ts/core/protocol';
import { NumericBackendError } from './numeric-wasm.js';

interface FourierCard { fundamental: number; outputs: string[] }

// This first slice supports simple voltage and source-current probes only.
export function parseFourierCards(cards: string[]): FourierCard[] {
  const result: FourierCard[] = [];
  for (const card of cards) {
    if (!/^\.(?:four|fourier)(?:\s|$)/i.test(card)) continue;
    const match = /^\.\S+\s+(\S+)\s+(.+)$/i.exec(card);
    if (!match) continue;
    const number = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i.exec(match[1]!);
    if (!number) continue;
    const scale: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, mil: 25.4e-6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18 };
    const suffix = number[2]!.toLowerCase();
    const key = suffix.startsWith('meg') ? 'meg' : suffix.startsWith('mil') ? 'mil' : suffix[0] ?? '';
    const fundamental = Number(number[1]) * (scale[key] ?? 1);
    if (!Number.isFinite(fundamental) || fundamental <= 0) continue;
    const outputs = match[2]!.match(/(?:v\s*\(\s*[^\s(),]+\s*(?:,\s*[^\s(),]+\s*)?\)|i\s*\(\s*[^\s(),]+\s*\))/gi) ?? [];
    if (!outputs.length || match[2]!.replace(/(?:v\s*\(\s*[^\s(),]+\s*(?:,\s*[^\s(),]+\s*)?\)|i\s*\(\s*[^\s(),]+\s*\))/gi, '').trim()) {
      throw new NumericBackendError({ code: 'UNSUPPORTED_FEATURE', phase: 'validation', retryable: false, message: 'Only simple Fourier voltage and current probes are supported', details: { backend: 'spice-ts-wasm', feature: 'fourier-expression' } });
    }
    result.push({ fundamental, outputs });
  }
  return result;
}

function serialize(result: FourierResult): FourierResultV1 {
  const finite = (value: number): number | null => Number.isFinite(value) ? value : null;
  return { vector: result.vector, fundamental: finite(result.fundamental), gridSize: result.gridSize, degree: result.degree, periods: result.periods, thd: finite(result.thd), harmonics: result.harmonics.map(h => ({ harmonic: h.harmonic, frequency: finite(h.frequency), magnitude: finite(h.magnitude), phase: finite(h.phase), normalizedMagnitude: finite(h.normalizedMagnitude), normalizedPhase: finite(h.normalizedPhase) })) };
}

export function addFourier(result: TransientResultV1, cards: FourierCard[]): void {
  if (!cards.length) return;
  const tables: FourierResultV1[] = [];
  const find = (record: Record<string, number[]>, name: string) => Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  for (const card of cards) for (const output of card.outputs) {
    const probe = /^([vi])\s*\(\s*([^\s(),]+)\s*(?:,\s*([^\s(),]+)\s*)?\)$/i.exec(output)!;
    const node = (name: string) => /^(?:0|gnd)$/i.test(name) ? result.timeS.map(() => 0) : find(result.voltagesV, name);
    const values = probe[1]!.toLowerCase() === 'v' ? node(probe[2]!) : find(result.currentsA, probe[2]!);
    const reference = probe[3] ? node(probe[3]) : undefined;
    if (!values || (probe[3] && !reference)) continue;
    try {
      tables.push(serialize(ngspiceFourier(output, Float64Array.from(result.timeS), Float64Array.from(values.map((value, i) => value - (reference?.[i] ?? 0))), card.fundamental, 10, 200, 1, 1)));
    } catch { /* Core omits failed tables from the protocol result. */ }
  }
  result.fourier = tables;
}
