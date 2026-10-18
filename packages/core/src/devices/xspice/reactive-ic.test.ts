import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { parse } from '../../parser/index.js';
import { chargeTruncatedNodes } from '../../analysis/transient-node-truncation.js';
import { createTransientSim } from '../../analysis/transient-driver.js';
import { REACTIVE_IC_BEHAVIORS } from './reactive-ic-models.js';
import type { CodeModelCall } from './models.js';

// Identical minimal decks checked with Homebrew ngspice-47: OP=1, TRAN=1+2*t
// (the voltage-source branch current is the negative of the inductor current).
const cases = [
  { model: 'capacitoric', source: 'i1 0 out 0.002', parameter: 'c=0.001' },
  { model: 'inductoric', source: 'v1 out 0 2', parameter: 'l=1' },
];

for (const { model, source, parameter } of cases) {
  describe(`XSPICE ${model}`, () => {
    const deck = (options = '') => `${model} reference\n${source}\na1 out 0 m\n.model m ${model}(${parameter} ic=1)\n${options}\n`;
    it('uses the specified initial condition in OP', async () => {
      const result = await simulate(`${deck()} .op\n.end`);
      const value = model === 'capacitoric' ? result.dc!.voltage('out') : -result.dc!.current('v1');
      expect(value).toBeCloseTo(1, 10);
    });
    it('uses MIF integral truncation without an additional node-voltage LTE check (#1237)', () => {
      const circuit = parse(`${deck()}.tran .1 1\n.end`).compile();
      const reactive = circuit.devices.find(device => device.name === 'a1')!;
      expect(reactive.truncateTransientStep).toBeTypeOf('function');
      expect(reactive.truncationCoversCharges).toBe(true);
      const exempt = chargeTruncatedNodes(Math.max(...reactive.nodes) + 1, circuit.devices);
      for (const node of reactive.nodes) {
        if (node >= 0) expect(exempt[node]).toBe(1);
      }
    });
    it('does not ramp a plain OP even when ramptime is specified', async () => {
      const result = await simulate(`${deck('.option ramptime=0.2')}.op\n.end`);
      expect(model === 'capacitoric' ? result.dc!.voltage('out') : -result.dc!.current('v1')).toBeCloseTo(1, 10);
    });
    it('matches the ngspice-47 ramp-release state and decay grid (#1237)', async () => {
      // Unit-time-constant RC/RL discharge: ngspice-47 takes 67 points and
      // releases the ramp from the last accepted state, not exactly ic=1.
      const resistance = model === 'capacitoric' ? '1k' : '1';
      const result = await simulate(`${deck('.option ramptime=0.2').replace(source, `r1 out 0 ${resistance}`)}.tran .1 5\n.end`);
      const tran = result.transient!;
      const release = tran.time.findIndex(time => time === 0.2);
      expect(release).toBeGreaterThan(0);
      expect(tran.time).toHaveLength(67);
      const sign = model === 'capacitoric' ? 1 : -1;
      expect(sign * tran.voltage('out')[release]).toBeCloseTo(0.9434399588155, 9);
      expect(sign * tran.voltage('out').at(-1)!).toBeCloseTo(0.009673735460594442, 10);
    });
    it('integrates from ic at every transient point', async () => {
      const result = await simulate(`${deck()}.tran .1 1\n.end`);
      const tran = result.transient!;
      const values = model === 'capacitoric' ? tran.voltage('out') : tran.current('v1');
      for (let i = 0; i < tran.time.length; i++) {
        expect(values[i] * (model === 'capacitoric' ? 1 : -1)).toBeCloseTo(1 + 2 * tran.time[i], 8);
      }
    });
    it('matches ngspice-47 AC gain, including its inductoric convention', async () => {
      const acDeck = deck().replace(source, `${source} ac 1`);
      const result = await simulate(`${acDeck}.ac lin 1 1 1\n.end`);
      const point = model === 'capacitoric' ? result.ac!.voltage('out')[0] : result.ac!.current('v1')[0];
      expect(point.magnitude).toBeCloseTo(model === 'capacitoric' ? 159.15494309189535 : 6.283185307179586, 8);
      expect(point.phase).toBeCloseTo(-90, 8);
    });
    it('ramps ic before integrating, including the transient OP', async () => {
      const result = await simulate(`${deck('.option ramptime=0.2')}.tran .1 1\n.end`);
      const tran = result.transient!;
      const values = model === 'capacitoric' ? tran.voltage('out') : tran.current('v1');
      expect(values[0]).toBeCloseTo(0, 10);
      for (let i = 1; i < tran.time.length; i++) {
        if (tran.time[i] < 0.2) expect(values[i] * (model === 'capacitoric' ? 1 : -1)).toBeCloseTo(tran.time[i] / 0.2, 8);
      }
      expect(values.at(-1)! * (model === 'capacitoric' ? 1 : -1)).toBeGreaterThan(2.5);
    });
    it('restarts the ramp in the streaming API and honours API overrides', async () => {
      const sim = await createTransientSim(`${deck('.option ramptime=0.2')}.tran .1 1\n.end`, { rampTime: 0.4 });
      const first = sim.advance();
      expect(first.voltages.get('out')).toBeCloseTo(model === 'capacitoric' ? first.time / 0.4 : 2, 10);
      if (model === 'inductoric') expect(first.currents.get('v1')).toBeCloseTo(-first.time / 0.4, 10);
      sim.reset();
      const restarted = sim.advance();
      expect(restarted.time).toBe(first.time);
      expect(restarted.voltages).toEqual(first.voltages);
      expect(restarted.currents).toEqual(first.currents);
      sim.dispose();
    });
    it('keeps accepted history unchanged by rejected trials and uses BDF2', () => {
      const behavior = REACTIVE_IC_BEHAVIORS.get(model)!(new Map([[model === 'capacitoric' ? 'c' : 'l', [2]], ['ic', [1]]]), {} as never);
      const call = (time: number, input = 4): CodeModelCall => ({ analysis: time === 0 ? 'dc' : 'tran', init: false,
        time, delta: 0.1, inputs: Float64Array.of(input), outputs: new Float64Array(1), partials: new Float64Array(1), notConverged() {} });
      behavior.accept!(call(0));
      behavior.load(call(5, 999));
      const first = call(0.1);
      behavior.load(first);
      expect(first.outputs[0]).toBeCloseTo(1.2, 12);
      expect(first.partials[0]).toBeCloseTo(0.05, 12);
      behavior.accept!(first);
      const second = { ...call(0.2), integration: { method: 'gear2' as const, dt: 0.1, prevDt: 0.1 } };
      behavior.load(second);
      expect(second.outputs[0]).toBeCloseTo(1.4, 12);
      expect(second.partials[0]).toBeCloseTo(1 / 30, 12);
    });
  });
}
