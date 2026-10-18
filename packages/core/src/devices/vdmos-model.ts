import type { ModelParams } from '../types.js';
import { parseNumber } from '../parser/tokenizer.js';

/**
 * VDMOS power MOSFET model card handling, ported from ngspice-47
 * src/frontend/inpcom.c inp_vdmos_model (card normalisation),
 * src/spicelib/devices/vdmos/vdmos.c (parameter table) and vdmosset.c
 * (defaults and preprocessing).
 */

/** `.model` types that select the VDMOS device (ngspice inpdomod.c). */
export const VDMOS_MODEL_TYPES: ReadonlySet<string> = new Set(['VDMOS', 'VDMOSN', 'VDMOSP']);

/** Whether a canonical `.model` type is a VDMOS card. */
export function isVdmosModelType(type: string): boolean {
  return type === 'VDMOSN' || type === 'VDMOSP';
}

/**
 * Datasheet annotations that ngspice inp_vdmos_model drops from a VDMOS card
 * before the model parameters are read (`Vds`, `Ron`, `Qg`, `mfg`), plus the
 * `nchan`/`pchan` polarity flags that it folds into the model type.
 */
const DROPPED_TOKEN_PREFIXES = ['PCHAN', 'NCHAN', 'RON=', 'VDS=', 'QG=', 'MFG='];

/**
 * Parse a tokenized `.model <name> VDMOS ...` card as ngspice inp_vdmos_model
 * does: the type becomes VDMOSP when a `pchan` flag is present (or the type is
 * already `vdmosp`), VDMOSN otherwise, and the datasheet annotations are
 * ignored. Every other `name=value` token is a numeric model parameter.
 */
export function parseVdmosModelCard(tokens: string[]): ModelParams {
  const name = tokens[1];
  const declared = tokens[2].toUpperCase();
  const rest = tokens.slice(3);
  const pchan = declared === 'VDMOSP'
    || rest.some(token => token.toUpperCase() === 'PCHAN');
  const params: Record<string, number> = {};
  for (const token of rest) {
    if (token === '(' || token === ')') continue;
    const upper = token.toUpperCase();
    if (DROPPED_TOKEN_PREFIXES.some(prefix => upper.startsWith(prefix))) continue;
    const eqIdx = token.indexOf('=');
    if (eqIdx <= 0) continue;
    params[upper.substring(0, eqIdx)] = parseNumber(token.substring(eqIdx + 1));
  }
  return { name, type: pchan ? 'VDMOSP' : 'VDMOSN', params };
}

/** ngspice vdmos.c model parameter aliases (IOPR entries). */
const ALIASES: Readonly<Record<string, string>> = {
  VTH0: 'VTO',
  VTOTC: 'TCVTH',
  BEX: 'MU',
};

/**
 * Model parameters of ngspice-47 vdmos.c that spice-ts reads. Parameters of
 * the self-heating network (RTHJC, RTHCA, CTHJ) only act on an instance with
 * the `thermal` flag; the safe-operating-area limits
 * only feed ngspice's SOA warnings; KF/AF only feed noise analysis.
 */
const KNOWN_PARAMETERS = new Set([
  'VTO', 'KP', 'PHI', 'LAMBDA', 'THETA', 'RD', 'RS', 'RG', 'TNOM', 'KF', 'AF',
  'RQ', 'VQ', 'MTRIODE', 'TCVTH', 'MU', 'TEXP0', 'TEXP1', 'TRD1', 'TRD2',
  'TRG1', 'TRG2', 'TRS1', 'TRS2', 'TRB1', 'TRB2', 'SUBSHIFT', 'KSUBTHRES',
  'TKSUBTHRES1', 'TKSUBTHRES2', 'BV', 'IBV', 'NBV', 'RDS', 'RB', 'N', 'TT',
  'EG', 'XTI', 'IS', 'VJ', 'VP', 'CJO', 'M', 'FC', 'CGDMIN', 'CGDMAX', 'A',
  'CGS', 'RTHJC', 'RTHCA', 'CTHJ', 'VGS_MAX', 'VGD_MAX', 'VDS_MAX',
  'VGSR_MAX', 'VGDR_MAX', 'PD_MAX', 'ID_MAX', 'IDR_MAX', 'TE_MAX', 'RTH_EXT',
  'DERATING',
]);

/** Resolved VDMOS model card after vdmosset.c defaulting. */
export interface VdmosModel {
  readonly name: string;
  /** +1 for VDMOSN, -1 for VDMOSP (ngspice VDMOStype). */
  readonly type: 1 | -1;
  readonly vth0: number;
  readonly kp: number;
  readonly phi: number;
  readonly lambda: number;
  readonly theta: number;
  readonly rd: number;
  readonly rs: number;
  readonly rg: number;
  readonly kf: number;
  readonly af: number;
  /** Parameter measurement temperature in kelvin. */
  readonly tnom: number;
  readonly rds: number;
  readonly rdsGiven: boolean;
  readonly rq: number;
  readonly vq: number;
  /** Quasi-saturation model active (RQ and VQ both given). */
  readonly qsGiven: boolean;
  readonly mtriode: number;
  readonly tcvth: number;
  readonly mu: number;
  readonly texp0: number;
  readonly texp0Given: boolean;
  readonly texp1: number;
  readonly trd1: number;
  readonly trd2: number;
  readonly trg1: number;
  readonly trg2: number;
  readonly trs1: number;
  readonly trs2: number;
  readonly subshift: number;
  readonly ksubthres: number;
  readonly tksubthres1: number;
  readonly tksubthres2: number;
  readonly cgdmin: number;
  readonly cgdmax: number;
  readonly a: number;
  readonly cgs: number;
  readonly rthjc: number;
  readonly rthca: number;
  readonly cthj: number;
  /** Body diode parameters (ngspice VDIO*). */
  readonly diode: {
    readonly is: number;
    readonly n: number;
    readonly rb: number;
    readonly tt: number;
    readonly vj: number;
    readonly cjo: number;
    readonly m: number;
    readonly fc: number;
    readonly eg: number;
    readonly xti: number;
    readonly bv: number;
    readonly bvGiven: boolean;
    readonly ibv: number;
    readonly nbv: number;
    readonly trb1: number;
    readonly trb2: number;
    /** Soft reverse recovery parameter VP. */
    readonly vp: number;
  };
}

/** ngspice CKTepsmin: lower limit of the body diode saturation current. */
const EPSMIN = 1e-28;
/** ngspice CKTnomTemp default, 27 C. */
const NOMINAL_TEMPERATURE = 300.15;

/**
 * Resolve a VDMOS `.model` card (type VDMOSN or VDMOSP) with the vdmosset.c
 * defaults. Unknown parameters are reported in `warnings` and ignored, as
 * ngspice-47 does.
 */
export function resolveVdmosModel(card: ModelParams): { model: VdmosModel; warnings: string[] } {
  const warnings: string[] = [];
  const raw: Record<string, number> = {};
  for (const [key, value] of Object.entries(card.params)) {
    const canonical = ALIASES[key] ?? key;
    if (!KNOWN_PARAMETERS.has(canonical)) {
      warnings.push(`${card.name}: unrecognized VDMOS model parameter '${key.toLowerCase()}' ignored`);
      continue;
    }
    raw[canonical] = value;
  }
  const type: 1 | -1 = card.type === 'VDMOSP' ? -1 : 1;
  const given = (key: string) => raw[key] !== undefined;
  const value = (key: string, fallback: number) => raw[key] ?? fallback;

  const phi = value('PHI', 0.6);
  if (phi <= 0) throw new Error(`${card.name}: Phi is not positive.`);

  let eg = value('EG', 1.11);
  if (eg < 0.1) {
    warnings.push(`${card.name}: body diode activation energy too small, limited to 0.1`);
    eg = 0.1;
  }
  let fc = value('FC', 0.5);
  if (fc > 0.95) {
    warnings.push(`${card.name}: coefficient Fc too large, limited to 0.95`);
    fc = 0.95;
  }
  const is = Math.max(value('IS', 1e-14), EPSMIN);
  const tt = value('TT', 0);

  const model: VdmosModel = {
    name: card.name,
    type,
    vth0: value('VTO', 3 * type),
    kp: value('KP', 15 + 5 * type),
    phi,
    lambda: value('LAMBDA', 0),
    theta: value('THETA', 0),
    rd: value('RD', 0),
    rs: value('RS', 0),
    rg: value('RG', 0),
    kf: value('KF', 0),
    af: value('AF', 1),
    tnom: given('TNOM') ? raw.TNOM + 273.15 : NOMINAL_TEMPERATURE,
    rds: value('RDS', 1e15),
    rdsGiven: given('RDS'),
    rq: value('RQ', 0),
    vq: value('VQ', 0),
    qsGiven: given('RQ') && given('VQ'),
    mtriode: value('MTRIODE', 1),
    tcvth: value('TCVTH', 0),
    mu: value('MU', -1.5),
    texp0: value('TEXP0', 1.5),
    texp0Given: given('TEXP0'),
    texp1: value('TEXP1', 0.3),
    trd1: value('TRD1', 0),
    trd2: value('TRD2', 0),
    trg1: value('TRG1', 0),
    trg2: value('TRG2', 0),
    trs1: value('TRS1', 0),
    trs2: value('TRS2', 0),
    subshift: value('SUBSHIFT', 0),
    ksubthres: value('KSUBTHRES', 0.1),
    tksubthres1: value('TKSUBTHRES1', 0),
    tksubthres2: value('TKSUBTHRES2', 0),
    cgdmin: value('CGDMIN', 2e-11),
    cgdmax: value('CGDMAX', 2e-9),
    a: value('A', 1),
    cgs: value('CGS', 1.4e-9),
    rthjc: value('RTHJC', 1),
    rthca: value('RTHCA', 23),
    cthj: value('CTHJ', 10e-6),
    diode: {
      is,
      n: value('N', 1),
      rb: value('RB', 0),
      tt,
      vj: value('VJ', 0.8),
      cjo: value('CJO', 5e-10),
      m: value('M', 0.5),
      fc,
      eg,
      xti: value('XTI', 3),
      bv: value('BV', 1e99),
      bvGiven: given('BV'),
      ibv: value('IBV', 1e-10),
      nbv: value('NBV', 1),
      trb1: value('TRB1', 0),
      trb2: value('TRB2', 0),
      vp: value('VP', 0),
    },
  };
  return { model, warnings };
}
