import { describe, expect, it } from 'vitest';
import { InvalidCircuitError } from '../../errors.js';
import { parseXspiceInstance, parseXspiceModelCard } from '../../parser/xspice-parser.js';
import { buildXspiceEventNetwork, prepareXspiceInstance } from './compile.js';
import { XspiceEventNetwork } from './event-network.js';

describe('XSPICE event network initialization', () => {
  it('rejects a trial without committing state or history, then retries the temporary breakpoint', () => {
    const network = new XspiceEventNetwork();
    const view = network.addInstance({
      name: 'rollback', inputs: [], outputs: [{ node: 'out', invert: false }], hybrid: true,
      behavior: {
        createState: () => ({ calls: 0 }),
        event(call) {
          call.outputs[0].changed = false;
          if (call.analysis !== 'tran') return;
          call.state.calls++;
          if (call.time > .5) call.setTemporaryBreakpoint(.5);
        },
      },
    });
    network.operatingPoint(() => {});
    network.beginTransient(() => {}, 1e-12);
    expect(network.prepareStep(1, true)).toBe(.5);
    expect(view.state.calls).toBe(0);
    expect(network.prepareStep(.5, true)).toBeUndefined();
    network.acceptStep(.5, true);
    expect(view.state.calls).toBe(1);
  });
  it('rejects transient startup before initialization and permits it after initialization', () => {
    const prepared = prepareXspiceInstance(
      parseXspiceInstance('a1 d pull', 1),
      parseXspiceModelCard('.model pull d_pulldown', 2),
      false, '0',
    );
    const { network } = buildXspiceEventNetwork([prepared])!;
    const beginTransient = () => network.beginTransient(() => {}, 0);

    expect(beginTransient).toThrow(InvalidCircuitError);
    expect(beginTransient).toThrow('XSPICE event-driven instances need initialization before transient analysis');
    expect(network.nodeHistories().get('d')).toEqual([]);

    network.operatingPoint(() => {});
    expect(beginTransient).not.toThrow();
    expect(network.nodeHistories().get('d')).toEqual([{ time: 0, state: '0', strength: 'r' }]);
    network.processEvents(1e-9, 0);
    network.acceptStep(1e-9, true);
    expect(network.nodeHistories().get('d')).toEqual([{ time: 0, state: '0', strength: 'r' }]);
  });
});
