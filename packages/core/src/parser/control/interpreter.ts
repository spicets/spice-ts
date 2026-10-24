import type { AnalysisDirective, TransientAnalysis } from '../../types.js';
import { squaredNoiseOutput, TransientResult, type MeasurementResult, type SensitivityEntry, type SimulationResult } from '../../results.js';
import { getMeasure2, type MeasurePlot } from '../../measure/measure2.js';
import { gettokWords } from '../../measure/dot-measure.js';
import { inpEvaluate } from '../../measure/numparse.js';
import { tokenizeNetlist } from '../tokenizer.js';
import { ControlScriptError, ControlScriptExitError, UnsupportedControlCommandError } from './errors.js';
import { CONTROL_ANALYSIS_COMMANDS, commandName, isExecutableCommand, type ControlScript, type ControlStatement } from './script.js';
import type { ControlSourceLine } from './source.js';
import { setArguments, splitWords, unquote } from './set-arguments.js';
import { validatePreSet } from './pre-set.js';
import {
  ExpressionError, UnsupportedExpressionFeature, evaluateVectorExpression, parseControlNumber, parseVectorExpression, splitVectorExpressions,
  type ExpressionEnvironment, type ExpressionNode,
} from './vector-expression.js';
import { complexDft, ngspiceFft, ngspiceLinearInterpolate, ngspicePsd, spectrumWindow } from './spectrum.js';
import { ngspiceFourier } from './fourier.js';
import { eventOutput } from './event-output.js';
import type { FourierResult } from '../../results.js';
import {
  complexVector, formatVector, isTrue, realVector, renamed, scalar, type ControlVector,
} from './vector.js';

/** One analysis the script ran, with the plot ngspice would have created for it. */
export interface ControlAnalysisRun {
  /** ngspice plot name, e.g. `tran1`, `dc3`, `noise2`. */
  plot: string;
  /** Analysis type (`op`, `dc`, `ac`, `tran`, `noise`, ...). */
  analysis: string;
  /** The result of that one analysis. */
  result: SimulationResult;
}

/** One solved analysis returned by the host. */
export interface ControlHostRun {
  directive: AnalysisDirective | { type: 'pz' };
  result: SimulationResult;
}

/**
 * What the interpreter needs from the simulator. Implemented in `simulate.ts`
 * against the deck's {@link Circuit}; every call that cannot be honoured throws
 * an {@link UnsupportedControlCommandError} itself.
 */
export interface ControlHost {
  inputDirectory?: string;
  writeFile?(path: string, contents: string): void;
  /** Solve one analysis given as the tokens of its dot card (`['.TRAN', '1n', '1u']`). */
  runAnalysis(dotCardTokens: string[], line: ControlSourceLine, saves: readonly string[]): ControlHostRun;
  /** Solve the deck's own dot-card analyses (ngspice `run`). */
  runDeck(line: ControlSourceLine, saves: readonly string[]): ControlHostRun[];
  /** `alter`: set an instance parameter (`undefined` = the device's primary value). */
  alterInstance(device: string, parameter: string | undefined, values: number[], line: ControlSourceLine): void;
  /** `altermod`: set a `.model` parameter. */
  alterModel(model: string, parameter: string, value: number, line: ControlSourceLine): void;
  alterParameter(subcircuit: string | undefined, name: string, expression: string, line: ControlSourceLine): void;
  reset(line: ControlSourceLine, newCircuit?: boolean): Readonly<Record<string, number>>;
  setSeed?(seed: number): void;
  random?(gaussian: boolean, complex: boolean): number;
  /** Remove the current circuit, selecting the previous one if any remains. */
  removeCircuit(): boolean;
  /** `@device[parameter]` / `@model[parameter]` input-parameter readout, or undefined when unavailable. */
  parameterVector(device: string, parameter: string): number[] | undefined;
  /** `option`/`set` of a simulator option: tokens as on a `.options` card. */
  setOptions(tokens: string[], line: ControlSourceLine): void;
}

export interface ControlScriptOutcome {
  files: { path: string; contents: string }[];
  /** Analyses in execution order. */
  runs: ControlAnalysisRun[];
  /** Lines printed by `echo`. */
  output: string[];
  /** True when the script ended with `quit`/`exit` (status 0): ngspice then skips the deck's own run. */
  quit: boolean;
  /** The current circuit was removed and has not been reloaded with mc_source. */
  circuitRemoved: boolean;
  /** Final front-end noise-output mode, also used by the deck's implicit batch run. */
  squaredNoise: boolean;
  /** Every `meas` command the script ran, in order; ngspice prints a failed one and continues. */
  measurements: MeasurementResult[];
  /** Non-fatal warnings ngspice-47 prints while running the script (batch-mode `edit`). */
  warnings: string[];
  fourier: FourierResult[];
}

interface Plot {
  sp?: { ports: number; impedance: number };
  name: string;
  title: string;
  vectors: Map<string, ControlVector>;
  scale?: ControlVector;
  /** `save @device[param]` requests active when the plot was made: vectors spice-ts does not produce. */
  unproducedSaves: ReadonlySet<string>;
}

type VariableValue = string | string[] | true;

type Flow = 'next' | 'break' | 'continue' | { target: string; line: ControlSourceLine };

/** ngspice-47's batch-mode `edit` message ("Warning: " prefix dropped). */
const EDIT_DISABLED_WARNING = "`edit' is disabled because 'interactive' has not been set";

class QuitSignal {
  constructor(readonly status: number, readonly line: ControlSourceLine) {}
}

const MAX_LOOP_ITERATIONS = 1_000_000;

/**
 * `set` variables that ngspice forwards to the simulator as circuit options.
 * `savecurrents` is not one (ngspice-47 cktsopt.c has no such option): only the
 * deck's `.option` cards are read for it, before the circuit is loaded
 * (inp.c inp_savecurrents), so in `.control` it is a plain front-end variable.
 */
const OPTION_VARIABLES = new Set([
  'temp', 'tnom', 'gmin', 'reltol', 'abstol', 'vntol', 'trtol', 'chgtol', 'pivtol', 'pivrel',
  'itl1', 'itl2', 'itl3', 'itl4', 'itl5', 'itl6', 'srcsteps', 'gminsteps', 'gminfactor', 'method', 'maxord',
  'noinit', 'noopiter', 'keepopinfo', 'rshunt', 'cshunt', 'xmu', 'bypass', 'defl', 'defw', 'defad', 'defas',
  'ramptime', 'seed',
]);

/** Front-end variables that change computed vectors in ways spice-ts does not reproduce. */
const RESULT_AFFECTING_VARIABLES: Record<string, string> = {
  ngbehavior: 'compatibility modes change netlist interpretation',
  nobjthack: 'the BJT three-terminal hack is not implemented',
  notrnoise: 'transient noise switching is not implemented',
  rndseed: 'random-number seeding is not implemented',
  xtrtol: 'XSPICE truncation tolerance is not implemented',
  nosubckt: 'disabling subcircuit expansion is not implemented',
  dpolydegree: 'polynomial interpolation settings are not implemented',
  polysteps: 'polynomial interpolation settings are not implemented',
  interp: 'raw-file interpolation is not implemented',
  strict_errorhandling: 'ngspice error-handling modes are not implemented',
};

/** ngspice `const` plot. */
function constantPlot(): Plot {
  const values: [string, number][] = [
    ['pi', Math.PI], ['e', Math.E], ['c', 299792458], ['kelvin', -273.15], ['echarge', 1.60219e-19],
    ['boltz', 1.38062e-23], ['planck', 6.62607e-34], ['yes', 1], ['no', 0], ['true', 1], ['false', 0],
  ];
  const vectors = new Map(values.map(([name, value]) => [name, scalar(value, name)]));
  vectors.set('i', complexVector('i', [0], [1]));
  return { name: 'const', title: 'Constant values', vectors, unproducedSaves: new Set() };
}

/**
 * Execute an ngspice `.control` script.
 *
 * Plots, vectors, variables and `define`d functions follow ngspice-47's front
 * end: analyses create plots named `<type><n>` (n from one counter, bumped only
 * on a name clash), unqualified names resolve in the current plot then in
 * `const`, and `plot.vector` reaches any plot. Errors stop the script with a
 * {@link ControlScriptError}; unsupported forms with an
 * {@link UnsupportedControlCommandError}.
 */
export function runControlScript(script: ControlScript, host: ControlHost): ControlScriptOutcome {
  return new ControlInterpreter(host).run(script);
}

class ControlInterpreter {
  private circuitRemoved = false;
  private preLoading = true;
  private readonly plots: Plot[] = [constantPlot()];
  private current: Plot = this.plots[0];
  private plotNumber = 1;
  private readonly variables = new Map<string, VariableValue>([['batchmode', true]]);
  private readonly functions = new Map<string, { params: string[]; body: ExpressionNode }>();
  private readonly savedDeviceVectors = new Set<string>();
  private readonly runs: ControlAnalysisRun[] = [];
  private readonly output: string[] = [];
  private readonly files: { path: string; contents: string }[] = [];
  private readonly measurements: MeasurementResult[] = [];
  private readonly warnings: string[] = [];
  private readonly fourierResults: FourierResult[] = [];
  private fourierCount = 0;
  private gotoIterations = 0;
  /** inpcom.c `replaceno`: numbers the `vexprint<n>` vectors of `meas` operands. */
  private measureExpressionCount = 1;
  /**
   * The `.tran` job of the circuit's current task (ngspice `ci_curTask`), read
   * by `linearize` (spiceif.c if_tranparams): the last `tran` command, or the
   * deck's `.tran` card after `run`; undefined after any other analysis.
   */
  private transientTask: TransientAnalysis | undefined;

  constructor(private readonly host: ControlHost) {
    if (host.inputDirectory !== undefined) this.variables.set('inputdir', host.inputDirectory);
  }

  run(script: ControlScript): ControlScriptOutcome {
    try {
      for (const line of script.preSet ?? []) {
        const name = commandName(line.text).slice(4);
        if (name === 'set') {
          const expanded = { ...line, text: this.substitute(line.text, line) };
          // Substitution must not smuggle a loading option through the allowlist.
          validatePreSet(expanded);
          this.set(expanded.text.slice('pre_set'.length).trim(), line, true);
        } else {
          this.command(name, { ...line, text: line.text.slice(4) });
        }
      }
      this.preLoading = false;
      for (const [name, value] of Object.entries(script.constants ?? {})) {
        this.plots[0].vectors.set(name, scalar(value, name));
      }
      const flow = this.block(script.statements);
      if (typeof flow === 'object') {
        throw new ControlScriptError(`label ${flow.target} not found`, flow.line.lineNumber, flow.line.text);
      }
    } catch (signal) {
      if (!(signal instanceof QuitSignal)) throw signal;
      if (signal.status !== 0) throw new ControlScriptExitError(signal.status, signal.line.lineNumber, this.output);
      return { files: this.files, runs: this.runs, output: this.output, quit: true, circuitRemoved: this.circuitRemoved, squaredNoise: this.variables.has('sqrnoise'), measurements: this.measurements, warnings: this.warnings, fourier: this.fourierResults };
    }
    return { files: this.files, runs: this.runs, output: this.output, quit: false, circuitRemoved: this.circuitRemoved, squaredNoise: this.variables.has('sqrnoise'), measurements: this.measurements, warnings: this.warnings, fourier: this.fourierResults };
  }

  // -------------------------------------------------------------------------
  // Statements

  private block(statements: ControlStatement[]): Flow {
    // ngspice-47 src/frontend/control.c findlabel/doblock: search siblings
    // first, then propagate outward. Never search children or an else branch.
    for (let index = 0; index < statements.length; index++) {
      const flow = this.statement(statements[index]);
      if (typeof flow === 'object') {
        const target = statements.findIndex(statement => statement.kind === 'label'
          && splitWords(statement.target)[0] === flow.target);
        if (target < 0) return flow;
        index = target;
        continue;
      }
      if (flow !== 'next') return flow;
    }
    return 'next';
  }

  private statement(statement: ControlStatement): Flow {
    switch (statement.kind) {
      case 'label':
        if (!splitWords(statement.target)[0]) {
          throw new ControlScriptError('missing label', statement.line.lineNumber, statement.line.text);
        }
        return 'next';
      case 'goto': {
        const target = splitWords(this.substitute(statement.target, statement.line))[0];
        if (!target) throw new ControlScriptError('missing label', statement.line.lineNumber, statement.line.text);
        this.countIteration(++this.gotoIterations, statement.line);
        return { target, line: statement.line };
      }
      case 'command':
        this.command(statement.name, statement.line);
        return 'next';
      case 'break':
      case 'continue':
        return statement.kind;
      case 'if':
        return this.block(this.condition(statement.condition, statement.line) ? statement.then : statement.otherwise);
      case 'while':
      case 'dowhile': {
        let iterations = 0;
        let first = statement.kind === 'dowhile';
        while (first || this.condition(statement.condition, statement.line)) {
          first = false;
          this.countIteration(++iterations, statement.line);
          const flow = this.block(statement.body);
          if (typeof flow === 'object') return flow;
          if (flow === 'break') break;
        }
        return 'next';
      }
      case 'repeat': {
        const text = this.substitute(statement.count, statement.line).trim();
        if (text === '') {
          throw new UnsupportedControlCommandError(
            'repeat', 'an unbounded repeat loop is not executed', statement.line.lineNumber, statement.line.text,
          );
        }
        const count = this.evaluate(text, statement.line).re[0];
        for (let iteration = 0; iteration < count; iteration++) {
          this.countIteration(iteration + 1, statement.line);
          const flow = this.block(statement.body);
          if (typeof flow === 'object') return flow;
          if (flow === 'break') break;
        }
        return 'next';
      }
      case 'foreach': {
        const values = splitWords(this.substitute(statement.values, statement.line)).map(unquote);
        for (const value of values) {
          this.variables.set(statement.variable.toLowerCase(), value);
          const flow = this.block(statement.body);
          if (typeof flow === 'object') return flow;
          if (flow === 'break') break;
        }
        return 'next';
      }
    }
  }

  private countIteration(iteration: number, line: ControlSourceLine): void {
    if (iteration > MAX_LOOP_ITERATIONS) {
      throw new ControlScriptError(`loop exceeded ${MAX_LOOP_ITERATIONS} iterations`, line.lineNumber, line.text);
    }
  }

  private condition(text: string, line: ControlSourceLine): boolean {
    // ngspice frontend/control.c diagnoses a missing if; cpitf.c:cp_istrue
    // returns false when substitution/parsing/evaluation produces no vector.
    if (text.trim() === '') {
      this.warnings.push('Error: missing if condition.');
      return false;
    }
    try {
      const substituted = this.substitute(text, line).trim();
      if (substituted === '') return false;
      // Condition-only convenience spelling requested in #1455. ngspice-47 uses
      // not/~, not !; keep let/define expressions strict and preserve != tokens.
      const expression = substituted.replace(/!(?!=)/g, '~');
      return isTrue(this.evaluate(expression, line));
    } catch (error) {
      // Recover only supported-language errors, not unsupported features or bugs.
      if (!(error instanceof ControlScriptError)) throw error;
      this.warnings.push(error.message);
      return false;
    }
  }

  private command(name: string, line: ControlSourceLine): void {
    if (!isExecutableCommand(name)) {
      this.warnings.push(`${name}: no such command available in ngspice`);
      return;
    }
    const text = this.substitute(line.text, line);
    const rest = text.slice(/^\s*[^\s=(]*/.exec(text)![0].length).trim();
    // ngspice keeps plots and the retained source after remcirc. Only
    // mc_source recreates a circuit; reset/alterparam require a loaded one.
    if (this.circuitRemoved) {
      if (name === 'reset' || name === 'alterparam' || name === 'remcirc') {
        this.warnings.push(`No circuit loaded. Command '${name}' ignored.`);
        return;
      }
      if (CONTROL_ANALYSIS_COMMANDS.has(name) || ['run', 'alter', 'altermod'].includes(name)) {
        throw new ControlScriptError(`${name}: no circuit loaded`, line.lineNumber, line.text);
      }
    }
    switch (name) {
      case 'remcirc':
        if (rest !== '') throw new UnsupportedControlCommandError('remcirc', 'removing a named circuit is not implemented', line.lineNumber, line.text);
        this.circuitRemoved = !this.host.removeCircuit();
        this.transientTask = undefined;
        return;
      case 'op': case 'dc': case 'ac': case 'tran': case 'noise': case 'sp': case 'sens': case 'pz': {
        const tokens = tokenizeNetlist(text)[0]?.tokens ?? [];
        const run = this.host.runAnalysis([`.${name.toUpperCase()}`, ...tokens.slice(1)], line, [...this.savedDeviceVectors]);
        this.recordRun(run);
        this.transientTask = run.directive.type === 'tran' ? run.directive : undefined;
        return;
      }
      case 'run':
        if (rest !== '') {
          throw new UnsupportedControlCommandError('run', 'writing a raw file from run is not supported', line.lineNumber, line.text);
        }
        {
          const runs = this.host.runDeck(line, [...this.savedDeviceVectors]);
          for (const run of runs) this.recordRun(run);
          this.transientTask = runs.map(run => run.directive).find(
            (directive): directive is TransientAnalysis => directive.type === 'tran',
          );
        }
        return;
      case 'let': return this.let(rest, line);
      case 'reshape': return this.reshape(rest, line);
      case 'transpose': return this.transpose(rest, line);
      case 'unlet':
        for (const word of splitWords(rest)) this.current.vectors.delete(word.toLowerCase());
        return;
      case 'set': return this.set(rest, line);
      case 'unset':
        for (const word of splitWords(rest)) this.variables.delete(word.toLowerCase());
        return;
      case 'define': return this.define(rest, line);
      case 'undefine':
        for (const word of splitWords(rest)) {
          for (const key of [...this.functions.keys()]) if (key.startsWith(`${word.toLowerCase()}/`)) this.functions.delete(key);
        }
        return;
      case 'alter': return this.alter(rest, line);
      case 'altermod': return this.altermod(rest, line);
      case 'alterparam': {
        const match = /^(?:(\S+)\s+)?([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(rest);
        if (!match) throw new ControlScriptError('alterparam needs [subcircuit] name = expression', line.lineNumber, line.text);
        this.host.alterParameter(match[1], match[2], match[3], line);
        return;
      }
      case 'setseed': {
        if (!/^\d+$/.test(rest) || !Number.isSafeInteger(Number(rest)) || Number(rest) <= 0 || Number(rest) > 0x7fffffff) {
          throw new ControlScriptError('setseed requires one integer in [1, 2147483647]', line.lineNumber, line.text);
        }
        if (!this.host.setSeed) throw new UnsupportedControlCommandError('setseed', 'no retained parameter RNG', line.lineNumber, line.text);
        this.host.setSeed(Number(rest));
        return;
      }
      case 'reset':
      case 'mc_source':
        // ngspice-47 com_mc_source ignores arguments and loads another circuit
        // from the retained deck without re-entering its .control block.
        if (name === 'reset' && rest !== '') throw new ControlScriptError('reset takes no arguments', line.lineNumber, line.text);
        for (const [key, value] of Object.entries(this.host.reset(line, name === 'mc_source'))) {
          this.plots[0].vectors.set(key, scalar(value, key));
        }
        this.circuitRemoved = false;
        this.transientTask = undefined;
        return;
      case 'option':
      case 'options':
        if (rest !== '') this.host.setOptions(splitWords(rest).map(unquote), line);
        return;
      case 'setplot': return this.setplot(rest);
      case 'destroy': return this.destroy(rest);
      case 'remzerovec':
        // ngspice-47 frontend/postcoms.c:77-92 (com_remzerovec) marks only
        // current-plot zero-length vectors for vec_gc; arguments are ignored.
        for (const [name, vector] of this.current.vectors) {
          if (vector.re.length === 0) this.current.vectors.delete(name);
        }
        return;
      case 'compose': return this.compose(rest, line);
      case 'strcmp': return this.strcmp(rest, line);
      case 'meas': return this.meas(rest, line);
      case 'linearize': return this.linearize(rest, line);
      case 'cutout': return this.cutout(rest);
      case 'fft': return this.spectrum('fft', rest, line);
      case 'psd': return this.spectrum('psd', rest, line);
      case 'fourier': return this.fourier(rest, line);
      case 'wrs2p': return this.wrs2p(rest, line);
      case 'write': return this.writeRaw(rest, line);
      case 'eprint': case 'edisplay':
        this.output.push(...eventOutput(name, rest, this.runs, line));
        return;
      case 'setscale': {
        if (rest === '') return;
        this.current.scale = this.vector(rest, line);
        return;
      }
      case 'echo':
        this.output.push(withoutRedirection(splitWords(rest)).map(unquote).join(' '));
        return;
      case 'edit':
        // ngspice-47 batch mode: edit only opens an editor once `interactive` is set.
        if (this.variables.has('interactive')) {
          throw new UnsupportedControlCommandError(
            'edit', 'the interactive netlist editor is not available', line.lineNumber, line.text,
          );
        }
        this.warnings.push(EDIT_DISABLED_WARNING);
        return;
      case 'save':
        for (const word of splitWords(rest)) if (word.startsWith('@')) this.savedDeviceVectors.add(word.toLowerCase());
        return;
      case 'quit':
      case 'exit': {
        const status = rest === '' ? 0 : parseControlNumber(rest);
        if (status === undefined) throw new ControlScriptError(`invalid exit status '${rest}'`, line.lineNumber, line.text);
        throw new QuitSignal(status, line);
      }
      default:
        // Output-only commands (print, plot, write, wrdata, settype, rusage, ...).
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Commands

  /** Export constructed vectors as ASCII raw without launching any external process. */
  private writeRaw(rest: string, line: ControlSourceLine): void {
    const [path, ...names] = splitWords(rest).map(unquote);
    if (!path) throw new ControlScriptError('write needs an output filename', line.lineNumber, line.text);
    const selected = names.length === 0 || names[0].toLowerCase() === 'all'
      ? [...this.current.vectors.values()].filter(vector => vector !== this.current.scale)
      : names.map(name => renamed(this.evaluate(name, line), name));
    const scale = this.current.scale ?? selected[0];
    if (!scale) throw new ControlScriptError('write needs writable vectors', line.lineNumber, line.text);
    const vectors = [scale, ...selected.filter(vector => vector !== scale)];
    if (vectors.some(vector => vector.re.length !== scale.re.length)) {
      throw new ControlScriptError('write needs vectors with matching scale lengths', line.lineNumber, line.text);
    }
    const complex = vectors.some(vector => vector.im);
    const lines = [
      `Title: ${this.current.title}`, `Plotname: ${this.current.name}`,
      `Flags: ${complex ? 'complex' : 'real'}`, `No. Variables: ${vectors.length}`,
      `No. Points: ${scale.re.length}`, 'Variables:',
      ...vectors.map((vector, index) => `\t${index}\t${vector.name}\tnotype`), 'Values:',
    ];
    for (let sample = 0; sample < scale.re.length; sample++) {
      for (let index = 0; index < vectors.length; index++) {
        const vector = vectors[index];
        lines.push(`${index === 0 ? sample : ''}\t${vector.re[sample]}${complex ? `,${vector.im?.[sample] ?? 0}` : ''}`);
      }
    }
    const file = { path, contents: `${lines.join('\n')}\n` };
    try {
      this.host.writeFile?.(path, file.contents);
    } catch (error) {
      throw new ControlScriptError(`write: ${error instanceof Error ? error.message : String(error)}`, line.lineNumber, line.text);
    }
    this.files.push(file);
  }

  private wrs2p(rest: string, line: ControlSourceLine): void {
    const words = splitWords(rest).map(unquote);
    if (words.length !== 1 || !words[0]) {
      throw new ControlScriptError('wrs2p needs one output filename', line.lineNumber, line.text);
    }
    const plot = this.current;
    // ngspice also accepts S vectors synthesized by AC measurements (s-param.cir).
    if ((plot.sp && plot.sp.ports !== 2) || plot.scale?.name !== 'frequency') {
      throw new ControlScriptError('wrs2p needs a current two-port sp plot', line.lineNumber, line.text);
    }
    const vectors = ['s_1_1', 's_2_1', 's_1_2', 's_2_2'].map(name => plot.vectors.get(name));
    if (vectors.some(vector => !vector?.im || vector.re.length !== plot.scale!.re.length || vector.im.length !== plot.scale!.re.length)) {
      throw new ControlScriptError('wrs2p needs complete complex S-parameter vectors', line.lineNumber, line.text);
    }
    // ngspice-47 com_wrs2p uses %e (six digits after the decimal) in RI order.
    const number = (value: number): string => value.toExponential(6).replace(/e([+-])(\d)$/, 'e$10$2');
    const lines = [
      '!2-port S-parameter file', '!Generated by spice-ts',
      `# Hz S RI R ${plot.vectors.get('rbase')?.re[0] ?? plot.sp?.impedance ?? 50}`,
      '!freq ReS11 ImS11 ReS21 ImS21 ReS12 ImS12 ReS22 ImS22',
      ...Array.from(plot.scale.re, (frequency, index) => [frequency, ...vectors.flatMap(vector => [vector!.re[index], vector!.im![index]])].map(number).join(' ')),
    ];
    const file = { path: words[0], contents: `${lines.join('\n')}\n` };
    try {
      this.host.writeFile?.(file.path, file.contents);
    } catch (error) {
      throw new ControlScriptError(`wrs2p: ${error instanceof Error ? error.message : String(error)}`, line.lineNumber, line.text);
    }
    this.files.push(file);
  }

  private let(rest: string, line: ControlSourceLine): void {
    const equals = assignmentIndex(rest);
    if (equals < 0) {
      throw new UnsupportedControlCommandError('let', 'let without an assignment (vector listing) is not supported', line.lineNumber, line.text);
    }
    const target = rest.slice(0, equals).trim();
    const expression = rest.slice(equals + 1).trim();
    rejectRedirection('let', expression, line);
    const value = this.evaluate(expression, line);
    const element = /^([^\s[\]]+)\s*(\[.+\])$/.exec(target);
    if (element) {
      const name = element[1].toLowerCase();
      const plot = this.assignmentPlot(name);
      const existing = plot.vectors.get(name);
      if (!existing) throw new ControlScriptError(`no such vector '${element[1]}' to index`, line.lineNumber, line.text);
      let tree = this.parse(target, line);
      const indices: ExpressionNode[] = [];
      while (tree.kind === 'index') {
        indices.unshift(tree.index);
        tree = tree.target;
      }
      const dims = existing.dims ?? [existing.re.length];
      let offset = 0;
      let count = existing.re.length;
      for (const [axis, expression] of indices.entries()) {
        let selected: ControlVector;
        try { selected = evaluateVectorExpression(expression, this.environment()); } catch (error) {
          throw this.wrap(error, line);
        }
        const index = Math.trunc(selected.re[0]);
        if (selected.im || selected.re.length !== 1 || !Number.isFinite(index) || axis >= dims.length || index < 0 || index >= dims[axis]) {
          throw new ControlScriptError(`index ${index} out of range for vector '${element[1]}'`, line.lineNumber, line.text);
        }
        count /= dims[axis];
        offset += index * count;
      }
      if (value.re.length !== count) {
        throw new ControlScriptError(`indexed assignment needs exactly ${count} elements, got ${value.re.length}`, line.lineNumber, line.text);
      }
      const updated = renamed(existing, name);
      updated.re.set(value.re, offset);
      if (value.im || updated.im) {
        updated.im ??= new Float64Array(updated.re.length);
        updated.im.set(value.im ?? new Float64Array(count), offset);
      }
      plot.vectors.set(name, updated);
      return;
    }
    // ngspice let names are not expression identifiers: punctuation (including
    // v(/22), v(+22), and quoted-expression names with spaces) is legal.
    // '[' belongs to indexed assignment; '@', numeric prefixes and all are reserved.
    if (!target || /^\d/.test(target) || /[@[]/.test(target) || target.toLowerCase() === 'all') {
      throw new ControlScriptError(`invalid vector name '${target}'`, line.lineNumber, line.text);
    }
    this.assignmentPlot(target.toLowerCase()).vectors.set(target.toLowerCase(), renamed(value, target));
  }

  /**
   * Plot a `let` writes to: the plot where the name already resolves (current
   * plot, then `const`), else the current plot. ngspice updates a `const`
   * vector in place even while an analysis plot is current.
   */
  private assignmentPlot(name: string): Plot {
    if (this.current.vectors.has(name)) return this.current;
    if (this.plots[0].vectors.has(name)) return this.plots[0];
    return this.current;
  }

  private reshape(rest: string, line: ControlSourceLine): void {
    const match = /^(.*?)\s+(\[.*\])$/.exec(rest);
    const shape = match?.[2];
    if (!match || !shape || !/^(?:\[\s*\d+\s*\]\s*)+$/.test(shape)) {
      throw new ControlScriptError('reshape needs vector names and positive integer dimensions', line.lineNumber, line.text);
    }
    const dims = Array.from(shape.matchAll(/\[\s*(\d+)\s*\]/g), part => Number(part[1]));
    const size = dims.reduce((a, b) => a * b, 1);
    if (dims.length > 8 || dims.some(dim => !Number.isSafeInteger(dim) || dim <= 0) || !Number.isSafeInteger(size)) {
      throw new ControlScriptError('reshape dimensions must be positive integers (at most 8 axes)', line.lineNumber, line.text);
    }
    for (const name of splitWords(match[1])) {
      const vector = this.vector(name, line);
      if (vector.re.length !== size) {
        throw new ControlScriptError(`reshape dimensions do not fit '${name}' (total size = ${vector.re.length})`, line.lineNumber, line.text);
      }
      vector.dims = [...dims];
    }
  }

  private transpose(rest: string, line: ControlSourceLine): void {
    if (!rest) throw new ControlScriptError('transpose needs vector names', line.lineNumber, line.text);
    for (const name of splitWords(rest)) {
      const vector = this.vector(name, line);
      const dims = vector.dims;
      if (!dims || dims.length < 2) continue;
      const rows = dims[dims.length - 2];
      const columns = dims[dims.length - 1];
      const block = rows * columns;
      const reorder = (values: Float64Array): Float64Array => {
        const result = new Float64Array(values.length);
        for (let base = 0; base < values.length; base += block) {
          for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
              result[base + column * rows + row] = values[base + row * columns + column];
            }
          }
        }
        return result;
      };
      vector.re = reorder(vector.re);
      if (vector.im) vector.im = reorder(vector.im);
      vector.dims = [...dims.slice(0, -2), columns, rows];
    }
  }

  private set(rest: string, line: ControlSourceLine, preSet = false): void {
    for (const { name, rawValue } of setArguments(rest, line)) {
      const reason = RESULT_AFFECTING_VARIABLES[name];
      if (reason !== undefined && !(preSet && name === 'strict_errorhandling')) {
        throw new UnsupportedControlCommandError('set', `variable '${name}': ${reason}`, line.lineNumber, line.text);
      }
      if (OPTION_VARIABLES.has(name)) {
        this.host.setOptions([rawValue === undefined ? name : `${name}=${unquote(rawValue)}`], line);
        continue;
      }
      if (name === 'curplot') {
        const target = rawValue === undefined ? '' : unquote(rawValue);
        this.setplot(target);
        continue;
      }
      if (name === 'curplottitle') {
        this.current.title = rawValue === undefined ? '' : unquote(rawValue);
        continue;
      }
      if (rawValue === undefined) {
        this.variables.set(name, true);
      } else if (rawValue.startsWith('(') && rawValue.endsWith(')')) {
        this.variables.set(name, splitWords(rawValue.slice(1, -1)).map(unquote));
      } else {
        this.variables.set(name, unquote(rawValue));
      }
    }
  }

  private define(rest: string, line: ControlSourceLine): void {
    const match = /^([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(.+)$/.exec(rest);
    if (!match) {
      throw new UnsupportedControlCommandError('define', 'only define name(args) expression is supported', line.lineNumber, line.text);
    }
    rejectRedirection('define', match[3], line);
    const params = match[2].split(',').map(param => param.trim()).filter(Boolean);
    this.functions.set(`${match[1].toLowerCase()}/${params.length}`, { params, body: this.parse(match[3], line) });
  }

  private alter(rest: string, line: ControlSourceLine): void {
    const { target, parameter, valueText } = this.splitAlter('alter', rest, line);
    this.host.alterInstance(target, parameter, this.alterValues(valueText, line), line);
  }

  private altermod(rest: string, line: ControlSourceLine): void {
    const { target, parameter, valueText } = this.splitAlter('altermod', rest, line);
    if (parameter === undefined) {
      throw new UnsupportedControlCommandError('altermod', 'altermod needs a model parameter (altermod model param = value)', line.lineNumber, line.text);
    }
    const values = this.alterValues(valueText, line);
    if (values.length !== 1) {
      throw new ControlScriptError('altermod needs a single value', line.lineNumber, line.text);
    }
    this.host.alterModel(target, parameter, values[0], line);
  }

  private splitAlter(command: string, rest: string, line: ControlSourceLine): { target: string; parameter?: string; valueText: string } {
    const bracket = /^@([^\s[]+)\[([^\]]+)\]\s*=?\s*(.+)$/.exec(rest);
    if (bracket) return { target: bracket[1], parameter: bracket[2], valueText: bracket[3] };
    const equals = rest.indexOf('=');
    if (equals >= 0) {
      const left = rest.slice(0, equals).trim().split(/\s+/);
      const valueText = rest.slice(equals + 1).trim();
      if (left.length === 1 && left[0] !== '') return { target: left[0], valueText };
      if (left.length === 2) return { target: left[0], parameter: left[1], valueText };
    } else {
      const words = rest.split(/\s+/);
      if (words.length === 2) return { target: words[0], valueText: words[1] };
      if (words.length === 3) return { target: words[0], parameter: words[1], valueText: words[2] };
    }
    throw new UnsupportedControlCommandError(command, `unsupported ${command} form`, line.lineNumber, line.text);
  }

  private alterValues(valueText: string, line: ControlSourceLine): number[] {
    const trimmed = valueText.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return splitWords(trimmed.slice(1, -1)).map(word => {
        const value = parseControlNumber(word);
        if (value === undefined) throw new ControlScriptError(`invalid number '${word}' in value list`, line.lineNumber, line.text);
        return value;
      });
    }
    const vector = this.evaluate(trimmed, line);
    if (vector.im && vector.im.some(value => value !== 0)) {
      throw new ControlScriptError('alter needs a real value', line.lineNumber, line.text);
    }
    return Array.from(vector.re);
  }

  /**
   * ngspice-47 plot_setcur (frontend/vectors.c). `this.plots` is in creation
   * order, the reverse of ngspice's plot_list, so `previous` (pl_next, older)
   * is one index down and `next` (newer) one index up. A failed selection
   * prints ngspice's message, keeps the current plot and the script goes on.
   */
  private setplot(rest: string): void {
    const name = rest.trim().toLowerCase();
    if (name === '') return;
    if (name === 'new') {
      this.current = this.newPlot('unknown', 'anonymous', undefined);
      return;
    }
    if (name === 'previous' || name === 'next') {
      const index = this.plots.indexOf(this.current) + (name === 'previous' ? -1 : 1);
      const plot = this.plots[index];
      if (index >= 0 && plot) this.current = plot;
      else this.warnings.push(`No ${name} plot is available. Plot remains unchanged (${this.current.name})`);
      return;
    }
    // get_plot: the newest plot whose type name `name` prefixes (plot_prefix).
    const plot = [...this.plots].reverse().find(candidate => plotPrefix(name, candidate.name));
    if (!plot) {
      this.warnings.push(`no such plot named ${rest.trim()}`);
      return;
    }
    this.current = plot;
  }

  /** ngspice-47 com_destroy (frontend/postcoms.c): a missing plot is reported, the rest destroyed. */
  private destroy(rest: string): void {
    const names = splitWords(rest).map(word => word.toLowerCase());
    const doomed: Plot[] = [];
    if (names.length === 0) doomed.push(this.current);
    else if (names[0] === 'all') doomed.push(...this.plots.filter(plot => plot.name !== 'const'));
    else {
      for (const name of names) {
        const plot = this.plots.find(candidate => candidate.name === name && !doomed.includes(candidate));
        if (plot) doomed.push(plot);
        else this.warnings.push(`no such plot ${name}`);
      }
    }
    for (const plot of doomed) {
      if (plot.name === 'const') continue;
      this.plots.splice(this.plots.indexOf(plot), 1);
    }
    if (!this.plots.includes(this.current)) this.current = this.plots.at(-1)!;
  }

  private compose(rest: string, line: ControlSourceLine): void {
    const [target, ...words] = splitWords(rest.replace(/\s*=\s*/g, '='));
    if (!target) throw new ControlScriptError('compose needs a vector name', line.lineNumber, line.text);
    if (words[0]?.toLowerCase() === 'values') {
      const values = words.slice(1).map(word => this.evaluate(word, line));
      const complex = values.some(value => value.im !== undefined);
      const re = values.map(value => value.re[0]);
      const vector = complex
        ? complexVector(target, re, values.map(value => (value.im ? value.im[0] : 0)))
        : realVector(target, re);
      this.current.vectors.set(target.toLowerCase(), vector);
      return;
    }
    const params = new Map<string, number>();
    for (const word of words) {
      const [key, value] = word.split('=');
      if (value === undefined || !['start', 'stop', 'step', 'lin', 'len'].includes(key.toLowerCase())) {
        throw new UnsupportedControlCommandError('compose', `compose parameter '${word}' is not supported`, line.lineNumber, line.text);
      }
      params.set(key.toLowerCase() === 'len' ? 'lin' : key.toLowerCase(), this.evaluate(value, line).re[0]);
    }
    const start = params.get('start');
    const stop = params.get('stop');
    const step = params.get('step');
    const count = params.get('lin');
    let values: number[];
    if (start !== undefined && step !== undefined && count !== undefined && stop === undefined) {
      values = Array.from({ length: Math.trunc(count) }, (_, index) => start + index * step);
    } else if (start !== undefined && stop !== undefined && count !== undefined && step === undefined) {
      const points = Math.trunc(count);
      values = Array.from({ length: points }, (_, index) =>
        (points === 1 ? start : start + (index * (stop - start)) / (points - 1)));
    } else if (start !== undefined && stop !== undefined && step !== undefined && count === undefined) {
      if (step === 0) throw new ControlScriptError('compose step must be non-zero', line.lineNumber, line.text);
      const points = Math.trunc(Math.abs((stop - start) / step) + 1.5);
      values = Array.from({ length: points }, (_, index) => start + index * step);
    } else {
      throw new UnsupportedControlCommandError('compose', 'this compose parameter combination is not supported', line.lineNumber, line.text);
    }
    this.current.vectors.set(target.toLowerCase(), realVector(target, values));
  }

  private strcmp(rest: string, line: ControlSourceLine): void {
    const words = splitWords(rest).map(unquote);
    if (words.length !== 3) throw new ControlScriptError('strcmp needs a variable and two strings', line.lineNumber, line.text);
    const [name, left, right] = words;
    this.variables.set(name.toLowerCase(), String(left < right ? -1 : left > right ? 1 : 0));
  }

  /**
   * `meas`: ngspice-47 com_meas() (frontend/measure.c) after inpcom.c's
   * inp_meas_control() rewrite, which moves every `=` operand with an
   * arithmetic character into a temporary vector (`let vexprint<n> = operand`
   * before the command, `unlet` after). A failed measurement is recorded, not
   * thrown: ngspice prints it and runs on.
   */
  private meas(rest: string, line: ControlSourceLine): void {
    // ngspice reads the deck lower-cased and inpcom.c inp_remove_excess_ws drops the blanks around `=`.
    let text = rest.replace(/\s*=\s*/g, '=').toLowerCase();
    const temporaries: { plot: Plot; name: string }[] = [];
    let search = 0;
    for (let equals = findAssignment(text, search); equals >= 0; equals = findAssignment(text, search)) {
      const { token, end } = gettokAt(text, equals + 1);
      if (!/[+\-*/()<>?:|&^!%\\]/.test(token)) {
        search = end;
        continue;
      }
      search = equals + 1;
      const name = `vexprint${this.measureExpressionCount++}`;
      try {
        const plot = this.assignmentPlot(name);
        plot.vectors.set(name, renamed(this.evaluate(token, line), name));
        temporaries.push({ plot, name });
      } catch (error) {
        // ngspice prints the failed `let` and the measurement then misses the vector.
        if (!(error instanceof ControlScriptError)) throw error;
      }
      text = `${text.slice(0, equals)}=${name} ${text.slice(end)}`;
    }
    try {
      const result = this.measure(text.trim().split(/\s+/).filter(Boolean), line);
      if (result) this.measurements.push(result);
    } finally {
      for (const { plot, name } of temporaries) plot.vectors.delete(name);
    }
  }

  /** com_meas body: replace `=<single-valued vector>` by its value, measure, `let` the result. */
  private measure(words: string[], line: ControlSourceLine): MeasurementResult | undefined {
    if (words.length === 0) return undefined; // `meas` alone lists the vectors (com_display).
    const failed = (error: string): MeasurementResult => ({
      name: (words[1] ?? '').toLowerCase(), analysis: words[0].toLowerCase(), function: (words[2] ?? '').toLowerCase(),
      line: line.lineNumber, status: 'failed', error,
    });
    const value = (operand: string): string | undefined => {
      if (operand.toLowerCase() === 'last' || inpEvaluate(operand) !== undefined) return undefined;
      const vector = this.measureVector(operand);
      return vector && vector.re.length === 1 ? formatC(vector.re[0]) : undefined;
    };
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      if (word.endsWith('=')) {
        if (++index >= words.length) return failed(`meas failed due to missing token in meas ${words.join(' ')}`);
        words[index] = value(words[index]) ?? words[index];
      } else if (word.includes('=')) {
        const lhs = word.slice(0, word.indexOf('='));
        const replaced = value(word.slice(word.indexOf('=') + 1));
        if (replaced !== undefined) words[index] = `${lhs}=${replaced}`;
      }
    }
    if (words.length < 2) return failed('unspecified output var name');
    const outcome = getMeasure2(words, this.measurePlot());
    if (!outcome.ok) return failed(outcome.error);
    const name = words[1].toLowerCase();
    const { ok: _ok, value: measured, ...details } = outcome;
    // com_let(`%s = %e`): the vector holds the value printed with 7 significant digits.
    this.assignmentPlot(name).vectors.set(name, scalar(Number(formatC(measured)), name));
    return {
      name, analysis: words[0].toLowerCase(), function: words[2].toLowerCase(), line: line.lineNumber, status: 'ok',
      value: measured, ...details,
    };
  }

  /** The current plot as `get_measure2` reads it. */
  private measurePlot(): MeasurePlot {
    return { type: this.current.name, scale: this.current.scale, vector: name => this.measureVector(name) };
  }

  /** ngspice vec_get for a measurement: the name, `v(node)` as `node`, `i(dev)` as `dev#branch`. */
  private measureVector(rawName: string): ControlVector | undefined {
    const name = rawName.toLowerCase();
    const candidates = [name];
    const voltage = /^v\((.+)\)$/.exec(name);
    if (voltage) candidates.push(voltage[1]);
    const current = /^i\((.+)\)$/.exec(name);
    if (current) candidates.push(`${current[1]}#branch`);
    for (const candidate of candidates) {
      try {
        return this.lookup(candidate);
      } catch (error) {
        if (!(error instanceof ExpressionError || error instanceof UnsupportedExpressionFeature)) throw error;
      }
    }
    return undefined;
  }

  /**
   * `linearize [np=n] [vec ...]`: ngspice-47 com_linearize (frontend/linear.c).
   * Re-interpolates the current transient plot onto `tstart, tstart+tstep, ...`
   * (`(tstop-tstart)/tstep + 1.5` points, accumulated by repeated addition)
   * with the current task's `.tran` parameters, or the scale's range and
   * `range/length` when there is none, overridden by `lin-tstart`, `lin-tstop`
   * and `lin-tstep` vectors of the plot. The new plot `tran<n>` becomes
   * current. Complex, scalar and short vectors are not copied (lincopy).
   */
  private linearize(rest: string, line: ControlSourceLine): void {
    const fail = (message: string): never => {
      throw new ControlScriptError(`linearize: ${message}`, line.lineNumber, line.text);
    };
    const old = this.current;
    if (!old.name.startsWith('tran')) fail('plot must be a transient analysis');
    const oldTime = old.scale;
    if (!oldTime || old.vectors.size === 0) fail('no vectors available');
    if (oldTime!.im) fail(`non-real time scale for ${old.name}`);
    let tstart: number;
    let tstop: number;
    let tstep: number;
    if (this.transientTask) {
      tstart = this.transientTask.startTime ?? 0;
      tstop = this.transientTask.stopTime;
      tstep = this.transientTask.timestep;
    } else {
      const length = oldTime!.re.length;
      if (length < 1) fail('no data in vector');
      tstart = oldTime!.re[0];
      tstop = oldTime!.re[length - 1];
      tstep = (tstop - tstart) / length;
    }
    tstart = old.vectors.get('lin-tstart')?.re[0] ?? tstart;
    tstop = old.vectors.get('lin-tstop')?.re[0] ?? tstop;
    tstep = old.vectors.get('lin-tstep')?.re[0] ?? tstep;
    if ((tstop - tstart) * tstep <= 0.0 || tstop - tstart < tstep) {
      fail(`bad parameters -- start = ${tstart}, stop = ${tstop}, step = ${tstep}`);
    }

    const words = splitWords(rest);
    const npWord = words.find(word => word.toLowerCase().startsWith('np='));
    let length: number;
    if (npWord !== undefined) {
      const text = npWord.slice(3);
      length = Math.trunc(Number(/^\s*[+-]?\d+/.exec(text)?.[0] ?? 0));
      if (length === 0 && text.toLowerCase().startsWith('auto2n')) {
        length = 2 ** roundHalfAway(Math.log2((tstop - tstart) / tstep));
      }
    } else {
      length = Math.trunc((tstop - tstart) / tstep + 1.5);
    }
    if (!(length >= 2)) fail(`cannot interpolate onto ${length} points`);

    const grid = new Float64Array(length);
    for (let index = 0, time = tstart; index < length; index++, time += tstep) grid[index] = time;
    const time = realVector(oldTime!.name, grid);
    const plot = this.newPlot('tran', `${old.title} (linearized)`, time, old.unproducedSaves);
    this.current = plot;

    const names = words.filter(word => !word.toLowerCase().startsWith('np='));
    const sources: [string, ControlVector][] = names.length > 0
      ? names.map(name => {
        const found = this.plotVector(old, name);
        if (!found) fail(`no such vector ${name}`);
        return found!;
      })
      : [...old.vectors].filter(([, vector]) => vector !== oldTime);
    for (const [key, vector] of sources) {
      // lincopy skips these with a warning.
      if (vector.im || vector.re.length === 1 || vector.re.length < oldTime!.re.length) continue;
      const values = ngspiceLinearInterpolate(vector.re.subarray(0, oldTime!.re.length), oldTime!.re, grid);
      if (!values) fail(`can't interpolate ${vector.name}`);
      plot.vectors.set(key, { name: vector.name, re: values!, scale: time });
    }
    this.exportTransientPlot(old, plot);
  }

  /** ngspice-47 src/frontend/linear.c:173-290 (com_cutout).
   * Bounds default to scale endpoints (202-229); explicit bounds use the first
   * strictly greater sample, capped at length-1. The stop index is exclusive,
   * even for the default/full-copy case (254-264). No interpolation occurs.
   */
  private cutout(rest: string): void {
    const old = this.current;
    const scale = old.scale;
    const warn = (message: string): void => { this.warnings.push(`cutout: ${message}`); };
    if (!scale || old.vectors.size === 0) return warn('no vectors available');
    if (scale.im) return warn(`non-real time scale for ${old.name}`);
    if (!old.name.startsWith('tran')) return warn('plot must be a transient analysis');
    const length = scale.re.length;
    if (length === 0) return warn('no data in vector');
    const start = old.vectors.get('cut-tstart');
    const stop = old.vectors.get('cut-tstop');
    const tstart = start?.re[0] ?? scale.re[0];
    const tstop = stop?.re[0] ?? scale.re[length - 1];
    const after = (bound: number): number => {
      let index = 0;
      while (index < length - 1 && scale.re[index] <= bound) index++;
      return index;
    };
    const first = start ? after(tstart) : 0;
    const last = stop ? after(tstop) : length - 1;
    if (tstop - tstart <= 0 || last - first <= 0) {
      return warn(`bad parameters -- start = ${tstart}, stop = ${tstop}`);
    }
    const time = realVector(scale.name, scale.re.slice(first, last));
    const plot = this.newPlot('tran', `${old.title} (${start || stop ? 'cut out' : 'copy'})`, time, old.unproducedSaves);
    this.current = plot;
    const names = splitWords(rest);
    const sources: [string, ControlVector][] = names.length > 0
      ? names.flatMap(name => {
        const found = this.plotVector(old, name);
        if (!found) warn(`no such vector ${name}`);
        return found ? [found] : [];
      })
      : [...old.vectors];
    for (const [key, vector] of sources) {
      if (vector === scale || vector.re.length < last) continue;
      plot.vectors.set(key, {
        name: vector.name, re: vector.re.slice(first, last),
        ...(vector.im ? { im: vector.im.slice(first, last) } : {}), scale: time,
      });
    }
    this.exportTransientPlot(old, plot);
  }

  private exportTransientPlot(old: Plot, plot: Plot): void {
    // The plot exists in the interpreter, but consumers of simulate() can only
    // see control.runs. Export the transformed circuit vectors as a separate
    // transient result, not the old adaptive solve under a new plot identity.
    // Use the source result's names/units: a let vector is not a node voltage.
    const transient = this.runs.filter(run => run.plot === old.name).at(-1)?.result.transient;
    const copy = (names: Iterable<string>, branch: boolean): Map<string, number[]> => {
      const vectors = new Map<string, number[]>();
      for (const name of names) {
        const vector = plot.vectors.get(`${name.toLowerCase()}${branch ? '#branch' : ''}`);
        if (vector) vectors.set(name, Array.from(vector.re));
      }
      return vectors;
    };
    this.runs.push({
      plot: plot.name, analysis: 'tran',
      result: {
        transient: new TransientResult(
          Array.from(plot.scale!.re), copy(transient?.voltages.keys() ?? [], false), copy(transient?.currents.keys() ?? [], true),
        ),
        warnings: [],
      },
    });
  }

  /** ngspice-47 frontend/fourier.c:69-163: last-period grid and sine-reference table. */
  private fourier(rest: string, line: ControlSourceLine): void {
    const fail = (message: string): never => { throw new ControlScriptError(`fourier: ${message}`, line.lineNumber, line.text); };
    const frequency = /^\s*(\S+)/.exec(rest)?.[1] ?? '';
    const fundamental = parseControlNumber(frequency ?? '');
    if (fundamental === undefined || !Number.isFinite(fundamental) || fundamental <= 0) fail('bad fundamental freq');
    const text = rest.trimStart().slice(frequency.length).trim();
    if (!text) fail('missing vector');
    const operands = (() => {
      try { return splitVectorExpressions(text); }
      catch (error) { throw this.wrap(error, line); }
    })();
    const time = this.current.scale;
    if (!time || time.im || time.name !== 'time') fail('fourier needs real time scale');
    const setting = (name: string, fallback: number, minimum: number): number => {
      const value = Math.trunc(Number(this.variables.get(name)));
      return Number.isFinite(value) && value >= minimum ? value : fallback;
    };
    const nfreqs = setting('nfreqs', 10, 1);
    const degree = setting('polydegree', 1, 0);
    const gridSize = setting('fourgridsize', 200, 1);
    const periods = setting('nperiods', 1, 1);
    const call = ++this.fourierCount;
    operands.forEach((operand, index) => {
      const vector = this.evaluate(operand, line);
      if (vector.im) fail(`${operand} isn't real!`);
      if (vector.re.length !== time!.re.length) fail("lengths don't match");
      const result = (() => {
        try {
          return ngspiceFourier(operand, time!.re, vector.re, fundamental!, nfreqs, gridSize, degree, periods);
        } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      })();
      this.fourierResults.push(result);
      this.output.push(`Fourier analysis for ${operand}:`,
        `  No. Harmonics: ${nfreqs}, THD: ${result.thd} %, Gridsize: ${result.gridSize}, Interpolation Degree: ${degree}, No. Periods: ${periods}`,
        'Harmonic Frequency Magnitude Phase Norm. Mag Norm. Phase',
        ...result.harmonics.map(row => [row.harmonic, row.frequency, row.magnitude, row.phase, row.normalizedMagnitude, row.normalizedPhase].join(' ')));
      if (!this.variables.has('fournosave')) {
        const name = `thd${call}${index + 1}`;
        this.current.vectors.set(name, scalar(result.thd, name));
      }
    });
  }

  private spectrum(command: 'fft' | 'psd', rest: string, line: ControlSourceLine): void {
    const fail = (message: string): never => {
      throw new ControlScriptError(`${command}: ${message}`, line.lineNumber, line.text);
    };
    const source = this.current;
    const scale = source.scale;
    if (!scale) fail('no vectors loaded');
    if (scale!.im || scale!.name !== 'time') fail('fft needs real time scale');
    const time = scale!.re;
    const length = time.length;
    if (length < 2) fail('fft needs more than one time point, check the tran simulation!');

    let words = splitWords(rest);
    let smooth = 1;
    if (command === 'psd') {
      if (words.length === 0) fail('missing number of averaged data points');
      const value = parseControlNumber(words[0]);
      smooth = value === undefined || !(value >= 1) ? 1 : Math.trunc(value);
      words = words.slice(1);
    }

    const windowSetting = this.variables.get('specwindow');
    const window = typeof windowSetting === 'string' ? windowSetting : 'hanning';
    const orderSetting = Number(this.variables.get('specwindoworder'));
    const order = Number.isFinite(orderSetting) ? Math.max(2, Math.trunc(orderSetting)) : 2;
    const maxt = time[length - 1];
    const span = command === 'fft'
      ? time[length - 1] - time[0] + time[length - 1] - time[length - 2]
      : time[length - 1] - time[0];
    const weights = spectrumWindow(window, time, maxt, span, order);
    if (!weights) fail(`unknown window type ${window}`);

    const inputs: { name: string; values: Float64Array }[] = [];
    for (const word of words) {
      const vector = this.evaluate(word, line);
      if (vector.re.length !== length) {
        fail(`lengths of ${word} vectors don't match: ${vector.re.length}, ${length}`);
      }
      if (vector.im) fail(`${word} isn't real!`);
      if (vector === scale) continue;
      const key = [...source.vectors].find(([, candidate]) => candidate === vector)?.[0] ?? word.toLowerCase();
      inputs.push({ name: key, values: vector.re });
    }
    if (inputs.length === 0) fail('no vectors to transform');

    const values = inputs.map(input => input.values);
    const result = command === 'fft' ? ngspiceFft(time, values, weights!) : ngspicePsd(time, values, weights!, smooth);
    const frequency = realVector('frequency', result.frequency);
    const plot = this.newPlot('sp', command === 'fft' ? 'Spectrum' : 'PSD', frequency, source.unproducedSaves);
    inputs.forEach((input, index) => {
      const { re, im } = result.vectors[index];
      plot.vectors.set(input.name, complexVector(input.name, re, im, frequency));
    });
    this.current = plot;
  }

  /** cmath4.c cx_fft/cx_ifft (FFTW3), not the com_fft defaults or frequency span. */
  private spectralTransform(name: 'fft' | 'ifft', arg: ControlVector): ControlVector {
    const plotScale = this.current.scale;
    const length = arg.re.length;
    if (!plotScale || plotScale.re.length < 2 || length < 2) {
      throw new ExpressionError(`${name}() needs a plot scale and at least two points`);
    }
    const span = plotScale.re[plotScale.re.length - 1] - plotScale.re[0];
    if (name === 'ifft') {
      if (!arg.im) throw new ExpressionError('ifft() needs complex input');
      const outputLength = plotScale.name === 'frequency' ? plotScale.re.length : length;
      if (length > outputLength) throw new ExpressionError('ifft() input exceeds the frequency scale length');
      const scale = realVector('ifft_scale', Array.from({ length: outputLength }, (_, i) =>
        plotScale.name === 'frequency' ? i / span : i));
      const re = new Float64Array(outputLength);
      const im = new Float64Array(outputLength);
      re.set(arg.re);
      im.set(arg.im.map(value => -value));
      const result = complexDft(re, im);
      this.current.vectors.set(scale.name, scale);
      return complexVector('result', result.re, result.im.map(value => -value), scale);
    }
    if (plotScale.re.length !== length) throw new ExpressionError('fft() needs a matching plot scale');
    const time = plotScale.name === 'time' ? plotScale.re : Float64Array.from({ length }, (_, i) =>
      plotScale.name === 'frequency' ? i / span : i);
    const windowSpan = time[length - 1] - time[0];
    const setting = this.variables.get('specwindow');
    const window = typeof setting === 'string' ? setting : 'none';
    const orderSetting = Number(this.variables.get('specwindoworder'));
    const order = Number.isFinite(orderSetting) ? Math.max(2, Math.trunc(orderSetting)) : 2;
    const weights = spectrumWindow(window, time, time[length - 1], windowSpan, order);
    if (!weights) throw new ExpressionError(`fft(): unknown window type ${window}`);
    const bins = arg.im ? length : Math.floor(length / 2) + 1;
    const scale = realVector('fft_scale', Array.from({ length: bins }, (_, i) =>
      plotScale.name === 'time' ? i / span : plotScale.name === 'frequency' ? plotScale.re[i] : i));
    let result: { re: Float64Array; im: Float64Array };
    if (arg.im) {
      result = complexDft(arg.re.map((value, i) => value * weights[i]), arg.im.map((value, i) => value * weights[i]));
      result.re = result.re.map(value => value / length);
      result.im = result.im.map(value => value / length);
    } else {
      result = ngspiceFft(time, [arg.re], weights).vectors[0];
    }
    this.current.vectors.set(scale.name, scale);
    return complexVector('result', result.re, result.im, scale);
  }

  /** ngspice vec_fromplot: a vector of one plot by name, `v(node)` or `i(device)`, with its key. */
  private plotVector(plot: Plot, rawName: string): [string, ControlVector] | undefined {
    const name = rawName.toLowerCase();
    const voltage = /^v\((.+)\)$/.exec(name);
    const current = /^i\((.+)\)$/.exec(name);
    for (const candidate of [name, voltage?.[1], current ? `${current[1]}#branch` : undefined]) {
      if (candidate === undefined) continue;
      const vector = plot.vectors.get(candidate);
      if (vector) return [candidate, vector];
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Plots

  private newPlot(type: string, title: string, scale: ControlVector | undefined, unproducedSaves: ReadonlySet<string> = new Set<string>()): Plot {
    while (this.plots.some(plot => plot.name === `${type}${this.plotNumber}`)) this.plotNumber++;
    const plot: Plot = { name: `${type}${this.plotNumber}`, title, vectors: new Map(), scale, unproducedSaves };
    if (scale) plot.vectors.set(scale.name, scale);
    this.plots.push(plot);
    return plot;
  }

  private recordRun(run: ControlHostRun): void {
    const saves = new Set(this.savedDeviceVectors);
    const type = run.directive.type;
    const { result } = run;
    if (type === 'noise' && result.noise) {
      let noise = result.noise;
      if (this.variables.has('sqrnoise')) {
        noise = squaredNoiseOutput(noise);
        result.noise = noise;
      }
      const frequency = realVector('frequency', noise.frequencies);
      const spectrum = this.newPlot('noise', noise.squared
        ? 'Noise Spectral Density Curves - (V^2 or A^2)/Hz'
        : 'Noise Spectral Density Curves', frequency, saves);
      spectrum.vectors.set('onoise_spectrum', realVector('onoise_spectrum', noise.outputNoiseDensity, frequency));
      spectrum.vectors.set('inoise_spectrum', realVector('inoise_spectrum', noise.inputNoiseDensity, frequency));
      this.runs.push({ plot: spectrum.name, analysis: type, result });
      // ngspice creates an integrated plot only when the sweep has a frequency
      // interval to integrate. Otherwise the spectrum remains the current plot.
      if (noise.integratedOutputNoise === undefined && noise.integratedInputNoise === undefined) {
        this.current = spectrum;
        return;
      }
      const integrated = this.newPlot('noise', noise.squared
        ? 'Integrated Noise - V^2 or A^2'
        : 'Integrated Noise', undefined, saves);
      if (noise.integratedOutputNoise !== undefined) {
        integrated.vectors.set('onoise_total', scalar(noise.integratedOutputNoise, 'onoise_total'));
      }
      if (noise.integratedInputNoise !== undefined) {
        integrated.vectors.set('inoise_total', scalar(noise.integratedInputNoise, 'inoise_total'));
      }
      this.current = integrated;
      return;
    }
    const plot = this.plotFor(run, saves);
    this.runs.push({ plot: plot.name, analysis: type, result });
    this.current = plot;
  }

  private plotFor(run: ControlHostRun, saves: Set<string>): Plot {
    const { directive, result } = run;
    switch (directive.type) {
      case 'pz': {
        const plot = this.newPlot('pz', 'Pole-Zero Analysis', undefined, saves);
        for (const [kind, roots] of [['pole', result.poleZero?.poles], ['zero', result.poleZero?.zeros]] as const) {
          roots?.forEach((root, index) => {
            const name = `${kind}(${index + 1})`;
            plot.vectors.set(name, complexVector(name, [root.real], [root.imaginary]));
          });
        }
        return plot;
      }
      case 'op': {
        const plot = this.newPlot('op', 'Operating Point', undefined, saves);
        for (const [node, value] of result.dc?.voltages ?? []) plot.vectors.set(node.toLowerCase(), scalar(value, node));
        for (const [branch, value] of result.dc?.currents ?? []) {
          plot.vectors.set(`${branch.toLowerCase()}#branch`, scalar(value, `${branch}#branch`));
        }
        return plot;
      }
      case 'dc': {
        const sweep = result.dcSweep;
        const source = directive.source.toLowerCase();
        const scaleName = source === 'temp' ? 'temp-sweep' : `${source[0] === 'i' ? 'i' : source[0] === 'r' ? 'res' : 'v'}-sweep`;
        const scale = realVector(scaleName, sweep ? sweep.sweepValues : []);
        const plot = this.newPlot('dc', 'DC transfer characteristic', scale, saves);
        if (sweep) {
          for (const [name, values] of sweep.deviceVectors) plot.vectors.set(name, realVector(name, values, scale));
          // ngspice 3ef069f: frontend/outitf.c:837-861 samples saved special
          // parameters per point; frontend/vectors.c:613-640 looks up that plot
          // vector before falling back to a live scalar device query. Use the
          // sweep values, not the source's restored value after the sweep.
          for (const [name, values] of [
            [source, sweep.sweepValues],
            [directive.secondary?.source.toLowerCase(), sweep.secondarySweepValues],
          ] as const) {
            if (!name || !values || !/^[vi]/.test(name)) continue;
            const saved = `@${name}[dc]`;
            if (saves.has(saved)) plot.vectors.set(saved, realVector(saved, values, scale));
          }
          for (const [node, values] of sweep.voltages) plot.vectors.set(node.toLowerCase(), realVector(node, values, scale));
          for (const [branch, values] of sweep.currents) {
            plot.vectors.set(`${branch.toLowerCase()}#branch`, realVector(`${branch}#branch`, values, scale));
          }
        }
        return plot;
      }
      case 'tran': {
        const transient = result.transient;
        const scale = realVector('time', transient ? transient.time : []);
        const plot = this.newPlot('tran', 'Transient Analysis', scale, saves);
        if (transient) {
          for (const [name, values] of transient.deviceVectors) plot.vectors.set(name, realVector(name, values, scale));
          for (const [node, values] of transient.voltages) plot.vectors.set(node.toLowerCase(), realVector(node, values, scale));
          for (const [branch, values] of transient.currents) {
            plot.vectors.set(`${branch.toLowerCase()}#branch`, realVector(`${branch}#branch`, values, scale));
          }
        }
        return plot;
      }
      case 'ac': {
        const ac = result.ac;
        const scale = realVector('frequency', ac ? ac.frequencies : []);
        const plot = this.newPlot('ac', 'AC Analysis', scale, saves);
        const phasors = (name: string, values: { magnitude: number; phase: number }[]): ControlVector => complexVector(
          name,
          values.map(value => value.magnitude * Math.cos((value.phase * Math.PI) / 180)),
          values.map(value => value.magnitude * Math.sin((value.phase * Math.PI) / 180)),
          scale,
        );
        if (ac) {
          for (const [node, values] of ac.voltages) plot.vectors.set(node.toLowerCase(), phasors(node, values));
          for (const [branch, values] of ac.currents) {
            plot.vectors.set(`${branch.toLowerCase()}#branch`, phasors(`${branch}#branch`, values));
          }
        }
        return plot;
      }
      case 'sp': {
        // span.c: plot `sp<n>` with a `frequency` scale and one complex vector per S/Y/Z
        // (and, with donoise, Cy/NF/SOpt/NFmin/Rn) result, under its ngspice name.
        const sp = result.sParameters;
        const scale = realVector('frequency', sp ? sp.frequencies : []);
        const plot = this.newPlot('sp', 'SP Analysis', scale, saves);
        if (sp) plot.sp = { ports: sp.ports.length, impedance: sp.referenceImpedances[0] };
        for (const [name, values] of sp?.vectors ?? []) {
          plot.vectors.set(name.toLowerCase(), complexVector(
            name, values.map(value => value.real), values.map(value => value.imaginary), scale,
          ));
        }
        return plot;
      }
      case 'sens': {
        const sens = result.sensitivity;
        const ac = directive.mode === 'ac';
        // cktsens.c: an AC plot has a `frequency` scale; a DC plot holds one value per vector.
        const scale = ac ? realVector('frequency', sens ? sens.frequencies : []) : undefined;
        const plot = this.newPlot('sens', 'Sensitivity Analysis', scale, saves);
        for (const entry of sens?.entries ?? []) {
          const vector = entry.dc !== undefined
            ? scalar(entry.dc, entry.device)
            : complexVector(
              entry.device,
              (entry.ac ?? []).map(value => value.real),
              (entry.ac ?? []).map(value => value.imaginary),
              scale,
            );
          for (const { name, firstPointOnly } of sensitivityVectorNames(entry.device, entry.parameter, ac)) {
            plot.vectors.set(name, firstPointOnly
              ? complexVector(
                name,
                (entry.ac ?? []).map((value, index) => (index === 0 ? value.real : -0)),
                (entry.ac ?? []).map((value, index) => (index === 0 ? value.imaginary : -0)),
                scale,
              )
              : renamed(vector, name));
          }
        }
        return plot;
      }
      default:
        return this.newPlot(directive.type, directive.type, undefined, saves);
    }
  }

  // -------------------------------------------------------------------------
  // Vectors and expressions

  private environment(): ExpressionEnvironment {
    return {
      lookup: name => this.lookup(name),
      random: this.host.random?.bind(this.host),
      scale: () => this.current.scale,
      spectralTransform: (name, arg) => this.spectralTransform(name, arg),
      movingAverageWindow: () => {
        const setting = this.variables.get('mtimeavgwindow');
        return typeof setting === 'string'
          ? parseControlNumber(setting) ?? NaN
          : this.transientTask ? 10 * this.transientTask.timestep : 1e-6;
      },
      userFunction: (name, arity) => this.functions.get(`${name.toLowerCase()}/${arity}`),
      degrees: () => {
        const units = this.variables.get('units');
        return typeof units === 'string' && units.toLowerCase().startsWith('degree');
      },
    };
  }

  private lookup(rawName: string): ControlVector {
    const name = rawName.toLowerCase();
    const dot = name.indexOf('.');
    if (dot > 0) {
      const plot = this.plots.find(candidate => candidate.name === name.slice(0, dot));
      if (plot) return this.lookupIn(plot, name.slice(dot + 1), rawName);
    }
    const local = this.current.vectors.get(name) ?? this.current.vectors.get(`v(${name})`);
    if (local) return local;
    const constant = this.plots[0].vectors.get(name) ?? this.plots[0].vectors.get(`v(${name})`);
    if (constant) return constant;
    return this.lookupIn(this.current, name, rawName);
  }

  private lookupIn(plot: Plot, name: string, rawName: string): ControlVector {
    // Voltage probes normally look up their bare node name. A let target may
    // instead be stored literally as v(node), as in ngspice's plainwrite deck.
    const vector = plot.vectors.get(name) ?? plot.vectors.get(`v(${name})`);
    if (vector) return vector;
    if (name.startsWith('@')) {
      if (plot.unproducedSaves.has(name)) {
        throw new UnsupportedExpressionFeature(rawName, `saved device-parameter vector '${rawName}' is not produced by spice-ts analyses`);
      }
      const match = /^@([^[]+)\[([^\]]+)\]$/.exec(name);
      const values = match && !this.circuitRemoved && !this.preLoading ? this.host.parameterVector(match[1], match[2]) : undefined;
      if (values === undefined) {
        throw new UnsupportedExpressionFeature(rawName, `device or model parameter '${rawName}' is not available to the spice-ts control language`);
      }
      return realVector(name, values);
    }
    throw new ExpressionError(`no such vector '${rawName}' in plot '${plot.name}'`);
  }

  private parse(text: string, line: ControlSourceLine): ExpressionNode {
    try {
      return parseVectorExpression(text);
    } catch (error) {
      throw this.wrap(error, line);
    }
  }

  private evaluate(text: string, line: ControlSourceLine): ControlVector {
    const tree = this.parse(text, line);
    try {
      return evaluateVectorExpression(tree, this.environment());
    } catch (error) {
      throw this.wrap(error, line);
    }
  }

  private vector(name: string, line: ControlSourceLine): ControlVector {
    try {
      return this.lookup(name.trim());
    } catch (error) {
      throw this.wrap(error, line);
    }
  }

  private wrap(error: unknown, line: ControlSourceLine): Error {
    if (error instanceof UnsupportedExpressionFeature) {
      return new UnsupportedControlCommandError(commandWord(line.text), error.message, line.lineNumber, line.text);
    }
    if (error instanceof ExpressionError) return new ControlScriptError(error.message, line.lineNumber, line.text);
    return error as Error;
  }

  // -------------------------------------------------------------------------
  // Variable substitution

  /**
   * ngspice variable substitution: `$name`, `{$name}`, `$&vector`, `$?name`,
   * `$#name`, and the plot variables `$curplot`, `$curplottitle`, `$plots`.
   * Nothing is substituted inside single quotes.
   */
  private substitute(text: string, line: ControlSourceLine): string {
    let output = '';
    let index = 0;
    let singleQuoted = false;
    while (index < text.length) {
      const character = text[index];
      if (character === "'") singleQuoted = !singleQuoted;
      if (singleQuoted) {
        output += character;
        index++;
        continue;
      }
      if (character === '{' && text[index + 1] === '$') {
        const close = text.indexOf('}', index);
        if (close > index) {
          output += this.substituteReference(text.slice(index + 1, close), line);
          index = close + 1;
          continue;
        }
      }
      if (character === '$') {
        const reference = /^\$(?:&[A-Za-z0-9_#@.]+(?:\([^)]*\))?(?:\[[^\]]*\])*|[?#][A-Za-z0-9_]+|[A-Za-z0-9_]+)/.exec(text.slice(index));
        if (reference) {
          output += this.substituteReference(reference[0], line);
          index += reference[0].length;
          continue;
        }
      }
      output += character;
      index++;
    }
    return output;
  }

  private substituteReference(reference: string, line: ControlSourceLine): string {
    if (reference.startsWith('$&')) {
      const digits = Number(this.variables.get('numdgt'));
      return formatVector(this.evaluate(reference.slice(2), line), Number.isInteger(digits) && digits > 0 ? digits : 6);
    }
    if (reference.startsWith('$?')) return this.variable(reference.slice(2)) === undefined ? '0' : '1';
    if (reference.startsWith('$#')) {
      const value = this.variable(reference.slice(2));
      return String(value === undefined ? 0 : Array.isArray(value) ? value.length : 1);
    }
    const name = reference.slice(1);
    const value = this.variable(name);
    if (value === undefined) throw new ControlScriptError(`'${name}': no such variable`, line.lineNumber, line.text);
    if (value === true) return 'TRUE';
    return Array.isArray(value) ? value.join(' ') : value;
  }

  private variable(rawName: string): VariableValue | undefined {
    const name = rawName.toLowerCase();
    if (name === 'curplot') return this.current.name;
    if (name === 'curplottitle') return this.current.title;
    if (name === 'curplotname') return this.current.title;
    if (name === 'plots') return this.plots.map(plot => plot.name);
    return this.variables.get(name);
  }
}

// ---------------------------------------------------------------------------
// Word helpers

/**
 * ngspice-47 plot_prefix (frontend/vectors.c): `pre` names `plot` when it is a
 * prefix of it, except that a prefix ending in a digit must match the whole
 * name (`op` selects op2, `op1` never selects op12).
 */
function plotPrefix(pre: string, plot: string): boolean {
  if (!plot.startsWith(pre)) return false;
  return pre.length === plot.length || !/[0-9]$/.test(pre);
}

function commandWord(text: string): string {
  return (/^[^\s=(]+/.exec(text)?.[0] ?? '').toLowerCase();
}

/** Drop csh-style output redirection (`> file`, `>> file`) from an output command. */
function withoutRedirection(words: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (/^>>?/.test(word)) {
      if (word === '>' || word === '>>') index++;
      continue;
    }
    kept.push(word);
  }
  return kept;
}

/**
 * ngspice's csh-like command lexer treats a whitespace-separated `<`, `>` or
 * `>>` word on a `let` or `define` line as I/O redirection, not as a
 * comparison (`abs(a-b)>err` is a comparison). spice-ts does not emulate the
 * redirection, so such lines are rejected.
 */
function rejectRedirection(command: string, text: string, line: ControlSourceLine): void {
  if (splitWords(text).some(word => word === '<' || word === '>' || word === '>>')) {
    throw new UnsupportedControlCommandError(
      command,
      `a separate '<' or '>' word on a ${command} line is csh-style redirection in ngspice and is not supported`,
      line.lineNumber,
      line.text,
    );
  }
}

/** inpcom.c find_assignment: the next `=` from `from` that is not part of `==`, `!=`, `<=` or `>=`. */
function findAssignment(text: string, from: number): number {
  for (let index = text.indexOf('=', from); index >= 0; index = text.indexOf('=', index + 1)) {
    if (text[index + 1] === '=') {
      index++;
      continue;
    }
    if (index > 0 && '!<>'.includes(text[index - 1])) continue;
    return index;
  }
  return -1;
}

/** misc/string.c gettok from `start`: the word and where the next one begins. */
function gettokAt(text: string, start: number): { token: string; end: number } {
  const [token = ''] = gettokWords(text.slice(start));
  let end = text.indexOf(token, start) + token.length;
  while (end < text.length && (/\s/.test(text[end]) || text[end] === ',')) end++;
  return { token, end };
}

/**
 * Names of a sensitivity vector in ngspice-47's `sens<n>` plot (cktsens.c names
 * each perturbed parameter `<device>` for its primary value, `<device>_<param>`
 * otherwise). A resistor's AC resistance defaults to its resistance, so in an
 * AC plot `r1_ac` holds the AC sensitivity at every frequency. ngspice-47 also
 * lists `r1`, whose perturbation only reaches the matrix at the first frequency:
 * `r1` equals `r1_ac` at point 0 and is -0 at every later point (`firstPointOnly`).
 * spice-ts rejects an explicit `ac=` resistance in AC sensitivity.
 */
function sensitivityVectorNames(
  device: string,
  parameter: SensitivityEntry['parameter'],
  ac: boolean,
): { name: string; firstPointOnly: boolean }[] {
  const name = device.toLowerCase();
  const plain = (vectorName: string) => [{ name: vectorName, firstPointOnly: false }];
  if (parameter.startsWith('bjt:')) return plain(`${name}:${parameter.slice(4)}`);
  switch (parameter) {
    case 'resistance':
      return ac
        ? [{ name, firstPointOnly: true }, { name: `${name}_ac`, firstPointOnly: false }]
        : plain(name);
    case 'acMagnitude': return plain(`${name}_acmag`);
    case 'gain': return plain(`${name}_gain`);
    case 'multiplier': return plain(`${name}_m`);
    case 'scale': return plain(`${name}_scale`);
    default: return plain(name);
  }
}

/** C `round()`: halves away from zero. */
function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** C `printf("%e")`. */
function formatC(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  return value.toExponential(6).replace(/e([+-])(\d)$/, 'e$10$2');
}

/** Index of the `=` that separates a `let` target from its expression. */
function assignmentIndex(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '[' || character === '(') depth++;
    if (character === ']' || character === ')') depth--;
    if (character === '=' && depth === 0) return index;
  }
  return -1;
}
