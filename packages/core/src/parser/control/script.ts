import { UnsupportedControlCommandError } from './errors.js';
import { validatePreSet } from './pre-set.js';
import type { ControlSourceBlock, ControlSourceLine } from './source.js';

/**
 * Statement structure of an ngspice `.control` script and the static contract
 * of which commands spice-ts executes.
 */
export type ControlStatement =
  | { kind: 'command'; name: string; line: ControlSourceLine }
  | { kind: 'if'; line: ControlSourceLine; condition: string; then: ControlStatement[]; otherwise: ControlStatement[] }
  | { kind: 'while' | 'dowhile'; line: ControlSourceLine; condition: string; body: ControlStatement[] }
  | { kind: 'repeat'; line: ControlSourceLine; count: string; body: ControlStatement[] }
  | { kind: 'foreach'; line: ControlSourceLine; variable: string; values: string; body: ControlStatement[] }
  | { kind: 'break' | 'continue'; line: ControlSourceLine };

/** A parsed `.control` script (all blocks of the deck, in order). */
export interface ControlScript {
  statements: ControlStatement[];
  /** Hoisted pre_set lines, validated before circuit setup, not runtime statements. */
  preSet?: ControlSourceLine[];
  /** Deck `.csparam` values, installed before executing any control statement. */
  constants?: Readonly<Record<string, number>>;
}

/** Analysis commands; each runs one analysis and creates one plot (noise: two). */
export const CONTROL_ANALYSIS_COMMANDS = new Set(['op', 'dc', 'ac', 'tran', 'noise', 'sp', 'sens']);

/**
 * Commands that only format, display, save or report already-computed vectors,
 * or exit. They cannot change a simulated value, so spice-ts recognizes them
 * without executing them (`echo` output is captured).
 */
export const OUTPUT_ONLY_CONTROL_COMMANDS = new Set([
  'asciiplot', 'display', 'echo', 'exit', 'gnuplot', 'hardcopy', 'listing', 'plot', 'print', 'quit',
  'rusage', 'save', 'settype', 'show', 'showmod', 'status', 'version', 'wrdata', 'write', 'wrs2p',
]);

/** Commands with an effect that the spice-ts interpreter executes. */
const EXECUTED_CONTROL_COMMANDS = new Set([
  'run', 'let', 'unlet', 'set', 'unset', 'define', 'undefine', 'alter', 'altermod', 'alterparam', 'reset', 'option', 'options',
  'setplot', 'destroy', 'remzerovec', 'compose', 'strcmp', 'setscale', 'meas', 'linearize', 'cutout', 'fft', 'psd', 'fourier',
  // Interactive editor: ngspice-47 batch mode warns and continues unless `interactive` is set.
  'edit',
]);

/** Why a known ngspice command is not executed, for the structured error. */
const UNSUPPORTED_REASONS: Record<string, string> = {
  measure: "ngspice's control-language measurement command is 'meas'",
  spec: 'the spec spectral command is not implemented (fft and psd are)',
  reshape: 'multi-dimensional vectors are not implemented',
  goto: 'goto/label jumps are not implemented',
  label: 'goto/label jumps are not implemented',
  source: 'sourcing further netlists or scripts is not implemented',
  shell: 'shell commands are not executed',
  pz: 'control-language pole-zero analysis is not implemented',
  tf: 'control-language transfer-function analysis is not implemented',
  disto: 'control-language distortion analysis is not implemented',
  pss: 'periodic steady-state analysis is not implemented',
  hbosc: 'harmonic-balance oscillator analysis is not implemented',
  load: 'loading raw files is not implemented',
  remcirc: 'circuit management is not implemented',
  circbyline: 'circuit management is not implemented',
  mc_source: 'circuit management is not implemented',
};

const STRUCTURE_KEYWORDS = new Set(['if', 'else', 'end', 'while', 'dowhile', 'repeat', 'foreach', 'break', 'continue']);

/** The contract text listed in an unsupported-command error. */
const CONTRACT = 'spice-ts executes the analyses op/dc/ac/tran/noise/run, set/unset, let/unlet, define, alter/altermod/alterparam, reset, '
  + 'option, setplot/destroy, remzerovec, compose, strcmp, setscale, meas, linearize, cutout, fft, psd, fourier, the sp and sens analyses, if/else/end, while/dowhile/repeat/foreach/break/continue, '
  + 'and treats output-only commands (echo, print, plot, write, wrdata, save, ...) and batch-mode edit as no-ops';

/** Lower-cased command word of a control line. */
export function commandName(text: string): string {
  return (/^[^\s=(]+/.exec(text)?.[0] ?? '').toLowerCase();
}

function unsupported(name: string, line: ControlSourceLine): UnsupportedControlCommandError {
  const reason = UNSUPPORTED_REASONS[name] ?? 'it is not an ngspice control-language command spice-ts executes';
  return new UnsupportedControlCommandError(name, `${reason}; ${CONTRACT}`, line.lineNumber, line.text);
}

/**
 * Parse the blocks of a deck into one statement tree, rejecting every command
 * spice-ts does not execute with an {@link UnsupportedControlCommandError}.
 * Commands are checked everywhere, including branches that may never run, so a
 * script is either fully executable or rejected up front.
 */
export function parseControlScript(blocks: ControlSourceBlock[]): ControlScript {
  const preSet: ControlSourceLine[] = [];
  const lines = blocks.flatMap(block => block.lines).filter(line => {
    if (commandName(line.text) !== 'pre_set') return true;
    validatePreSet(line);
    preSet.push(line);
    return false;
  });
  let position = 0;

  function body(terminators: string[]): { statements: ControlStatement[]; terminator?: string } {
    const statements: ControlStatement[] = [];
    while (position < lines.length) {
      const line = lines[position];
      const name = commandName(line.text);
      if (terminators.includes(name)) return { statements, terminator: name };
      position++;
      statements.push(statement(name, line));
    }
    return { statements };
  }

  function block(opening: ControlSourceLine, allowElse: boolean): { then: ControlStatement[]; otherwise: ControlStatement[] } {
    const first = body(allowElse ? ['end', 'else'] : ['end']);
    if (first.terminator === undefined) {
      throw new UnsupportedControlCommandError(
        commandName(opening.text), "block is missing its closing 'end'", opening.lineNumber, opening.text,
      );
    }
    position++;
    if (first.terminator === 'end') return { then: first.statements, otherwise: [] };
    const second = body(['end']);
    if (second.terminator === undefined) {
      throw new UnsupportedControlCommandError(
        'if', "block is missing its closing 'end'", opening.lineNumber, opening.text,
      );
    }
    position++;
    return { then: first.statements, otherwise: second.statements };
  }

  function statement(name: string, line: ControlSourceLine): ControlStatement {
    const rest = line.text.slice(name.length).trim();
    switch (name) {
      case 'if': {
        const { then, otherwise } = block(line, true);
        return { kind: 'if', line, condition: rest, then, otherwise };
      }
      case 'while':
      case 'dowhile':
        return { kind: name, line, condition: rest, body: block(line, false).then };
      case 'repeat':
        return { kind: 'repeat', line, count: rest, body: block(line, false).then };
      case 'foreach': {
        const [variable, ...values] = rest.split(/\s+/);
        if (!variable) {
          throw new UnsupportedControlCommandError('foreach', 'missing loop variable', line.lineNumber, line.text);
        }
        return { kind: 'foreach', line, variable, values: values.join(' '), body: block(line, false).then };
      }
      case 'break':
      case 'continue':
        return { kind: name, line };
      case 'else':
      case 'end':
        throw new UnsupportedControlCommandError(
          name, `'${name}' without a matching opening statement`, line.lineNumber, line.text,
        );
      default:
        if (!isExecutableCommand(name)) throw unsupported(name, line);
        return { kind: 'command', name, line };
    }
  }

  const { statements } = body([]);
  return preSet.length > 0 ? { statements, preSet } : { statements };
}

function isExecutableCommand(name: string): boolean {
  return CONTROL_ANALYSIS_COMMANDS.has(name)
    || OUTPUT_ONLY_CONTROL_COMMANDS.has(name)
    || EXECUTED_CONTROL_COMMANDS.has(name)
    || STRUCTURE_KEYWORDS.has(name);
}
