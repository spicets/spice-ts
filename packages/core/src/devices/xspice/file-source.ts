import { InvalidCircuitError } from '../../errors.js';
import { flag, real, STATIC, type BehaviorFactory } from './models.js';

interface Sample { readonly time: number; readonly values: readonly number[] }
const fail = (message: string): never => { throw new InvalidCircuitError(`XSPICE filesource: ${message}`); };

/** Independently expressed from ngspice-47 analog/file_source/cfunc.mod:
 * engineering suffixes, channel transforms, cumulative times and left-held
 * steps (the previous channel value is retained at an exact table corner).
 * File access belongs to the host resolver, never to the device model.
 */
export const fileSource: BehaviorFactory = (params, context) => {
  const text = params.get('__file_data')?.[0];
  if (typeof text !== 'string') fail('file requires host-resolved file data');
  const width = context.connections[0].ports.length;
  const offset = params.get('amploffset') ?? [];
  const scale = params.get('amplscale') ?? [];
  const rows: Sample[] = [];
  const number = (word: string): number => {
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i.exec(word);
    if (!match) return fail(`invalid value '${word}'`);
    const suffix = match[2].toLowerCase();
    const scales: Record<string, number> = { t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18 };
    const value = Number(match[1]) * (suffix.startsWith('me') ? 1e6 : suffix.startsWith('mi') ? 25.4e-6 : scales[suffix[0]] ?? 1);
    if (!Number.isFinite(value)) fail('values must be finite');
    return value;
  };
  let previous = real(params, 'timeoffset');
  for (const line of (text as string).split(/\r?\n/)) {
    if (/^\s*(?:[*#;]|$)/.test(line)) continue;
    const words = line.trim().split(/[\s=(),]+/);
    if (words.length < width + 1) fail('not enough value columns for output ports');
    const time = number(words[0]) * real(params, 'timescale')
      + (flag(params, 'timerelative') ? previous : real(params, 'timeoffset'));
    const values = words.slice(1, width + 1).map((word, i) => number(word) * Number(scale[i] ?? 1) + Number(offset[i] ?? 0));
    if (!Number.isFinite(time) || values.some(value => !Number.isFinite(value))) fail('transformed values must be finite');
    if (rows.length && time <= previous) fail('times must be strictly increasing');
    rows.push({ time, values });
    previous = time;
  }
  if (rows.length < 2) fail('at least two time rows required');
  return {
    stateful: false,
    ac: STATIC,
    breakpoints: () => rows.map(row => row.time).filter(time => time > 0),
    load({ time, outputs }) {
      // Search from scratch: rejected transient steps and repeated analyses
      // must not mutate a streaming cursor or retain future channel values.
      let low = 0, high = rows.length - 1;
      while (high - low > 1) {
        const mid = (low + high) >>> 1;
        if (time > rows[mid].time) low = mid; else high = mid;
      }
      const a = rows[low], b = rows[high];
      const fraction = flag(params, 'amplstep') ? 0 : (time - a.time) / (b.time - a.time);
      for (let i = 0; i < width; i++) {
        // Upstream returns the second row before the first timestamp.
        outputs[i] = time < rows[0].time ? rows[1].values[i]
          : time > rows.at(-1)!.time ? rows.at(-1)!.values[i]
            : a.values[i] + fraction * (b.values[i] - a.values[i]);
      }
    },
  };
};
