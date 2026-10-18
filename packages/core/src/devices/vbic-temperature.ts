/**
 * VBIC temperature mapping, a port of ngspice-47 `vbic_4T_et_cf_t`
 * (src/spicelib/devices/vbic/vbictemp.c) restricted to the bounded VBIC subset.
 *
 * Parameters outside that subset are held at their ngspice vbicsetup.c
 * defaults: EA = EAIE = EAIC = EAIS = EANE = EANC = EANS = EAP = 1.12 eV,
 * XIS = XII = XIN = 3, and every other temperature
 * exponent (XRCI, XRBI, XRBP, XIKF, XVO, TNF, TAVC, XISR, DEAR) at 0, which
 * leaves RCI, RBI, RBP, IKF, VO, AVC2, NF, NR and ISRR temperature independent.
 */

/** ngspice CONSTCtoK and the Boltzmann/charge constants used by vbictemp.c. */
const CELSIUS_TO_KELVIN = 2.7315e2;
const BOLTZMANN = 1.380662e-23;
const CHARGE = 1.602189e-19;

const EA = 1.12;
const EAIE = 1.12;
const EAIC = 1.12;
const EAIS = 1.12;
const EANE = 1.12;
const EANC = 1.12;
const EANS = 1.12;
const EAP = 1.12;
const XIS = 3;
const XII = 3;
const XIN = 3;

/** Junction built-in potentials and grading coefficients (ngspice defaults). */
export const VBIC_PE = 0.75;
export const VBIC_ME = 0.33;
export const VBIC_PC = 0.75;
export const VBIC_MC = 0.33;
export const VBIC_PS = 0.75;
export const VBIC_MS = 0.33;

export interface VBICTemperatureInput {
  IBEIP: number;
  IBENP: number;
  NF: number;
  NEI: number;
  NEN: number;
  NCI: number;
  NCN: number;
  NFP: number;
  NCIP: number;
  NCNP: number;
  IBCIP: number;
  IBCNP: number;
  TNOM: number;
  IS: number;
  IBEI: number;
  IBEN: number;
  IBCI: number;
  IBCN: number;
  ISP: number;
  GAMM: number;
  CJE: number;
  CJC: number;
  CJEP: number;
  CJCP: number;
  PE: number;
  ME: number;
  PC: number;
  MC: number;
  PS: number;
  MS: number;
}

/** Temperature-resolved values that differ from the nominal model card. */
export interface VBICTemperatureState {
  IBEIP: number;
  IBENP: number;
  IBCIP: number;
  IBCNP: number;
  /** Thermal voltage kT/q at the device temperature. */
  vt: number;
  IS: number;
  IBEI: number;
  IBEN: number;
  IBCI: number;
  IBCN: number;
  ISP: number;
  GAMM: number;
  CJE: number;
  CJC: number;
  CJEP: number;
  CJCP: number;
  /** Base-emitter, base-collector and substrate built-in potentials. */
  PE: number;
  PC: number;
  PS: number;
}

/** Map the bounded VBIC parameters from TNOM to `temperature` (degrees Celsius). */
export function resolveVBICTemperature(
  params: VBICTemperatureInput,
  temperature: number,
): VBICTemperatureState {
  const tini = CELSIUS_TO_KELVIN + params.TNOM;
  const tdev = CELSIUS_TO_KELVIN + temperature;
  const vtv = BOLTZMANN * tdev / CHARGE;
  const rT = tdev / tini;

  // ngspice: I(T) = I * (rT^XI * exp(-EA * (1 - rT) / Vtv))^(1 / N).
  const saturation = (current: number, exponent: number, activation: number, emission: number): number =>
    current * Math.pow(Math.pow(rT, exponent) * Math.exp(-activation * (1 - rT) / vtv), 1 / emission);
  // ngspice-47 src/spicelib/devices/vbic/vbictemp.c:278-331:
  // built-in potential mapping with a smooth lower limit and C(T) scaling.
  const potential = (nominal: number, activation: number): number => {
    const psiio = 2 * (vtv / rT) * Math.log(
      Math.exp(0.5 * nominal * rT / vtv) - Math.exp(-0.5 * nominal * rT / vtv),
    );
    const psiin = psiio * rT - 3 * vtv * Math.log(rT) - activation * (rT - 1);
    return psiin + 2 * vtv * Math.log(0.5 * (1 + Math.sqrt(1 + 4 * Math.exp(-psiin / vtv))));
  };

  const PE = potential(params.PE, EAIE);
  const PC = potential(params.PC, EAIC);
  const PS = potential(params.PS, EAIS);
  return {
    vt: vtv,
    IS: saturation(params.IS, XIS, EA, params.NF),
    IBEI: saturation(params.IBEI, XII, EAIE, params.NEI),
    IBEN: saturation(params.IBEN, XIN, EANE, params.NEN),
    IBCI: saturation(params.IBCI, XII, EAIC, params.NCI),
    IBCN: saturation(params.IBCN, XIN, EANC, params.NCN),
    IBEIP: saturation(params.IBEIP, XII, EAIC, params.NCI),
    IBENP: saturation(params.IBENP, XIN, EANC, params.NCN),
    ISP: saturation(params.ISP, XIS, EAP, params.NFP),
    IBCIP: saturation(params.IBCIP, XII, EAIS, params.NCIP),
    IBCNP: saturation(params.IBCNP, XIN, EANS, params.NCNP),
    GAMM: params.GAMM * Math.pow(rT, XIS) * Math.exp(-EA * (1 - rT) / vtv),
    CJE: params.CJE * Math.pow(params.PE / PE, params.ME),
    CJC: params.CJC * Math.pow(params.PC / PC, params.MC),
    CJEP: params.CJEP * Math.pow(params.PC / PC, params.MC),
    CJCP: params.CJCP * Math.pow(params.PS / PS, params.MS),
    PE,
    PC,
    PS,
  };
}
