import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.js';
import { simulate } from '../simulate.js';
import { parseTitleless as parse } from './index.js';

/**
 * #713: the exact `.options` package lines of the 22 corpus-g Xyce Regression
 * Suite decks (Xyce_Regression 7bb7e98f, GPL-3.0-or-later) that spice-ts
 * rejected while ngspice-47 runs them. Expected options follow ngspice-47:
 * inp.c cp_setparse() + spiceif.c if_option() apply option-table names and
 * ignore every other word, including the package keyword.
 */
const CORPUS_G_PACKAGE_LINES: ReadonlyArray<readonly [string, string, object, number?]> = [
  ['BJT_ANALYTIC/ramp_test1.cir', '.options device gmin=0 voltlim=0', { deviceGmin: 0 }],
  [
    'BJT_OFF/bjt_off.cir',
    '.options nonlin maxstep=200 reltol=1.0e-2 abstol=1.0e-6 rhstol=1.0e-4',
    { reltol: 1e-2, abstol: 1e-6 },
  ],
  ['BUG_458/bug458.cir', '.OPTIONS LINSOL TYPE=klu', {}],
  [
    'DIAGNOSTIC/DC_CurrentCheck1.cir',
    '.options diagnostic CURRENTLIMIT=3e-2 diagfilename=DC_CurrentCheck1.dia',
    {},
  ],
  ['DIODE_ANALYTIC/reverse_model.cir', '.options TIMEINT reltol=1e-6 abstol-1e-6', { reltol: 1e-6 }],
  [
    'GMIN_STEPPING/gstep_cont3a.cir',
    '.options nonlin nlstrategy=0 searchmethod=0 maxstep=200 continuation=3 reltol=1.0e-2 abstol=1.0e-6 rhstol=1.0e-4',
    { reltol: 1e-2, abstol: 1e-6 },
  ],
  ['HOMOTOPY/schmidt.cir', '.options device voltlim=1 debuglevel=-100', {}],
  ['MEASURE_CONT/DerivTest1DC.cir', '.OPTIONS MEASURE USE_CONT_FILES=0', {}],
  ['MEXTRAM/acFreq_Gbb_noFlip_P.cir', '.options device temp=25', {}, 25],
  ['MPDE/invert1.cir', '.options TIMEINT maxord=5 debuglevel=-10 reltol=1.0e-4', { reltol: 1e-4, maxOrder: 5 }],
  ['Nonlinear/ConvergenceTests/NLStrategy1.cir', '.options nonlin nlstrategy=1 searchmethod=0', {}],
  ['PARAM_REFACTOR/paramHomotopy.cir', '.options nonlin continuation=1', {}],
  ['POWERNODE/resInner.cir', '.options nonlin nox=1', {}],
  ['PSEUDO/pseudo.cir', '.options device debuglevel=-10 voltlim=1', {}],
  ['PSP102/idvg0_Id_T27_pmos.cir', '.options device temp=27', {}, 27],
  ['PSP103/invert_psp_testDTA0.cir', '.options device temp=100', {}, 100],
  ['RESISTOR_TD/temp_dep.cir', '.OPTIONS DEVICE TEMP=-55', {}, -55],
  ['SANDLER25/sandler25.cir', '.OPTIONS NONLIN-TRAN SEARCHMETHOD=0', {}],
  ['SUPERNODE/supernode1.cir', '.options topology supernode=true', {}],
  [
    'TESTJAC/testjac_comp.cir',
    '.options device testjac=1 testjacwarn=1 TESTJACDEVICENAME=MQLO   TJABSTOL=1.0e-19  TJRELTOL=1.0e-12 debuglevel=-100',
    {},
  ],
  [
    'TIA/ERROROPTION/erroroption.cir',
    '.options TIMEINT method=7 erroption=1 nlmin=3 nlmax=5 timestepsreversal=0',
    {},
  ],
  ['TwoLevelAPI/resInnerTran.cir', '.options timeint debuglevel=-100', {}],
];

/** Further package lines from the same decks, after their first failing card. */
const COMPANION_PACKAGE_LINES: ReadonlyArray<readonly [string, object]> = [
  ['.options loca stepper=1 maxsteps=500', {}],
  ['.options loca ', {}],
  ['.options linsol TR_partition=0 ', {}],
  ['.options loca stepper=natural predictor=constant stepcontrol=adaptive', {}],
  ['.options nonlin nlstrategy=0 continuation=9', {}],
  ['.options nonlin nox=0  debuglevel=-100', {}],
  ['.options timeint abstol=1e-12 reltol=1e-6 ', { abstol: 1e-12, reltol: 1e-6 }],
  ['.options timeint method=gear abstol=1.0e-7 reltol=1.0e-6', {
    integrationMethod: 'gear2', abstol: 1e-7, reltol: 1e-6,
  }],
];

describe('Xyce .options packages follow ngspice-47 (#713)', () => {
  it.each(CORPUS_G_PACKAGE_LINES.map(([fixture, card, expected, temperature]) => ({
    fixture, card, expected, temperature,
  })))('$fixture: $card', ({ card, expected, temperature }) => {
    const circuit = parse(`${card}\n.op`);

    expect(circuit.simulationOptions).toEqual(expected);
    expect(circuit.temperature).toBe(temperature);
    expect(circuit.parseWarnings[0]).toMatch(/^Xyce \.options [A-Z-]+ package: ngspice-47 ignores the package name/);
    expect(circuit.parseWarnings.slice(1)).toEqual(
      card.includes('method=7')
        ? ['Ignored .options method=7: ngspice-47 rejects a numeric METHOD and keeps the current method']
        : [],
    );
  });

  it.each(COMPANION_PACKAGE_LINES)('companion card %s', (card, expected) => {
    expect(parse(`${card}\n.op`).simulationOptions).toEqual(expected);
  });

  it('names the ignored and applied fields in the structured parse warning', async () => {
    const result = await simulate(
      'Xyce package\n.options nonlin maxstep=200 reltol=1.0e-2 abstol=1.0e-6 rhstol=1.0e-4\nV1 1 0 1\nR1 1 0 1k\n.op\n.end',
    );

    expect(result.warnings).toContainEqual({
      type: 'parse',
      message: 'Xyce .options NONLIN package: ngspice-47 ignores the package name; '
        + 'ignored option names it does not recognise: maxstep=200 rhstol=1.0e-4; '
        + 'applied as ngspice options: reltol=1.0e-2 abstol=1.0e-6',
    });
  });

  it('reads TIMEINT ABSTOL as the ngspice current tolerance only, not VNTOL', () => {
    expect(parse('.options timeint reltol=1e-6 abstol=1e-6\n.op').simulationOptions)
      .toEqual({ reltol: 1e-6, abstol: 1e-6 });
  });

  it.each([
    ['trap', 'trapezoidal'],
    ['gear', 'gear2'],
    ['7', undefined],
    ['8', undefined],
  ] as const)('TIMEINT METHOD=%s follows the ngspice string-typed METHOD option', (method, expected) => {
    expect(parse(`.options timeint method=${method}\n.op`).simulationOptions.integrationMethod).toBe(expected);
  });

  it('treats MAXORD above 2 as the no-op ngspice trapezoidal order cap', () => {
    expect(parse('.options timeint maxord=5\n.op').simulationOptions).toEqual({ maxOrder: 5 });
    expect(parse('.options maxord=2 method=gear\n.op').simulationOptions).toEqual({ integrationMethod: 'gear2', maxOrder: 2 });
  });

  it.each([
    ['.options timeint maxord=5\n.options method=gear\n.op', 1],
    ['.options method=gear maxord=3\n.op', 1],
  ])('rejects MAXORD values that change ngspice integration: %s', (netlist, line) => {
    expect(() => parse(netlist)).toThrow(ParseError);
    expect(() => parse(netlist)).toThrow(expect.objectContaining({ line }));
  });

  it.each([
    ['.options device tnom=50\n.op', "Unsupported .options field: 'tnom'"],
    ['.options nonlin gminsteps=10\n.op', "Unsupported .options field: 'gminsteps'"],
    ['.options output savecurrents=1\n.op', "Unsupported .options field: 'savecurrents=1'"],
    ['.options timeint reltol=-1m\n.op', "Invalid .options reltol value: '-1m'"],
  ])('keeps ngspice-meaningful fields inside a package strict: %s', (netlist, message) => {
    expect(() => parse(netlist)).toThrow(message);
  });

  // A plain card follows the same ngspice-47 rule (#790): names it does not
  // recognise are ignored with a warning, the rest stay strict.
  it.each([
    ['.options maxstep=200\n.op', {}, 'maxstep=200'],
    ['.options voltlim=1\n.op', {}, 'voltlim=1'],
    ['.options nonlinx reltol=1e-3\n.op', { reltol: 1e-3 }, 'nonlinx'],
  ])('ignores names ngspice-47 does not recognise on plain .options cards: %s', (netlist, options, ignored) => {
    const circuit = parse(netlist);
    expect(circuit.simulationOptions).toEqual(options);
    expect(circuit.parseWarnings).toEqual([`Ignored .options fields ngspice-47 does not recognise: ${ignored}`]);
  });

  it('keeps ngspice-meaningful fields on plain .options cards strict', () => {
    expect(() => parse('.options gminsteps=10\n.op')).toThrow(ParseError);
  });
});
