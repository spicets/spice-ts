import { describe, expect, it } from 'vitest';
import { parse } from '../parser/index.js';
import { simulate } from '../simulate.js';

/**
 * #633: the Gummel-Poon parameters past the forward set (VAR, IKR, ISC/NC,
 * IRB/RBM, NKF and their ngspice-47 aliases VB, C4, NK, TREF) used to be
 * silently dropped unless the card also set VAF/IKF/ISE/NE. They are now
 * ported from ngspice-47 bjtload.c/bjttemp.c/bjtsetup.c, and the parameters
 * that are not (the IBE/IBC split) are rejected
 * whatever else is on the card.
 *
 * Every reference is ngspice-47 `ngspice -b` on the identical deck with
 * `.control / set numdgt=15 / op / print ... / .endc` in place of `.op` (or
 * `ac lin 3 1meg 100meg / print vm(c) vp(c)` for the AC decks).
 *
 * The saturated, base-resistance and AC decks carry TIGHT options in both
 * simulators. ngspice-47 bjtload.c does not differentiate gx: it is a linear
 * conductance re-evaluated each Newton iteration, so at default tolerances
 * both simulators stop while gx still lags the bias (ngspice-47 default and
 * tight-tolerance v(c) differ by ~5e-6 on the IRB deck). With TIGHT options
 * ngspice-47 and spice-ts agree to ~1e-10.
 */
const RELATIVE = 1e-7;
const TIGHT = '.options reltol=1e-9 vntol=1e-12 abstol=1e-18';

function expectRelative(actual: number, expected: number, tolerance = RELATIVE): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tolerance);
}

const issueDeck = (model: string) => `bjt
V1 c 0 5
V2 b 0 0.7
Q1 c b 0 qm
.model qm NPN(IS=1e-15 BF=100 ${model})
.op
.end
`;

const reverseDeck = (model: string, instance = '') => `bjt reverse
V1 e 0 5
V2 b 0 0.7
V3 c 0 0
Q1 c b e qm ${instance}
.model qm NPN(IS=1e-15 BF=100 ${model})
.op
.end
`;

const saturationDeck = (model: string, extra = '') => `bjt sat
Vcc vcc 0 5
Rc vcc c 1k
Rb vcc b 10k
Q1 c b 0 qm
.model qm NPN(${model})
${extra}
${TIGHT}
.op
.end
`;

const baseResistanceDeck = (vb: number, model: string, instance = '') => `bjt rb
Vcc vcc 0 5
Rc vcc c 1k
Vb in 0 ${vb}
Q1 c in 0 qm ${instance}
.model qm NPN(${model})
${TIGHT}
.op
.end
`;

const acDeck = (model: string) => `bjt ac
vcc vcc 0 10
vin in 0 dc 0.75 ac 1
rc vcc c 5k
q1 c in 0 qm
.model qm NPN(IS=1e-15 BF=100 CJE=1p CJC=0.5p TF=0.3n ${model})
${TIGHT}
.ac lin 3 1meg 100meg
.end
`;

const sourceCurrents = async (netlist: string, sources: string[]) => {
  const { dc } = await simulate(netlist);
  return sources.map(source => dc!.current(source));
};

describe('BJT Gummel-Poon parameters past the forward set match ngspice-47 (#633)', () => {
  // Issue repro rows. Before #633 every row gave i(V1) = -5.670346864442288e-4
  // except the last, which threw "Unsupported bounded BJT model parameter: 'IKR'".
  it.each([
    ['', -5.67034686444230e-04, -5.67034317042062e-06],
    ['IKR=1m', -5.67034686444797e-04, -5.67034317042062e-06],
    ['VAR=10', -5.27342259044204e-04, -5.67034317042236e-06],
    ['VB=10', -5.27342259044204e-04, -5.67034317042236e-06],
    // RB = 0: bjtsetup.c merges base and base prime, so IRB/RBM do nothing.
    ['IRB=1m RBM=1', -5.67034686444230e-04, -5.67034316712672e-06],
    ['VAF=50 IKR=1m', -6.15799668679163e-04, -5.67034317042236e-06],
  ])('issue deck with %s', async (model, iV1, iV2) => {
    const [v1, v2] = await sourceCurrents(issueDeck(model), ['V1', 'V2']);
    expectRelative(v1, iV1);
    expectRelative(v2, iV2);
  });

  it.each([
    ['BR=5 IKR=1m', '', [-4.03899709545852e-04, -1.13406931828435e-04, 5.173066413742853e-04]],
    ['BR=5 IKR=1m VAR=10 VAF=50', '', [-5.71921986928113e-04, -1.13406931828437e-04, 6.853289187565546e-04]],
    ['BR=5 ISC=1e-13 NC=1.5', '', [-5.67034681443233e-04, -1.20257707388431e-04, 6.872923888316694e-04]],
    // bjtsetup.c: an ISC (alias C4) above 1e-4 is a multiple of IS.
    ['BR=5 C4=1000', '', [-5.67034681443233e-04, -1.14159947878140e-04, 6.811946293213779e-04]],
    ['BR=5 IKR=1m NKF=0.8 IKF=2m', '', [-3.16873425019853e-04, -1.13406931828437e-04, 4.302803568482874e-04]],
    // bjttemp.c: IKR scales by AREA, ISC by AREAB (default AREA); M multiplies all.
    ['BR=5 IKR=1m ISC=1e-13 NC=1.7 VAR=10', 'area=2 m=3',
      [-5.80406773670941e-03, -1.36580405393770e-03, 7.169871790647121e-03]],
  ] as const)('reverse-active deck with %s %s', async (model, instance, expected) => {
    const currents = await sourceCurrents(reverseDeck(model, instance), ['V1', 'V2', 'V3']);
    currents.forEach((current, index) => expectRelative(current, expected[index]));
  });

  it.each([
    ['IS=1e-14 BF=200 BR=3 ISC=1e-13 NC=2 IKR=5m VAR=20', '', 4.902980272669968e-02, 7.082207974511758e-01],
    // bjttemp.c tBCleakCur = ISC*exp(factlog/NC)/bfactor.
    ['IS=1e-14 BF=200 BR=3 ISC=1e-13 NC=1.6 IKR=5m VAR=20 XTB=1.5 TNOM=-10', '.options TEMP=85',
      4.666073211811477e-02, 4.210980208183865e-01],
    ['IS=1e-14 BF=200 BR=3 ISE=1e-13 C4=2e-13 NC=1.8 TREF=-10', '.options TEMP=85',
      5.135646808625463e-02, 4.107873095622049e-01],
  ])('saturated deck with %s %s', async (model, extra, vc, vb) => {
    const { dc } = await simulate(saturationDeck(model, extra));
    expectRelative(dc!.voltage('c'), vc, 1e-8);
    expectRelative(dc!.voltage('b'), vb, 1e-8);
  });

  it.each([
    [0.9, '', 'IS=1e-15 BF=100 RB=200 RBM=20 IRB=0.1m', 3.471847959223560e-02, -2.82046082119502e-03],
    [0.9, '', 'IS=1e-15 BF=100 RB=200 RBM=20 IKF=5m VAF=50', 6.903368670312483e-02, -1.18776597652888e-03],
    [0.9, '', 'IS=1e-15 BF=100 RB=200 RBM=20 IRB=0.1m IKF=5m VAR=10', 6.192954268835234e-02, -2.24396209975741e-03],
    [0.9, 'area=2 m=2', 'IS=1e-15 BF=100 RB=200 RBM=20 IRB=0.1m IKF=5m', 5.371610660320888e-02, -1.11848734531142e-02],
    // RBM defaults to RB, so IRB alone leaves the base resistance at RB.
    [0.9, '', 'IS=1e-15 BF=100 RB=200 IRB=0.1m', 5.918749878107318e-02, -6.90706858622029e-04],
    // RB = 0 has no base-prime node: RBM/IRB do nothing.
    [0.8, '', 'IS=1e-15 BF=100 RB=0 RBM=20 IRB=0.1m', 2.318004106748740e-02, -1.13239180433711e-02],
  ] as const)('bias-dependent base resistance at vb=%s %s with %s', async (vb, instance, model, vc, ib) => {
    const { dc } = await simulate(baseResistanceDeck(vb, model, instance));
    expectRelative(dc!.voltage('c'), vc, 1e-8);
    expectRelative(dc!.current('Vb'), ib, 1e-8);
  });

  it.each([
    ['RB=500 RBM=50 IRB=20u', [
      [1.732601572503085e+00, 3.136120352525673e+00],
      [1.684854439177250e+00, 2.869544803843138e+00],
      [1.564591578885623e+00, 2.624966781797237e+00],
    ]],
    ['VAR=5 IKR=1m IKF=0.5m VAF=40', [
      [1.084079914823542e+02, 3.133922994307856e+00],
      [1.012138084417292e+02, 2.771602241841757e+00],
      [8.631618478917036e+01, 2.484730952698158e+00],
    ]],
    ['RB=500 RBM=50 VAR=5 IKF=0.5m', [
      [8.268326971012742e+01, 3.102835908062063e+00],
      [3.878308521217913e+01, 1.979780488644971e+00],
      [2.124936060362571e+01, 1.675157659434549e+00],
    ]],
  ] as const)('AC small-signal response with %s', async (model, expected) => {
    const { ac } = await simulate(acDeck(model));
    const response = ac!.voltage('c');
    expected.forEach(([magnitude, phase], index) => {
      expectRelative(response[index].magnitude, magnitude, 1e-8);
      expect(Math.abs(response[index].phase * Math.PI / 180 - phase)).toBeLessThan(1e-8);
    });
  });

  it.each([
    'VO=5 GAMMA=1e-10 QCO=1e-12',
    'VBE_MAX=1 PD_MAX=1 RTH0=10',
    'TLEV=1 TLEVC=1',
  ])('accepts %s, which ngspice-47 leaves inert on this card', async (model) => {
    const [v1, v2] = await sourceCurrents(issueDeck(model), ['V1', 'V2']);
    expectRelative(v1, -5.67034686444230e-04);
    expectRelative(v2, -5.67034317042062e-06);
  });

  it.each([
    ['IBE=1e-15 IBC=2e-15', 'IBE'],
    ['VAF=50 IBE=1e-15', 'IBE'],
    ['ISE=1e-14 IBC=2e-15', 'IBC'],
  ])('rejects the unported %s whatever else is on the card', (model, parameter) => {
    expect(() => parse(issueDeck(model)).compile())
      .toThrow(`Unsupported bounded BJT model parameter: '${parameter}'`);
  });

  it.each(['VAR=-1', 'IKR=-1m', 'NC=0', 'ISC=-1e-15', 'RBM=-1 RB=10', 'IRB=-1m'])(
    'rejects the invalid value %s explicitly',
    (model) => {
      expect(() => parse(issueDeck(model)).compile()).toThrow(/Invalid bounded BJT/);
    },
  );
});
