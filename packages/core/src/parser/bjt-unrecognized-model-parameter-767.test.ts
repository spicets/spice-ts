import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulate } from '../simulate.js';
import { parse } from './index.js';

/**
 * Issue #767: ngspice-47 INPgetMod (src/spicelib/parser/inpgmod.c create_model)
 * looks every .model name up in the device's model table, then its instance
 * table. A name in neither, such as the MEXTRAM `DTA` on an npn/pnp card that
 * selects the level-1 BJT (LEVEL>99 is read as 1, #747), prints
 * "unrecognized parameter (dta) - ignored" and the card simulates without it.
 * Names ngspice-47 does know (IBE, IBC, ...) stay rejected when spice-ts has no
 * implementation, and an instance name on the card (an ngspice instance
 * default) is not dropped either.
 */
const DECK = readFileSync(
  new URL('../../../../benchmarks/results/issue-767/decks/mextram-card-op.cir', import.meta.url),
  'utf8',
);

const BASE = `bjt card
V2 vcc 0 10
R3 vc vcc 1.5k
R4 0 ve 270
R1 vb vcc 39k
R2 0 vb 6.8k
Q1 vc vb ve 0 qm
.model qm npn (is=22e-18 bf=215 ik=0.1 re=5 EXTRA)
.op
.end`;

const card = (extra: string) => BASE.replace('EXTRA', extra);

describe('BJT .model names ngspice-47 does not recognise are ignored with its warning (#767)', () => {
  it('MEXTRAM LEVEL=504 card matches the ngspice-47 operating point', async () => {
    const result = await simulate(DECK);
    // ngspice-47 `ngspice -b` on these bytes, `set numdgt=12`. Both engines stop
    // Newton at RELTOL-scale convergence, so agreement is ~1e-7 relative.
    const reference: Record<string, number> = {
      vc: 6.747853629518e+00,
      vb: 1.425058874742e+00,
      ve: 5.881681018594e-01,
    };
    for (const [node, expected] of Object.entries(reference)) {
      expect(Math.abs(result.dc!.voltage(node) - expected), `v(${node})`).toBeLessThan(1e-6 * Math.abs(expected));
    }
    expect(Math.abs(result.dc!.current('V2') - -2.38796786558e-03)).toBeLessThan(1e-6 * 2.38796786558e-03);
    const warning = result.warnings.find(entry => /unrecognized parameter/.test(entry.message));
    expect(warning?.message).toMatch(/\(dta\).*\(exmod\).*\(ver\).*\(vef\).*\(ibf\).*\(rbc\).*\(vde\).*\(mult\)/);
  });

  it('DTA=0 and other unknown names leave the solution bit-identical', async () => {
    const plain = await simulate(card(''));
    const extra = await simulate(card('DTA=5 VEF=44 TAUB=4.2e-12 MULT=1.5'));
    for (const node of ['vc', 'vb', 've']) {
      expect(extra.dc!.voltage(node)).toBe(plain.dc!.voltage(node));
    }
  });

  it('still rejects names ngspice-47 implements and spice-ts does not', () => {
    expect(() => parse(card('DTA=0 IBC=1e-15')).compile()).toThrow("Unsupported bounded BJT model parameter: 'IBC'");
    expect(() => parse(card('IBE=1e-15')).compile()).toThrow("Unsupported bounded BJT model parameter: 'IBE'");
  });

  it('does not drop a BJT instance parameter written on the model card', () => {
    expect(() => parse(card('AREA=2')).compile()).toThrow("Unsupported bounded BJT model parameter: 'AREA'");
  });

  it('leaves non-BJT levels (VBIC LEVEL=4) alone', () => {
    // VBIC has its own ngspice-47 table and its own spice-ts check.
    const vbic = BASE.replace(/\(is=.*\)/, '(LEVEL=4 DTA=0)');
    expect(() => parse(vbic).compile()).toThrow("Unsupported bounded VBIC DC model parameter: 'DTA'");
  });
});
