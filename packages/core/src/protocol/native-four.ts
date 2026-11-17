import type { CompiledCircuit } from '../circuit.js';
import { ngspiceFourier } from '../parser/control/fourier.js';
import type { TransientResult } from '../results.js';
import type { FourierResultV1, SimulationRequestV1 } from './types.js';
import { ProtocolExecutionError, type ProtocolExecutionGuard } from './execution-guard.js';
import { VoltageSource } from '../devices/voltage-source.js';

function invalid(path: string, message = 'Invalid native Fourier field'): never {
  throw new ProtocolExecutionError({ code: 'INVALID_REQUEST', phase: 'validation', retryable: false, message, details: { path } });
}

export function validateNativeFourier(request: SimulationRequestV1, compiled: CompiledCircuit): void {
  if (request.input.format !== 'spice-ts') return;
  const nodes = new Set(['0', 'gnd', ...compiled.nodeNames.map(n => n.toLowerCase())]);
  const sources = new Set(compiled.devices.filter(d => d instanceof VoltageSource).map(d => d.name.toLowerCase()));
  for (const [index, analysis] of request.input.document.analyses.entries()) {
    const fourier = (analysis as { fourier?: unknown }).fourier;
    if (fourier === undefined) continue;
    const path = `/input/document/analyses/${index}/fourier`;
    if (analysis.type !== 'tran' || !fourier || typeof fourier !== 'object' || Array.isArray(fourier)) invalid(path);
    const config = fourier as Record<string, unknown>;
    if (typeof config.fundamentalHz !== 'number' || !Number.isFinite(config.fundamentalHz) || config.fundamentalHz <= 0) invalid(`${path}/fundamentalHz`);
    if (config.harmonics !== undefined && (typeof config.harmonics !== 'number' || !Number.isInteger(config.harmonics) || config.harmonics < 1 || config.harmonics > 199)) invalid(`${path}/harmonics`);
    for (const key of Object.keys(config)) if (!['fundamentalHz', 'outputs', 'harmonics'].includes(key)) invalid(`${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    if (!Array.isArray(config.outputs) || !config.outputs.length || config.outputs.length > 16) invalid(`${path}/outputs`, 'Fourier requires between 1 and 16 outputs');
    for (const [i, output] of config.outputs.entries()) {
      const voltage = typeof output === 'string' && /^v\(\s*([^\s(),]+)\s*(?:,\s*([^\s(),]+)\s*)?\)$/i.exec(output);
      const current = typeof output === 'string' && /^i\(\s*([^\s(),]+)\s*\)$/i.exec(output);
      if (voltage ? ![voltage[1], voltage[2] ?? '0'].every(n => nodes.has(n.toLowerCase())) : !current || !sources.has(current[1].toLowerCase())) invalid(`${path}/outputs/${i}`);
    }
  }
}

/** Evaluate native Fourier operands against the guarded, expanded circuit snapshot. */
export function nativeFourier(request: SimulationRequestV1, index: number, compiled: CompiledCircuit, result: TransientResult, guard: ProtocolExecutionGuard): import('../results.js').FourierResult[] | undefined {
  if (request.input.format !== 'spice-ts') return undefined;
  const analysis = request.input.document.analyses[index];
  if (analysis.type !== 'tran' || !analysis.fourier) return undefined;
  const { fundamentalHz, outputs, harmonics = 9 } = analysis.fourier;
  if (result.time.length < 2 || result.time.at(-1)! - result.time[0] < 1 / fundamentalHz) invalid(`/input/document/analyses/${index}/fourier/fundamentalHz`, 'Fourier period exceeds available waveform span');
  return outputs.map(vector => {
    guard.checkpoint('solve:fourier-output');
    const voltage = /^v\(\s*([^\s(),]+)\s*(?:,\s*([^\s(),]+)\s*)?\)$/i.exec(vector);
    const node = (name: string): number[] => ['0', 'gnd'].includes(name.toLowerCase()) ? result.time.map(() => 0) : result.voltage(compiled.nodeNames.find(n => n.toLowerCase() === name.toLowerCase())!);
    const reference = voltage?.[2] ? node(voltage[2]) : undefined;
    const values = voltage
      ? node(voltage[1]).map((v, i) => v - (reference?.[i] ?? 0))
      : result.current(compiled.branchNames.find(n => n.toLowerCase() === /^i\(\s*([^\s(),]+)\s*\)$/i.exec(vector)![1].toLowerCase())!);
    try {
      return ngspiceFourier(vector, Float64Array.from(result.time), Float64Array.from(values), fundamentalHz, harmonics + 1, 200, 1, 1);
    } catch (error) {
      invalid(`/input/document/analyses/${index}/fourier/fundamentalHz`, error instanceof Error ? error.message : 'Fourier postprocessing failed');
    }
  });
}

export function serializeFourier(result: import('../results.js').FourierResult): FourierResultV1 {
  const finite = (value: number): number | null => Number.isFinite(value) ? value : null;
  return {
    vector: result.vector, fundamental: finite(result.fundamental), gridSize: result.gridSize,
    degree: result.degree, periods: result.periods, thd: finite(result.thd),
    harmonics: result.harmonics.map(h => ({ harmonic: h.harmonic, frequency: finite(h.frequency), magnitude: finite(h.magnitude), phase: finite(h.phase), normalizedMagnitude: finite(h.normalizedMagnitude), normalizedPhase: finite(h.normalizedPhase) })),
  };
}
