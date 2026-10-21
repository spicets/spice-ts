import { describe, expect, it } from 'vitest';
import { parse } from './index.js';
import { simulate } from '../simulate.js';
import { ParseError } from '../errors.js';

/**
 * Analysis commands inside ngspice `.control` blocks (#489).
 *
 * The control blocks below are verbatim excerpts of ngspice decks from corpus-f batch 1
 * (ngspice `3ef069fb1f04177a153f342a32d941fc20ff047e`, BSD-3-Clause), committed on branch
 * `wt/corpus-f-batch1-484` under `benchmarks/corpus/corpus-f/fixtures/<path>`. The circuits
 * around them are small stand-ins so these tests do not depend on unsupported devices.
 */
const rc = `V1 1 0 dc 1 ac 1 pulse(0 1 0 1u 1u 1m 2m)
R1 1 2 1k
C1 2 0 1u`;

function parseError(netlist: string): ParseError {
  try {
    parse(netlist);
  } catch (error) {
    expect(error).toBeInstanceOf(ParseError);
    return error as ParseError;
  }
  throw new Error('expected a ParseError');
}

describe('.control analysis commands (#489)', () => {
  it('maps a control tran command onto the .tran dot card (examples/digital/auto_bridge/vcc.cir)', async () => {
    const control = await simulate(`Control tran
${rc}
.control
tran 100n 30u
plot in out
.endc
.end`);
    const dot = await simulate(`Dot tran
${rc}
.tran 100n 30u
.end`);

    expect(parse(`t\n${rc}\n.control\ntran 100n 30u\n.endc`).analyses)
      .toEqual(parse(`t\n${rc}\n.tran 100n 30u`).analyses);
    expect(control.transient!.time).toEqual(dot.transient!.time);
    expect(control.transient!.voltage('2')).toEqual(dot.transient!.voltage('2'));
  });

  it('accepts upper-case TRAN with tstart/tmax plus rusage and plot-only set variables (examples/TransmissionLines/ltra3_2_line.sp)', () => {
    const circuit = parse(`Control TRAN
${rc}
.control
TRAN 0.2N 47.9NS
rusage
set color0=white
set xbrushwidth=3
PLOT v(648) v(651) v(751)
.endc`);
    expect(circuit.analyses).toEqual(parse(`t\n${rc}\n.tran 0.2N 47.9NS`).analyses);
    expect(circuit.analyses[0]).toMatchObject({ type: 'tran', timestep: 0.2e-9, stopTime: 47.9e-9 });

    const withStart = parse(`Control TRAN\n${rc}\n.control\nTRAN 0.2N 47N 0 0.1N\nrusage\n.endc`);
    expect(withStart.analyses).toEqual([parse(`t\n${rc}\n.tran 0.2N 47N 0 0.1N`).analyses[0]]);
  });

  it('maps a nested control dc sweep and keeps display/plot output-only (examples/p-to-n-examples/MOS1_out.cir, examples/probe/probe-i-dev.cir)', async () => {
    const circuit = parse(`Control dc
${rc}
V2 3 0 1
R2 3 0 1k
.control
dc v1 0 5 0.1 v2 0 5 1
plot vs1#branch vs2#branch vs3#branch
display
.endc`);
    expect(circuit.analyses).toEqual([{
      type: 'dc', source: 'v1', start: 0, stop: 5, step: 0.1,
      secondary: { source: 'v2', start: 0, stop: 5, step: 1 },
    }]);

    const result = await simulate(`Control dc\n${rc}\n.control\ndc V1 -5 5 1\ndisplay\nset xbrushwidth=2\nplot i(r1)\n.endc`);
    expect(result.dcSweep!.sweepValues).toHaveLength(11);
  });

  it('runs op, tran and ac commands in one block (tests/regression/misc/empty-1.cir)', async () => {
    const netlist = `Control op/tran/ac
${rc}
.control
op
tran 0.1m 1m
ac lin 3 1kHz 2kHz
echo "TEST: done"
quit 0
.endc
.end`;
    expect(parse(netlist).analyses.map(analysis => analysis.type)).toEqual(['op', 'tran', 'ac']);

    const result = await simulate(netlist);
    expect(result.dc!.voltage('2')).toBeCloseTo(1, 9);
    expect(result.transient!.time.at(-1)).toBeCloseTo(1e-3, 12);
    expect(result.ac!.frequencies).toHaveLength(3);
  });

  it('keeps pyplot and pyplot_subplots output-only after run (#1631)', async () => {
    const deck = `Batch pyplot\n${rc}\n.tran 1u 20u`;
    const result = await simulate(`${deck}
.control
run
pyplot py1 v(1) v(2)+6 title 'named plot'
set pyplot_subplots=1
pyplot py2 v(1) v(2) title 'subplots'
unset pyplot_subplots
PYPLOT v(1) v(2)+6 title 'unnamed plot'
set pyplot_subplots=2
pyplot v(1) v(2) title 'shared scale'
.endc
.end`);
    const baseline = await simulate(`${deck}\n.end`);
    expect(result.transient!.time.length).toBeGreaterThan(1);
    expect(result.transient!.time).toEqual(baseline.transient!.time);
    expect(result.transient!.voltage('2')).toEqual(baseline.transient!.voltage('2'));
  });

  it('still rejects known unimplemented commands following pyplot with a structured error (#1631)', async () => {
    await expect(simulate(`Unsupported after pyplot\n${rc}\n.tran 1u 20u\n.control\nrun\npyplot v(2)\nsource other.cir\n.endc\n.end`))
      .rejects.toMatchObject({
        name: 'UnsupportedControlCommandError',
        code: 'UNSUPPORTED_CONTROL_COMMAND',
        command: 'source',
        line: 9,
        context: 'source other.cir',
      });
  });

  it('accepts settype between analyses as output-only (examples/vbic/vbic99_tran.sp)', () => {
    const circuit = parse(`Control settype
${rc}
.control
op
tran 50p 100n
set xbrushwidth=2
plot v(in) v(b) v(c) v(vp)
settype temperature v(t)
plot v(t)
.endc`);
    expect(circuit.analyses.map(analysis => analysis.type)).toEqual(['op', 'tran']);
  });

  it('treats bare run as a no-op next to control analyses (examples/osdi/hicuml0/vbic_out.sp)', () => {
    const circuit = parse(`Control run\n${rc}\n.control\ndc v1 0.0 5.0 0.05\nrun\nplot abs(i(vc))\n.endc`);
    expect(circuit.analyses).toEqual([{ type: 'dc', source: 'v1', start: 0, stop: 5, step: 0.05, secondary: undefined }]);
  });

  it('reports malformed control analysis arguments with the control line number', () => {
    const error = parseError(`Bad tran\n${rc}\n.control\ntran 1u\n.endc`);
    expect(error.line).toBe(6);
    expect(error.message).toContain('.tran requires TSTEP and TSTOP');
  });

  it('runs a repeated analysis type through the interpreter, one plot per run (examples/vdmos/IXTP6N100D2-n-weak-inv.sp)', async () => {
    const netlist = `Two sweeps
${rc}
.control
dc  v1 -3.1 -2.1 0.01
plot vs#branch
dc  v1 0 60 0.1
.endc`;
    // Not lowered onto dot cards: the interpreter runs both sweeps in order.
    expect(parse(netlist).analyses).toEqual([]);
    const result = await simulate(netlist);
    expect(result.control!.runs.map(run => run.plot)).toEqual(['dc1', 'dc2']);
    expect(result.control!.runs[0].result.dcSweep!.sweepValues).toHaveLength(101);
    // The top-level field holds the latest run of the type, like ngspice's current plot.
    // ngspice-47 accumulates `+= 0.1` to 60.00000000000058, past its 1e3*DBL_EPSILON stop
    // tolerance, so `dc v1 0 60 0.1` has 600 points ending at 59.90000000000058 (#654).
    expect(result.dcSweep!.sweepValues).toHaveLength(600);

    // A dot card plus a control command of the same type: the control run, then
    // ngspice's own run of the deck's dot cards after the script.
    const dotThenControl = await simulate(`Dot then control\n${rc}\n.tran 1u 1m\n.control\ntran 1u 2m\n.endc`);
    expect(dotThenControl.control!.runs.map(run => run.plot)).toEqual(['tran1']);
    expect(dotThenControl.control!.runs[0].result.transient!.time.at(-1)).toBeCloseTo(2e-3, 12);
    expect(dotThenControl.transient!.time.at(-1)).toBeCloseTo(1e-3, 12);
  });

  it.each([
    // examples/rf/pss/vackar_osc_pss_ctrl.cir
    ['tran 10n 20u\nspec 10 1meg 10 v(4)', 'spec'],
    ['pss 1.8e6 20e-6 4 1024 10 50 5e-3 uic', 'pss'],
  ])('rejects a command spice-ts does not execute at parse time: %s', (control, command) => {
    const error = parseError(`Unsupported\n${rc}\n.control\n${control}\n.endc`);
    expect(error.message).toContain(`Unsupported .control command '${command}'`);
  });

  it.each([
    // examples/vdmos/IXTH80N20L-IXTH48P20P-quasisat.sp (no such model in this stand-in circuit)
    ['dc v1 -1 100 0.05\naltermod mn1 rq=0', 'altermod'],
    // result-affecting front-end variables are rejected, one assignment at a time (#516 review)
    ['set ngbehavior=ps\nop', 'set'],
    ['set color0=white ngbehavior=ps\nop', 'set'],
    ['set ngbehavior=ps color0=white\nop', 'set'],
  ])('rejects a result-affecting form when the script runs: %s', async (control, command) => {
    await expect(simulate(`Unsupported\n${rc}\n.control\n${control}\n.endc`))
      .rejects.toThrow(`Unsupported .control command '${command}'`);
  });

  it.each<string>([
    'set color0=white color1=black xbrushwidth=3',
    'set color0 = white xgridwidth = 2',
  ])('accepts a set line whose every assignment is plot styling: %s', (setLine) => {
    expect(parse(`Plot styling\n${rc}\n.control\n${setLine}\nop\n.endc`).analyses)
      .toEqual(parse(`t\n${rc}\n.op`).analyses);
  });
});
