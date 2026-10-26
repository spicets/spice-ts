import { readFileSync } from 'node:fs';
import { simulate } from '../../../packages/core/src/index.js';

type Point = Record<string, number>;
const directory = new URL('./', import.meta.url);
const { references } = JSON.parse(readFileSync(new URL('reference.json', directory), 'utf8')) as {
  references: { id: string; temperature: number; op: Point[]; dc: Point[] }[];
};
const totals = new Map<number, { passed: number; failed: number; worstRelativeError: number }>();
for (const reference of references) {
  const total = totals.get(reference.temperature) ?? { passed: 0, failed: 0, worstRelativeError: 0 };
  totals.set(reference.temperature, total);
  try {
    const result = await simulate(readFileSync(new URL(`${reference.id}.cir`, directory), 'utf8'));
    for (const [kind, points] of [['op', reference.op], ['dc', reference.dc]] as const) {
      points.forEach((point, index) => {
        for (const [signal, expected] of Object.entries(point)) {
          const name = signal.slice(2, -1);
          const actual = kind === 'op'
            ? signal.startsWith('v(') ? result.dc!.voltage(name) : result.dc!.current(name)
            : name === 'v-sweep' ? result.dcSweep!.sweepValues[index]
              : signal.startsWith('v(') ? result.dcSweep!.voltage(name)[index] : result.dcSweep!.current(name)[index];
          const error = expected === 0 ? (actual === 0 ? 0 : Infinity) : Math.abs((actual - expected) / expected);
          total.worstRelativeError = Math.max(total.worstRelativeError, error);
          if (!(error <= 1e-6)) throw new Error(`${kind} ${signal}: relative error ${error}`);
        }
      });
    }
    total.passed++;
  } catch (error) {
    total.failed++;
    console.error(reference.id, error instanceof Error ? error.message : error);
  }
}
console.log(JSON.stringify(Object.fromEntries(totals), null, 2));
if ([...totals.values()].some(total => total.failed)) process.exitCode = 1;
