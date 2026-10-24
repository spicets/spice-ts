import { Circuit, type CompiledCircuit } from '../circuit.js';
import { InvalidCircuitError } from '../errors.js';
import { generateStepValues } from '../analysis/step.js';
import { parse } from '../parser/index.js';
import { preprocess } from '../parser/preprocessor.js';
import { ACResult, DCResult, DCSweepResult, TransientResult, type SimulationResult, type StepResult } from '../results.js';
import type {
  AnalysisDirective,
  DCSweepAnalysis,
  SimulationOptions,
  SimulationWarning,
  SimulatorAdapter,
  StepAnalysis,
  TransientAnalysis,
} from '../types.js';

type NgspiceComplex = { real: number; img: number };
type NgspiceData = {
  name: string;
  type: string;
  values: number[] | NgspiceComplex[];
};
type NgspiceResult = {
  numVariables: number;
  numPoints: number;
  dataType: 'real' | 'complex';
  data: NgspiceData[];
};
type NgspiceSimulation = {
  start(): Promise<void>;
  setNetList(input: string): void;
  runSim(): Promise<NgspiceResult>;
  getError(): string[];
};
type NgspiceSimulationClass = new () => NgspiceSimulation;

export interface WasmNgspiceSimulatorOptions {
  /** Optional injected Simulation class, useful for tests or custom bundlers. */
  Simulation?: NgspiceSimulationClass;
}

interface PreparedInput {
  netlist: string;
  compiled: CompiledCircuit;
}

interface VariableName {
  kind: 'voltage' | 'current' | 'time' | 'frequency' | 'other';
  name: string;
}

/**
 * Optional ngspice WASM simulator backend powered by `eecircuit-engine`.
 *
 * The package is loaded lazily so the default TypeScript simulator remains
 * dependency-light unless this backend is selected.
 */
export class WasmNgspiceSimulator implements SimulatorAdapter {
  readonly name = 'ngspice-wasm';

  constructor(private readonly options: WasmNgspiceSimulatorOptions = {}) {}

  async simulate(
    input: string | Circuit,
    options?: SimulationOptions,
  ): Promise<SimulationResult> {
    const prepared = await prepareInput(input, options);

    const warnings: SimulationWarning[] = [];
    const result: SimulationResult = { warnings };
    const baseNetlist = stripAnalysisCommands(prepared.netlist);

    if (prepared.compiled.steps.length > 0) {
      if (prepared.compiled.steps.length > 1) {
        throw new InvalidCircuitError(
          'Multiple .step directives are not supported; nested or multi-dimensional stepping is unsupported',
        );
      }
      result.steps = await this.runStepAnalyses(baseNetlist, prepared.compiled, prepared.compiled.steps[0], warnings);
      return result;
    }

    Object.assign(result, await this.runAnalyses(baseNetlist, prepared.compiled, warnings));
    return result;
  }

  private async runStepAnalyses(
    baseNetlist: string,
    compiled: CompiledCircuit,
    step: StepAnalysis,
    warnings: SimulationWarning[],
  ): Promise<StepResult[]> {
    const values = generateStepValues(step);
    const device = compiled.devices.find(d => d.name === step.param);
    if (!device) {
      throw new InvalidCircuitError(`Step parameter device '${step.param}' not found`);
    }
    if (!device.setParameter || !device.getParameter) {
      throw new InvalidCircuitError(`Device '${step.param}' does not support parametric sweep`);
    }

    const results: StepResult[] = [];
    for (const value of values) {
      const stepNetlist = setSteppedDeviceValue(baseNetlist, step.param, value);
      results.push({
        paramName: step.param,
        paramValue: value,
        ...(await this.runAnalyses(stepNetlist, compiled, warnings)),
      });
    }

    return results;
  }

  private async runAnalyses(
    baseNetlist: string,
    compiled: CompiledCircuit,
    warnings: SimulationWarning[],
  ): Promise<Omit<SimulationResult, 'warnings' | 'steps'>> {
    const result: Omit<SimulationResult, 'warnings' | 'steps'> = {};

    for (const analysis of compiled.analyses) {
      if (analysis.type === 'noise' || analysis.type === 'tf' || analysis.type === 'sens') {
        throw new InvalidCircuitError(
          `ngspice-wasm .${analysis.type} result mapping is not supported`,
        );
      }
      const raw = await this.runRaw(`${baseNetlist}\n${formatAnalysis(analysis)}\n.end`, warnings);
      switch (analysis.type) {
        case 'op':
          result.dc = mapDCResult(raw, compiled);
          break;
        case 'dc':
          result.dcSweep = mapDCSweepResult(raw, compiled, analysis);
          break;
        case 'tran':
          result.transient = mapTransientResult(raw, compiled, analysis);
          break;
        case 'ac':
          result.ac = mapACResult(raw, compiled);
          break;
      }
    }

    return result;
  }

  private async runRaw(netlist: string, warnings: SimulationWarning[]): Promise<NgspiceResult> {
    const Sim = await this.loadSimulationClass();
    const sim = new Sim();
    await sim.start();
    sim.setNetList(adaptNetlistForNgspice(netlist));
    const raw = await sim.runSim();
    const messages = sim.getError().filter(line => line.trim().length > 0);

    for (const message of messages) {
      warnings.push({ type: 'ngspice-wasm', message });
    }

    const fatal = messages.find(message => /^error:/i.test(message.trim()));
    if (fatal) {
      throw new InvalidCircuitError(`ngspice-wasm simulation failed: ${fatal}`);
    }
    if (raw.numVariables === 0 || raw.numPoints === 0) {
      throw new InvalidCircuitError('ngspice-wasm simulation produced no data');
    }

    return raw;
  }

  private async loadSimulationClass(): Promise<NgspiceSimulationClass> {
    if (this.options.Simulation) return this.options.Simulation;

    try {
      const mod = await import('eecircuit-engine');
      return (mod as { Simulation: NgspiceSimulationClass }).Simulation;
    } catch (err) {
      throw new InvalidCircuitError(
        `ngspice-wasm simulator requires optional package 'eecircuit-engine': ${(err as Error).message}`,
      );
    }
  }
}

async function prepareInput(
  input: string | Circuit,
  options?: SimulationOptions,
): Promise<PreparedInput> {
  if (typeof input !== 'string') {
    const compiled = input.compile();
    return { netlist: input.toNetlist(), compiled };
  }

  const netlist = options?.resolveInclude
    ? await preprocess(input, options.resolveInclude)
    : input;
  const circuit = parse(netlist);
  return { netlist, compiled: circuit.compile() };
}

function stripAnalysisCommands(netlist: string): string {
  const lines: string[] = [];
  for (const line of netlist.split('\n')) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (
      lower === '.end'
      || lower === '.op'
      || lower.startsWith('.dc ')
      || lower.startsWith('.tran ')
      || lower.startsWith('.ac ')
      || lower.startsWith('.noise ')
      || lower.startsWith('.tf ')
      || lower.startsWith('.step ')
    ) {
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function setSteppedDeviceValue(netlist: string, deviceName: string, value: number): string {
  let found = false;
  const valueText = formatNumber(value);
  const lines = netlist.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith(';')) return line;

    const tokens = trimmed.split(/\s+/);
    if (tokens[0]?.toLowerCase() !== deviceName.toLowerCase()) return line;

    found = true;
    const type = tokens[0][0].toUpperCase();
    switch (type) {
      case 'R':
        if (tokens.length < 4) {
          throw new InvalidCircuitError(`Cannot step malformed resistor '${deviceName}'`);
        }
        tokens[3] = valueText;
        break;
      case 'C':
      case 'L':
        replacePassiveValue(tokens, type as 'C' | 'L', valueText);
        break;
      default:
        throw new InvalidCircuitError(
          `Device '${deviceName}' does not support parametric sweep with ngspice-wasm`,
        );
    }

    const leading = line.match(/^\s*/)?.[0] ?? '';
    return `${leading}${tokens.join(' ')}`;
  });

  if (!found) {
    throw new InvalidCircuitError(`Step parameter device '${deviceName}' not found in netlist`);
  }

  return lines.join('\n');
}

function replacePassiveValue(tokens: string[], kind: 'C' | 'L', valueText: string): void {
  const valueKeys = kind === 'C' ? ['C', 'CAP'] : ['L', 'IND'];
  if (tokens.length <= 3) {
    tokens.push(valueText);
    return;
  }

  const candidate = tokens[3];
  const eqIdx = candidate.indexOf('=');
  if (eqIdx > 0) {
    const key = candidate.slice(0, eqIdx).toUpperCase();
    if (valueKeys.includes(key)) {
      tokens[3] = `${candidate.slice(0, eqIdx + 1)}${valueText}`;
    } else {
      tokens.splice(3, 0, valueText);
    }
    return;
  }

  if (tokens[4] && isSeparatedPhysicalUnit(tokens[4], kind)) {
    tokens.splice(3, 2, valueText);
    return;
  }

  if (looksLikePassiveValue(candidate, kind)) {
    tokens[3] = valueText;
    return;
  }

  tokens.splice(3, 0, valueText);
}

function isSeparatedPhysicalUnit(token: string, kind: 'C' | 'L'): boolean {
  const unit = kind === 'C' ? '[Ff]' : '[Hh]';
  return new RegExp(`^[TtGgKkMmUuNnPpFf]?${unit}$`).test(token);
}

function looksLikePassiveValue(token: string, kind: 'C' | 'L'): boolean {
  const unit = kind === 'C' ? '[Ff]' : '[Hh]';
  const suffix = `[Mm][Ee][Gg]|[TtGgKkMmUuNnPpFf]|[TtGgKkMmUuNnPpFf]?${unit}`;
  return new RegExp(`^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?(?:${suffix})?$`).test(token);
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toString() : String(value);
}

function adaptNetlistForNgspice(netlist: string): string {
  const adapted: string[] = ['* spice-ts ngspice-wasm'];
  for (const line of netlist.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase() === '.end') continue;

    const mosfetMatch = line.match(/^(M\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(NMOD|PMOD|NMOS\S*|PMOS\S*)\s*(.*)$/i);
    if (mosfetMatch) {
      const [, name, drain, gate, source, model, rest] = mosfetMatch;
      adapted.push(`${name} ${drain} ${gate} ${source} ${source} ${model}${rest ? ` ${rest}` : ''}`);
      continue;
    }

    adapted.push(line.replace(/[^\x00-\x7F]/g, '-'));
  }
  adapted.push('.end');
  return adapted.join('\n');
}

function formatAnalysis(analysis: AnalysisDirective): string {
  switch (analysis.type) {
    case 'op':
      return '.op';
    case 'dc':
      return `.dc ${analysis.source} ${analysis.start} ${analysis.stop} ${analysis.step}`;
    case 'tran': {
      const parts = ['.tran', analysis.timestep.toString(), analysis.stopTime.toString()];
      if (analysis.startTime !== undefined) parts.push(analysis.startTime.toString());
      if (analysis.maxTimestep !== undefined) parts.push(analysis.maxTimestep.toString());
      return parts.join(' ');
    }
    case 'ac':
      return `.ac ${analysis.variation} ${analysis.points} ${analysis.startFreq} ${analysis.stopFreq}`;
    case 'noise':
      return `.noise v(${analysis.outputNode}) ${analysis.inputSource} lin ${analysis.points} ${analysis.startFreq} ${analysis.stopFreq}`;
    case 'disto':
      throw new InvalidCircuitError('ngspice-wasm does not support .disto result mapping');
    case 'sp':
      throw new InvalidCircuitError('ngspice-wasm does not support .sp result mapping');
    case 'tf':
      return 'outputNode' in analysis
        ? `.tf v(${analysis.outputNode}${analysis.outputReferenceNode === undefined ? '' : `,${analysis.outputReferenceNode}`}) ${analysis.inputSource}`
        : `.tf i(${analysis.outputSource}) ${analysis.inputSource}`;
    case 'sens':
      throw new InvalidCircuitError('ngspice-wasm does not support .sens result mapping');
  }
}

function variableName(name: string): VariableName {
  const lower = name.toLowerCase();
  if (lower === 'time') return { kind: 'time', name: 'time' };
  if (lower === 'frequency') return { kind: 'frequency', name: 'frequency' };

  const voltage = name.match(/^v\((.+)\)$/i);
  if (voltage) return { kind: 'voltage', name: voltage[1] };

  const current = name.match(/^i\((.+)\)$/i);
  if (current) return { kind: 'current', name: current[1] };

  return { kind: 'other', name };
}

function canonical(name: string, candidates: string[]): string {
  return candidates.find(candidate => candidate.toLowerCase() === name.toLowerCase()) ?? name;
}

function asRealArray(data: NgspiceData): number[] {
  return data.values as number[];
}

function asComplexArray(data: NgspiceData): NgspiceComplex[] {
  return data.values as NgspiceComplex[];
}

function mapDCResult(raw: NgspiceResult, compiled: CompiledCircuit): DCResult {
  if (raw.dataType !== 'real') {
    throw new InvalidCircuitError('ngspice-wasm .op produced non-real data');
  }

  const voltages = new Map<string, number>();
  const currents = new Map<string, number>();
  for (const data of raw.data) {
    const parsed = variableName(data.name);
    if (parsed.kind === 'voltage') {
      voltages.set(canonical(parsed.name, compiled.nodeNames), asRealArray(data)[0]);
    } else if (parsed.kind === 'current') {
      currents.set(canonical(parsed.name, compiled.branchNames), asRealArray(data)[0]);
    }
  }
  return new DCResult(voltages, currents);
}

function mapDCSweepResult(
  raw: NgspiceResult,
  compiled: CompiledCircuit,
  _analysis: DCSweepAnalysis,
): DCSweepResult {
  if (raw.dataType !== 'real') {
    throw new InvalidCircuitError('ngspice-wasm .dc produced non-real data');
  }

  const sweepValues = Float64Array.from(asRealArray(raw.data[0]));
  const voltages = new Map<string, Float64Array>();
  const currents = new Map<string, Float64Array>();

  for (const data of raw.data.slice(1)) {
    const parsed = variableName(data.name);
    if (parsed.kind === 'voltage') {
      voltages.set(canonical(parsed.name, compiled.nodeNames), Float64Array.from(asRealArray(data)));
    } else if (parsed.kind === 'current') {
      currents.set(canonical(parsed.name, compiled.branchNames), Float64Array.from(asRealArray(data)));
    }
  }

  return new DCSweepResult(sweepValues, voltages, currents);
}

function mapTransientResult(
  raw: NgspiceResult,
  compiled: CompiledCircuit,
  _analysis: TransientAnalysis,
): TransientResult {
  if (raw.dataType !== 'real') {
    throw new InvalidCircuitError('ngspice-wasm .tran produced non-real data');
  }

  const timeVar = raw.data.find(data => variableName(data.name).kind === 'time');
  if (!timeVar) throw new InvalidCircuitError('ngspice-wasm .tran result has no time vector');

  const voltages = new Map<string, number[]>();
  const currents = new Map<string, number[]>();
  for (const data of raw.data) {
    const parsed = variableName(data.name);
    if (parsed.kind === 'voltage') {
      voltages.set(canonical(parsed.name, compiled.nodeNames), [...asRealArray(data)]);
    } else if (parsed.kind === 'current') {
      currents.set(canonical(parsed.name, compiled.branchNames), [...asRealArray(data)]);
    }
  }

  return new TransientResult([...asRealArray(timeVar)], voltages, currents);
}

function mapACResult(raw: NgspiceResult, compiled: CompiledCircuit): ACResult {
  if (raw.dataType !== 'complex') {
    throw new InvalidCircuitError('ngspice-wasm .ac produced non-complex data');
  }

  const freqVar = raw.data.find(data => variableName(data.name).kind === 'frequency');
  if (!freqVar) throw new InvalidCircuitError('ngspice-wasm .ac result has no frequency vector');

  const frequencies = asComplexArray(freqVar).map(value => value.real);
  const voltages = new Map<string, { magnitude: number; phase: number }[]>();
  const currents = new Map<string, { magnitude: number; phase: number }[]>();

  for (const data of raw.data) {
    const parsed = variableName(data.name);
    if (parsed.kind !== 'voltage' && parsed.kind !== 'current') continue;

    const mapped = asComplexArray(data).map(value => ({
      magnitude: Math.hypot(value.real, value.img),
      phase: Math.atan2(value.img, value.real) * 180 / Math.PI,
    }));

    if (parsed.kind === 'voltage') {
      voltages.set(canonical(parsed.name, compiled.nodeNames), mapped);
    } else {
      currents.set(canonical(parsed.name, compiled.branchNames), mapped);
    }
  }

  return new ACResult(frequencies, voltages, currents);
}
