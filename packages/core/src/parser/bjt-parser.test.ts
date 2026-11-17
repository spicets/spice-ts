import { describe, expect, it } from 'vitest';
import { ParseError } from '../errors.js';
import { simulate } from '../simulate.js';
import { parseBJTInstance } from './bjt-parser.js';
import { parse } from './index.js';

describe('BJT Q-card parser', () => {
  it.each([
    [['Q1', 'c', 'b', 'e', 'QMOD'], {}],
    [['Q1', 'c', 'b', 'e', 'QMOD', 'OFF'], {}],
    [['Q1', 'c', 'b', 'e', 'substrate', 'QMOD'], { substrate: 'substrate' }],
    [['Q1', 'c', 'b', 'e', 'substrate', 'QMOD', 'OFF'], { substrate: 'substrate' }],
    [['Q1', 'c', 'b', 'e', '0', 'QMOD'], { substrate: '0' }],
    [['Q1', 'c', 'b', 'e', '0', 'QMOD', 'OFF'], { substrate: '0' }],
    [['Q1', 'c', 'b', 'e', '0', 'QMOD', 'OFF=1'], { substrate: '0' }],
    [['Q1', 'c', 'b', 'e', 's', 't', 'QMOD'], { substrate: 's', thermal: 't' }],
    [['Q1', 'c', 'b', 'e', 's', 't', 'QMOD', 'OFF'], { substrate: 's', thermal: 't' }],
  ])('resolves the bounded token shape %j', (tokens, extraTerminals) => {
    expect(parseBJTInstance(tokens, 1)).toEqual({
      collector: 'c',
      base: 'b',
      emitter: 'e',
      modelName: 'QMOD',
      ...extraTerminals,
    });
  });

  it('treats OFF as an initial-state hint rather than disabling the BJT', async () => {
    const result = await simulate(`BJT OFF startup hint
      VCC 1 0 DC 12
      .model QMOD NPN(BF=100 IS=1e-14)
      RB 1 2 100k
      RC 1 3 1k
      Q1 3 2 0 QMOD OFF
      .op
      .end
    `);

    expect(result.dc!.voltage('2')).toBeGreaterThan(0.55);
    expect(result.dc!.voltage('3')).toBeLessThan(12);
  });

  it('accepts the classic four-node substrate form and resolves its model', () => {
    const compiled = parse(`classic four-node BJT
      Q1 collector base emitter substrate QMOD
      .model QMOD NPN(BF=80)
      .op
    `).compile();

    expect(compiled.devices[0]).toMatchObject({
      name: 'Q1',
      params: { BF: 80 },
    });
  });

  it('resolves the model of a grounded-substrate card like ngspice (#382)', () => {
    const compiled = parse(`grounded substrate BJT
      Q1 3 2 0 0 test
      .model test npn kf=1e-20 af=1 bf=100 rb=10
      .op
    `).compile();

    const names = compiled.devices.map(device => device.name);
    expect(names).toContain('Q1.RB');
    expect(compiled.devices.find(device => device.name === 'Q1')).toMatchObject({
      params: { BF: 100, RB: 10 },
    });
  });

  it('rejects a grounded-substrate card whose model is undefined instead of using a default BJT', () => {
    expect(() => parse(`grounded substrate, missing model
      Q1 3 2 0 0 missing
      .op
    `).compile()).toThrow("BJT 'Q1' references unknown model 'missing'");
  });

  it('exposes the next unsupported model fields after classic Q-card parsing', () => {
    expect(() => parse(`classic OFF form
      Q1 c b e QSTD OFF
      .model QSTD NPN(BF=50 VAF=50 IBE=1f)
      .op
    `).compile()).toThrow("Unsupported bounded BJT model parameter: 'IBE'");

    expect(() => parse(`classic substrate form
      Q1 c b e substrate QMOD
      .model QMOD NPN(BF=100 VAF=50 IBC=1f)
      .op
    `).compile()).toThrow("Unsupported bounded BJT model parameter: 'IBC'");
  });

  it.each([
    [['Q1', 'c', 'b', 'e', 'QMOD', 'AREA=100p'], { params: { AREA: 100e-12 } }],
    [['Q1', 'c', 'b', 'e', 'QMOD', 'area=8', 'M=2'], { params: { AREA: 8, M: 2 } }],
    [['Q1', 'c', 'b', 'e', 'QMOD', '3'], { params: { AREA: 3 } }],
    [['Q1', 'c', 'b', 'e', 'QMOD', '3', 'm=2', 'OFF'], { params: { AREA: 3, M: 2 } }],
    [['Q1', 'c', 'b', 'e', 'QMOD', 'OFF=1'], {}],
    [['Q1', 'c', 'b', 'e', 'QMOD', 'TEMP=50'], { params: { TEMP: 50 } }],
    [['Q1', 'c', 'b', 'e', 'QMOD', 'DTEMP=2'], { params: { DTEMP: 2 } }],
    [['Q1', 'c', 'b', 'e', 'QMOD', 'TEMP=-40', 'DTEMP=-500'], { params: { TEMP: -40, DTEMP: -500 } }],
    [['Q1', 'c', 'b', 'e', 'substrate', 'QMOD', 'M=2'], { substrate: 'substrate', params: { M: 2 } }],
    [['Q1', 'c', 'b', 'e', 's', 't', 'QMOD', 'area=1', 'm=1'],
      { substrate: 's', thermal: 't', params: { AREA: 1, M: 1 } }],
  ])('resolves the ngspice instance-parameter form %j', (tokens, extra) => {
    expect(parseBJTInstance(tokens, 1)).toEqual({
      collector: 'c', base: 'b', emitter: 'e', modelName: 'QMOD', ...extra,
    });
  });

  it('keeps a numeric model after a grounded substrate instead of reading it as an area', () => {
    expect(parseBJTInstance(['Q1', 'c', 'b', 'e', '0', '2'], 1))
      .toEqual({ collector: 'c', base: 'b', emitter: 'e', substrate: '0', modelName: '2' });
    expect(parseBJTInstance(['Q1', 'c', 'b', 'e', '2N3904'], 1))
      .toEqual({ collector: 'c', base: 'b', emitter: 'e', modelName: '2N3904' });
  });

  it.each([
    ['Q1 c b e QMOD DTEMP=1e999', 'BJT DTEMP must be finite'],
    ['Q1 c b e QMOD TEMP=1e999', 'BJT TEMP must be finite'],
    ['Q1 c b e QMOD TEMP=-273.15', 'BJT TEMP must be above absolute zero'],
    ['Q1 c b e QMOD TEMP=-274', 'BJT TEMP must be above absolute zero'],
    ['Q1 c b e QMOD AREAB=0', 'BJT AREAB must be a finite number greater than zero'],
    ['Q1 c b e QMOD AREAC=1 AREAC=2', "Duplicate BJT instance parameter: 'AREAC'"],
    ['Q1 c b e QMOD IC=0.6,1,2', 'Unsupported BJT instance token after the model'],
    ['Q1 c b e QMOD TEMP=NaN', 'Invalid BJT instance parameter value'],
    ['Q1 c b e QMOD DTEMP=Infinity', 'Invalid BJT instance parameter value'],
    ['Q1 c b e QMOD AREA=0', 'BJT AREA must be a finite number greater than zero'],
    ['Q1 c b e QMOD M=-1', 'BJT M must be a finite number greater than zero'],
    ['Q1 c b e QMOD AREA=2 AREA=3', "Duplicate BJT instance parameter: 'AREA'"],
    ['Q1 c b e QMOD 2 AREA=3', "Duplicate BJT instance parameter: 'AREA'"],
    ['Q1 c b e QMOD M=2 junk', "Unsupported BJT instance token after the model: 'junk'"],
    ['Q1 c b e QMOD OFF=2', 'Unsupported BJT Q-card form'],
    ['Q1 c b e s t u QMOD', 'Unsupported BJT Q-card form'],
  ])('rejects %s with a typed parse error', (card, message) => {
    let error: unknown;
    try {
      parse(`unsupported Q-card\n${card}\n.model QMOD NPN(BF=100)\n.op`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).toContain(message);
  });

  it.each(['TEMP', 'DTEMP'])('preserves source diagnostics for malformed subcircuit %s', keyword => {
    const card = `Q1 c b 0 QM ${keyword}=1e3k`;
    const input = `temperature diagnostics\n.subckt cell c b\n${card}\n.model QM NPN\n.ends cell\nX1 c b cell\n.op\n.end`;
    let error: unknown;
    try {
      parse(input).compile();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ line: 3, context: card });
    expect((error as Error).message).toContain(`Invalid BJT instance parameter value: '${keyword}=1e3k'`);
  });

  // Instance AREA/M is exactly the model with IS/ISE/IKF scaled and RB/RC/RE
  // divided by AREA*M once AREAB=1: bjttemp.c BCtSatCur = tSatCur*AREAB, and
  // AREAB defaults to AREA (IS*AREA^2*M, #641). ngspice-47 .op on the AREAB=1
  // instance deck: v(2)=7.217898051124e-01, v(3)=4.308499040406e+00.
  it('scales a Gummel-Poon instance by AREA*M exactly like the equivalent scaled model', async () => {
    const model = 'BF=100 IS=1e-15 VAF=50 IKF=10m ISE=1e-14 NE=1.5 RB=20 RC=5 RE=2';
    const scaled = 'BF=100 IS=6e-15 VAF=50 IKF=60m ISE=6e-14 NE=1.5 RB=3.3333333333333335 RC=0.8333333333333334 RE=0.3333333333333333';
    const deck = (card: string, params: string) => `area scaling
      VCC 1 0 5
      VB 4 0 0.8
      RB 4 2 1k
      RC 1 3 100
      ${card}
      .model QMOD NPN(${params})
      .op
      .end`;
    const instance = await simulate(deck('Q1 3 2 0 QMOD AREA=3 AREAB=1 M=2', model));
    const reference = await simulate(deck('Q1 3 2 0 QMOD', scaled));
    for (const node of ['2', '3']) {
      expect(instance.dc!.voltage(node)).toBeCloseTo(reference.dc!.voltage(node), 12);
    }
    expect(instance.dc!.voltage('2')).toBeCloseTo(7.217898051124e-01, 8);
    expect(instance.dc!.voltage('3')).toBeCloseTo(4.308499040406e+00, 7);
  });

  it('matches ngspice-47 for a VBIC card with area= and m= (#490)', async () => {
    // ngspice-47 .op on the identical deck: v(2)=8.0411496008e-01, v(3)=4.0658900012e+00.
    const result = await simulate(`#490 vbic area+m
      VCC 1 0 5
      VB 4 0 0.8
      RB 4 2 1k
      RC 1 3 100
      Q1 3 2 0 0 VMOD area=2 m=3
      .model VMOD NPN LEVEL=4 IS=1e-16 IBEI=1e-18 IBEN=5e-15 IBCI=2e-17 IBCN=5e-15 ISP=1e-15
      + RCX=10 RCI=60 RBX=10 RBI=40 RE=2 RS=20 RBP=40 VEF=10 VER=4 IKF=2e-3 IKR=2e-4 IKP=2e-4
      + VO=2 GAMM=2e-11 HRCF=2 AVC1=2 AVC2=15
      .op
      .end`);
    expect(result.dc!.voltage('2')).toBeCloseTo(8.0411496008e-01, 9);
    expect(result.dc!.voltage('3')).toBeCloseTo(4.0658900012e+00, 9);
  });

  it('folds M into flicker KF as ngspice bjtnoise.c M*KF*|Ib/M|^AF does', () => {
    const compiled = parse(`flicker scaling
      Q1 c b e QMOD AREA=1.5 M=4
      .model QMOD NPN(BF=100 IS=1e-15 KF=1e-14 AF=1.5 RB=20)
      .op
    `).compile();
    const device = compiled.devices.find(d => d.name === 'Q1') as unknown as { params: Record<string, number> };
    expect(device.params.IS).toBeCloseTo(6e-15, 27);
    expect(device.params.KF).toBeCloseTo(1e-14 * Math.pow(4, -0.5), 27);
    const rb = compiled.devices.find(d => d.name === 'Q1.RB') as unknown as { resistance: number };
    expect(rb.resistance).toBeCloseTo(20 / 6, 12);
  });

  it('evaluates AREA={param} inside a subcircuit like the flat card', async () => {
    const deck = (body: string, instance: string) => `subckt area
      ${body}
      VCC 1 0 5
      VB 4 0 0.8
      RB 4 2 1k
      RC 1 3 100
      ${instance}
      .model QMOD NPN(BF=100 IS=1e-15 VAF=50 IKF=10m RB=20 RC=5 RE=2)
      .op
      .end`;
    const sub = await simulate(deck(
      '.subckt amp c b e a=1\nQ1 c b e QMOD AREA={a} M=2\n.ends',
      'X1 3 2 0 amp a=3',
    ));
    const flat = await simulate(deck('', 'Q1 3 2 0 QMOD AREA=3 M=2'));
    expect(sub.dc!.voltage('3')).toBeCloseTo(flat.dc!.voltage('3'), 12);
  });

  it('accepts a VBIC thermal node when area/m are given (vbic99_dc.sp)', () => {
    expect(() => parse(`vbic99 thermal form
      q1 c b e s dt vbic99 area=1 m=1
      .model vbic99 npn level=4 rth=300
      .op
    `).compile()).not.toThrow();
  });

  it('round-trips AREAB and AREAC through toNetlist()', () => {
    const netlist = parse(`round trip
      Q1 c b e QMOD AREA=2 AREAB=3 AREAC=0.5
      .model QMOD NPN(BF=100)
      .op
    `).toNetlist();
    expect(netlist).toContain('Q1 c b e QMOD AREA=2 AREAB=3 AREAC=0.5');
    expect(parse(netlist).toNetlist()).toBe(netlist);
  });

  it('rejects AREAB/AREAC on a VBIC instance, which ngspice-47 vbic.c does not accept', () => {
    expect(() => parse(`vbic areab
      Q1 c b e VMOD AREA=2 AREAB=3
      .model VMOD NPN LEVEL=4 IS=1e-16
      .op
    `).compile()).toThrow("VBIC 'Q1' does not accept instance parameters: AREAB");
  });

  it('round-trips AREA and M through toNetlist()', () => {
    const netlist = parse(`round trip
      Q1 c b e QMOD 3 M=2
      .model QMOD NPN(BF=100)
      .op
    `).toNetlist();
    expect(netlist).toContain('Q1 c b e QMOD AREA=3 M=2');
    expect(parse(netlist).toNetlist()).toBe(netlist);
  });
});
