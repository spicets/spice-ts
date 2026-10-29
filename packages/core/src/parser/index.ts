import { Circuit } from '../circuit.js';
import { addFourierCard, takeFourierOptions } from './dot-four.js';
import { parseUrcParams } from '../devices/urc.js';
import { assertControlledSourceCard, withoutNodePairParentheses } from './controlled-source.js';
import { ParseError } from '../errors.js';
import { tokenizeNetlist, tokenizeLine, parseNumber, type ParsedLine } from './tokenizer.js';
import { fixGndName, hasGndToken } from './gnd-alias.js';
import { parseModelCard } from './model-parser.js';
import { assertSupportedModelType } from './model-type.js';
import { assertSupportedResistorModel, parseResistorElement } from './resistor-parser.js';
import {
  extractRFPort, extractSourceMultiplier, hasSourceMultiplier, parseSourceCardWaveform, parseInstanceParams,
  VOLTAGE_SOURCE_MULTIPLIER_ERROR,
} from './waveform-parser.js';
import { invalidPassiveInstanceLine, parsePassiveElement } from './passive-parser.js';
import { diodeModelIndex, parseDiodeInstanceParams } from './diode-parser.js';
import { parseBJTInstance } from './bjt-parser.js';
import { parseJFETInstance } from './jfet-parser.js';
import { parsePoleZero } from './pole-zero-parser.js';
import { parseSensitivity } from './sensitivity-parser.js';
import {
  parseCplLines,
  parseLossyTransmissionLine,
  parseTransmissionLine,
  parseTransmissionLineModelCard,
  parseTxlLine,
} from './transmission-line-parser.js';
import { preprocessDeck, preprocessDeckSync, type PreprocessedDeck } from './preprocessor.js';
import { tempDirective } from './temp-directive.js';
import { translateMicroSign } from './micro-sign.js';
import { lowerControlScript } from './control-block.js';
import {
  extractControlBlocks, type ControlSourceBlock, type ControlSourceLine, type ControlSourceWarning,
} from './control/source.js';
import {
  CONTROL_ANALYSIS_COMMANDS, commandName, parseControlScript, type ControlScript, type ControlStatement,
} from './control/script.js';
import { UnsupportedControlCommandError } from './control/errors.js';
import { validatePreSet } from './control/pre-set.js';
import { parseBehavioralSourceCard } from './behavioral-expression.js';
import { parseZInstance } from './z-device-parser.js';
import { locateSubcircuitCall, parseSubcircuitCallParams, parseSubcircuitHeader, type SubcircuitHeader } from './subcircuit-syntax.js';
import { parseSwitchInstance } from './switch-parser.js';
import { parseXspiceInstance, parseXspiceModelCard, xspiceModelType } from './xspice-parser.js';
import { isPspiceSwitchModel, translatePspiceSwitchModel } from './pspice-switch.js';
import { isNgspiceOptionField, splitXyceOptionPackage } from './xyce-option-packages.js';
import { parseNgbehavior } from './ngbehavior.js';
import type { AnalysisDirective, IncludeResolver, IntegrationMethod, PoleZeroAnalysis, SimulationOptions } from '../types.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';
import { measureCard } from '../measure/dot-measure.js';
import { addMeasureCard, measureCards } from '../measure/registry.js';
import { UnsupportedMeasureError } from '../measure/errors.js';

export { parseSourceWaveform } from './waveform-parser.js';
export { SUPPORTED_MODEL_TYPES, UnsupportedModelTypeError } from './model-type.js';
export { UnsupportedSourceWaveformError } from './waveform-parser.js';
export { UnsupportedResistorParameterError } from './resistor-parser.js';
export { UnsupportedModelFlagError } from './model-flags.js';

/**
 * Parse a standard SPICE deck into a {@link Circuit} object.
 *
 * SPICE reserves the first physical line as the deck title. It is always
 * discarded, even when its text has the shape of a device or directive. Use
 * {@link parseTitleless} for generated fragments that omit the title line.
 *
 * Handles device lines (R, C, L, V, I, D, Q, J, M, E, G, H, F, X),
 * dot commands (`.op`, `.dc`, `.tran`, `.ac`, `.model`, `.subckt`),
 * and subcircuit definitions. Runs the same `.param`/`.func`/`.if`
 * preprocessing as {@link parseAsync} and `simulate()`, so a deck that
 * `simulate()` accepts also parses here. Does not resolve `.include` or `.lib`
 * file directives -- use {@link parseAsync} for netlists with file includes.
 *
 * @param netlist - SPICE netlist text (may include line continuations with `+`)
 * @returns A {@link Circuit} ready for compilation and simulation
 * @throws {@link ParseError} if the netlist contains syntax errors or unknown device types
 * @example
 * ```ts
 * const circuit = parse(`
 *   V1 in 0 DC 5
 *   R1 in out 1k
 *   R2 out 0 1k
 *   .op
 * `);
 * const compiled = circuit.compile();
 * ```
 */
export function parse(netlist: string): Circuit {
  const { title, control } = splitTitledDeck(netlist);
  const preprocessed = preprocessDeckSync(control.netlist, undefined, 1);
  return parseNetlist(
    `${title}\n${preprocessed.text}`, true, undefined, control.blocks, preprocessed.parameters,
    [...control.warnings, ...preprocessed.warnings], preprocessed.controlConstants, preprocessed.atTemperature, preprocessed.withParameters,
  );
}

/**
 * Parse a title-less SPICE fragment.
 *
 * Unlike {@link parse}, the first physical line is parsed as a device or
 * directive. Use this explicit API for generated snippets that omit the
 * standard SPICE title line.
 */
export function parseTitleless(netlist: string): Circuit {
  const control = extractControlBlocks(translateMicroSign(netlist), false);
  const preprocessed = preprocessDeckSync(control.netlist, undefined, 0);
  return parseNetlist(preprocessed.text, false, undefined, control.blocks, preprocessed.parameters,
    [...control.warnings, ...preprocessed.warnings], preprocessed.controlConstants, preprocessed.atTemperature, preprocessed.withParameters);
}

/**
 * Split off the title line and take out the control blocks, which must not
 * reach `.param` preprocessing: it would read their `{$var}` references as
 * numparam expressions. The body starts on line 2 of the caller's netlist.
 */
function splitTitledDeck(netlist: string): { title: string; control: ReturnType<typeof extractControlBlocks> } {
  const newline = netlist.indexOf('\n');
  const title = newline < 0 ? netlist : netlist.slice(0, newline);
  const body = translateMicroSign(newline < 0 ? '' : netlist.slice(newline + 1));
  return { title, control: extractControlBlocks(body, false, 1) };
}

function parseNetlist(
  netlist: string,
  firstLineIsTitle: boolean,
  guard?: ProtocolExecutionGuard,
  extractedBlocks: ControlSourceBlock[] = [],
  parameters: Record<string, number | string> = {},
  controlWarnings: ControlSourceWarning[] = [],
  controlConstants: Record<string, number> = {},
  atTemperature?: PreprocessedDeck['atTemperature'],
  withParameters?: PreprocessedDeck['withParameters'],
): Circuit {
  // ngspice control-language lines are not netlist cards; read them from the raw text.
  const extracted = extractControlBlocks(translateMicroSign(netlist, firstLineIsTitle), firstLineIsTitle);
  const controlBlocks = [...extractedBlocks, ...extracted.blocks];
  // Validate hoisted pre_set loading effects before setting up the circuit.
  for (const block of controlBlocks) {
    for (const line of block.lines) if (commandName(line.text) === 'pre_set') validatePreSet(line);
  }
  const controlStartLine = controlBlocks[0]?.startLine;
  const lines = tokenizeNetlist(extracted.netlist, { firstLineIsTitle }).map(withGndAsGround);
  const circuit = new Circuit();
  circuit.setParameters(parameters);
  // ngspice-47 inserts `.global gnd`; it only matters for a `gnd` that
  // inp_fix_gnd_name left in place (#772).
  if (lines.some(line => hasGndToken(line.tokens))) circuit.addGlobalNodes(['gnd']);
  for (const warning of [...controlWarnings, ...extracted.warnings]) circuit.addParseWarning(warning.message);

  let subcktCollector: (SubcircuitHeader & { body: string[]; bodyLines: number[]; depth: number }) | null = null;
  let hasNoiseAnalysis = false;
  let hasPoleZeroAnalysis = false;
  let hasSensitivityAnalysis = false;
  let hasDistortionAnalysis = false;
  let hasStepAnalysis = false;
  let directiveTemperature: number | undefined;
  // Index in circuit.analyses where the control block sits among the dot cards.
  let controlAnalysisIndex: number | undefined;

  for (const { tokens, lineNumber, raw } of lines) {
    guard?.checkpoint('parse:line');
    if (tokens.length === 0) continue;
    const first = tokens[0].toUpperCase();
    if (controlAnalysisIndex === undefined && controlStartLine !== undefined && lineNumber > controlStartLine) {
      controlAnalysisIndex = circuit.analyses.length;
    }

    try {
      // Inside a .subckt — collect raw lines until .ends
      if (subcktCollector !== null) {
        if (first === '.SUBCKT') {
          subcktCollector.depth++;
          subcktCollector.body.push(raw);
          subcktCollector.bodyLines.push(lineNumber);
        } else if (first === '.ENDS') {
          if (subcktCollector.depth > 0) {
            subcktCollector.depth--;
            subcktCollector.body.push(raw);
            subcktCollector.bodyLines.push(lineNumber);
          } else {
            circuit.addSubcircuit({
              name: subcktCollector.name,
              ports: subcktCollector.ports,
              params: subcktCollector.params,
              body: subcktCollector.body,
              bodyLines: subcktCollector.bodyLines,
            });
            subcktCollector = null;
          }
        } else {
          // Subcircuit bodies are compiled later; reject unsupported model types now,
          // while the source line is still known.
          if (first === '.MODEL') {
            if (isPspiceSwitchModel(tokens)) {
              // Values in body model expressions require the instance scope.
              if (!raw.includes('{')) translatePspiceSwitchModel(raw, lineNumber);
            } else if (xspiceModelType(tokens) !== undefined) {
              // Keep local code models in the body for instance-scoped resolution.
              // Parameter expressions can only be checked after expansion.
              if (!raw.includes('{')) parseXspiceModelCard(raw, lineNumber);
            } else {
              assertSupportedModelType(tokens, lineNumber, raw);
              if (!raw.includes('{')) assertSupportedResistorModel(tokens, lineNumber, raw);
            }
          }
          subcktCollector.body.push(raw);
          subcktCollector.bodyLines.push(lineNumber);
        }
        continue;
      }

      if (first === '.SUBCKT') {
        subcktCollector = { ...parseSubcircuitHeader(raw), body: [], bodyLines: [], depth: 0 };
        continue;
      }

      if (first.startsWith('.')) {
        const temperatureCard = tempDirective(raw, lineNumber);
        if (temperatureCard !== undefined) {
          directiveTemperature = temperatureCard.value;
          if (temperatureCard.warning) circuit.addParseWarning(temperatureCard.warning);
          continue;
        }
        if ((first === '.NOISE' && hasStepAnalysis) || (first === '.STEP' && hasNoiseAnalysis)) {
          throw new ParseError(
            '.step cannot be combined with .noise',
            lineNumber,
            raw,
          );
        }
        if ((first === '.PZ' && hasStepAnalysis) || (first === '.STEP' && hasPoleZeroAnalysis)) {
          throw new ParseError(
            '.step cannot be combined with .pz',
            lineNumber,
            raw,
          );
        }
        if ((first === '.SENS' && hasStepAnalysis) || (first === '.STEP' && hasSensitivityAnalysis)) {
          throw new ParseError(
            '.step cannot be combined with .sens',
            lineNumber,
            raw,
          );
        }
        if ((first === '.DISTO' && hasStepAnalysis) || (first === '.STEP' && hasDistortionAnalysis)) {
          throw new ParseError(
            '.step cannot be combined with .disto',
            lineNumber,
            raw,
          );
        }
        if (first === '.NOISE') hasNoiseAnalysis = true;
        if (first === '.PZ') hasPoleZeroAnalysis = true;
        if (first === '.SENS') hasSensitivityAnalysis = true;
        if (first === '.DISTO' && hasDistortionAnalysis) {
          throw new ParseError('Multiple .disto analyses are not supported', lineNumber, raw);
        }
        if (first === '.DISTO') hasDistortionAnalysis = true;
        if (first === '.STEP' && hasStepAnalysis) {
          throw new ParseError(
            'Multiple .step directives are not supported; nested or multi-dimensional stepping is unsupported',
            lineNumber,
            raw,
          );
        }
        if (first === '.STEP') hasStepAnalysis = true;
        parseDotCommand(circuit, tokens, lineNumber, raw);
      } else {
        parseDevice(circuit, tokens, lineNumber, raw);
      }
    } catch (e) {
      if (e instanceof ParseError) throw e;
      throw new ParseError((e as Error).message, lineNumber, raw);
    }
  }

  // inp.c inp_spsource sets .temp only after inp_dodeck has applied .options.
  if (directiveTemperature !== undefined) circuit.setTemperature(directiveTemperature);
  if (controlBlocks.length > 0) {
    const script = parseControlScript(controlBlocks);
    script.constants = controlConstants;
    attachControlScript(circuit, script, controlAnalysisIndex, hasStepAnalysis);
  }
  assertMaxOrderIsNoOp(circuit);

  if (atTemperature) circuit.reparseAtTemperature = celsius => {
    const deck = atTemperature(celsius);
    const title = firstLineIsTitle ? `${netlist.split('\n', 1)[0]}\n` : '';
    const evaluated = parseNetlist(`${title}${deck.text}`, firstLineIsTitle, guard,
      [], deck.parameters, [], deck.controlConstants);
    evaluated.setTemperature(celsius);
    return evaluated;
  };
  if (circuit.reparseAtTemperature) circuit.recompileAtTemperature = celsius =>
    circuit.reparseAtTemperature!(celsius).compile(guard);

  if (withParameters) circuit.reparseWithParameters = (changes, seed) => {
    const deck = withParameters(changes, seed);
    const title = firstLineIsTitle ? `${netlist.split('\n', 1)[0]}\n` : '';
    return parseNetlist(`${title}${deck.text}`, firstLineIsTitle, guard, controlBlocks,
      deck.parameters, controlWarnings, deck.controlConstants, deck.atTemperature, deck.withParameters);
  };
  return circuit;
}

/** A joined card with node `gnd` renamed to ground as ngspice-47 does (#772). */
function withGndAsGround(line: ParsedLine): ParsedLine {
  const raw = fixGndName(line.raw);
  return raw === line.raw ? line : { ...line, raw, tokens: tokenizeLine(raw) };
}

/**
 * Lower a straight-line control script onto the circuit's analyses (#489), or
 * attach it for the interpreter after checking its literal analysis commands.
 */
function attachControlScript(
  circuit: Circuit,
  script: ControlScript,
  insertionIndex: number | undefined,
  hasStepAnalysis: boolean,
): void {
  const dotTypes = new Set(circuit.analyses.map(analysis => analysis.type as string));
  const lowered = lowerControlScript(script, dotTypes);
  if (lowered !== null) {
    const dotAnalyses = circuit.analyses.splice(0);
    for (const { dotCardTokens, lineNumber, context } of lowered) {
      parseAnalysisCard(circuit, dotCardTokens, lineNumber, context);
    }
    const controlAnalyses = circuit.analyses.splice(0);
    const index = insertionIndex ?? dotAnalyses.length;
    circuit.analyses.push(...dotAnalyses.slice(0, index), ...controlAnalyses, ...dotAnalyses.slice(index));
    return;
  }
  const first = script.statements[0]?.line;
  if (hasStepAnalysis && first) {
    throw new UnsupportedControlCommandError(
      commandName(first.text),
      'an interpreted .control script cannot be combined with .step',
      first.lineNumber,
      first.text,
    );
  }
  forEachControlCommand(script.statements, (name, line) => {
    if (!CONTROL_ANALYSIS_COMMANDS.has(name) || /[$`{]/.test(line.text)) return;
    const tokens = tokenizeNetlist(line.text)[0]?.tokens ?? [];
    parseControlAnalysisCard([`.${name.toUpperCase()}`, ...tokens.slice(1)], line.lineNumber, line.text);
  });
  circuit.setControlScript(script);
}

function forEachControlCommand(
  statements: ControlStatement[],
  visit: (name: string, line: ControlSourceLine) => void,
): void {
  for (const statement of statements) {
    switch (statement.kind) {
      case 'command': visit(statement.name, statement.line); break;
      case 'if':
        forEachControlCommand(statement.then, visit);
        forEachControlCommand(statement.otherwise, visit);
        break;
      case 'while': case 'dowhile': case 'repeat': case 'foreach':
        forEachControlCommand(statement.body, visit);
        break;
      default:
        break;
    }
  }
}

function parseAnalysisCard(circuit: Circuit, tokens: string[], lineNumber: number, context: string): void {
  try {
    parseDotCommand(circuit, tokens, lineNumber, context);
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError((e as Error).message, lineNumber, context);
  }
}

/**
 * @internal Parse an analysis given as dot-card tokens (`['.TRAN', '1n', '1u']`)
 * for the control-language interpreter.
 */
export function parseControlAnalysisCard(tokens: string[], lineNumber: number, context: string): AnalysisDirective | PoleZeroAnalysis {
  const scratch = new Circuit();
  parseAnalysisCard(scratch, tokens, lineNumber, context);
  const analysis = scratch.analyses[0] ?? scratch.poleZeroAnalyses[0];
  if (!analysis) throw new ParseError(`'${tokens[0].toLowerCase()}' did not define an analysis`, lineNumber, context);
  return analysis;
}

/** @internal Parse `.options` tokens for the control-language `option`/`set` commands. */
export function parseControlOptions(tokens: string[], lineNumber: number, context: string, circuit?: Circuit): SimulationOptions {
  try {
    // Control splitWords retains spaces around '='; normalize assignments
    // with the same tokenizer as dot cards (e.g. `option xmu = 0.49`).
    const fields = splitXyceOptionPackage(tokenizeLine(tokens.join(' '))).fields;
    const temperature = circuit ? takeCircuitTemperatureOption(fields, lineNumber, context) : undefined;
    const nominalTemperature = circuit ? takeCircuitTemperatureOption(fields, lineNumber, context, 'tnom') : undefined;
    const options = parseSimulationOptions(fields, lineNumber, context);
    if (temperature !== undefined) circuit!.setTemperature(temperature);
    if (nominalTemperature !== undefined) circuit!.setNominalTemperature(nominalTemperature);
    return options;
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError((e as Error).message, lineNumber, context);
  }
}

/**
 * Parse a SPICE netlist with async resolution of `.include` and `.lib` directives.
 *
 * Preprocesses the netlist first (resolving includes, `.param` substitution,
 * expression evaluation), then delegates to {@link parse}.
 *
 * @param netlist - SPICE netlist text, possibly containing `.include`/`.lib` directives
 * @param resolver - Async function that returns file contents given a path
 * @returns A {@link Circuit} ready for compilation and simulation
 * @throws {@link ParseError} if the netlist contains syntax errors
 * @throws {@link CycleError} if `.include`/`.lib` directives form a circular dependency
 * @example
 * ```ts
 * const circuit = await parseAsync(netlist, async (path) => {
 *   return await fs.readFile(path, 'utf-8');
 * });
 * ```
 */
export async function parseAsync(
  netlist: string,
  resolver?: IncludeResolver,
): Promise<Circuit> {
  const { title, control } = splitTitledDeck(netlist);
  const preprocessed = await preprocessDeck(control.netlist, resolver, undefined, 1);
  const circuit = parseNetlist(
    `${title}\n${preprocessed.text}`, true, undefined, control.blocks, preprocessed.parameters,
    [...control.warnings, ...preprocessed.warnings], preprocessed.controlConstants, preprocessed.atTemperature, preprocessed.withParameters,
  );
  await circuit.resolveXspiceFiles(resolver);
  return circuit;
}

/** Parse and preprocess a title-less SPICE fragment. */
export async function parseTitlelessAsync(
  netlist: string,
  resolver?: IncludeResolver,
  guard?: ProtocolExecutionGuard,
): Promise<Circuit> {
  const control = extractControlBlocks(translateMicroSign(netlist), false);
  const preprocessed = await preprocessDeck(control.netlist, resolver, guard, 0);
  const circuit = parseNetlist(preprocessed.text, false, guard, control.blocks, preprocessed.parameters,
    [...control.warnings, ...preprocessed.warnings], preprocessed.controlConstants, preprocessed.atTemperature, preprocessed.withParameters);
  await circuit.resolveXspiceFiles(resolver);
  return circuit;
}

const OUTPUT_ONLY_OPTION_FLAGS = new Set([
  'nopage', 'acct', 'noacct', 'list', 'node', 'post', 'trans', 'noinit', 'seedinfo',
  // ngspice-47 spiceif.c if_option: ft_nomod only skips com_showmod in the
  // printed operating-point report (dotcards.c).
  'nomod',
]);
/** ngspice's default TNOM (REFTEMP) in degrees Celsius. */
const DEFAULT_NOMINAL_TEMPERATURE = 27;
const BEHAVIOR_CHANGING_GNUCAP_OPTIONS = new Set([
  'cstray', 'dampstrategy', 'itermin', 'nobypass', 'noincmode', 'rstray', 'trsteporder',
]);

function parseDotCommand(
  circuit: Circuit,
  tokens: string[],
  lineNumber: number,
  context: string,
): void {
  const cmd = tokens[0].toUpperCase();

  switch (cmd) {
    case '.OP': {
      const args = stripGnucapTraceSuffix(tokens.slice(1), '.op', ['ITER'], lineNumber, context);
      if (args.length > 0) {
        throw new ParseError(`Unsupported .op arguments: '${args.join(' ')}'`, lineNumber, context);
      }
      circuit.addAnalysis('op');
      break;
    }
    case '.DC': {
      if (tokens.length !== 5 && tokens.length !== 9) {
        throw new ParseError(
          "Invalid .dc sweep; expected '.dc source start stop step [source2 start2 stop2 step2]'",
          lineNumber,
          context,
        );
      }
      const source = tokens[1];
      const start = parseNumber(tokens[2]);
      const stop = parseNumber(tokens[3]);
      const step = parseNumber(tokens[4]);
      const secondary = tokens.length === 9 ? {
        source: tokens[5],
        start: parseNumber(tokens[6]),
        stop: parseNumber(tokens[7]),
        step: parseNumber(tokens[8]),
      } : undefined;
      circuit.addAnalysis('dc', { source, start, stop, step, secondary });
      break;
    }
    case '.TRAN': {
      if (tokens.length < 3) {
        throw new ParseError(
          ".tran requires TSTEP and TSTOP; expected '.tran tstep tstop [tstart [tmax]] [uic]'",
          lineNumber, context,
        );
      }
      const timestep = parseNumber(tokens[1]);
      const stopTime = parseNumber(tokens[2]);
      const args = stripGnucapTraceSuffix(
        tokens.slice(3), '.tran', ['ALL', 'REJECTED'], lineNumber, context,
      );
      const uicIndex = args.findIndex(token => token.toUpperCase() === 'UIC');
      const useInitialConditions = uicIndex >= 0;
      if (uicIndex >= 0) args.splice(uicIndex, 1);
      if (args.length > 2) {
        throw new ParseError(`Unsupported .tran arguments: '${args.slice(2).join(' ')}'`, lineNumber, context);
      }
      const startTime = args[0] ? parseNumber(args[0]) : undefined;
      const maxTimestep = args[1] ? parseNumber(args[1]) : undefined;
      circuit.addAnalysis('tran', {
        timestep, stopTime, startTime, maxTimestep, useInitialConditions,
      });
      break;
    }
    case '.IC':
      parseNodeInitialState(circuit, 'ic', tokens, lineNumber);
      break;
    case '.NODESET':
      parseNodeInitialState(circuit, 'nodeset', tokens, lineNumber);
      break;
    case '.AC': {
      if (tokens.length < 5) {
        throw new ParseError(
          ".ac requires '.ac {dec|oct|lin} points fstart fstop'", lineNumber, context,
        );
      }
      const variation = tokens[1].toLowerCase() as 'dec' | 'oct' | 'lin';
      const points = parseInt(tokens[2], 10);
      const startFreq = parseNumber(tokens[3]);
      const stopFreq = parseNumber(tokens[4]);
      circuit.addAnalysis('ac', { variation, points, startFreq, stopFreq });
      break;
    }
    case '.SP': {
      // ngspice-47 inp2dot.c dot_sp: {DEC|OCT|LIN} points fstart fstop [donoise].
      const variation = tokens[1]?.toLowerCase();
      if ((tokens.length !== 5 && tokens.length !== 6)
          || (variation !== 'lin' && variation !== 'dec' && variation !== 'oct')) {
        throw new ParseError(
          "Unsupported .sp form; expected '.sp {dec|oct|lin} points fstart fstop [donoise]'",
          lineNumber, context,
        );
      }
      const points = parseNumber(tokens[2]);
      const startFreq = parseNumber(tokens[3]);
      const stopFreq = parseNumber(tokens[4]);
      if (!Number.isInteger(points) || points < 1 || !(startFreq >= 0) || !(stopFreq >= startFreq)
          || (variation !== 'lin' && startFreq <= 0)) {
        throw new ParseError(`Invalid .sp ${variation} sweep`, lineNumber, context);
      }
      const noise = tokens[5] === undefined ? false : parseNumber(tokens[5]) === 1;
      circuit.addAnalysis('sp', { variation, points, startFreq, stopFreq, noise });
      break;
    }
    case '.NOISE': {
      const isDifferential = tokens[5] === ')';
      const sourceIndex = isDifferential ? 6 : 5;
      const variationIndex = sourceIndex + 1;
      const variation = tokens[variationIndex]?.toLowerCase();
      const baseTokenCount = variationIndex + 4;
      const isSupportedVoltageForm = (tokens.length === baseTokenCount || tokens.length === baseTokenCount + 1)
        && tokens[1].toUpperCase() === 'V'
        && tokens[2] === '('
        && tokens[isDifferential ? 5 : 4] === ')'
        && (variation === 'lin' || variation === 'dec' || variation === 'oct');
      if (!isSupportedVoltageForm) {
        throw new ParseError(
          "Unsupported .noise form; expected '.noise v(node) source {lin|dec|oct} points start stop [points_per_summary]'",
          lineNumber, tokens.join(' '),
        );
      }
      const points = parseInt(tokens[variationIndex + 1], 10);
      const startFreq = parseNumber(tokens[variationIndex + 2]);
      const stopFreq = parseNumber(tokens[variationIndex + 3]);
      const pointsPerSummary = tokens[variationIndex + 4] === undefined
        ? undefined
        : parseNumber(tokens[variationIndex + 4]);
      const minimumPoints = variation === 'lin' ? 2 : 1;
      if (!Number.isInteger(points) || points < minimumPoints || startFreq <= 0 || stopFreq < startFreq) {
        throw new ParseError(`Invalid .noise ${variation} sweep`, lineNumber, tokens.join(' '));
      }
      if (pointsPerSummary !== undefined
          && (!Number.isInteger(pointsPerSummary) || pointsPerSummary < 1)) {
        throw new ParseError(
          'Invalid .noise points_per_summary; expected a positive integer',
          lineNumber, tokens.join(' '),
        );
      }
      circuit.addAnalysis('noise', {
        outputNode: tokens[3],
        ...(isDifferential ? { outputReferenceNode: tokens[4] } : {}),
        inputSource: tokens[sourceIndex],
        variation: variation as 'dec' | 'oct' | 'lin',
        points,
        startFreq,
        stopFreq,
        ...(pointsPerSummary === undefined ? {} : { pointsPerSummary }),
      });
      break;
    }
    case '.DISTO': {
      if (tokens.length < 5 || tokens.length > 6) {
        throw new ParseError(
          "Unsupported .disto sweep; expected '.disto dec points start stop [f2overf1]'",
          lineNumber, tokens.join(' '),
        );
      }
      if (tokens[1]?.toLowerCase() !== 'dec') {
        throw new ParseError(
          "Unsupported .disto sweep; expected '.disto dec points start stop'",
          lineNumber, tokens.join(' '),
        );
      }
      const points = Math.round(parseNumber(tokens[2]));
      const startFreq = parseNumber(tokens[3]);
      const stopFreq = parseNumber(tokens[4]);
      if (!Number.isInteger(points) || points < 1 || startFreq <= 0 || stopFreq < startFreq) {
        throw new ParseError('Invalid .disto dec sweep', lineNumber, tokens.join(' '));
      }
      const f2OverF1 = tokens[5] === undefined ? undefined : parseNumber(tokens[5]);
      if (f2OverF1 !== undefined && (!Number.isFinite(f2OverF1)
          || f2OverF1 <= 0 || f2OverF1 >= 1)) {
        throw new ParseError(
          'Invalid .disto f2overf1; expected a value greater than 0 and less than 1',
          lineNumber, tokens.join(' '),
        );
      }
      circuit.addAnalysis('disto', {
        variation: 'dec', points, startFreq, stopFreq,
        ...(f2OverF1 === undefined ? {} : { f2OverF1 }),
      });
      break;
    }
    case '.TF': {
      if (tokens[1]?.toUpperCase() === 'I') {
        const isSourceCurrentForm = tokens.length === 6
          && tokens[2] === '('
          && tokens[4] === ')';
        if (!isSourceCurrentForm) {
          const message = tokens.slice(3, -2).some(token => token === '(' || token === ')')
            ? ".tf nested current output is not supported; expected '.tf i(source) input'"
            : "Unsupported .tf current output; expected '.tf i(source) input'";
          throw new ParseError(message, lineNumber, tokens.join(' '));
        }
        circuit.addAnalysis('tf', {
          outputSource: tokens[3],
          inputSource: tokens[5],
        });
        break;
      }
      // Commas are discarded by the tokenizer; retain empty-component validation.
      const voltageNodes = context.match(/^\s*\.tf\s+v\s*\(([^()]*)\)/i)?.[1];
      const hasEmptyComponent = voltageNodes?.split(',').some(node => node.trim() === '') ?? false;
      const isVoltageForm = !hasEmptyComponent && (tokens.length === 6 || tokens.length === 7)
        && tokens[1]?.toUpperCase() === 'V'
        && tokens[2] === '('
        && tokens[tokens.length - 2] === ')'
        && tokens.slice(3, -2).every(token => token !== '(' && token !== ')');
      if (!isVoltageForm) {
        throw new ParseError(
          "Unsupported .tf voltage output; expected '.tf v(node[,reference]) source'",
          lineNumber, tokens.join(' '),
        );
      }
      circuit.addAnalysis('tf', {
        outputNode: tokens[3],
        ...(tokens.length === 7 ? { outputReferenceNode: tokens[4] } : {}),
        inputSource: tokens[tokens.length - 1],
      });
      break;
    }
    case '.PZ':
      circuit.addAnalysis('pz', parsePoleZero(tokens, lineNumber));
      break;
    case '.SENS': {
      const analysis = parseSensitivity(tokens, lineNumber);
      if (analysis.mode === 'dc') {
        circuit.addAnalysis('sens', {
          ...(analysis.outputType ? { outputType: analysis.outputType } : {}),
          outputNode: analysis.outputNode,
          outputReferenceNode: analysis.outputReferenceNode,
          mode: 'dc',
        });
      } else {
        circuit.addAnalysis('sens', {
          ...(analysis.outputType ? { outputType: analysis.outputType } : {}),
          outputNode: analysis.outputNode,
          outputReferenceNode: analysis.outputReferenceNode,
          mode: 'ac',
          variation: analysis.variation,
          points: analysis.points,
          startFreq: analysis.startFreq,
          stopFreq: analysis.stopFreq,
        });
      }
      break;
    }
    case '.MODEL': {
      let modelTokens = tokens;
      if (isPspiceSwitchModel(tokens)) {
        const translated = translatePspiceSwitchModel(context, lineNumber);
        if (translated.kind === 'xspice') {
          circuit.addXspiceModel(translated.card);
          break;
        }
        modelTokens = tokenizeLine(translated.raw);
      }
      if (xspiceModelType(modelTokens) !== undefined) {
        circuit.addXspiceModel(parseXspiceModelCard(context, lineNumber));
        break;
      }
      assertSupportedModelType(modelTokens, lineNumber, context);
      assertSupportedResistorModel(modelTokens, lineNumber, context);
      const model = parseTransmissionLineModelCard(modelTokens, lineNumber)
        ?? parseModelCard(modelTokens, lineNumber, message => circuit.addParseWarning(message));
      circuit.addModel(model);
      break;
    }
    case '.GLOBAL':
      circuit.addGlobalNodes(tokens.slice(1));
      break;
    case '.OPT':
    case '.OPTION':
    case '.OPTIONS': {
      const { fields: optionTokens, warning } = splitXyceOptionPackage(takeFourierOptions(circuit, tokens.slice(1)));
      if (warning !== undefined) circuit.addParseWarning(warning);
      const temperature = takeCircuitTemperatureOption(optionTokens, lineNumber, context);
      const nominalTemperature = takeCircuitTemperatureOption(optionTokens, lineNumber, context, 'tnom');
      const xspiceTrtol = takeXspiceTrtolOption(optionTokens, lineNumber, context);
      circuit.setSimulationOptions(parseSimulationOptions(optionTokens, lineNumber, context, {
        warn: message => circuit.addParseWarning(message),
        maxOrder: order => {
          if (order > 3) pendingMaxOrders.set(circuit, { order, lineNumber, context });
          else pendingMaxOrders.delete(circuit);
        },
      }));
      if (temperature !== undefined) circuit.setTemperature(temperature);
      if (nominalTemperature !== undefined) circuit.setNominalTemperature(nominalTemperature);
      if (xspiceTrtol !== undefined) circuit.setXspiceTrtol(xspiceTrtol);
      break;
    }
    case '.LIST':
      requireGnucapOutputDirective(tokens.length === 1, '.list', lineNumber, context);
      break;
    case '.WIDTH': {
      requireGnucapOutputDirective(
        tokens.length > 1 && tokens.slice(1).every(token => {
          const match = token.match(/^(?:in|out)=(\d+)$/i);
          return match !== null && Number(match[1]) > 0;
        }),
        '.width {in|out}=<positive integer>',
        lineNumber,
        context,
      );
      break;
    }
    case '.STAT':
    case '.STATUS':
      requireGnucapOutputDirective(
        tokens.length === 1 || (tokens.length === 2 && tokens[1].toUpperCase() === 'NOTIME'),
        `${tokens[0]} [notime]`,
        lineNumber,
        context,
      );
      break;
    case '.SAVE':
      // spice-ts returns all computed vectors through its result API, so this
      // ngspice output-selection directive is metadata-only.
      break;
    case '.PRINT':
    case '.PLOT':
      // Metadata-only like .save. ngspice-47 numparam leaves their braces
      // unsubstituted and its print command cannot parse them either, so the
      // analyses run unchanged; each brace expression is reported (#714).
      for (const expression of context.match(/\{[^}]*\}/g) ?? []) {
        circuit.addParseWarning(
          `.print/.plot expression '${expression}' is not evaluated: spice-ts returns every computed vector, ` +
          'and ngspice-47 does not substitute braces on output cards either',
        );
      }
      break;
    case '.MEAS':
    case '.MEASURE': {
      // Evaluated after the analyses run (ngspice do_measure); ngspice numbers
      // the par() B-sources deck-wide.
      const firstPar = measureCards(circuit).reduce((count, card) => count + card.parSources.length, 0);
      const card = measureCard(context, lineNumber, firstPar);
      for (const source of card.parSources) {
        try {
          const parsed = parseBehavioralSourceCard(source, lineNumber);
          circuit.addBehavioralVoltageSource(parsed.name, parsed.nodes[0], parsed.nodes[1], parsed.expression, parsed.params);
        } catch (error) {
          throw new UnsupportedMeasureError(
            `the par() operand needs the B-source '${source}', which spice-ts cannot build: ${(error as Error).message}`,
            lineNumber,
            context,
          );
        }
      }
      addMeasureCard(circuit, card);
      break;
    }
    case '.PROBE':
      // .probe selects raw-file vectors in ngspice, and ngspice-47 treats a
      // bare .probe as `.probe alli` (#790). spice-ts returns every computed
      // vector through its result API, so the request does not narrow results.
      break;
    case '.FOUR':
    case '.FOURIER': {
      addFourierCard(circuit, context, lineNumber);
      break;
    }
    case '.INCLUDE':
      throw new ParseError(
        '.include directive requires async parsing. Use parseAsync() with a resolveInclude option.',
        lineNumber, tokens.join(' '),
      );
    case '.LIB':
      throw new ParseError(
        '.lib directive requires async parsing. Use parseAsync() with a resolveInclude option.',
        lineNumber, tokens.join(' '),
      );
    case '.STEP': {
      let idx = 1;
      let sweepMode: 'lin' | 'dec' | 'oct' = 'lin';
      const modeToken = tokens[idx].toUpperCase();
      if (modeToken === 'DEC' || modeToken === 'OCT') {
        sweepMode = modeToken.toLowerCase() as 'dec' | 'oct';
        idx++;
      }
      if (tokens[idx].toUpperCase() === 'PARAM') idx++;
      const paramName = tokens[idx++];
      if (tokens[idx] && tokens[idx].toUpperCase() === 'LIST') {
        idx++;
        const values: number[] = [];
        for (; idx < tokens.length; idx++) {
          values.push(parseNumber(tokens[idx]));
        }
        if (paramName.toUpperCase() === 'TEMP' && values.length === 0) {
          throw new ParseError(
            '.step TEMP LIST requires at least one value',
            lineNumber,
            context,
          );
        }
        circuit.addStep(paramName, { values });
      } else {
        const start = parseNumber(tokens[idx++]);
        const stop = parseNumber(tokens[idx++]);
        if (sweepMode === 'lin') {
          circuit.addStep(paramName, { mode: 'lin', start, stop, step: parseNumber(tokens[idx]) });
        } else {
          circuit.addStep(paramName, { mode: sweepMode, start, stop, points: parseInt(tokens[idx], 10) });
        }
      }
      break;
    }
    default:
      throw new ParseError(
        `Unsupported dot command: '${tokens[0]}'`,
        lineNumber, tokens.join(' '),
      );
  }
}

function requireGnucapOutputDirective(
  valid: boolean,
  expected: string,
  lineNumber: number,
  context: string,
): void {
  if (!valid) {
    throw new ParseError(
      `Unsupported Gnucap output directive; expected '${expected}'`,
      lineNumber,
      context,
    );
  }
}

function stripGnucapTraceSuffix(
  args: string[],
  analysis: '.op' | '.tran',
  allowedModes: string[],
  lineNumber: number,
  context: string,
): string[] {
  const traceIndex = args.findIndex(token => token.toUpperCase() === 'TRACE');
  const hasRejectedWithoutTrace = traceIndex < 0
    && args.some(token => token.toUpperCase() === 'REJECTED');
  if (hasRejectedWithoutTrace) {
    throw new ParseError(`Unsupported ${analysis} trace arguments`, lineNumber, context);
  }
  if (traceIndex < 0) return args;

  const mode = args[traceIndex + 1]?.toUpperCase();
  if (traceIndex !== args.length - 2 || !mode || !allowedModes.includes(mode)) {
    throw new ParseError(`Unsupported ${analysis} trace arguments`, lineNumber, context);
  }
  return args.slice(0, traceIndex);
}

/**
 * Remove TEMP or TNOM fields from `.options` tokens (in place), returning the
 * last value. TEMP selects operating temperature; TNOM defaults model nominal
 * temperature. Both are Celsius and default to 27 C when absent.
 */
function takeCircuitTemperatureOption(
  tokens: string[],
  lineNumber: number,
  context: string,
  optionName: 'temp' | 'tnom' = 'temp',
): number | undefined {
  let temperature: number | undefined;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    const separator = token.indexOf('=');
    const name = token.slice(0, separator < 0 ? token.length : separator).toLowerCase();
    if (name !== optionName) continue;
    const rawValue = separator < 0 ? '' : token.slice(separator + 1);
    const value = rawValue === '' ? Number.NaN : parseNumber(rawValue);
    if (!Number.isFinite(value) || value <= -273.15) {
      throw new ParseError(`Invalid .options ${optionName} value: '${rawValue}'`, lineNumber, context);
    }
    // The last field wins, as with every other repeated .options field.
    temperature ??= value;
    tokens.splice(index, 1);
  }
  return temperature;
}

/**
 * Remove ngspice `XTRTOL=<n>` fields from `.options` tokens (in place) and
 * return the last value. ngspice-47 inp.c turns every `.options` field into a
 * circuit variable; cktdojob.c reads `xtrtol` with cp_getvar(CP_NUM), which
 * truncates a real value to int, as the trtol of a circuit with 'A' devices.
 * A value that truncates below 1 (ngspice then runs with trtol 0 and fails) or
 * is not a number (ngspice silently falls back to 1) is rejected.
 */
function takeXspiceTrtolOption(
  tokens: string[],
  lineNumber: number,
  context: string,
): number | undefined {
  let trtol: number | undefined;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    const separator = token.indexOf('=');
    const name = token.slice(0, separator < 0 ? token.length : separator).toLowerCase();
    if (name !== 'xtrtol') continue;
    const rawValue = separator < 0 ? '' : token.slice(separator + 1);
    const value = rawValue === '' ? Number.NaN : Math.trunc(parseNumber(rawValue));
    if (!Number.isFinite(value) || value < 1) {
      throw new ParseError(`Invalid .options xtrtol value: '${rawValue}'`, lineNumber, context);
    }
    trtol ??= value;
    tokens.splice(index, 1);
  }
  return trtol;
}

interface SimulationOptionHooks {
  /** Receive a non-fatal parse diagnostic. */
  warn?(message: string): void;
  /**
   * Receive an accepted ngspice MAXORD (1..6). Without this hook, orders above
   * 2 are rejected because their effect depends on the deck's final METHOD.
   */
  maxOrder?(order: number): void;
}

interface PendingMaxOrder {
  readonly order: number;
  readonly lineNumber: number;
  readonly context: string;
}

/** The last MAXORD above 3 of each circuit being parsed, checked after the last card. */
const pendingMaxOrders = new WeakMap<Circuit, PendingMaxOrder>();

/**
 * ngspice-47 dctran.c raises the trapezoidal order only from 1 to 2, so any
 * MAXORD >= 2 leaves METHOD=TRAP unchanged. With METHOD=GEAR, MAXORD above 3
 * enables Gear orders spice-ts does not implement. The API method name remains
 * gear2 for compatibility; MAXORD=3 enables the shared BDF3 integration path.
 */
function assertMaxOrderIsNoOp(circuit: Circuit): void {
  const pending = pendingMaxOrders.get(circuit);
  pendingMaxOrders.delete(circuit);
  if (pending === undefined || circuit.simulationOptions.integrationMethod !== 'gear2') return;
  throw new ParseError(
    `Unsupported .options maxord=${pending.order} with method=gear (spice-ts implements Gear orders 1 through 3 only)`,
    pending.lineNumber,
    pending.context,
  );
}

/** cp_setparse() reads a numeric word as a number, which the string METHOD option rejects. */
const NUMERIC_OPTION_VALUE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function parseSimulationOptions(
  tokens: string[],
  lineNumber: number,
  context: string,
  hooks: SimulationOptionHooks = {},
): SimulationOptions {
  const optionTokens = tokens.filter(value => value !== '(' && value !== ')');

  const options: SimulationOptions = {};
  const unrecognised: string[] = [];
  const obsoleteNumericFields = new Set(['limpts', 'itl5', 'lvlcod']);

  for (const token of optionTokens) {
    const separator = token.indexOf('=');
    const name = token.slice(0, separator < 0 ? token.length : separator).toLowerCase();
    if (name === 'savecurrents' || name === 'autostop' || name === 'interp') {
      // These are ngspice boolean flags, not numeric or string-valued options.
      if (separator >= 0) throw new ParseError(`Unsupported .options field: '${token}'`, lineNumber, context);
      options[name] = true;
      continue;
    }
    if (OUTPUT_ONLY_OPTION_FLAGS.has(name) && separator < 0) continue;
    if (name === 'ngbehavior') {
      options.ngbehavior = parseNgbehavior(separator < 0 ? '' : token.slice(separator + 1), lineNumber, context);
      continue;
    }
    if (name === 'klu' || name === 'sparse') {
      if (separator >= 0) {
        throw new ParseError(`Unsupported .options field: '${token}'`, lineNumber, context);
      }
      // Compatibility hint only. Every native analysis retains its sparse LU path.
      options.solverSelection = name;
      continue;
    }
    if (isOutputOnlyGnucapOption(name, separator < 0 ? undefined : token.slice(separator + 1))) {
      continue;
    }
    if (BEHAVIOR_CHANGING_GNUCAP_OPTIONS.has(name)) {
      throw new ParseError(
        `Unsupported behavior-changing .options field: '${name}'`,
        lineNumber,
        context,
      );
    }
    if (!isNgspiceOptionField(token)) {
      // ngspice-47 if_option() silently returns for a name outside OPTtbl
      // that no cp_getvar() reads (WRspice `ysep`, ...), so the card runs (#790).
      unrecognised.push(token);
      continue;
    }
    if (separator <= 0 || separator === token.length - 1) {
      throw new ParseError(`Unsupported .options field: '${token}'`, lineNumber, context);
    }

    const rawValue = token.slice(separator + 1);
    if (name === 'xmu') {
      // ngspice-47 cktsopt.c:120-122 assigns XMU with no range check.
      const value = parseNumber(rawValue);
      if (!Number.isFinite(value)) throw new Error(`Invalid .options xmu value: '${rawValue}'`);
      options.xmu = value;
      continue;
    }
    if (name === 'scale') {
      options.scale = parseNumber(rawValue);
      continue;
    }
    if (name === 'tnom') {
      // ngspice-47 cktsopt.c: TNOM sets the default nominal temperature of every
      // model. Only its default, 27 C, is implemented circuit-wide.
      if (parseNumber(rawValue) === DEFAULT_NOMINAL_TEMPERATURE) continue;
      throw new ParseError(
        `Unsupported .options field: 'tnom' (spice-ts implements the default TNOM = 27 C only; got '${rawValue}')`,
        lineNumber,
        context,
      );
    }
    if (name === 'warn' || name === 'maxwarns' || name === 'bypass') {
      const value = parseNumber(rawValue);
      if (!Number.isInteger(value) || (name === 'bypass' && value < 0)) {
        throw new Error(`Invalid .options ${name} value: '${rawValue}'`);
      }
      // WARN/MAXWARNS only control ngspice's SOA diagnostics. BYPASS is
      // retained for serialization and an explicit native-solver warning.
      if (name === 'bypass') options.bypass = value;
      continue;
    }
    if (obsoleteNumericFields.has(name)) {
      const value = parseNumber(rawValue);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid .options ${name} value: '${rawValue}'`);
      }
      // LIMPTS limits legacy printed/plotted points, ITL5 is documented as
      // unimplemented in SPICE3, and LVLCOD selected CDC matrix codegen.
      continue;
    }
    if (name === 'seed') {
      // ngspice-47 inp.c: `seed=N` (atoi, N > 0) re-seeds the random streams;
      // `seed=random` seeds from the clock, which would make runs unrepeatable.
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) {
        throw new ParseError(
          `Unsupported .options seed value: '${rawValue}' (spice-ts needs a positive integer seed)`,
          lineNumber,
          context,
        );
      }
      options.seed = value;
      continue;
    }
    if (name === 'method') {
      if (NUMERIC_OPTION_VALUE.test(rawValue)) {
        // ngspice-47 if_option(): METHOD is IF_STRING, so a numeric value
        // (Xyce TIMEINT METHOD=7) is a "bad type" and the method is unchanged.
        hooks.warn?.(`Ignored .options method=${rawValue}: ngspice-47 rejects a numeric METHOD and keeps the current method`);
        continue;
      }
      const methods: Record<string, IntegrationMethod> = {
        trap: 'trapezoidal',
        gear: 'gear2',
      };
      const method = methods[rawValue.toLowerCase()];
      if (!method) throw new Error(`Unsupported .options method: '${rawValue}'`);
      options.integrationMethod = method;
      continue;
    }
    if (name === 'rshunt') {
      // ngspice-47 cktsopt.c OPT_ENH_RSHUNT: a value above 1e-30 enables the
      // node-to-ground shunts; anything else is ignored with a warning and
      // leaves an earlier RSHUNT in place.
      const value = parseNumber(rawValue);
      if (!Number.isFinite(value)) throw new Error(`Invalid .options rshunt value: '${rawValue}'`);
      if (value > 1e-30) options.rshunt = value;
      else hooks.warn?.(`Ignored .options rshunt=${rawValue}: ngspice-47 ignores an RSHUNT of at most 1e-30 ("Rshunt option too small")`);
      continue;
    }
    if (name === 'maxord') {
      const value = parseNumber(rawValue);
      if (!Number.isFinite(value)) throw new Error(`Invalid .options maxord value: '${rawValue}'`);
      // ngspice-47 if_option() rounds a real value; cktsopt.c clamps to 1..6.
      const order = Math.min(6, Math.max(1, Math.floor(value + 0.5)));

      if (order > 3 && hooks.maxOrder === undefined) {
        throw new ParseError(
          `Unsupported .options maxord=${order} outside a netlist .options card`,
          lineNumber,
          context,
        );
      }
      if (order > 3 && options.integrationMethod === 'gear2') {
        throw new ParseError(
          `Unsupported .options maxord=${order} with method=gear (spice-ts implements Gear orders 1 through 3 only)`,
          lineNumber,
          context,
        );
      }
      hooks.maxOrder?.(order);
      options.maxOrder = order;
      continue;
    }

    const mappings: Record<string, keyof SimulationOptions> = {
      abstol: 'abstol',
      vntol: 'vntol',
      reltol: 'reltol',
      gmin: 'deviceGmin',
      itl1: 'maxIterations',
      itl4: 'maxTransientIterations',
      trtol: 'trtol',
      chgtol: 'chgtol',
      ramptime: 'rampTime',
    };
    const target = mappings[name];
    if (!target) throw new ParseError(`Unsupported .options field: '${name}'`, lineNumber, context);

    const value = parseNumber(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid .options ${name} value: '${rawValue}'`);
    }
    if ((name === 'itl1' || name === 'itl4') && !Number.isInteger(value)) {
      throw new Error(`Invalid .options ${name} value: '${rawValue}'`);
    }
    Object.assign(options, { [target]: value });
  }

  if (unrecognised.length > 0) {
    hooks.warn?.(`Ignored .options fields ngspice-47 does not recognise: ${unrecognised.join(' ')}`);
  }
  return options;
}

function isOutputOnlyGnucapOption(name: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (name === 'phase') return value.toLowerCase() === 'radians';
  if (name === 'outwidth') return /^\d+$/.test(value) && Number(value) > 0;
  return false;
}

function parseNodeInitialState(
  circuit: Circuit,
  kind: 'ic' | 'nodeset',
  tokens: string[],
  lineNumber: number,
): void {
  // ngspice-47 runs a deck with a bare `.ic` or `.nodeset` card unchanged (#790).
  if (tokens.length === 1) return;
  if (tokens.length < 6 || (tokens.length - 1) % 5 !== 0) {
    throw new ParseError(`Invalid .${kind} node-voltage assignment`, lineNumber, tokens.join(' '));
  }
  for (let index = 1; index < tokens.length; index += 5) {
    if (tokens[index].toUpperCase() !== 'V' || tokens[index + 1] !== '('
      || tokens[index + 3] !== ')' || !tokens[index + 4].startsWith('=')) {
      throw new ParseError(`Invalid .${kind} node-voltage assignment`, lineNumber, tokens.join(' '));
    }
    const node = tokens[index + 2];
    const valueToken = tokens[index + 4].slice(1);
    if (!node || !valueToken) {
      throw new ParseError(`Invalid .${kind} node-voltage assignment`, lineNumber, tokens.join(' '));
    }
    circuit.addInitialState(kind, { node, value: parseNumber(valueToken) });
  }
}

function parseDevice(circuit: Circuit, tokens: string[], lineNumber: number, raw: string): void {
  const name = tokens[0];
  const type = name[0].toUpperCase();

  switch (type) {
    case 'R': {
      const parsed = parseResistorElement(tokens, lineNumber, tokens.join(' '),
        warning => circuit.addParseWarning(warning.message, warning));
      if (!parsed) break;
      circuit.addResistor(name, tokens[1], tokens[2], parsed.value, parsed.params, parsed.modelName);
      break;
    }
    case 'C':
    case 'L': {
      const kind = type === 'C' ? 'C' : 'L';
      const invalid = invalidPassiveInstanceLine(tokens, kind);
      if (invalid !== undefined) {
        circuit.addParseWarning(`${invalid} (line ${lineNumber})`);
        break;
      }
      const parsed = parsePassiveElement(tokens, 3, kind);
      const { IC: ic, ...params } = parsed.params;
      if (kind === 'C') {
        circuit.addCapacitor(name, tokens[1], tokens[2], parsed.value, parsed.modelName, params, ic);
      } else {
        circuit.addInductor(name, tokens[1], tokens[2], parsed.value, parsed.modelName, params, ic);
      }
      break;
    }
    case 'K': {
      circuit.addInductorCoupling(name, tokens[1], tokens[2], parseNumber(tokens[3]));
      break;
    }
    case 'T': {
      const { impedance, delay, initialConditions, relativeTolerance, absoluteTolerance } = parseTransmissionLine(tokens, lineNumber);
      circuit.addTransmissionLine(
        name,
        tokens[1], tokens[2], tokens[3], tokens[4],
        impedance, delay, initialConditions, relativeTolerance, absoluteTolerance,
      );
      break;
    }
    case 'U': {
      if (tokens.length < 6) throw new ParseError('URC requires three nodes, a model and L', lineNumber, raw);
      circuit.addUrc(name, tokens.slice(1, 4), tokens[4], parseUrcParams(tokens.slice(5), lineNumber));
      break;
    }
    case 'O': {
      const { modelName } = parseLossyTransmissionLine(tokens, lineNumber);
      circuit.addLossyTransmissionLine(
        name,
        tokens[1], tokens[2], tokens[3], tokens[4],
        modelName,
      );
      break;
    }
    case 'Y': {
      const { input, output, modelName, length } = parseTxlLine(tokens, lineNumber);
      circuit.addLossyLines(name, 'Y', [input], [output], modelName, length);
      break;
    }
    case 'P': {
      const { inputs, outputs, modelName, length } = parseCplLines(tokens, lineNumber);
      circuit.addLossyLines(name, 'P', inputs, outputs, modelName, length);
      break;
    }
    case 'V': {
      if (hasSourceMultiplier(tokens, 3)) {
        // ngspice-47 vsrc has no `m`: "unknown parameter (m)" stops the run.
        throw new ParseError(VOLTAGE_SOURCE_MULTIPLIER_ERROR, lineNumber, raw);
      }
      const { tokens: sourceTokens, port } = extractRFPort(tokens, 3);
      const waveform = parseSourceCardWaveform(sourceTokens, 3, lineNumber, raw);
      circuit.addVoltageSource(name, tokens[1], tokens[2], waveform, port);
      break;
    }
    case 'I': {
      const { tokens: sourceTokens, multiplier } = extractSourceMultiplier(tokens, 3);
      const waveform = parseSourceCardWaveform(sourceTokens, 3, lineNumber, raw);
      circuit.addCurrentSource(name, tokens[1], tokens[2], waveform, multiplier);
      break;
    }
    case 'D': {
      const modelIndex = diodeModelIndex(tokens);
      circuit.addDiode(
        name,
        tokens[1],
        tokens[2],
        tokens[modelIndex],
        parseDiodeInstanceParams(tokens, modelIndex + 1),
        modelIndex === 4 ? tokens[3] : undefined,
      );
      break;
    }
    case 'Q': {
      const instance = parseBJTInstance(tokens, lineNumber);
      circuit.addBJT(
        name,
        instance.collector,
        instance.base,
        instance.emitter,
        instance.modelName,
        instance.substrate,
        instance.thermal,
        instance.params,
      );
      break;
    }
    case 'J': {
      const instance = parseJFETInstance(tokens, lineNumber);
      circuit.addJFET(
        name, instance.drain, instance.gate, instance.source, instance.modelName, instance.params,
      );
      break;
    }
    case 'M': {
      if (tokens.length < 5 || tokens.slice(1, 5).some(token => token.includes('='))) {
        throw new ParseError(`MOSFET '${name}' requires D G S [B] and a model name`, lineNumber, raw);
      }
      // SPICE MOSFET: M name D G S [B] modelName [W=x L=y ...]
      // tokens[4] is either the body node (4-terminal) or the model name (3-terminal).
      // Heuristic: if tokens[5] exists and does not contain '=', then tokens[4] is the
      // body node and tokens[5] is the model name; otherwise tokens[4] is the model name.
      let modelName: string;
      let instanceParamStart: number;
      let bulkNode: string | undefined;
      let caseNode: string | undefined;
      if (tokens[6] && !tokens[6].includes('=') && !['THERMAL', 'OFF'].includes(tokens[6].toUpperCase())) {
        bulkNode = tokens[4];
        caseNode = tokens[5];
        modelName = tokens[6];
        instanceParamStart = 7;
      } else if (tokens[5] && !tokens[5].includes('=') && tokens[5].toUpperCase() !== 'THERMAL') {
        bulkNode = tokens[4];
        modelName = tokens[5];       // 4-terminal form: D G S B model
        instanceParamStart = 6;
      } else {
        modelName = tokens[4];       // 3-terminal form: D G S model
        instanceParamStart = 5;
      }
      const mosfetParams = parseInstanceParams(tokens, instanceParamStart);
      if (tokens.slice(instanceParamStart).some(token => token.toUpperCase() === 'THERMAL')) {
        mosfetParams.THERMAL = 1;
      }
      circuit.addMOSFET(name, tokens[1], tokens[2], tokens[3], modelName, mosfetParams, bulkNode, caseNode);
      break;
    }
    case 'X': {
      // X<name> <port1> <port2> ... <subcktName> [params:] [param=val ...]
      const call = locateSubcircuitCall(tokens, raw);
      const subcktName = tokens[call.nameIndex];
      const ports = call.ports;
      const xParams = parseSubcircuitCallParams(raw);
      circuit.addSubcircuitInstance(name, ports, subcktName, xParams, raw);
      break;
    }
    case 'E':
    case 'G':
    case 'H':
    case 'F': {
      const fields = withoutNodePairParentheses(tokens);
      assertControlledSourceCard(fields, lineNumber, raw);
      if (type === 'E') circuit.addVCVS(name, fields[1], fields[2], fields[3], fields[4], parseNumber(fields[5]));
      else if (type === 'G') circuit.addVCCS(name, fields[1], fields[2], fields[3], fields[4], parseNumber(fields[5]));
      else if (type === 'H') circuit.addCCVS(name, fields[1], fields[2], fields[3], parseNumber(fields[4]));
      else circuit.addCCCS(name, fields[1], fields[2], fields[3], parseNumber(fields[4]));
      break;
    }
    case 'B': {
      const card = parseBehavioralSourceCard(raw, lineNumber);
      if (card.kind === 'voltage') {
        circuit.addBehavioralVoltageSource(card.name, card.nodes[0], card.nodes[1], card.expression, card.params);
      } else {
        circuit.addBehavioralCurrentSource(card.name, card.nodes[0], card.nodes[1], card.expression, card.params);
      }
      break;
    }
    case 'Z': {
      const instance = parseZInstance(tokens, lineNumber, raw);
      circuit.addZDevice(name, ...instance.nodes, instance.modelName, instance.params);
      break;
    }
    case 'A':
      circuit.addXspiceInstance(parseXspiceInstance(raw, lineNumber));
      break;
    case 'S':
    case 'W': {
      const instance = parseSwitchInstance(tokens, lineNumber);
      if (instance.controlSource === undefined) {
        const [nodePos, nodeNeg, nCtrlP, nCtrlN] = instance.nodes;
        circuit.addVoltageSwitch(name, nodePos, nodeNeg, nCtrlP, nCtrlN, instance.modelName, instance.initiallyOn);
      } else {
        const [nodePos, nodeNeg] = instance.nodes;
        circuit.addCurrentSwitch(
          name, nodePos, nodeNeg, instance.controlSource, instance.modelName, instance.initiallyOn,
        );
      }
      break;
    }
    default:
      throw new ParseError(`Unsupported device card: '${type}'`, lineNumber, tokens.join(' '));
  }
}
