import { Circuit } from './circuit.js';
import type { CompiledCircuit } from './circuit.js';
import { parse, parseAsync, parseControlAnalysisCard, parseControlOptions } from './parser/index.js';
import type { AnalysisDirective, PoleZeroAnalysis } from './types.js';
import type { ControlScript } from './parser/control/script.js';
import type { ControlSourceLine } from './parser/control/source.js';
import { runControlScript, type ControlHost, type ControlHostRun } from './parser/control/interpreter.js';
import { ControlScriptError, UnsupportedControlCommandError } from './parser/control/errors.js';
import { controlOperatingState, deviceOutputVector, savedCurrentVectors, type ControlOperatingState } from './control-device-output.js';
import type { ConvergenceTelemetry, SimulationOptions, SimulationWarning, TransientStep, ACPoint } from './types.js';
import type { TransientAnalysis, ACAnalysis, ResolvedOptions, SimulatorAdapter, SimulatorBackend } from './types.js';
import { resolveOptions, withNetlistOptions } from './types.js';
import { solveDCOperatingPoint } from './analysis/dc.js';
import { isSavedTransientPoint, runnableTransient, solveTransient } from './analysis/transient.js';
import { transientStepCap } from './analysis/max-timestep.js';
import { buildACRHS, solveAC } from './analysis/ac.js';
import { assertNoiseDevicesSupported, solveNoise } from './analysis/noise.js';
import { solveSParameters } from './analysis/s-parameter.js';
import { solveTransferFunction } from './analysis/transfer-function.js';
import { solvePoleZero } from './analysis/pole-zero.js';
import { solveSensitivity } from './analysis/sensitivity.js';
import {
  assertDistortionSupported, solveDistortion,
} from './analysis/distortion.js';
import { Diode } from './devices/diode.js';
import { solveDCSweep } from './analysis/dc-sweep.js';
import { solveStep, generateStepValues, resolveStepTarget } from './analysis/step.js';
import type { StepStreamEvent, StepAnalysis } from './types.js';
import type { MeasurementResult, SimulationResult, StepResult } from './results.js';
import { InvalidCircuitError } from './errors.js';
import { createMatrixVariableIdentities, MNAAssembler } from './mna/assembler.js';
import { toCsc } from './solver/csc-matrix.js';
import { ComplexSparseSolver } from './solver/complex-sparse-solver.js';
import { createDriverFromCompiled } from './analysis/transient-driver.js';
import { WasmNgspiceSimulator } from './simulators/ngspice-wasm.js';
import { computeUICInitialSolution } from './analysis/uic.js';
import { frequencyGrid } from './analysis/frequency-grid.js';
import { createConvergenceTelemetry } from './convergence-telemetry.js';
import { solveStepInWorkers } from './analysis/step-parallel.js';
import type { ProtocolExecutionGuard } from './protocol/execution-guard.js';
import { evaluateMeasureCards, gettokWords, measuredAnalyses, measurePlot, type MeasureCard } from './measure/dot-measure.js';
import { measureCards } from './measure/registry.js';
import { UnsupportedMeasureError } from './measure/errors.js';

class UnsupportedStreamAnalysisError extends InvalidCircuitError {
  readonly code = 'UNSUPPORTED_FEATURE' as const;
  readonly details: { api: 'simulateStream'; analysis: string };

  constructor(analysis: string) {
    super(`simulateStream() does not support '.${analysis}' analysis`);
    this.name = 'UnsupportedStreamAnalysisError';
    this.details = { api: 'simulateStream', analysis };
  }
}

class SpiceTsSimulator implements SimulatorAdapter {
  readonly name = 'spice-ts';

  async simulate(input: string | Circuit, options?: SimulationOptions): Promise<SimulationResult> {
    return simulate(input, { ...options, simulator: 'spice-ts' });
  }
}

export function createSimulator(simulator: SimulatorBackend = 'spice-ts'): SimulatorAdapter {
  if (typeof simulator !== 'string') return simulator;

  switch (simulator) {
    case 'spice-ts':
      return new SpiceTsSimulator();
    case 'ngspice-wasm':
      return new WasmNgspiceSimulator();
    default:
      throw new InvalidCircuitError(`Unknown simulator backend '${simulator}'`);
  }
}

function withoutSimulator(options?: SimulationOptions): SimulationOptions | undefined {
  if (!options) return undefined;
  const { simulator: _simulator, ...rest } = options;
  return rest;
}

function selectedExternalSimulator(options?: SimulationOptions): SimulatorAdapter | null {
  const simulator = options?.simulator;
  if (!simulator || simulator === 'spice-ts') return null;
  return createSimulator(simulator);
}

/**
 * Run all analyses declared in a SPICE netlist or {@link Circuit} object.
 *
 * Parses the input (if a string), compiles the circuit, and executes every
 * analysis command (`.op`, `.dc`, `.tran`, `.ac`) found in the netlist.
 *
 * @param input - A SPICE netlist string or a pre-built {@link Circuit} object
 * @param options - Simulation options (tolerances, integration method, include resolver)
 * @returns Simulation results with `.dc`, `.transient`, `.ac`, `.dcSweep` fields
 * @throws {@link ParseError} if the netlist is malformed
 * @throws {@link InvalidCircuitError} if the circuit has no nodes or no analysis command
 * @throws {@link ConvergenceError} if Newton-Raphson fails to converge
 * @example
 * ```ts
 * const result = await simulate(`
 *   V1 in 0 DC 5
 *   R1 in out 1k
 *   R2 out 0 1k
 *   .op
 * `);
 * console.log(result.dc?.voltage('out')); // 2.5
 * ```
 */
export async function simulate(
  input: string | Circuit,
  options?: SimulationOptions,
  guard?: ProtocolExecutionGuard,
): Promise<SimulationResult> {
  const simulator = selectedExternalSimulator(options);
  if (simulator) {
    return simulator.simulate(input, withoutSimulator(options));
  }

  let circuit: Circuit;
  if (typeof input === 'string') {
    circuit = await parseAsync(input, options?.resolveInclude);
  } else {
    circuit = input;
  }
  const measures = measureCards(circuit);
  if (circuit.controlScript) {
    return simulateControlScript(circuit, circuit.controlScript, options, guard, measures);
  }
  const compiled = circuit.compile(guard);
  options = withNetlistOptions(compiled.simulationOptions, options);
  const warnings: SimulationWarning[] = parseWarnings(circuit);
  const convergence = createConvergenceTelemetry();
  if (options.bypass) {
    warnings.push({
      type: 'option',
      message: 'bypass: native solver always evaluates nonlinear devices; ngspice evaluation reuse is not implemented. Iteration counts and tolerance-level results may differ.',
    });
  }

  validateCircuit(compiled, warnings);

  if (compiled.steps.length > 0) {
    if (measures.length > 0) {
      throw new UnsupportedMeasureError(
        '.meas with .step is not implemented (ngspice measures each step run separately)',
        measures[0].line,
        measures[0].text,
      );
    }
    if (compiled.steps.length > 1) {
      throw new InvalidCircuitError(
        'Multiple .step directives are not supported; nested or multi-dimensional stepping is unsupported',
      );
    }
    const parallelResults = typeof input === 'string'
      ? await solveStepInWorkers(input, compiled.steps[0], options, warnings, convergence)
      : null;
    const stepResults = parallelResults
      ?? solveStep(compiled, compiled.steps[0], options, warnings, convergence, guard);
    return { steps: stepResults, warnings, convergence };
  }

  const result = solveCompiledAnalyses(compiled, options, warnings, convergence, guard, measures, new Map(), true);
  warnUnmeasuredAnalyses(measures, compiled.analyses, warnings);
  return result;
}

/** ngspice silently skips `.meas` cards whose analysis never runs; say so. */
function warnUnmeasuredAnalyses(
  measures: readonly MeasureCard[],
  analyses: readonly { type: string }[],
  warnings: SimulationWarning[],
): void {
  const ran = new Set(analyses.map(analysis => analysis.type));
  for (const type of measuredAnalyses(measures)) {
    if (!ran.has(type)) {
      warnings.push({ type: 'measure', message: `.meas ${type} cards were not evaluated: the deck runs no .${type} analysis` });
    }
  }
}

/**
 * Solve every analysis of a compiled circuit into one result. `.meas` cards
 * are evaluated after each tran/ac/dc analysis, as ngspice's dosim() calls
 * do_measure(); `measureValues` is ngspice's dictionary of earlier results.
 */
function solveCompiledAnalyses(
  compiled: CompiledCircuit,
  options: SimulationOptions,
  warnings: SimulationWarning[],
  convergence: ConvergenceTelemetry,
  guard: ProtocolExecutionGuard | undefined,
  measures: readonly MeasureCard[],
  measureValues: Map<string, number>,
  retainRuns: boolean,
  savedDeviceVectors: readonly string[] = [],
): SimulationResult {
  const result: SimulationResult = { warnings, convergence };
  savedDeviceVectors = savedCurrentVectors({ devices: compiled.devices, simulationOptions: options }, savedDeviceVectors);
  if (retainRuns && compiled.analyses.length + compiled.poleZeroAnalyses.length >= 2) result.analyses = [];
  const measure = (analysis: AnalysisDirective, run: SimulationResult): void => {
    if (measures.length === 0) return;
    const plot = measurePlot(analysis, result);
    if (!plot) return;
    const measurements = evaluateMeasureCards(measures, analysis.type, plot, measureValues);
    if (measurements.length > 0) {
      result.measurements = [...(result.measurements ?? []), ...measurements];
      if (run !== result) run.measurements = measurements;
    }
  };

  for (const analysis of compiled.analyses) {
    const run: SimulationResult = result.analyses ? { warnings: [] } : result;
    if (options.savecurrents && !['dc', 'tran'].includes(analysis.type)) {
      throw new InvalidCircuitError(`.option savecurrents is not supported for '${analysis.type}' analyses`);
    }
    switch (analysis.type) {
      case 'op': {
        const opts = resolveOptions(options);
        const { result: dcResult } = solveDCOperatingPoint(
          compiled, opts, undefined, convergence, 'operating-point', guard,
        );
        guard?.recordResultPoint();
        result.dc = run.dc = dcResult;
        break;
      }
      case 'dc': {
        const opts = resolveOptions(options);
        result.dcSweep = run.dcSweep = solveDCSweep(compiled, analysis, opts, convergence, guard, savedDeviceVectors);
        measure(analysis, run);
        break;
      }
      case 'tran': {
        const opts = resolveOptions(options, analysis.stopTime);
        const seed = transientInitialSolution(compiled, analysis, opts, undefined, convergence, guard);
        // ngspice-47 measure.c:341-346,405-407: chk_only skips param/expr
        // and returns before the second pass. Failed/unresolved measurements
        // must not stop the run or mutate the final measurement dictionary.
        const completionCards = options.autostop ? measures.filter(card => {
          const [, type, , fn = ''] = gettokWords(card.text);
          return type === 'tran' && !fn.startsWith('param') && !fn.startsWith('expr');
        }) : [];
        result.transient = run.transient = solveTransient(
          compiled, runnableTransient(analysis, options), opts, seed, convergence, guard,
          completionCards.length === 0 ? undefined : transient => {
            const plot = measurePlot(analysis, { transient, warnings: [] });
            if (!plot) return false;
            const checked = evaluateMeasureCards(completionCards, 'tran', plot, new Map(measureValues));
            return checked.length === completionCards.length && checked.every(value => value.status === 'ok');
          },
          savedDeviceVectors,
        );
        measure(analysis, run);
        break;
      }
      case 'ac': {
        const opts = resolveOptions(options);
        const { assembler: dcAsm } = solveDCOperatingPoint(
          compiled, opts, undefined, convergence, 'operating-point', guard,
        );
        result.ac = run.ac = solveAC(compiled, analysis, opts, dcAsm.solution, guard);
        measure(analysis, run);
        break;
      }
      case 'noise': {
        assertNoiseDevicesSupported(compiled);
        const opts = resolveOptions(options);
        const { assembler: dcAsm } = solveDCOperatingPoint(
          compiled, opts, undefined, convergence,
        );
        result.noise = run.noise = solveNoise(compiled, analysis, opts, dcAsm.solution);
        break;
      }
      case 'sp': {
        const opts = resolveOptions(options);
        const { assembler: dcAsm } = solveDCOperatingPoint(
          compiled, opts, undefined, convergence, 'operating-point', guard,
        );
        result.sParameters = run.sParameters = solveSParameters(compiled, analysis, opts, dcAsm.solution, guard);
        break;
      }
      case 'disto': {
        assertDistortionSupported(compiled, analysis);
        const opts = resolveOptions(options);
        const diodes = compiled.devices.filter((device): device is Diode => device instanceof Diode);
        for (const diode of diodes) diode.setDistortionMode(true);
        try {
          const { assembler: dcAsm } = solveDCOperatingPoint(
            compiled, opts, undefined, convergence, 'operating-point', guard,
          );
          result.distortion = run.distortion = solveDistortion(
            compiled, analysis, opts, dcAsm.solution, guard,
          );
        } finally {
          for (const diode of diodes) diode.setDistortionMode(false);
        }
        break;
      }
      case 'tf': {
        const opts = resolveOptions(options);
        result.transferFunction = run.transferFunction = solveTransferFunction(
          compiled, analysis, opts, convergence,
        );
        break;
      }
      case 'sens': {
        const opts = resolveOptions(options);
        result.sensitivity = run.sensitivity = solveSensitivity(
          compiled, analysis, opts, convergence,
        );
        break;
      }
    }
    result.analyses?.push({ index: result.analyses.length, analysis: analysis.type, result: run });
  }

  for (const analysis of compiled.poleZeroAnalyses) {
    const opts = resolveOptions(options);
    result.poleZero = solvePoleZero(compiled, analysis, opts, convergence);
    result.analyses?.push({
      index: result.analyses.length, analysis: 'pz', result: { poleZero: result.poleZero, warnings: [] },
    });
  }

  return result;
}

/** Analysis result fields a control-script run contributes to the top-level result. */
const ANALYSIS_RESULT_FIELDS = [
  'dc', 'dcSweep', 'transient', 'ac', 'noise', 'sParameters', 'distortion', 'transferFunction', 'poleZero', 'sensitivity',
] as const;

/**
 * Run a deck through its ngspice `.control` script.
 *
 * Mirrors ngspice batch mode: the script runs first (analysis commands, `run`,
 * `alter`/`altermod`, ...), then, unless it ended with `quit`, the deck's own
 * dot-card analyses run once more with every alteration applied. Each top-level
 * field holds the latest run of its analysis type; `result.control.runs` keeps
 * every script run.
 */
function simulateControlScript(
  circuit: Circuit,
  script: ControlScript,
  options: SimulationOptions | undefined,
  guard: ProtocolExecutionGuard | undefined,
  measures: readonly MeasureCard[],
): SimulationResult {
  const warnings: SimulationWarning[] = parseWarnings(circuit);
  const convergence = createConvergenceTelemetry();
  const measureValues = new Map<string, number>();
  const reparse = circuit.reparseWithParameters;
  const parameterChanges: import('./parser/preprocessor.js').ParameterAlteration[] = [];
  let deckAnalyses = [...circuit.analyses];
  let deckPoleZero = [...circuit.poleZeroAnalyses];

  // ngspice reads `@device[i]` from the circuit's present state: the last analysis's last solution.
  let operatingState: ControlOperatingState | undefined;

  const solve = (analyses: AnalysisDirective[], poleZero: PoleZeroAnalysis[], saves: readonly string[] = []): SimulationResult => {
    const savedAnalyses = circuit.analyses.splice(0, circuit.analyses.length, ...analyses);
    const savedPoleZero = circuit.poleZeroAnalyses.splice(0, circuit.poleZeroAnalyses.length, ...poleZero);
    let compiled: CompiledCircuit;
    try {
      compiled = circuit.compile(guard);
    } finally {
      circuit.analyses.splice(0, circuit.analyses.length, ...savedAnalyses);
      circuit.poleZeroAnalyses.splice(0, circuit.poleZeroAnalyses.length, ...savedPoleZero);
    }
    // The compiled circuit shares the circuit's analysis arrays, which were just restored.
    compiled = { ...compiled, analyses: [...analyses], poleZeroAnalyses: [...poleZero] };
    validateCircuit(compiled, warnings);
    const resolved = withNetlistOptions(compiled.simulationOptions, options);
    // Cleared first: a failed analysis leaves no state to read out.
    operatingState = undefined;
    const result = solveCompiledAnalyses(compiled, resolved, warnings, convergence, guard, measures, measureValues, false, saves);
    operatingState = analyses.length === 1 && poleZero.length === 0
      ? controlOperatingState(compiled, analyses[0], result)
      : undefined;
    return result;
  };

  const runDeck = (saves: readonly string[] = []): ControlHostRun[] => [
    ...deckAnalyses.map(directive => ({ directive, result: solve([directive], [], saves) })),
    ...deckPoleZero.map(analysis => ({ directive: { type: 'pz' as const }, result: solve([], [analysis]) })),
  ];

  const unsupported = (command: string, reason: string, line: ControlSourceLine): UnsupportedControlCommandError =>
    new UnsupportedControlCommandError(command, reason, line.lineNumber, line.text);

  const host: ControlHost = {
    runAnalysis(tokens, line, saves) {
      const directive = parseControlAnalysisCard(tokens, line.lineNumber, line.text);
      return { directive, result: solve([directive], [], saves) };
    },
    runDeck(line, saves) {
      if (deckAnalyses.length === 0 && deckPoleZero.length === 0) {
        throw new ControlScriptError('run: the deck has no analysis cards', line.lineNumber, line.text);
      }
      return runDeck(saves);
    },
    alterInstance(device, parameter, values, line) {
      const reason = circuit.alterInstance(device, parameter, values);
      if (reason !== undefined) throw unsupported('alter', reason, line);
    },
    alterModel(model, parameter, value, line) {
      const reason = circuit.alterModel(model, parameter, value);
      if (reason !== undefined) throw unsupported('altermod', reason, line);
    },
    alterParameter(subcircuit, name, expression, line) {
      if (!reparse) throw unsupported('alterparam', 'no retained netlist source', line);
      const changes = [...parameterChanges, { subcircuit, name, expression }];
      try {
        reparse(changes);
      } catch (error) {
        throw new ControlScriptError(error instanceof Error ? error.message : String(error), line.lineNumber, line.text);
      }
      parameterChanges.push({ subcircuit, name, expression });
    },
    reset(line) {
      if (!reparse) throw unsupported('reset', 'no retained netlist source', line);
      circuit = reparse(parameterChanges);
      deckAnalyses = [...circuit.analyses];
      deckPoleZero = [...circuit.poleZeroAnalyses];
      measures = measureCards(circuit);
      operatingState = undefined;
      measureValues.clear();
      return circuit.controlScript?.constants ?? {};
    },
    parameterVector: (device, parameter) =>
      deviceOutputVector(operatingState, device, parameter) ?? circuit.parameterVector(device, parameter),
    setOptions(tokens, line) {
      circuit.setSimulationOptions(parseControlOptions(tokens, line.lineNumber, line.text));
    },
  };

  const restore = circuit.snapshotControlState();
  let outcome: ReturnType<typeof runControlScript>;
  let finalRuns: ControlHostRun[];
  try {
    outcome = runControlScript(script, host);
    finalRuns = outcome.quit ? [] : runDeck();
  } finally {
    // Restore even on script/solver errors and non-zero quit statuses.
    restore();
  }
  for (const message of outcome.warnings) warnings.push({ type: 'control', message });
  const result: SimulationResult = {
    warnings,
    convergence,
    control: { runs: outcome.runs, output: outcome.output, quit: outcome.quit, measurements: outcome.measurements, fourier: outcome.fourier },
  };
  // Like the analysis fields, measurements come from the latest run of each analysis type.
  const latestMeasurements = new Map<string, MeasurementResult[]>();
  for (const { result: run } of [...outcome.runs, ...finalRuns]) {
    for (const field of ANALYSIS_RESULT_FIELDS) {
      if (run[field] !== undefined) Object.assign(result, { [field]: run[field] });
    }
    for (const measurement of run.measurements ?? []) latestMeasurements.delete(measurement.analysis);
    for (const measurement of run.measurements ?? []) {
      latestMeasurements.set(measurement.analysis, [...(latestMeasurements.get(measurement.analysis) ?? []), measurement]);
    }
  }
  if (latestMeasurements.size > 0) result.measurements = [...latestMeasurements.values()].flat();
  const seen = new Set<string>();
  result.warnings = warnings.filter(warning => {
    const key = `${warning.type}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result;
}

/**
 * Stream simulation results one timestep or frequency point at a time.
 *
 * Only `.tran` and `.ac` analyses produce streamed output. Use this for
 * large simulations where you want to process results incrementally
 * rather than waiting for the full result set.
 *
 * @param input - A SPICE netlist string or a pre-built {@link Circuit} object
 * @param options - Simulation options (tolerances, integration method, include resolver)
 * @yields {@link TransientStep} for `.tran` analyses, {@link ACPoint} for `.ac` analyses
 * @throws {@link ParseError} if the netlist is malformed
 * @throws {@link InvalidCircuitError} if the circuit has no nodes or no analysis command
 * @throws {@link ConvergenceError} if Newton-Raphson fails to converge
 * @throws {@link TimestepTooSmallError} if the adaptive timestep shrinks below 1e-12
 * @example
 * ```ts
 * for await (const step of simulateStream('V1 1 0 DC 5\nR1 1 0 1k\n.tran 1u 1m')) {
 *   if ('time' in step) console.log(step.time, step.voltages.get('1'));
 * }
 * ```
 */
export async function* simulateStream(
  input: string | Circuit,
  options?: SimulationOptions,
): AsyncIterableIterator<TransientStep | ACPoint> {
  if (selectedExternalSimulator(options)) {
    const result = await simulate(input, options);
    yield* streamFromSimulationResult(result);
    return;
  }

  let circuit: Circuit;
  if (typeof input === 'string') {
    circuit = await parseAsync(input, options?.resolveInclude);
  } else {
    circuit = input;
  }
  if (circuit.controlScript) throw new UnsupportedStreamAnalysisError('control');
  const compiled = circuit.compile();
  options = withNetlistOptions(compiled.simulationOptions, options);
  const warnings: SimulationWarning[] = [];
  validateCircuit(compiled, warnings);

  for (const type of ['disto', 'sp'] as const) {
    if (compiled.analyses.some(analysis => analysis.type === type)) {
      throw new UnsupportedStreamAnalysisError(type);
    }
  }

  if (compiled.steps.length > 0) {
    for (const event of streamWithSteps(compiled, compiled.steps[0], options)) {
      yield event.point;
    }
    return;
  }

  for (const analysis of compiled.analyses) {
    switch (analysis.type) {
      case 'tran': {
        const opts = resolveOptions(options, analysis.stopTime);
        const seed = transientInitialSolution(compiled, analysis, opts);
        yield* streamTransient(compiled, runnableTransient(analysis, options), opts, seed);
        break;
      }
      case 'ac': {
        const opts = resolveOptions(options);
        const { assembler: dcAsm } = solveDCOperatingPoint(compiled, opts);
        yield* streamAC(compiled, analysis, opts, dcAsm.solution);
        break;
      }
    }
  }
}

/**
 * Stream simulation results with step metadata for parametric sweeps.
 *
 * Each yielded event includes the step index, parameter name/value, and the
 * inner {@link TransientStep} or {@link ACPoint}. Use this instead of
 * {@link simulateStream} when you need to distinguish which step each point
 * belongs to.
 *
 * @param input - A SPICE netlist string or a pre-built {@link Circuit} object
 * @param options - Simulation options
 * @yields {@link StepStreamEvent} for each inner time/frequency point across all steps
 */
export async function* simulateStepStream(
  input: string | Circuit,
  options?: SimulationOptions,
): AsyncIterableIterator<StepStreamEvent> {
  if (selectedExternalSimulator(options)) {
    const result = await simulate(input, options);
    if (result.steps) {
      for (let stepIndex = 0; stepIndex < result.steps.length; stepIndex++) {
        const step = result.steps[stepIndex];
        yield* streamEventsFromStepResult(step, stepIndex, step.paramName, step.paramValue);
      }
    } else {
      yield* streamEventsFromStepResult(result, 0, '', 0);
    }
    return;
  }

  let circuit: Circuit;
  if (typeof input === 'string') {
    circuit = await parseAsync(input, options?.resolveInclude);
  } else {
    circuit = input;
  }
  if (circuit.controlScript) throw new UnsupportedStreamAnalysisError('control');
  const compiled = circuit.compile();
  options = withNetlistOptions(compiled.simulationOptions, options);
  const warnings: SimulationWarning[] = [];
  validateCircuit(compiled, warnings);

  if (compiled.steps.length > 0) {
    yield* streamWithSteps(compiled, compiled.steps[0], options);
  } else {
    // No steps — yield events with stepIndex 0 and empty param info
    for (const analysis of compiled.analyses) {
      switch (analysis.type) {
        case 'tran': {
          const opts = resolveOptions(options, analysis.stopTime);
          const seed = transientInitialSolution(compiled, analysis, opts);
          for (const point of streamTransient(compiled, runnableTransient(analysis, options), opts, seed)) {
            yield { stepIndex: 0, paramName: '', paramValue: 0, point };
          }
          break;
        }
        case 'ac': {
          const opts = resolveOptions(options);
          const { assembler: dcAsm } = solveDCOperatingPoint(compiled, opts);
          for (const point of streamAC(compiled, analysis, opts, dcAsm.solution)) {
            yield { stepIndex: 0, paramName: '', paramValue: 0, point };
          }
          break;
        }
      }
    }
  }
}

function* streamWithSteps(
  compiled: CompiledCircuit,
  step: StepAnalysis,
  options: SimulationOptions | undefined,
): Generator<StepStreamEvent> {
  const values = generateStepValues(step);
  const target = resolveStepTarget(compiled, step);
  let prevDCSolution: Float64Array | undefined;

  try {
    for (let stepIndex = 0; stepIndex < values.length; stepIndex++) {
      const value = values[stepIndex];
      target.set(value);
      if (target.resetsContinuation) prevDCSolution = undefined;

      for (const analysis of compiled.analyses) {
        switch (analysis.type) {
          case 'tran': {
            const opts = resolveOptions(options, analysis.stopTime);
            const seed = transientInitialSolution(compiled, analysis, opts, prevDCSolution);
            if (!analysis.useInitialConditions) prevDCSolution = new Float64Array(seed);
            for (const point of streamTransient(compiled, runnableTransient(analysis, options), opts, seed)) {
              yield { stepIndex, paramName: target.paramName, paramValue: value, point };
            }
            break;
          }
          case 'ac': {
            const opts = resolveOptions(options);
            const { assembler: dcAsm } = solveDCOperatingPoint(compiled, opts, prevDCSolution);
            prevDCSolution = new Float64Array(dcAsm.solution);
            for (const point of streamAC(compiled, analysis, opts, dcAsm.solution)) {
              yield { stepIndex, paramName: target.paramName, paramValue: value, point };
            }
            break;
          }
        }
      }
    }
  } finally {
    target.restore();
  }
}

function parseWarnings(circuit: Circuit): SimulationWarning[] {
  return circuit.parseDiagnostics;
}

function validateCircuit(compiled: CompiledCircuit, warnings: SimulationWarning[]): void {
  // ngspice-47 runs a deck whose nodes are all XSPICE digital (event) nodes,
  // such as eSim's half_adder; the analog system is then empty.
  // ngspice also runs element-free .tran decks, returning only the time axis.
  if (compiled.nodeCount === 0 && !compiled.devices.some(device => device.eventDriven !== undefined)
    && !(compiled.analyses.length > 0 && compiled.analyses.every(analysis => analysis.type === 'tran'))) {
    throw new InvalidCircuitError('Circuit has no nodes');
  }
  if (compiled.analyses.length === 0 && compiled.poleZeroAnalyses.length === 0) {
    throw new InvalidCircuitError('No analysis command specified');
  }
  if (compiled.steps.length > 0 && compiled.poleZeroAnalyses.length > 0) {
    throw new InvalidCircuitError('.step cannot be combined with .pz');
  }
  if (compiled.steps.length > 0 && compiled.analyses.some(analysis => analysis.type === 'sens')) {
    throw new InvalidCircuitError('.step cannot be combined with .sens');
  }
  if (compiled.steps.length > 0 && compiled.analyses.some(analysis => analysis.type === 'disto')) {
    throw new InvalidCircuitError('.step cannot be combined with .disto');
  }
  if (compiled.steps.length > 0 && compiled.analyses.some(analysis => analysis.type === 'sp')) {
    throw new InvalidCircuitError('.step cannot be combined with .sp');
  }
  for (const device of compiled.devices) {
    for (const message of device.modelWarnings ?? []) {
      warnings.push({ type: 'model', message });
    }
  }
}

function transientInitialSolution(
  compiled: CompiledCircuit,
  analysis: TransientAnalysis,
  options: ResolvedOptions,
  initialGuess?: Float64Array,
  convergence?: ConvergenceTelemetry,
  guard?: ProtocolExecutionGuard,
): Float64Array {
  if (analysis.useInitialConditions) return computeUICInitialSolution(compiled);
  return solveDCOperatingPoint(
    compiled, options, initialGuess, convergence, 'transient', guard,
  ).assembler.solution;
}

function* streamFromSimulationResult(result: SimulationResult): Generator<TransientStep | ACPoint> {
  if (result.steps) {
    for (const step of result.steps) {
      yield* streamPointsFromStepResult(step);
    }
    return;
  }
  yield* streamPointsFromStepResult(result);
}

function* streamPointsFromStepResult(
  result: StepResult | SimulationResult,
): Generator<TransientStep | ACPoint> {
  if (result.transient) {
    const voltages = result.transient.voltages;
    const currents = result.transient.currents;
    for (let i = 0; i < result.transient.time.length; i++) {
      yield {
        time: result.transient.time[i],
        voltages: mapAtIndex(voltages, i),
        currents: mapAtIndex(currents, i),
      };
    }
  }

  if (result.ac) {
    const voltages = result.ac.voltages;
    const currents = result.ac.currents;
    for (let i = 0; i < result.ac.frequencies.length; i++) {
      yield {
        frequency: result.ac.frequencies[i],
        voltages: mapAtIndex(voltages, i),
        currents: mapAtIndex(currents, i),
      };
    }
  }
}

function* streamEventsFromStepResult(
  result: StepResult | SimulationResult,
  stepIndex: number,
  paramName: string,
  paramValue: number,
): Generator<StepStreamEvent> {
  for (const point of streamPointsFromStepResult(result)) {
    yield { stepIndex, paramName, paramValue, point };
  }
}

function mapAtIndex<T>(arrays: Map<string, T[]>, index: number): Map<string, T> {
  const result = new Map<string, T>();
  for (const [name, values] of arrays) {
    result.set(name, values[index]);
  }
  return result;
}

function* streamTransient(
  compiled: CompiledCircuit,
  analysis: TransientAnalysis,
  options: ResolvedOptions,
  initialSolution: Float64Array,
): Generator<TransientStep> {
  const driver = createDriverFromCompiled(compiled, options, {
    stopTime: analysis.stopTime,
    timestep: analysis.timestep,
    // SPICE convention: when `.tran` doesn't supply `tmax` (4th arg), bound
    // dt by `min(tstep, tstop/50)` — shared with solveTransient and
    // createTransientSim so every entry point steps the same grid.
    maxTimestep: transientStepCap(analysis),
    initialSolution,
    useInitialConditions: analysis.useInitialConditions,
  });

  try {
    const initialStep = driver.peekInitialStep();
    if (isSavedTransientPoint(analysis, initialStep.time)) yield initialStep;
    while (!driver.isDone) {
      const step = driver.advance();
      if (isSavedTransientPoint(analysis, step.time)) yield step;
    }
  } finally {
    driver.dispose();
  }
}

function* streamAC(
  compiled: CompiledCircuit,
  analysis: ACAnalysis,
  options: ResolvedOptions,
  dcSolution: Float64Array,
): Generator<ACPoint> {
  const { devices, nodeCount, branchCount, nodeNames, branchNames } = compiled;

  // Build linearized G and C matrices at DC operating point
  const assembler = new MNAAssembler(nodeCount, branchCount, { deviceGmin: options.deviceGmin });
  assembler.solution.set(dcSolution);
  const ctx = assembler.getStampContext();
  for (const device of devices) device.stamp(ctx);
  for (const device of devices) device.stampDynamic?.(ctx);

  // Add GMIN to diagonal for numerical stability (same as DC/transient paths)
  for (let i = 0; i < nodeCount; i++) {
    assembler.G.add(i, i, options.gmin ?? 1e-12);
  }

  const G = assembler.G;
  const C = assembler.C;

  const frequencies = frequencyGrid(analysis, options.reltol, 'ac');

  // Build n*n CSC for G and C
  const { csc: gCsc } = toCsc(G);
  const { csc: cCsc } = toCsc(C);

  // Complex sparse solver: analyze pattern once, factorize per frequency
  const solver = new ComplexSparseSolver();
  solver.analyzePattern(
    gCsc,
    cCsc,
    createMatrixVariableIdentities(nodeNames, branchNames),
  );

  // Pre-compute RHS (constant across frequencies)
  const { real: bReal, imaginary: bImag } = buildACRHS(compiled);

  for (const freq of frequencies) {
    const omega = 2 * Math.PI * freq;

    solver.factorize(gCsc, cCsc, omega);
    const [xReal, xImag] = solver.solve(bReal, bImag);

    // Extract results
    const voltages = new Map<string, { magnitude: number; phase: number }>();
    for (let i = 0; i < nodeNames.length; i++) {
      const re = xReal[i], im = xImag[i];
      voltages.set(nodeNames[i], {
        magnitude: Math.sqrt(re * re + im * im),
        phase: (Math.atan2(im, re) * 180) / Math.PI,
      });
    }
    const currents = new Map<string, { magnitude: number; phase: number }>();
    for (let i = 0; i < branchNames.length; i++) {
      const re = xReal[nodeCount + i], im = xImag[nodeCount + i];
      currents.set(branchNames[i], {
        magnitude: Math.sqrt(re * re + im * im),
        phase: (Math.atan2(im, re) * 180) / Math.PI,
      });
    }

    yield { frequency: freq, voltages, currents };
  }
}
