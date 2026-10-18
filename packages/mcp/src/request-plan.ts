import {
  estimateProtocolResultPointsV1,
  ParseError,
  parseTitlelessAsync,
} from '@spice-ts/core';
import type { AnalysisDirective, SimulationOptions } from '@spice-ts/core';
import type { ResolvedOptionsV1, SimulationRequestV1 } from '@spice-ts/core/protocol';

/** The analyses and netlist `.options` core will see for a request, parsed by core itself. */
export interface RequestPlan {
  analyses: readonly AnalysisDirective[];
  netlistOptions: Readonly<SimulationOptions>;
}

/**
 * Parse a request's directives with the core parser so MCP preflight and run
 * metadata agree with the run core performs (SI suffixes, `.options`, every
 * analysis directive). `.step` multipliers are not applied here; core still
 * enforces them during validation.
 */
export async function requestPlan(request: SimulationRequestV1): Promise<RequestPlan> {
  if (request.input.format !== 'spice') {
    const analyses = request.input.format === 'spice-ts' ? request.input.document.analyses : [];
    return { analyses: analyses as readonly AnalysisDirective[], netlistOptions: {} };
  }
  const files = request.input.virtualFiles ?? {};
  const circuit = await parseTitlelessAsync(request.input.source, async path => {
    const source = files[path];
    if (source === undefined) throw new ParseError(`Virtual include '${path}' was not provided`, 0, path);
    return source;
  });
  return { analyses: [...circuit.analyses], netlistOptions: circuit.simulationOptions };
}

export function estimatedResultPoints(request: SimulationRequestV1, plan: RequestPlan): number {
  return estimateProtocolResultPointsV1(plan.analyses, undefined, resolvedOptions(request, plan).reltol);
}

/**
 * Options in effect for the run: request options override netlist `.options`
 * (an unset request field keeps the netlist value), then core defaults.
 * `maxTimestep` is the largest step any transient analysis in the run may
 * take, or `Number.MAX_VALUE` (core's unbounded default) without one.
 */
export function resolvedOptions(request: SimulationRequestV1, plan: RequestPlan): ResolvedOptionsV1 {
  const requested = request.options;
  const netlist = plan.netlistOptions;
  return {
    backend: 'spice-ts-js',
    abstol: requested?.abstol ?? netlist.abstol ?? 1e-12,
    vntol: requested?.vntol ?? netlist.vntol ?? 1e-6,
    reltol: requested?.reltol ?? netlist.reltol ?? 1e-3,
    maxIterations: requested?.maxIterations ?? netlist.maxIterations ?? 100,
    maxTransientIterations: requested?.maxTransientIterations ?? netlist.maxTransientIterations ?? 100,
    maxTimestep: transientMaxTimestep(plan.analyses, requested?.maxTimestep || undefined),
    integrationMethod: requested?.integrationMethod ?? netlist.integrationMethod ?? 'trapezoidal',
    trtol: requested?.trtol ?? netlist.trtol ?? 7,
    gmin: requested?.gmin ?? netlist.gmin ?? 0,
    determinism: requested?.determinism ?? 'strict',
    ...(requested?.limits ? { limits: requested.limits } : {}),
  };
}

/**
 * Core's transient step cap: `.tran` TMAX, else the requested `maxTimestep`
 * (0 is unset, as in ngspice), else min(TSTEP, TSTOP/50), where a zero TSTEP runs as that cap or TSTOP/50.
 */
function transientMaxTimestep(analyses: readonly AnalysisDirective[], requested?: number): number {
  let largest: number | undefined;
  for (const analysis of analyses) {
    if (analysis.type !== 'tran') continue;
    const defaultCap = analysis.stopTime / 50;
    const explicitCap = analysis.maxTimestep ?? requested;
    const timestep = analysis.timestep > 0 ? analysis.timestep : explicitCap ?? defaultCap;
    const cap = explicitCap ?? Math.min(timestep, defaultCap);
    largest = Math.max(largest ?? cap, cap);
  }
  return largest ?? Number.MAX_VALUE;
}
