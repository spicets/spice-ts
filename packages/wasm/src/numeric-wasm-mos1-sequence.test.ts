import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { simulateLinearOpWasmV1 } from './numeric-wasm.js';

type Event = { kind: string; time: number };
const { wasmEvents } = vi.hoisted(() => ({ wasmEvents: [] as Event[] }));
vi.mock('@spice-ts/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@spice-ts/core')>();
  return {
    ...core,
    createTransientSim: async (...[input, options]: Parameters<typeof core.createTransientSim>) => {
      // Observe only: retain the real driver, options and WASM solver factory.
      const sim = await core.createTransientSim(input, {
        ...options,
        onReject: event => {
          wasmEvents.push({ kind: event.reason, time: event.time });
          options?.onReject?.(event);
        },
      });
      const advance = sim.advance.bind(sim);
      sim.advance = () => {
        const step = advance();
        wasmEvents.push({ kind: 'accept', time: step.time });
        return step;
      };
      return sim;
    },
  };
});

describe('default MOS1 adaptive decision parity', () => {
  it('has the same accepted/rejected trial sequence with dense and sparse solves', async () => {
    const source = readFileSync(new URL('../../../benchmarks/wasm-mos1-tran/inverter.cir', import.meta.url), 'utf8');
    const bytes = readFileSync(new URL('../native/dense-solver.wasm', import.meta.url));
    wasmEvents.length = 0;
    const result = await simulateLinearOpWasmV1({ apiVersion: '1', input: { format: 'spice', source } }, bytes);
    const core = await vi.importActual<typeof import('@spice-ts/core')>('@spice-ts/core');
    const events: Event[] = [];
    const sim = await core.createTransientSim(source, {
      onReject: event => events.push({ kind: event.reason, time: event.time }),
    });
    try {
      while (!sim.isDone) events.push({ kind: 'accept', time: sim.advance().time });
    } finally { sim.dispose(); }
    expect(wasmEvents.map(event => event.kind)).toEqual(events.map(event => event.kind));
    expect(events.some(event => event.kind !== 'accept')).toBe(true);
    expect(result.analyses[0]?.type).toBe('tran');
    process.stdout.write(`MOS1 adaptive sequence ${JSON.stringify({ accepted: events.filter(event => event.kind === 'accept').length, rejected: events.filter(event => event.kind !== 'accept').length })}\n`);
  });
});
