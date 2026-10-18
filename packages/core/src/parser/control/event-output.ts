import { ControlScriptError } from './errors.js';
import type { ControlAnalysisRun } from './interpreter.js';
import type { ControlSourceLine } from './source.js';
import { splitWords, unquote } from './set-arguments.js';

/**
 * ngspice src/xspice/evt/evtprint.c: EVTprint, print_data and EVTdisplay.
 * https://github.com/imr/ngspice/blob/master/src/xspice/evt/evtprint.c
 * Event output belongs to the latest simulation, not the selected analog plot.
 * The available histories include the initial DCOP value followed by transitions;
 * messages and solver statistics are not represented and must not be invented.
 */
export function eventOutput(
  command: 'eprint' | 'edisplay',
  rest: string,
  runs: readonly ControlAnalysisRun[],
  line: ControlSourceLine,
): string[] {
  const fail = (message: string): never => {
    throw new ControlScriptError(`${command}: ${message}`, line.lineNumber, line.text);
  };
  const names = splitWords(rest).map(unquote);
  if (command === 'eprint') {
    if (names.length === 0) return ['Usage: eprint <node1> <node2> ...'];
    if (names.length > 32) fail('currently limited to 32 arguments');
  }
  const latest = [...runs].reverse().find(run => run.result.transient !== undefined);
  const nodes = latest?.result.transient?.digitalNodes;
  if (command === 'edisplay') {
    if (!nodes?.size) return ['No event node available!'];
    return [
      `\nList of event nodes in plot ${latest!.plot}`,
      `    ${'node name'.padEnd(20)}: ${'type'.padEnd(5)}, number of events\n`,
      ...[...nodes].map(([name, events]) => `    ${name.padEnd(20)}: digital, ${String(events.length).padStart(5)}`),
    ];
  }
  if (!nodes) return fail('No node data: simulation not yet run?');
  const histories = names.map(name => {
    const events = [...nodes].find(([node]) => node.toLowerCase() === name.toLowerCase())?.[1];
    if (!events) return fail(`Node ${name} is not an event node.`);
    if (events.length === 0) return fail(`No node data for ${name}`);
    return events;
  });
  const positions = histories.map(() => 0);
  const row = (step: string) => step + histories.map((history, i) => {
    const event = history[positions[i]];
    return `    ${event.state}${event.strength}`;
  }).join('');
  const output = ['\n**** Results Data ****\n', 'Time or Step', ...names, '\n', row('DCOP            ')];
  // Advance one entry per node at each step, preserving simultaneous/repeated
  // timestamps exactly as EVTprint's linked-list merge does.
  while (true) {
    let time = Infinity;
    histories.forEach((history, i) => {
      const next = history[positions[i] + 1];
      if (next && next.time < time) time = next.time;
    });
    if (time === Infinity) break;
    histories.forEach((history, i) => {
      if (history[positions[i] + 1]?.time === time) positions[i]++;
    });
    const step = time.toExponential(9).replace(/e([+-])(\d)$/, 'e$10$2');
    output.push(row(step.padEnd(16)));
  }
  output.push('\n');
  return output;
}
