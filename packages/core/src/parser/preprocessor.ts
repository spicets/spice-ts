import { evaluateExpression } from './expression.js';
import { stringParameter, substituteStringAssignments, type ParameterScope } from './string-param.js';
import { endOfLineCommentStart } from './end-of-line-comment.js';
import {
  braceBareParameters, conditionExpression, expandUserFunctions, paramCardAsFunc, parseFuncCard, type FunctionScope,
  type UserFunction,
} from './numparam.js';
import { BEHAVIORAL_RUNTIME_EXPRESSION, NODE_DEPENDENT_EXPRESSION, substituteBehavioralParameters } from './behavioral-expression.js';
import { parseNumber, tokenizeLine } from './tokenizer.js';
import { formatNumber as formatLiteralNumber } from '../netlist-number.js';
import { tempDirective } from './temp-directive.js';
import { translateMicroSign } from './micro-sign.js';
import { bracedSubcircuitCallValues, locateSubcircuitCall } from './subcircuit-syntax.js';
import { lowerControlledTables } from './controlled-table.js';
import { lowerBehavioralCapacitors } from './behavioral-capacitor.js';
import { CycleError, ParseError } from '../errors.js';
import type { IncludeResolver } from '../types.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';

const MAX_DEPTH = 64;

/**
 * Preprocess a SPICE netlist: resolve `.include`/`.lib` directives,
 * evaluate `.param` definitions, and substitute `{expression}` tokens.
 *
 * This is called internally by {@link parseAsync} but can be used
 * standalone when you need the fully-expanded netlist text.
 *
 * @param netlist - Raw SPICE netlist text
 * @param resolver - Async function that returns file contents given a path;
 *   required if the netlist contains `.include` or `.lib` directives
 * @returns The preprocessed netlist with all includes inlined and expressions evaluated
 * @throws {@link ParseError} if include depth exceeds 64, resolver is missing,
 *   or a `{expression}` references an undefined or circular `.param`
 * @throws {@link CycleError} if includes form a circular dependency
 */
export async function preprocess(
  netlist: string,
  resolver?: IncludeResolver,
  guard?: ProtocolExecutionGuard,
): Promise<string> {
  return preprocessLines(netlist, resolver, guard, 0);
}

/**
 * @internal Preprocess a netlist fragment that starts `lineOffset` lines into the
 * original netlist (e.g. the body after a title line), so ParseError line
 * numbers refer to the caller's netlist.
 */
export async function preprocessLines(
  netlist: string,
  resolver: IncludeResolver | undefined,
  guard: ProtocolExecutionGuard | undefined,
  lineOffset: number,
): Promise<string> {
  return (await preprocessDeck(netlist, resolver, guard, lineOffset)).text;
}

/** A source-level numparam edit, applied only when the circuit is reset. */
export interface ParameterAlteration {
  subcircuit?: string;
  name: string;
  expression: string;
}

export interface PreprocessedDeck {
  /** The netlist with top-level parameters substituted. */
  text: string;
  /** Re-evaluate retained numparam expressions without resolving includes again. */
  atTemperature?: (celsius: number) => PreprocessedDeck;
  /** Replay numparam from retained source, without rereading include files. */
  withParameters?: (changes: readonly ParameterAlteration[]) => PreprocessedDeck;
  /**
   * Top-level `.param` values (upper-case names) for subcircuit expansion,
   * which evaluates subcircuit expressions per instance (ngspice numparam
   * global scope). Parameters whose value cannot be evaluated are omitted;
   * referencing one from a subcircuit reports it as undefined.
   */
  parameters: ParameterScope;
  /** Evaluated `.csparam` scalars (lower-case names) for the control const plot. */
  controlConstants: Record<string, number>;
  /** Non-fatal preprocessing diagnostics, surfaced as circuit parse warnings. */
  warnings: { message: string; line: number }[];
}

export async function preprocessDeck(
  netlist: string,
  resolver: IncludeResolver | undefined,
  guard: ProtocolExecutionGuard | undefined,
  lineOffset: number,
): Promise<PreprocessedDeck> {
  const steps = preprocessSteps(netlist, resolver !== undefined, guard, lineOffset);
  const includes: string[] = [];
  let step = steps.next();
  while (!step.done) {
    const text = await resolver!(step.value);
    includes.push(text);
    step = steps.next(text);
  }
  return retainParameterSource(step.value, netlist, includes, guard, lineOffset);
}

/**
 * @internal Synchronous {@link preprocessDeck} for `parse()` (#510): the same
 * `.param`/`.func`/`.if` preprocessing, without `.include`/`.lib` file
 * resolution, which reports that it needs `parseAsync()`.
 */
export function preprocessDeckSync(
  netlist: string,
  guard: ProtocolExecutionGuard | undefined,
  lineOffset: number,
): PreprocessedDeck {
  const step = preprocessSteps(netlist, false, guard, lineOffset).next();
  if (!step.done) throw new Error('preprocessDeckSync: unexpected include request without a resolver');
  return retainParameterSource(step.value, netlist, [], guard, lineOffset);
}

function retainParameterSource(
  deck: PreprocessedDeck, netlist: string, includes: string[],
  guard: ProtocolExecutionGuard | undefined, lineOffset: number,
): PreprocessedDeck {
  const withParameters = (changes: readonly ParameterAlteration[]): PreprocessedDeck => {
    const steps = preprocessSteps(netlist, includes.length > 0, guard, lineOffset, changes);
    let step = steps.next();
    let index = 0;
    while (!step.done) {
      if (index >= includes.length) throw new Error('reset: include source changed');
      step = steps.next(includes[index++]);
    }
    return { ...step.value, withParameters };
  };
  return { ...deck, withParameters };
}

/** Preprocessing as a generator that yields each include path and resumes with its content. */
function* preprocessSteps(
  netlist: string,
  hasResolver: boolean,
  guard: ProtocolExecutionGuard | undefined,
  lineOffset: number,
  changes: readonly ParameterAlteration[] = [],
): Generator<string, PreprocessedDeck, string> {
  const state = newCollectState();
  const { definitions } = state;
  let statements = state.statements;
  yield* collectStatements(netlist, hasResolver, new Set(), [], 0, state, guard, lineOffset);
  for (const change of changes) {
    const name = change.name.toUpperCase();
    if (change.subcircuit === undefined) {
      const previous = definitions.get(name);
      if (!previous) throw new ParseError(`alterparam: unknown parameter '${change.name}'`, 0, change.name);
      definitions.set(name, paramDefinition(change.expression, previous.line, previous.context));
      continue;
    }
    const scopes: string[] = [];
    let foundSubcircuit = false;
    let foundParameter = false;
    for (const statement of statements) {
      const header = /^\s*\.subckt\s+(\S+)/i.exec(statement.text);
      if (header) scopes.push(header[1].toLowerCase());
      if (scopes.at(-1) === change.subcircuit.toLowerCase()) {
        foundSubcircuit = true;
        if (header || /^\s*\.param\s/i.test(statement.text)) {
          statement.text = statement.text.replace(PARAM_ASSIGNMENT, (assignment, key: string) => {
            if (key.toUpperCase() !== name) return assignment;
            foundParameter = true;
            return `${key}={${change.expression.replace(/^\{(.*)\}$|^'(.*)'$/s, '$1$2')}}`;
          });
        }
      }
      if (/^\s*\.ends\b/i.test(statement.text)) scopes.pop();
    }
    if (!foundSubcircuit || !foundParameter) {
      throw new ParseError(foundSubcircuit
        ? `alterparam: unknown parameter '${change.name}' in subcircuit '${change.subcircuit}'`
        : `alterparam: unknown subcircuit '${change.subcircuit}'`, 0, change.name);
    }
    // ngspice-47 alterparam also replaces matching actuals on X cards, not
    // just the formal default (alterparam.sp: rint=7/rint1=9 become 13/15).
    for (const statement of statements) {
      if (!/^\s*x/i.test(statement.text)) continue;
      const tokens = tokenizeLine(statement.text);
      const call = locateSubcircuitCall(tokens, statement.text);
      if (tokens[call.nameIndex]?.toLowerCase() !== change.subcircuit.toLowerCase()) continue;
      statement.text = statement.text.replace(PARAM_ASSIGNMENT, (assignment, key: string) =>
        key.toUpperCase() === name ? `${key}={${change.expression.replace(/^\{(.*)\}$|^'(.*)'$/s, '$1$2')}}` : assignment);
    }
  }
  const unterminated = state.openBlocks[0];
  if (unterminated !== undefined) {
    const block = state.blocks[unterminated];
    throw new ParseError("Unterminated .if block: missing .endif", block.line, block.context);
  }
  // ngspice-47 reads every `.param`/`.func` card deck-wide (last definition
  // wins, even inside an unselected branch) before choosing `.if` branches;
  // only the other cards of a branch are gated.
  const selected = selectBranches(state);
  for (const statement of statements) {
    if (guardSelected(statement.guard, selected)) continue;
    statement.text = '';
    statement.substitute = false;
    statement.control = false;
  }
  expandFunctionCalls(state);
  statements = state.statements = lowerBehavioralCapacitors(statements);
  // inpcom.c TABLE lowering precedes numparam and retains per-instance scopes.
  if (statements.some(statement => /^\s*[eg]\S*\s+.*\btable\s*[={']/i.test(statement.text))) {
    statements = state.statements = lowerControlledTables(statements);
  }
  // inpcom.c inp_quote_params: brace bare parameter names on R/C/L cards (#837).
  const numericParams = new Set([...definitions].filter(([, definition]) => !definition.stringValue).map(([name]) => name));
  braceBareParameters(statements, numericParams).forEach((text, index) => { statements[index].text = text; });
  // ngspice collects every top-level `.param` before substituting, so a
  // parameter may be used before its definition and the last definition wins.
  let usesTemper = false;
  const temperature = circuitTemperature(statements, definitions, state.functionScopes[0].functions, state.warnings);
  const render = (celsius: number): PreprocessedDeck => {
    const scopes = createParamScopes(
      definitions, celsius, state.functionScopes[0].functions, true, () => { usesTemper = true; },
    );
    // Keep numparam diagnostics for the control const plot. Circuit parameters
    // remain a separate namespace, and each temperature needs a fresh cache.
    const controlConstants: Record<string, number> = Object.create(null);
    for (const { name, definition, guard } of state.csparams) {
      if (guardSelected(guard, selected)) {
        controlConstants[name] = evaluateParamExpression(definition, scopes.numparam, state.functionScopes[0].functions);
      }
    }
    const measureNames = new Set(statements.flatMap(statement => measureName(statement.text)));
    const text = statements.map(statement => statement.substitute
      ? substituteStatement(statement, scopes, measureNames)
      : statement.text).join('\n');
    const parameters: ParameterScope = {};
    for (const name of definitions.keys()) {
      try {
        parameters[name] = scopes.numparam[name];
      } catch {
        // Unused by the top level, or reported there; see PreprocessedDeck.
      }
    }
    return { text, parameters, controlConstants, warnings: state.warnings };
  };
  const result = render(temperature);
  if (usesTemper) result.atTemperature = render;
  return result;
}

/** One `.if`/`.elseif`/`.else` branch; `condition` is absent for `.else`. */
interface ConditionalBranch {
  condition?: string;
  keyword: string;
  line: number;
  context: string;
}

/** A `.if ... .endif` block; branch selection is deferred until every card is read. */
interface ConditionalBlock {
  line: number;
  context: string;
  branches: ConditionalBranch[];
  seenElse: boolean;
}

/** A statement sits in branch `branch` of block `block` (outermost first). */
interface BranchGuard {
  block: number;
  branch: number;
}

interface FunctionScopeFrame {
  parent: number;
  functions: Map<string, UserFunction>;
}

/** Preprocessor state shared across `.include`/`.lib` files. */
interface CollectState {
  definitions: Map<string, ParamDefinition>;
  statements: PendingStatement[];
  csparams: { name: string; definition: ParamDefinition; guard?: BranchGuard[] }[];
  blocks: ConditionalBlock[];
  /** Indices into `blocks` of the open `.if` blocks, outermost first. */
  openBlocks: number[];
  /** Index 0 is the top level; each `.subckt` opens a nested scope. */
  functionScopes: FunctionScopeFrame[];
  scopeStack: number[];
  warnings: { message: string; line: number }[];
  /** ngspice-47 reports unusual leading characters once per deck (#843). */
  warnedUnusualLeadingCharacter: boolean;
}

function newCollectState(): CollectState {
  return {
    definitions: new Map(),
    statements: [],
    csparams: [],
    blocks: [],
    openBlocks: [],
    functionScopes: [{ parent: -1, functions: new Map() }],
    scopeStack: [0],
    warnings: [],
    warnedUnusualLeadingCharacter: false,
  };
}

const CONDITIONAL_CARD = /^\.(elseif|else|endif|if)(?![\w])/i;
const FUNC_DIRECTIVE = /^\.func(?![\w])/i;
const CSPARAM_DIRECTIVE = /^\.csparam(?![\w])/i;
/** Output cards whose text ngspice-47 numparam never substitutes (#714). */
const OUTPUT_CARD = /^\.(?:print|plot)(?![\w])/i;
/**
 * ngspice-47 inpcom.c inp_check_syntax: a card whose first non-blank character
 * is one of these is turned into a `*` comment, with a warning (#843).
 */
const UNUSUAL_LEADING_CHARACTERS = new Set(['=', '[', ']', '?', '(', ')', '&', '%', '$', '"', '!', ':', ',', '\f']);
const UNUSUAL_LEADING_WARNING = (character: string) =>
  `Unusual leading characters like '${character}' or others out of '= [] ? () & % $"!:,\\f' `
  + "in netlist or included files, will be replaced with '*'";

/**
 * The card after ngspice's leading space/tab skip when ngspice-47 comments
 * it out: `#` or an unusual leading character.
 */
function commentedOutCard(line: string): { card: string; warn: boolean } | undefined {
  const card = line.replace(/^[ \t]+/, '');
  if (card.startsWith('#')) return { card, warn: false };
  return UNUSUAL_LEADING_CHARACTERS.has(card[0]) ? { card, warn: true } : undefined;
}

const PARAM_ASSIGNMENT = /([A-Za-z_]\w*)\s*=\s*('[^']*'|(?:"[^"]*"|\{[^}]+\}|[^\s"{}])+)/g;

/**
 * ngspice-47 reads the whole rest of a single-assignment `.param` card as the
 * expression (`.param x = 1 + 2` is 3, `.param x = 1 +` is an error), not just
 * its first token. Delimited values and multi-assignment cards keep their token.
 */
function singleParamValue(card: string, assignment: RegExpExecArray | RegExpMatchArray): string {
  const value = assignment[2];
  if (/^[{'"]/.test(value)) return value;
  const body = card.slice(7).trim();
  const rest = body.slice(assignment.index! + assignment[0].length - value.length);
  return rest.slice(0, commentStart(rest)).trim() || value;
}

function paramDefinition(value: string, line: number, context: string): ParamDefinition {
  const delimited = value.length >= 2
    && ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith("'") && value.endsWith("'")));
  return {
    expression: delimited ? value.slice(1, -1) : value,
    line,
    context,
    ...(value.startsWith('"') ? { stringValue: true } : {}),
  };
}

function currentScope(state: CollectState): number {
  return state.scopeStack[state.scopeStack.length - 1];
}

function currentGuard(state: CollectState): BranchGuard[] | undefined {
  if (state.openBlocks.length === 0) return undefined;
  return state.openBlocks.map(block => ({ block, branch: state.blocks[block].branches.length - 1 }));
}

/**
 * Record a top-level `.if`/`.elseif`/`.else`/`.endif` card. Branches are
 * selected only after the whole deck is read (`selectBranches`), because
 * ngspice-47 resolves `.param` and `.func` cards deck-wide first.
 */
function recordConditional(state: CollectState, keyword: string, trimmed: string, line: number): void {
  const open = state.openBlocks;
  const block = open.length > 0 ? state.blocks[open[open.length - 1]] : undefined;
  const branch = (): ConditionalBranch => {
    const condition = trimmed.slice(0, commentStart(trimmed)).slice(keyword.length + 1);
    if (condition.trim() === '') throw new ParseError(`.${keyword} requires a condition`, line, trimmed);
    return { condition, keyword, line, context: trimmed };
  };
  if (keyword === 'if') {
    state.blocks.push({ line, context: trimmed, branches: [branch()], seenElse: false });
    open.push(state.blocks.length - 1);
    return;
  }
  if (!block) throw new ParseError(`'.${keyword}' without a matching '.if'`, line, trimmed);
  if (keyword === 'endif') {
    open.pop();
    return;
  }
  if (block.seenElse) throw new ParseError(`'.${keyword}' after '.else'`, line, trimmed);
  if (keyword === 'else') {
    block.seenElse = true;
    block.branches.push({ keyword, line, context: trimmed });
    return;
  }
  block.branches.push(branch());
}

/**
 * Select one branch per `.if` block (-1: none). As in ngspice-47, every
 * condition is evaluated, including those in unselected branches, against
 * the deck-wide `.param` set and top-level `.func` definitions.
 */
function selectBranches(state: CollectState): number[] {
  if (state.blocks.length === 0) return [];
  const functions = state.functionScopes[0].functions;
  // TEMPER in a condition reads temperature cards outside any `.if`.
  const unconditional = state.statements.filter(statement => statement.guard === undefined);
  const scopes = createParamScopes(state.definitions, circuitTemperature(unconditional, state.definitions, functions), functions);
  return state.blocks.map(block => {
    let selected = -1;
    for (const [index, branch] of block.branches.entries()) {
      let taken = true;
      if (branch.condition !== undefined) {
        try {
          const expression = expandUserFunctions(conditionExpression(branch.condition), functions);
          taken = evaluateExpression(expression, scopes.numparam) !== 0;
        } catch (error) {
          if (error instanceof ParseError) throw error;
          throw toParseError(error, branch.line, branch.context);
        }
      }
      if (taken && selected === -1) selected = index;
    }
    return selected;
  });
}

function guardSelected(guard: BranchGuard[] | undefined, selected: number[]): boolean {
  return guard === undefined || guard.every(({ block, branch }) => selected[block] === branch);
}

/**
 * Expand `.func` calls in every netlist card, each with the functions visible
 * in its subcircuit scope (inner definitions shadow outer ones).
 */
function expandFunctionCalls(state: CollectState): void {
  const visible = state.functionScopes.map((_scope, index) => {
    const chain: Map<string, UserFunction>[] = [];
    for (let at = index; at >= 0; at = state.functionScopes[at].parent) chain.unshift(state.functionScopes[at].functions);
    return new Map(chain.flatMap(functions => [...functions]));
  });
  if (visible.every(functions => functions.size === 0)) return;
  for (const statement of state.statements) {
    if (statement.control || statement.text.trim().startsWith('*')) continue;
    const functions = visible[statement.scope ?? 0];
    try {
      statement.text = expandUserFunctions(statement.text, functions);
    } catch (error) {
      throw toParseError(error, statement.line, statement.text.trim());
    }
  }
}

interface ParamDefinition {
  expression: string;
  line: number;
  context: string;
  /** A quoted string literal (vectors retain the unsupported boundary). */
  stringValue?: boolean;
}

interface PendingStatement {
  text: string;
  substitute: boolean;
  line: number;
  /** A line inside a top-level `.control` block. */
  control?: boolean;
  /** `.func` scope (index into CollectState.functionScopes); 0 / absent is the top level. */
  scope?: number;
  /** Enclosing `.if` branches; absent outside any `.if` block. */
  guard?: BranchGuard[];
}

/**
 * Variable records for the expression evaluator. `numparam` also defines
 * TEMPER for `{...}`/`'...'` expressions; `params` holds only `.param` names
 * and is used for B-cards, whose ASRC expressions evaluate `temper` themselves.
 */
interface ParamScopes {
  params: ParameterScope;
  numparam: ParameterScope;
}

/** ngspice's default circuit temperature in Celsius. */
const DEFAULT_CIRCUIT_TEMPERATURE_CELSIUS = 27;
const TEMPER = 'TEMPER';

const OPTIONS_CARD = /^\s*\.opt(?:ion|ions)?(?:\s|$)/i;
const OPTIONS_TEMP_FIELD = /(?:^|\s)temp\s*=\s*([^\s=]+)/gi;

/**
 * ngspice-47 inp.c applies the last .temp after all .options TEMP fields.
 * Resolve its independent numparam expressions before TEMPER substitution;
 * normalize selected cards so the parser sees the same value and warnings.
 */
function circuitTemperature(
  statements: PendingStatement[],
  definitions: Map<string, ParamDefinition>,
  functions: FunctionScope,
  warnings?: { message: string; line: number }[],
): number {
  let temperature = DEFAULT_CIRCUIT_TEMPERATURE_CELSIUS;
  for (const statement of statements) {
    if (statement.control || !OPTIONS_CARD.test(statement.text)) continue;
    const text = statement.text.slice(0, commentStart(statement.text));
    for (const match of text.matchAll(OPTIONS_TEMP_FIELD)) {
      try {
        temperature = parseNumber(match[1]);
      } catch {
        // reported by the .options parser
      }
    }
  }
  // ngspice selects the last card before interpreting its value. Earlier
  // cards must not produce errors/warnings or reach the downstream parser.
  let effective: PendingStatement | undefined;
  for (const statement of statements) {
    if (statement.control || !/^\s*\.temp(?=\s|=|$)/i.test(statement.text)) continue;
    if (warnings !== undefined && effective !== undefined) {
      effective.text = '';
      effective.substitute = false;
    }
    effective = statement;
  }
  if (effective !== undefined) {
    const statement = effective;
    try {
      const scopes = createParamScopes(definitions, temperature, functions, false);
      const text = statement.text.slice(0, commentStart(statement.text));
      const expanded = substituteExpressions(quotedExpressionsAsBraces(expandUserFunctions(text, functions)), scopes.params);
      const card = tempDirective(expanded, statement.line)!;
      temperature = card.value;
      if (warnings !== undefined) {
        statement.text = `.temp ${card.value}`;
        if (card.warning) warnings.push({ message: card.warning, line: statement.line });
      }
    } catch (error) {
      if (error instanceof ParseError) throw error;
      throw toParseError(error, statement.line, statement.text);
    }
  }
  return temperature;
}


/**
 * Lazily evaluates `.param` definitions on first use, in dependency order.
 * Returned as variable records so the expression evaluator can look names up.
 */
function createParamScopes(
  definitions: Map<string, ParamDefinition>,
  temperature: number,
  functions: FunctionScope = new Map(),
  allowTemper = true,
  onTemper?: () => void,
): ParamScopes {
  const values = new Map<string, number | string>();
  const resolving: string[] = [];
  const isParam = (key: string | symbol): key is string => typeof key === 'string' && definitions.has(key);
  const params: ParameterScope = new Proxy({}, {
    has: (_target, key) => isParam(key),
    get: (_target, key) => (isParam(key) ? resolve(key) : undefined),
  });
  const isTemper = (key: string | symbol) => key === TEMPER && !definitions.has(TEMPER);
  const numparam: ParameterScope = new Proxy({}, {
    has: (_target, key) => isParam(key) || isTemper(key),
    get: (_target, key) => {
      if (isTemper(key)) return temper();
      return isParam(key) ? resolve(key) : undefined;
    },
  });

  function temper(): number {
    if (!allowTemper) throw new Error('.temp expressions depending on TEMPER are not supported');
    onTemper?.();
    return temperature;
  }

  function resolve(name: string): number | string {
    const known = values.get(name);
    if (known !== undefined) return known;
    const definition = definitions.get(name)!;
    if (definition.stringValue && /^"\s*\[/.test(definition.expression)) {
      throw new ParseError(
        `String-valued .param '${name}' is not supported: spice-ts parameters are numbers `
        + '(ngspice string and vector parameters are not implemented)',
        definition.line,
        definition.context,
      );
    }
    if (resolving.includes(name)) {
      const cycle = [...resolving.slice(resolving.indexOf(name)), name].join(' -> ');
      throw new ParseError(`Circular .param dependency: ${cycle}`, definition.line, definition.context);
    }
    resolving.push(name);
    try {
      const value = stringParameter(definition.expression, numparam)
        ?? evaluateParamExpression(definition, numparam, functions);
      values.set(name, value);
      return value;
    } finally {
      resolving.pop();
    }
  }

  return { params, numparam };
}

function evaluateParamExpression(
  definition: ParamDefinition,
  scope: ParameterScope,
  functions: FunctionScope = new Map(),
): number {
  try {
    return evaluateExpression(expandUserFunctions(definition.expression, functions), scope);
  } catch (error) {
    if (error instanceof ParseError) throw error;
    // A bare SPICE number (e.g. `1meg`) is not an expression; anything else
    // that fails to evaluate is reported at the `.param` definition.
    try {
      return parseNumber(definition.expression);
    } catch {
      throw toParseError(error, definition.line, definition.context);
    }
  }
}

function substituteStatement(statement: PendingStatement, scopes: ParamScopes, measureNames: ReadonlySet<string>): string {
  try {
    if (MEASURE_CARD.test(statement.text)) return substituteMeasureCard(statement.text, scopes, measureNames);
    const behavioralCard = behavioralCardAsBSource(statement.text);
    const text = substituteStringAssignments(behavioralCard ?? statement.text, scopes.numparam);
    if (/^\s*b/i.test(text)) {
      // B-cards: `'...'`, `{...}` and bare `.param` names are substituted by
      // the B-card front end; `temper` stays a live ASRC variable.
      const substituted = substituteExpressions(text, scopes.params, true);
      return substituteBehavioralParameters(substituted, scopes.params);
    }
    // X actuals are numparam bindings, not device values: preserve their
    // double until the subcircuit body substitutes it into a device card.
    return substituteExpressions(quotedExpressionsAsBraces(text), scopes.numparam, false,
      /^\s*x/i.test(text) ? formatLiteralNumber : formatNumber);
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw toParseError(error, statement.line, statement.text.trim());
  }
}

const MEASURE_CARD = /^\s*\.meas/i;

/** Result name of a `.meas` card (upper-cased like `.param` names), if the line is one. */
function measureName(text: string): string[] {
  if (!MEASURE_CARD.test(text)) return [];
  const name = text.trim().split(/\s+/)[2];
  return name ? [name.toUpperCase()] : [];
}

/**
 * numparam for a `.meas` card, following ngspice-47's deck preparation:
 * inpcom.c wraps the bare right-hand side of every `name=value` in braces
 * (except `v(...)`/`i(...)`, numbers and `last`), and subckt.c leaves a card
 * that mentions `param` for after the other measurements, because it may read
 * their results. Those cards keep their expression; only `.param` names that are
 * not measurement results are replaced by their values here. `par('expr')`
 * operands are B-source expressions and are left for the measure code.
 */
function substituteMeasureCard(text: string, scopes: ParamScopes, measureNames: ReadonlySet<string>): string {
  const end = commentStart(text);
  const operands: string[] = [];
  let card = protectParOperands(text.slice(0, end), operands);
  if (/param/i.test(card)) {
    const assignment = /\b(?:param|expr)\s*=/i.exec(card);
    const from = assignment ? assignment.index + assignment[0].length : card.length;
    const expression = card.slice(from).replace(/\b([A-Za-z_]\w*)\b(?!\s*\()/g, (match: string, name: string, offset: number, whole: string) => {
      const upper = name.toUpperCase();
      if (/[\d.]/.test(whole[offset - 1] ?? '') || measureNames.has(upper) || !(upper in scopes.numparam)) return match;
      return `(${formatNumber(evaluateExpression(upper, scopes.numparam))})`;
    });
    card = card.slice(0, from) + expression;
  } else {
    card = substituteExpressions(bracedMeasureValues(quotedExpressionsAsBraces(card)), scopes.numparam);
  }
  return card.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => parOperandWithParams(operands[Number(index)], scopes));
}

/** A `par('expr')` operand becomes a B-source expression: substitute `.param` names as on a B-card. */
function parOperandWithParams(operand: string, scopes: ParamScopes): string {
  const inner = /^par\(\s*(?:'([^']*)'|\{([^{}]*)\})\s*\)$/i.exec(operand);
  if (!inner) return operand;
  const head = 'bpar 0 0 v=';
  return `par('${substituteBehavioralParameters(head + (inner[1] ?? inner[2]), scopes.params).slice(head.length)}')`;
}

/** Replace each `par(...)` operand by a placeholder, collecting the originals. */
function protectParOperands(text: string, operands: string[]): string {
  let output = '';
  let index = 0;
  for (;;) {
    const start = text.slice(index).search(/par\(/i);
    if (start < 0) return output + text.slice(index);
    const open = index + start + 3;
    let depth = 0;
    let close = open;
    let quoted = false;
    for (; close < text.length; close++) {
      const character = text[close];
      if (character === "'") quoted = !quoted;
      if (quoted) continue;
      if (character === '(') depth++;
      else if (character === ')' && --depth === 0) break;
    }
    if (close >= text.length) return output + text.slice(index);
    output += text.slice(index, index + start) + `\u0000${operands.length}\u0000`;
    operands.push(text.slice(index + start, close + 1));
    index = close + 1;
  }
}

/** inpcom.c (inp_fix_param_values): brace the bare right-hand side of each `.meas` assignment. */
function bracedMeasureValues(card: string): string {
  let output = '';
  let index = 0;
  for (;;) {
    let equals = card.indexOf('=', index);
    while (equals >= 0 && (card[equals + 1] === '=' || /[!<>]/.test(card[equals - 1] ?? ''))) {
      equals = card.indexOf('=', card[equals + 1] === '=' ? equals + 2 : equals + 1);
    }
    if (equals < 0) return output + card.slice(index);
    let start = equals + 1;
    while (/\s/.test(card[start] ?? '')) start++;
    let stop = start;
    let parens = 0;
    while (stop < card.length && (!/\s/.test(card[stop]) || parens > 0)) {
      if (card[stop] === '(') parens++;
      if (card[stop] === ')') parens--;
      stop++;
    }
    const value = card.slice(start, stop);
    const keep = value === '' || /^[vi]\(/i.test(value) || /^(?:[\d{.\"[<\u0000]|[+-]\.?\d|true|false|last$)/i.test(value);
    output += card.slice(index, start) + (keep ? value : `{${value}}`);
    index = stop;
  }
}

/** Start of an end-of-line comment (`;`, `$` or `//`), as the tokenizer strips them. */
const commentStart = endOfLineCommentStart;

/**
 * ngspice numparam treats a single-quoted value as a brace expression:
 * `v1 1 0 '2--3'` is `v1 1 0 {2--3}`. Comments after the card are left alone.
 */
function quotedExpressionsAsBraces(line: string): string {
  if (!line.includes("'") || /^\s*\.title\b/i.test(line)) return line;
  const end = commentStart(line);
  return line.slice(0, end).replace(/'([^']*)'/g, '{$1}') + line.slice(end);
}

/**
 * Subcircuit bodies are expanded later by the circuit builder, whose tokenizer
 * splits on whitespace and evaluates only `{expr}` tokens. Rewrite `'expr'` as
 * `{expr}` and drop the whitespace inside brace expressions so each stays one
 * token (`R1 in out 'rint1 * 2'` -> `R1 in out {rint1*2}`). B-cards, comments
 * and dot commands other than `.param`/`.model` are left unchanged.
 */
function compactSubcircuitExpressions(line: string): string {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('*') || /^b/i.test(trimmed)) return line;
  if (trimmed.startsWith('.') && !/^\.(?:param|model)\b/i.test(trimmed)) return line;
  line = bracedSingleParamValue(line);
  if (!line.includes("'") && !line.includes('{')) return line;
  const end = commentStart(line);
  const compact = (expression: string) => `{${expression.replace(/\s+/g, '')}}`;
  return line.slice(0, end)
    .replace(/'([^']*)'/g, (_match, expression: string) => compact(expression))
    .replace(/\{([^{}]*)\}/g, (_match, expression: string) => compact(expression))
    + line.slice(end);
}

/**
 * A subcircuit `.param` card with one assignment whose value is an undelimited
 * expression (`.param w=limit(wiper, 0, 1)`, ngspice-bugs #505) gets that
 * value braced: ngspice-47 reads the whole rest of the card as the
 * expression, as at the top level (`singleParamValue`), while the subcircuit
 * tokenizer would split it at whitespace and commas (#870).
 */
function bracedSingleParamValue(line: string): string {
  const head = /^(\s*\.param\s+)/i.exec(line);
  if (!head) return line;
  const end = commentStart(line);
  const body = line.slice(head[0].length, end).trim();
  const assignments = [...body.matchAll(PARAM_ASSIGNMENT)];
  if (assignments.length !== 1) return line;
  const value = singleParamValue(`.param ${body}`, assignments[0]);
  if (/^[{'"]/.test(value) || !/[\s,()]/.test(value)) return line;
  return `${head[0]}${assignments[0][1]}={${value}}${line.slice(end)}`;
}

const BEHAVIORAL_RESISTOR = /^\s*(r\S*)\s+(\S+)\s+(\S+)\s+(?:r\s*=\s*)?(?:\{([^{}]*)\}|'([^']*)')\s*(.*)$/i;
const NODE_DEPENDENCE = /\b[vi]\s*\(/i;
const BEHAVIORAL_RESISTOR_PARAMETER = /^(m|tc1|tc2)=(\S+)$/i;

/**
 * ngspice (inpcom.c) turns a resistor whose value expression reads node
 * voltages or branch currents into an ASRC:
 * `Rxxx n1 n2 R={expr} m=4 tc1=a` -> `bRxxx n1 n2 i = 4*v(n1, n2)/(expr) tc1=a reciproctc=1`.
 * Returns the B-card, or undefined when the line is not such a resistor.
 */
function behavioralResistorAsBSource(line: string): string | undefined {
  const card = BEHAVIORAL_RESISTOR.exec(line.slice(0, commentStart(line)));
  if (!card) return undefined;
  const [, name, positive, negative, braced, quoted, rest] = card;
  const expression = (braced ?? quoted).trim();
  if (!NODE_DEPENDENCE.test(expression) && !/\bhertz\b/i.test(expression)) return undefined;
  const parameters = rest.replace(/\s*=\s*/g, '=').trim().split(/\s+/).filter(Boolean);
  let multiplier = '';
  const coefficients: string[] = [];
  for (const parameter of parameters) {
    const match = BEHAVIORAL_RESISTOR_PARAMETER.exec(parameter);
    if (!match) {
      throw new Error(
        `Unsupported parameter '${parameter}' on behavioral resistor '${name}': a resistor whose value `
        + 'depends on v() or i() supports only m=, tc1= and tc2=',
      );
    }
    if (match[1].toLowerCase() === 'm') {
      const value = parseNumber(match[2]);
      if (!Number.isFinite(value)) throw new Error(`behavioral resistor '${name}': m must be a finite numeric literal`);
      // ngspice inpcom.c eval_mvalue formats explicit numeric m with %15.8e.
      multiplier = `(${Number(value.toExponential(8))})*`;
    } else {
      coefficients.push(` ${parameter}`);
    }
  }
  return `b${name} ${positive} ${negative} i = ${multiplier}v(${positive}, ${negative})/(${expression})${coefficients.join('')} reciproctc=1`;
}

const BEHAVIORAL_CONTROLLED_SOURCE = /^\s*([eg]\S*)\s+(\S+)\s+(\S+)\s+(value|vol|cur)\s*=\s*(\S.*?)\s*$/i;

/**
 * ngspice (inpcom.c inp_compat) runs a behavioural E/G card as an ASRC:
 * `Exxx n1 n2 value={expr}` / `vol={expr}` drives v(n1,n2) = expr and
 * `Gxxx n1 n2 value={expr}` / `cur={expr}` sinks i = expr from n1 to n2.
 * Returns the equivalent B-card, or undefined when the line is not one.
 */
function behavioralControlledSourceAsBSource(line: string): string | undefined {
  const card = BEHAVIORAL_CONTROLLED_SOURCE.exec(line.slice(0, commentStart(line)));
  if (!card) return undefined;
  const [, name, positive, negative, keyword, expression] = card;
  const voltage = /^e/i.test(name);
  if (keyword.toLowerCase() === (voltage ? 'cur' : 'vol')) return undefined;
  return `b${name} ${positive} ${negative} ${voltage ? 'v' : 'i'} = ${expression}`;
}

/** Behavioural R/E/G cards that ngspice rewrites to B-sources, as their B-card. */
function behavioralCardAsBSource(line: string): string | undefined {
  return behavioralResistorAsBSource(line) ?? behavioralControlledSourceAsBSource(line);
}

/** @internal An expression evaluation error as a ParseError at a card, naming undefined parameters. */
export function toParseError(error: unknown, line: number, context: string): ParseError {
  const message = (error as Error).message
    .replace(/^Undefined variable '([^']*)'$/, "Undefined parameter '$1'");
  return new ParseError(message, line, context);
}

/** Yields each `.include`/`.lib` path to fetch and resumes with the file content. */
function* collectStatements(
  netlist: string,
  hasResolver: boolean,
  visited: Set<string>,
  chain: string[],
  depth: number,
  state: CollectState,
  guard?: ProtocolExecutionGuard,
  lineOffset = 0,
): Generator<string, void, string> {
  guard?.maximum('maxIncludeDepth', depth, 'parse');
  if (depth > MAX_DEPTH) {
    throw new ParseError(`Include depth limit exceeded (${MAX_DEPTH})`, 0, '');
  }

  const { definitions, statements } = state;
  const lines = netlist.split('\n');
  let inSubckt = 0;
  let inControl = false;
  let inOutputCard = false;
  const foldedCallContinuations = new Set<number>();
  // A card ngspice-47 comments out takes its `+` continuations with it (#843).
  let inCommentedOutCard = false;

  for (const [index, line] of lines.entries()) {
    guard?.checkpoint('parse:line');
    const lineNumber = index + 1 + lineOffset;
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    const scope = currentScope(state);
    const passThrough = () => statements.push({ text: line, substitute: false, line: lineNumber, scope });
    // Consumed numparam cards and unselected `.if` branches keep their line, blank.
    const blank = () => statements.push({ text: '', substitute: false, line: lineNumber });

    if (foldedCallContinuations.has(index)) {
      blank();
      continue;
    }

    // Comments are metadata, not expression-bearing netlist statements.
    if (trimmed.startsWith('*')) {
      passThrough();
      continue;
    }
    // inpcom.c:1442-1456 comments .title before continuation stitching (1958).
    // Like an ordinary comment, it must leave the preceding card's state intact.
    if (!inControl && /^\.title(?:\s|$)/i.test(trimmed)) {
      blank();
      continue;
    }
    const commentedOut = inControl ? undefined : commentedOutCard(line);
    if (commentedOut) {
      if (commentedOut.warn && !state.warnedUnusualLeadingCharacter) {
        state.warnedUnusualLeadingCharacter = true;
        const file = chain[chain.length - 1];
        const where = file === undefined ? `line ${lineNumber}` : `line ${lineNumber} of ${file}`;
        state.warnings.push({
          message: `${UNUSUAL_LEADING_WARNING(commentedOut.card[0])}: check line '${commentedOut.card.trimEnd()}' (${where})`,
          line: lineNumber,
        });
      }
      inCommentedOutCard = true;
      statements.push({ text: `*${commentedOut.card.slice(1)}`, substitute: false, line: lineNumber, scope });
      continue;
    }
    if (trimmed !== '') {
      if (inCommentedOutCard && trimmed.startsWith('+')) {
        blank();
        continue;
      }
      inCommentedOutCard = false;
    }
    // A `+` continuation (blank and comment lines may sit in between) belongs to the preceding card.
    if (trimmed !== '' && !trimmed.startsWith('+')) {
      inOutputCard = OUTPUT_CARD.test(trimmed);
    }
    let card = line;
    if (!inControl && /^x/i.test(trimmed)) {
      // Scan the logical X card, not physical fragments. An RHS may start
      // after '=' on the next line, or a brace/quote may span continuations.
      // Leave consumed lines blank so subsequent source line numbers survive.
      card = line.slice(0, commentStart(line));
      for (let next = index + 1; next < lines.length; next++) {
        const continuation = lines[next].slice(0, commentStart(lines[next])).trim();
        // .title is commented before stitching in ngspice, including inside X RHS values.
        if (continuation === '' || continuation.startsWith('*') || /^\.title(?:\s|$)/i.test(continuation)) continue;
        if (!continuation.startsWith('+')) break;
        card += ' ' + continuation.slice(1);
        foldedCallContinuations.add(next);
      }
      card = bracedSubcircuitCallValues(card, card.length);
    }

    const conditional = inControl ? null : CONDITIONAL_CARD.exec(trimmed);
    if (conditional) {
      if (inSubckt > 0) {
        throw new ParseError(
          '.if inside .subckt is not supported: spice-ts evaluates .if/.elseif/.else/.endif only at the top level',
          lineNumber, trimmed,
        );
      }
      recordConditional(state, conditional[1].toLowerCase(), trimmed, lineNumber);
      blank();
      continue;
    }
    // Cards other than `.param`/`.func`, `.include`/`.lib` and subcircuit
    // definitions are kept only if their enclosing `.if` branches are selected.
    const branchGuard = currentGuard(state);
    const guarded = branchGuard ? { guard: branchGuard } : {};

    // Track .subckt nesting — don't evaluate params inside subcircuits
    // (ngspice-47 keeps a subcircuit defined inside an unselected branch).
    if (upper.startsWith('.SUBCKT ')) {
      inSubckt++;
      passThrough();
      state.functionScopes.push({ parent: scope, functions: new Map() });
      state.scopeStack.push(state.functionScopes.length - 1);
      continue;
    }
    if (upper.startsWith('.ENDS')) {
      inSubckt--;
      passThrough();
      if (state.scopeStack.length > 1) state.scopeStack.pop();
      continue;
    }

    // `.func`, and a `.param` card defining a function (`.param f(x) = ...`, #870).
    const funcCard = inControl ? undefined : FUNC_DIRECTIVE.test(trimmed) ? trimmed : paramCardAsFunc(trimmed);
    if (funcCard !== undefined) {
      try {
        const fn = parseFuncCard(funcCard.slice(0, commentStart(funcCard)));
        state.functionScopes[scope].functions.set(fn.name.toLowerCase(), fn);
      } catch (error) {
        throw toParseError(error, lineNumber, trimmed);
      }
      blank();
      continue;
    }

    // Inside a subcircuit — expressions are evaluated per instance later.
    // A resistor whose value reads v()/i(), or a value= E/G card, becomes a B-source here too.
    if (inSubckt > 0) {
      let text: string;
      try {
        text = behavioralCardAsBSource(card) ?? compactSubcircuitExpressions(card);
      } catch (error) {
        throw toParseError(error, lineNumber, trimmed);
      }
      statements.push({ text, substitute: false, line: lineNumber, scope });
      continue;
    }

    // ngspice control language is not numparam input: `{$var}` and quotes
    // belong to the control interpreter.
    if (inControl) {
      if (upper.startsWith('.ENDC')) inControl = false;
      statements.push({ text: line, substitute: false, line: lineNumber, control: true, ...guarded });
      continue;
    }
    if (upper === '.CONTROL' || upper.startsWith('.CONTROL ')) {
      inControl = true;
      statements.push({ text: line, substitute: false, line: lineNumber, scope, ...guarded });
      continue;
    }

    // .param at top level
    if (upper.startsWith('.PARAM ')) {
      const assignments = [...trimmed.slice(7).trim().matchAll(PARAM_ASSIGNMENT)];
      for (const assignment of assignments) {
        definitions.set(assignment[1].toUpperCase(), paramDefinition(
          assignments.length === 1 ? singleParamValue(trimmed, assignment) : assignment[2], lineNumber, trimmed,
        ));
      }
      blank();
      continue;
    }

    // .csparam: numparam values handed to the control language
    if (CSPARAM_DIRECTIVE.test(trimmed)) {
      const content = trimmed.slice(0, commentStart(trimmed)).slice('.csparam'.length);
      const assignments = [...content.matchAll(PARAM_ASSIGNMENT)];
      if (assignments.length === 0) {
        throw new ParseError("Malformed .csparam card: expected 'name = expression'", lineNumber, trimmed);
      }
      for (const assignment of assignments) {
        const definition = paramDefinition(assignment[2], lineNumber, trimmed);
        if (!definition.stringValue) state.csparams.push({ name: assignment[1].toLowerCase(), definition, ...guarded });
      }
      blank();
      continue;
    }

    // .include directive
    if (upper.startsWith('.INCLUDE ')) {
      if (!hasResolver) {
        throw new ParseError(
          '.include directive requires a resolver. Use parseAsync() with a resolveInclude option.',
          0, trimmed,
        );
      }
      let path = trimmed.slice(9).trim();
      if ((path.startsWith("'") && path.endsWith("'")) ||
          (path.startsWith('"') && path.endsWith('"'))) {
        path = path.slice(1, -1);
      }
      if (visited.has(path)) {
        throw new CycleError([...chain, path]);
      }
      visited.add(path);
      const content = translateMicroSign(yield path);
      yield* collectStatements(
        content, hasResolver, visited, [...chain, path], depth + 1, state, guard,
      );
      visited.delete(path);
      continue;
    }

    // .lib <filename> <section> — fetch file and extract section
    if (upper.startsWith('.LIB ')) {
      const libTokens = trimmed.slice(5).trim().split(/\s+/);
      if (libTokens.length >= 2) {
        if (!hasResolver) {
          throw new ParseError(
            '.lib directive with file requires a resolver. Use parseAsync() with a resolveInclude option.',
            0, trimmed,
          );
        }
        let filePath = libTokens.slice(0, -1).join(' ');
        const section = libTokens[libTokens.length - 1];
        if ((filePath.startsWith("'") && filePath.endsWith("'")) ||
            (filePath.startsWith('"') && filePath.endsWith('"'))) {
          filePath = filePath.slice(1, -1);
        }
        const visitKey = `${filePath}:${section}`;
        if (visited.has(visitKey)) {
          throw new CycleError([...chain, visitKey]);
        }
        visited.add(visitKey);
        const content = yield filePath;
        const extracted = translateMicroSign(extractLibSection(content, section));
        yield* collectStatements(
          extracted, hasResolver, visited, [...chain, visitKey], depth + 1, state, guard,
        );
        visited.delete(visitKey);
        continue;
      }
      continue;
    }

    // .endl — skip (handled by extractLibSection)
    if (upper.startsWith('.ENDL')) {
      continue;
    }

    // ngspice-47 numparam leaves `.print`/`.plot` cards and their `+`
    // continuations verbatim: brace text is handed to the frontend print
    // command, never evaluated as a parameter expression (#714).
    if (inOutputCard) {
      statements.push({ text: line, substitute: false, line: lineNumber, scope, ...guarded });
      continue;
    }

    statements.push({ text: card, substitute: true, line: lineNumber, ...guarded });
  }
}

// `keepNodeDependent` leaves B-card `{...}` that read v()/i() to the B-card
// front end, which keeps them as ASRC sub-expressions.
export function substituteExpressions(
  line: string,
  params: ParameterScope,
  keepNodeDependent = false,
  formatter: (value: number) => string = formatNumber,
): string {
  return line.replace(/\{([^}]+)\}/g, (match, expr: string) => {
    if (keepNodeDependent && (NODE_DEPENDENT_EXPRESSION.test(expr) || BEHAVIORAL_RUNTIME_EXPRESSION.test(expr))) return match;
    const string = stringParameter(expr, params);
    if (string !== undefined) return JSON.stringify(string);
    const value = evaluateExpression(expr, params);
    return formatter(value);
  });
}

export function formatNumber(value: number): string {
  // ngspice-47 numparam double_to_string uses "% 23.15e". Padding and
  // exponent zero-padding do not affect INPevaluate, but all 16 mantissa
  // digits must survive until the downstream card reader parses the text.
  // JS toExponential rounds exact halfway cases away from zero, whereas
  // printf rounds to even. Expand the binary double exactly before rounding.
  if (!Number.isFinite(value)) return value.toExponential(15);
  if (value === 0) return `${Object.is(value, -0) ? '-' : ''}0.000000000000000e+0`;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biasedExponent = Number((bits >> 52n) & 0x7ffn);
  const significand = (bits & ((1n << 52n) - 1n))
    | (biasedExponent === 0 ? 0n : 1n << 52n);
  const binaryExponent = (biasedExponent === 0 ? 1 : biasedExponent) - 1023 - 52;
  // For negative exponents, m / 2^k = (m * 5^k) / 10^k.
  const scale = Math.max(0, -binaryExponent);
  const exact = binaryExponent < 0
    ? significand * 5n ** BigInt(scale)
    : significand << BigInt(binaryExponent);
  const digits = exact.toString();
  let exponent = digits.length - scale - 1;
  let rounded = BigInt(digits.slice(0, 16).padEnd(16, '0'));
  if (digits.length > 16) {
    const remainder = BigInt(digits.slice(16));
    const halfway = 5n * 10n ** BigInt(digits.length - 17);
    if (remainder > halfway || (remainder === halfway && rounded % 2n !== 0n)) rounded++;
  }
  if (rounded === 10n ** 16n) {
    rounded /= 10n;
    exponent++;
  }
  const mantissa = rounded.toString();
  return `${value < 0 ? '-' : ''}${mantissa[0]}.${mantissa.slice(1)}e${exponent < 0 ? '' : '+'}${exponent}`;
}

function extractLibSection(content: string, section: string): string {
  const lines = content.split('\n');
  const output: string[] = [];
  let currentSection: string | null = null;
  const sectionUpper = section.toUpperCase();

  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('.LIB ')) {
      const tokens = trimmed.slice(5).trim().split(/\s+/);
      if (tokens.length === 1) {
        currentSection = tokens[0].toUpperCase();
        continue;
      }
      if (currentSection === null || currentSection === sectionUpper) {
        output.push(line);
      }
      continue;
    }

    if (upper.startsWith('.ENDL')) {
      currentSection = null;
      continue;
    }

    if (currentSection === null || currentSection === sectionUpper) {
      output.push(line);
    }
  }

  return output.join('\n');
}
