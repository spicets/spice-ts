import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { simulate } from '../../simulate.js';
import { DIGITAL_MODELS } from './digital-models.js';
import { HI_IMPEDANCE, ONE, STRONG, UNDETERMINED, UNKNOWN, ZERO, type EventOutput } from './event-network.js';
import { XSPICE_CODE_MODEL_SPECS } from './spec.js';

function openDeck(model: string, inertial = false): string {
  return `open buffer reference
v1 in 0 PWL(0 0 10n 0 11n 1 30n 1 31n 0 50n 0 51n .5 70n .5 71n 1)
aadc [in] [din] adc
.model adc adc_bridge(in_low=.2 in_high=.8 rise_delay=1n fall_delay=1n)
aopen din dout open
.model open ${model}(open_delay=3n ${model === 'd_open_c' ? 'fall' : 'rise'}_delay=2n inertial_delay=${inertial})
adac [dout] [out] dac
.model dac dac_bridge(out_low=0 out_high=1 out_undef=.5 t_rise=2n t_fall=2n)
r1 out 0 1k
.tran .1n 90n
.end`;
}

describe.each(['d_open_c', 'd_open_e'])('%s', model => {
  it('registers only the ngspice open and driven-edge delays', () => {
    const spec = XSPICE_CODE_MODEL_SPECS.get(model)!;
    expect(spec.connections.map(c => [c.name, c.direction, c.defaultType, c.vector]))
      .toEqual([['in', 'in', 'd', false], ['out', 'out', 'd', false]]);
    expect(spec.params.map(p => p.name)).toEqual([
      ...(model === 'd_open_c' ? ['open_delay', 'fall_delay'] : ['rise_delay', 'open_delay']),
      'input_load', 'family', 'inertial_delay',
    ]);
  });

  it.each([ZERO, ONE, UNKNOWN])('copies state %s with open/strong/undetermined strength', input => {
    const params = new Map([['rise_delay', [2]], ['fall_delay', [2]], ['open_delay', [3]]]);
    const event = DIGITAL_MODELS.get(model)!(params, {
      given: new Set(), connections: [{ name: 'in', direction: 'in', isNull: false, ports: [{ type: 'd', positive: 'din' }] }],
    }).event;
    const state = event.createState();
    const output: EventOutput = { changed: true, state: ZERO, strength: STRONG, delay: 0, load: 0 };
    const call = { analysis: 'tran' as const, init: false, time: 7, previousTime: 6,
      state, previous: state, outputs: [output], inputState: () => input,
      inputReal: () => 0, queue() {}, inputValue() { throw new Error('unused'); },
      probeExternal() { throw new Error('unused'); }, setBreakpoint() {},
      setTemporaryBreakpoint: () => false, scheduleOutput() {},
    };
    event.event(call);
    const driven = model === 'd_open_c' ? ZERO : ONE;
    expect(output.state).toBe(input);
    expect(output.strength).toBe(input === UNKNOWN ? UNDETERMINED : input === driven ? STRONG : HI_IMPEDANCE);
    expect(output.delay).toBe(input === UNKNOWN ? (model === 'd_open_c' ? 2 : 3) : input === driven ? 2 : 3);
    event.event(call);
    expect(output.changed).toBe(false);
  });

  it.each([false, true])('parses and simulates .tran through ADC and DAC bridges, inertial=%s', async inertial => {
    const result = (await simulate(openDeck(model, inertial))).transient!;
    const changes = result.digital('dout');
    expect(changes.map(c => c.state)).toEqual(inertial ? ['0', '1', '0', 'U', '1'] : ['0', 'U', '1', 'U', '0', 'U', '1']);
    const strength = (state: string): string => state === 'U' ? 'u' : state === (model === 'd_open_c' ? '0' : '1') ? 's' : 'z';
    expect(changes.map(c => c.strength)).toEqual(changes.map(c => strength(c.state)));
    expect(result.voltage('out').every(Number.isFinite)).toBe(true);
  });
});

// Self-authored decks, project MIT licence. Invoke the opt-in oracle through spice-heavy.
describe.skipIf(process.env.NGSPICE_OPEN_REFERENCE !== '1')('ngspice-47 open buffer parity', () => {
  for (const model of ['d_open_c', 'd_open_e']) {
    for (const inertial of [false, true]) {
      it(`${model} inertial=${inertial}: exact digital events and DAC waveform`, async () => {
        expect(spawnSync('ngspice', ['--version'], { encoding: 'utf8' }).stdout).toMatch(/ngspice-47\b/);
        const directory = mkdtempSync(join(tmpdir(), 'spice-open-'));
        try {
          const deck = openDeck(model, inertial);
          writeFileSync(join(directory, 'input.cir'), deck);
          writeFileSync(join(directory, 'oracle.cir'), `open reference commands
.control
set numdgt=17
source input.cir
run
echo DIGITAL_BEGIN
eprint dout
echo DIGITAL_END
wrdata values.txt v(out)
quit
.endc
.end
`);
          const ngStart = performance.now();
          const ng = spawnSync('ngspice', ['-b', 'oracle.cir'], {
            cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: directory },
          });
          const ngMs = performance.now() - ngStart;
          expect(ng.error).toBeUndefined();
          expect(ng.status, ng.stderr).toBe(0);
          expect(ng.stdout + ng.stderr).not.toMatch(/MIF-ERROR|Error:/i);
          const history = ng.stdout.split('DIGITAL_BEGIN')[1].split('DIGITAL_END')[0].split('\n')
            .map(line => line.trim().split(/\s+/)).filter(row => row.length === 2 && Number.isFinite(Number(row[0])))
            .map(row => ({ time: Number(row[0]), state: row[1][0], strength: row[1][1] }));
          expect(history.length).toBeGreaterThan(0);
          const start = performance.now();
          const result = (await simulate(deck)).transient!;
          const tsMs = performance.now() - start;
          expect(result.digital('dout')).toEqual(history);
          const rows = readFileSync(join(directory, 'values.txt'), 'utf8').trim().split('\n')
            .map(line => line.trim().split(/\s+/).map(Number));
          const values = result.voltage('out');
          let i = 0;
          const errors = rows.map(([time, value]) => {
            while (i < result.time.length - 2 && result.time[i + 1] < time) i++;
            const fraction = (time - result.time[i]) / (result.time[i + 1] - result.time[i]);
            return Math.abs(values[i] + fraction * (values[i + 1] - values[i]) - value);
          });
          const maxAbs = Math.max(...errors);
          expect(maxAbs).toBeLessThanOrEqual(1e-6);
          console.log(JSON.stringify({ model, inertial, events: history.length, maxTimeError: 0,
            maxAbs, rmsAbs: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length),
            ngPoints: rows.length, tsPoints: result.time.length, ngMs, tsMs }));
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
