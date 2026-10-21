import { InvalidCircuitError } from '../../errors.js';
import type { DigitalModel, DigitalModelFactory } from './digital-models.js';
import { UNKNOWN, UNDETERMINED, type DigitalValue, type EventBehavior } from './event-network.js';

const fail = (message: string): never => { throw new InvalidCircuitError(`XSPICE d_source: ${message}`); };

/** Independently expressed from ngspice-47 digital/d_source/cfunc.mod:
 * token separators 178-210, suffix conversion 379-465, rows 728-823,
 * DC/initial state and 100ps advance/delay scheduling 1084-1191.
 * input_load is declared in ifspec.ifs:54-63 but unused by cfunc.mod.
 */
export const digitalSource: DigitalModelFactory = (params, context) => {
  const text = params.get('__file_data')?.[0];
  if (typeof text !== 'string') fail('input_file requires host-resolved file data');
  const width = context.connections.find(c => c.name === 'out')!.ports.length;
  const rows: { time: number; values: DigitalValue[] }[] = [];
  for (const line of (text as string).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('*') || /^[\s*]+$/.test(line)) continue;
    const words = line.split(/[\s=(),]+/).filter(Boolean);
    if (words.length !== width + 1) fail('vector width does not match output port');
    // This converter is not the netlist RKM parser: cfunc accepts exponent +
    // suffix and atto, and interprets an unknown suffix as a scale of one.
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i.exec(words[0]);
    if (!match) fail(`invalid time '${words[0]}'`);
    const suffix = match![2].toLowerCase();
    const scales: Record<string, number> = { t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18 };
    const scale = suffix.startsWith('me') ? 1e6 : suffix.startsWith('mi') ? 25.4e-6 : scales[suffix[0]] ?? 1;
    const time = Number(match![1]) * scale;
    if (!Number.isFinite(time) || time < 0) fail('time must be finite and nonnegative');
    if (rows.length && time <= rows[rows.length - 1].time) fail('times must be strictly increasing');
    const values = words.slice(1).map(word => {
      if (!/^[01U][srzu]$/.test(word)) fail(`invalid digital value '${word}'`);
      return { state: '01U'.indexOf(word[0]), strength: 'srzu'.indexOf(word[1]) };
    });
    rows.push({ time, values });
  }
  if (!rows.length) fail('empty input file');
  const advance = 1e-10;
  const event: EventBehavior<{ index: number }> = {
    createState: () => ({ index: 0 }),
    event(call) {
      const { state } = call;
      if (call.time === 0) {
        const initial = rows[0].time === 0;
        call.outputs.forEach((out, i) => {
          Object.assign(out, initial ? rows[0].values[i] : { state: UNKNOWN, strength: UNDETERMINED });
        });
        state.index = initial ? 1 : 0;
      } else {
        const row = rows[state.index];
        if (row && call.time === row.time - advance) {
          call.outputs.forEach((out, i) => { Object.assign(out, row.values[i]); out.delay = advance; });
          state.index++;
        } else call.outputs.forEach(out => { out.changed = false; });
      }
      if (state.index < rows.length) call.queue(rows[state.index].time - advance);
    },
  };
  return { event } as DigitalModel<unknown>;
};
