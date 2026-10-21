/**
 * Interface specifications of the XSPICE code models spice-ts implements,
 * transcribed from the ngspice-47 `ifspec.ifs` files (src/xspice/icm/analog).
 * The port table decides how an A-card's connection tokens are read, and the
 * parameter table how a `.model` card's values are parsed, exactly as ngspice
 * MIF_INP2A and MIFgetMod use them.
 */

import { OTA_SPEC } from './ota-model.js';
import { SEEGEN_SPEC } from './seegen.js';
import { REACTIVE_IC_SPECS } from './reactive-ic-models.js';

/** Analog port types spice-ts can stamp (XSPICE `%v`, `%vd`, `%i`, `%id`, `%vnam`, `%g`, `%gd`). */
export type XspiceAnalogPortType = 'v' | 'vd' | 'i' | 'id' | 'vnam' | 'g' | 'gd' | 'h' | 'hd';

/** Port types spice-ts resolves: the analog ones plus the event-driven digital `%d`. */
export type XspicePortType = XspiceAnalogPortType | 'd' | 'real';

export interface XspiceConnectionSpec {
  readonly name: string;
  readonly direction: 'in' | 'out' | 'inout';
  readonly defaultType: string;
  readonly allowedTypes: readonly string[];
  readonly vector: boolean;
  /** Inclusive [min, max] port count of a vector connection; max undefined = unbounded. */
  readonly vectorBounds?: readonly [number | undefined, number | undefined];
  readonly nullAllowed: boolean;
}

export type XspiceParamType = 'real' | 'int' | 'boolean' | 'string';
export type XspiceParamValue = number | boolean | string;

export interface XspiceParamSpec {
  readonly name: string;
  readonly type: XspiceParamType;
  /** Default element values; undefined means the parameter has no default. */
  readonly defaultValue?: readonly XspiceParamValue[];
  /** Inclusive value limits; out-of-range values are clamped with a warning (MIFmParam). */
  readonly limits?: readonly [number | undefined, number | undefined];
  readonly vector: boolean;
  /** Vector size is tied to this connection's port count. */
  readonly sizeFromConnection?: string;
  /** Inclusive [min, max] element count of a vector parameter. */
  readonly vectorBounds?: readonly [number | undefined, number | undefined];
  readonly nullAllowed: boolean;
}

export interface XspiceCodeModelSpec {
  readonly name: string;
  readonly connections: readonly XspiceConnectionSpec[];
  readonly params: readonly XspiceParamSpec[];
}

const ANALOG_IN = ['v', 'vd', 'i', 'id', 'vnam'] as const;
const ANALOG_OUT = ['v', 'vd', 'i', 'id'] as const;

function input(name: string, vector = false, vectorBounds?: readonly [number | undefined, number | undefined]): XspiceConnectionSpec {
  return {
    name, direction: 'in', defaultType: 'v', allowedTypes: ANALOG_IN, vector, nullAllowed: false,
    ...(vectorBounds ? { vectorBounds } : {}),
  };
}

function output(name: string): XspiceConnectionSpec {
  return { name, direction: 'out', defaultType: 'v', allowedTypes: ANALOG_OUT, vector: false, nullAllowed: false };
}

function real(
  name: string,
  defaultValue: number | undefined,
  extra: Partial<Pick<XspiceParamSpec, 'limits' | 'vector' | 'sizeFromConnection' | 'vectorBounds' | 'nullAllowed'>> = {},
): XspiceParamSpec {
  return {
    name,
    type: 'real',
    ...(defaultValue === undefined ? {} : { defaultValue: [defaultValue] }),
    vector: false,
    nullAllowed: true,
    ...extra,
  };
}

function boolean(name: string, defaultValue: boolean): XspiceParamSpec {
  return { name, type: 'boolean', defaultValue: [defaultValue], vector: false, nullAllowed: true };
}

/** astate/ifspec.ifs: no gain or offset parameters. */
const ASTATE: XspiceCodeModelSpec = {
  name: 'astate', connections: [input('in'), output('out')],
  params: [{ name: 'astate_no', type: 'int', defaultValue: [1], limits: [0, 3], vector: false, nullAllowed: true }],
};

/** gain/ifspec.ifs */
const GAIN: XspiceCodeModelSpec = {
  name: 'gain',
  connections: [input('in'), output('out')],
  params: [
    real('in_offset', 0), real('gain', 1), real('out_offset', 0),
    real('noise_voltage', 0), real('noise_current', 0),
    real('noise_corner', 0), real('noise_exponent', 1),
  ],
};

/** summer/ifspec.ifs */
const SUMMER: XspiceCodeModelSpec = {
  name: 'summer',
  connections: [input('in', true, [2, undefined]), output('out')],
  params: [
    real('in_offset', 0, { vector: true, sizeFromConnection: 'in' }),
    real('in_gain', 1, { vector: true, sizeFromConnection: 'in' }),
    real('out_gain', 1), real('out_offset', 0),
  ],
};

/** mult/ifspec.ifs */
const MULT: XspiceCodeModelSpec = {
  name: 'mult',
  connections: [input('in', true, [2, undefined]), output('out')],
  params: [
    real('in_offset', 0, { vector: true, sizeFromConnection: 'in' }),
    real('in_gain', 1, { vector: true, sizeFromConnection: 'in' }),
    real('out_gain', 1), real('out_offset', 0),
  ],
};

/** divide/ifspec.ifs */
const DIVIDE: XspiceCodeModelSpec = {
  name: 'divide',
  connections: [input('num'), input('den'), output('out')],
  params: [
    real('num_offset', 0), real('num_gain', 1),
    real('den_offset', 0), real('den_gain', 1),
    real('den_lower_limit', 1e-10, { limits: [1e-10, undefined] }),
    real('den_domain', 1e-16),
    boolean('fraction', false),
    real('out_gain', 1), real('out_offset', 0),
  ],
};

/** pwl/ifspec.ifs */
const PWL: XspiceCodeModelSpec = {
  name: 'pwl',
  connections: [input('in'), output('out')],
  params: [
    real('x_array', undefined, { vector: true, vectorBounds: [2, undefined], nullAllowed: false }),
    real('y_array', undefined, { vector: true, vectorBounds: [2, undefined], nullAllowed: false }),
    real('input_domain', 0.01, { limits: [1e-12, 0.5] }),
    boolean('fraction', true),
    boolean('limit', false),
  ],
};

/** multi_input_pwl/ifspec.ifs (ngspice-47). */
const MULTI_INPUT_PWL: XspiceCodeModelSpec = {
  name: 'multi_input_pwl',
  connections: [
    { name: 'in', direction: 'in', defaultType: 'vd', allowedTypes: ['vd', 'id'], vector: true, vectorBounds: [2, undefined], nullAllowed: false },
    { name: 'out', direction: 'out', defaultType: 'vd', allowedTypes: ['vd', 'id'], vector: false, nullAllowed: false },
  ],
  params: [
    real('x', undefined, { vector: true, vectorBounds: [2, undefined], nullAllowed: false }),
    real('y', undefined, { vector: true, vectorBounds: [2, undefined], nullAllowed: false }),
    { name: 'model', type: 'string', defaultValue: ['and'], vector: false, nullAllowed: true },
  ],
};

/** limit/ifspec.ifs */
const LIMIT: XspiceCodeModelSpec = {
  name: 'limit',
  connections: [input('in'), output('out')],
  params: [
    real('in_offset', 0), real('gain', 1),
    real('out_lower_limit', undefined), real('out_upper_limit', undefined),
    real('limit_range', 1e-6), boolean('fraction', false),
  ],
};

/** int/ifspec.ifs */
const INT: XspiceCodeModelSpec = {
  name: 'int',
  connections: [input('in'), output('out')],
  params: [
    real('in_offset', 0), real('gain', 1),
    real('out_lower_limit', undefined), real('out_upper_limit', undefined),
    real('limit_range', 1e-6), real('out_ic', 0),
  ],
};

/** d_dt/ifspec.ifs */
const D_DT: XspiceCodeModelSpec = {
  name: 'd_dt',
  connections: [input('in'), output('out')],
  params: [
    real('out_offset', 0), real('gain', 1),
    real('out_lower_limit', undefined), real('out_upper_limit', undefined),
    real('limit_range', 1e-6),
  ],
};

/** xfer/ifspec.ifs (not s_xfer: no gain or input offset). */
const XFER: XspiceCodeModelSpec = {
  name: 'xfer',
  connections: [input('in'), output('out')].map(port => ({ ...port, allowedTypes: ['v', 'vd', 'i', 'id'] })),
  params: [
    { name: 'table', type: 'real', defaultValue: [0], vector: true, vectorBounds: [3, undefined], nullAllowed: true },
    { name: 'file', type: 'string', vector: false, nullAllowed: true },
    boolean('r_i', false), boolean('db', true), boolean('rad', false),
    { name: 'span', type: 'int', defaultValue: [3], limits: [3, undefined], vector: false, nullAllowed: true },
    { name: 'offset', type: 'int', defaultValue: [1], limits: [1, undefined], vector: false, nullAllowed: true },
  ],
};

/** s_xfer/ifspec.ifs; omitted ICs are expanded to zero at the model boundary. */
const S_XFER: XspiceCodeModelSpec = {
  name: 's_xfer',
  connections: [{ ...input('in'), allowedTypes: ['v', 'vd', 'i', 'id'] }, output('out')],
  params: [
    real('in_offset', 0), real('gain', 1),
    real('num_coeff', undefined, { vector: true, vectorBounds: [1, undefined] }),
    real('den_coeff', undefined, { vector: true, vectorBounds: [1, undefined] }),
    { name: 'int_ic', type: 'real', defaultValue: [], vector: true, nullAllowed: true },
    real('denormalized_freq', 1),
  ],
};

/** climit/ifspec.ifs */
const CLIMIT: XspiceCodeModelSpec = {
  name: 'climit',
  connections: [input('in'), input('cntl_upper'), input('cntl_lower'), output('out')],
  params: [
    real('in_offset', 0), real('gain', 1),
    real('upper_delta', 0), real('lower_delta', 0),
    real('limit_range', 1e-6), boolean('fraction', false),
  ],
};

/** hyst/ifspec.ifs */
const HYST: XspiceCodeModelSpec = {
  name: 'hyst',
  connections: [input('in'), output('out')],
  params: [
    real('in_low', 0), real('in_high', 1),
    real('hyst', 0.1, { limits: [0, undefined] }),
    real('out_lower_limit', 0), real('out_upper_limit', 1),
    real('input_domain', 0.01), boolean('fraction', true),
  ],
};

/** A `%g`/`%gd` inout connection (ilimit power and output ports). */
function conductance(name: string, nullAllowed: boolean): XspiceConnectionSpec {
  return { name, direction: 'inout', defaultType: 'g', allowedTypes: ['g', 'gd'], vector: false, nullAllowed };
}

/** ilimit/ifspec.ifs */
const ILIMIT: XspiceCodeModelSpec = {
  name: 'ilimit',
  connections: [input('in'), conductance('pos_pwr', true), conductance('neg_pwr', true), conductance('out', false)],
  params: [
    real('in_offset', 0), real('gain', 1),
    real('r_out_source', 1, { limits: [1e-9, 1e9] }), real('r_out_sink', 1, { limits: [1e-9, 1e9] }),
    real('i_limit_source', 10e-3, { limits: [1e-12, undefined] }),
    real('i_limit_sink', 10e-3, { limits: [1e-12, undefined] }),
    real('v_pwr_range', 1e-6, { limits: [1e-15, undefined] }),
    real('i_source_range', 1e-9, { limits: [1e-15, undefined] }),
    real('i_sink_range', 1e-9, { limits: [1e-15, undefined] }),
    real('r_out_domain', 1e-9, { limits: [1e-15, undefined] }),
  ],
};

/** ngspice-47 src/xspice/icm/xtradev/pswitch/ifspec.ifs:28-76 (ports and defaults). */
const PSWITCH: XspiceCodeModelSpec = {
  name: 'pswitch',
  connections: [
    { name: 'cntl_in', direction: 'inout', defaultType: 'gd', allowedTypes: ['g', 'gd'], vector: false, nullAllowed: false },
    { name: 'out', direction: 'inout', defaultType: 'gd', allowedTypes: ['gd'], vector: false, nullAllowed: false },
  ],
  params: [
    real('cntl_off', 0.0), real('cntl_on', 1.0),
    boolean('log', true), real('r_off', 1.0e12),
    real('r_on', 1.0), real('r_cntl_in', 1.0e12),
  ],
};

/** xtradev/aswitch/ifspec.ifs */
const ASWITCH: XspiceCodeModelSpec = {
  name: 'aswitch',
  connections: [
    input('cntl_in'),
    { name: 'out', direction: 'inout', defaultType: 'gd', allowedTypes: ['gd'], vector: false, nullAllowed: false },
  ],
  params: [
    real('cntl_off', 0.0), real('cntl_on', 1.0),
    boolean('log', true), real('r_off', 1.0e12),
    real('r_on', 1.0), boolean('limit', false),
  ],
};

/** slew/ifspec.ifs */
const SLEW: XspiceCodeModelSpec = {
  name: 'slew',
  connections: [input('in'), output('out')],
  params: [real('rise_slope', 1e-9), real('fall_slope', 1e-9)],
};

/** sine/ifspec.ifs: the control/frequency table and output levels. */
const OSCILLATOR_TABLE: readonly XspiceParamSpec[] = [
  { name: 'cntl_array', type: 'real', defaultValue: [0, 1], vector: true, vectorBounds: [2, undefined], nullAllowed: true },
  {
    name: 'freq_array', type: 'real', defaultValue: [1e3, 2e3], limits: [0, undefined],
    vector: true, vectorBounds: [2, undefined], nullAllowed: true,
  },
  real('out_low', -1), real('out_high', 1),
];

/** sine/ifspec.ifs */
const SINE: XspiceCodeModelSpec = {
  name: 'sine',
  connections: [input('cntl_in'), output('out')],
  params: OSCILLATOR_TABLE,
};

/** triangle/ifspec.ifs calls the rise proportion duty_cycle. */
const TRIANGLE: XspiceCodeModelSpec = {
  ...SINE, name: 'triangle',
  params: [...OSCILLATOR_TABLE, real('duty_cycle', 0.5, { limits: [1e-6, 0.999999] })],
};

/** analog/square/ifspec.ifs */
const SQUARE: XspiceCodeModelSpec = {
  ...TRIANGLE, name: 'square',
  params: [
    ...TRIANGLE.params.map(param => param.name === 'cntl_array' || param.name === 'freq_array'
      ? { ...param, defaultValue: undefined, nullAllowed: false } : param),
    real('rise_time', 1e-9), real('fall_time', 1e-9),
  ],
};

/** ngspice-47 xtradev/potentiometer/ifspec.ifs (Public Domain). */
const POTENTIOMETER: XspiceCodeModelSpec = {
  name: 'potentiometer',
  connections: ['r0', 'wiper', 'r1'].map(name => ({
    name, direction: 'inout', defaultType: 'g', allowedTypes: ['g'], vector: false, nullAllowed: false,
  })),
  params: [
    real('position', 0.5, { limits: [0, 1] }),
    { name: 'log', type: 'boolean', defaultValue: [false], vector: false, nullAllowed: true },
    real('r', 1e5), real('log_multiplier', 1),
  ],
};

/** ngspice-47 xtradev/sidiode/ifspec.ifs:34-104. */
const SIDIODE: XspiceCodeModelSpec = {
  name: 'sidiode',
  connections: [{ name: 'ds', direction: 'inout', defaultType: 'gd', allowedTypes: ['gd'], vector: false, nullAllowed: false }],
  params: [
    real('ron', 1, { limits: [1e-6, undefined] }),
    real('roff', 1, { limits: [1e-12, undefined] }),
    real('vfwd', 0, { limits: [0, undefined] }),
    real('vrev', 1e30, { limits: [0, undefined] }),
    real('ilimit', 1e30, { limits: [1e-15, undefined] }),
    real('revilimit', 1e30, { limits: [1e-15, undefined] }),
    real('epsilon', 0, { limits: [0, undefined] }),
    real('revepsilon', 0, { limits: [0, undefined] }),
    real('rrev', 0),
  ],
};

/** xtradev/zener/ifspec.ifs */
const ZENER: XspiceCodeModelSpec = {
  name: 'zener',
  connections: [{ name: 'z', direction: 'inout', defaultType: 'gd', allowedTypes: ['gd'], vector: false, nullAllowed: false }],
  params: [
    { name: 'v_breakdown', type: 'real', vector: false, nullAllowed: false, limits: [1e-6, 1e6] },
    real('i_breakdown', 2e-2, { limits: [1e-9, undefined] }),
    real('r_breakdown', 1, { limits: [1e-12, undefined] }),
    real('i_rev', 1e-6, { limits: [1e-9, undefined] }),
    real('i_sat', 1e-12, { limits: [1e-15, undefined] }),
    real('n_forward', 1, { limits: [0.1, 10] }), boolean('limit_switch', false),
  ],
};

/** oneshot/ifspec.ifs */
const ONESHOT: XspiceCodeModelSpec = {
  name: 'oneshot',
  connections: [input('clk'), { ...input('cntl_in'), nullAllowed: true }, { ...input('clear'), nullAllowed: true }, output('out')],
  params: [
    real('cntl_array', 0, { vector: true, vectorBounds: [2, undefined], nullAllowed: false }),
    real('pw_array', 1e-6, { vector: true, vectorBounds: [2, undefined], limits: [0, undefined], nullAllowed: false }),
    real('clk_trig', 0.5), boolean('pos_edge_trig', true),
    real('out_low', 0), real('out_high', 1), real('rise_time', 1e-9),
    real('rise_delay', 1e-9), real('fall_delay', 1e-9), real('fall_time', 1e-9), boolean('retrig', false),
  ],
};

/** A meter's input: ngspice xtradev cmeter/lmeter allow only `%v` and `%vd`. */
const METER_IN: XspiceConnectionSpec = {
  name: 'in', direction: 'in', defaultType: 'v', allowedTypes: ['v', 'vd'], vector: false, nullAllowed: false,
};

/** xtradev/cmeter/ifspec.ifs */
const CMETER: XspiceCodeModelSpec = { name: 'cmeter', connections: [METER_IN, output('out')], params: [real('gain', 1)] };

/** xtradev/lmeter/ifspec.ifs */
const LMETER: XspiceCodeModelSpec = { name: 'lmeter', connections: [METER_IN, output('out')], params: [real('gain', 1)] };

/** A digital (`%d`) connection, the only type the digital port tables allow. */
function digital(
  name: string,
  direction: 'in' | 'out',
  vector = false,
  vectorBounds?: readonly [number | undefined, number | undefined],
): XspiceConnectionSpec {
  return {
    name, direction, defaultType: 'd', allowedTypes: ['d'], vector, nullAllowed: false,
    ...(vectorBounds ? { vectorBounds } : {}),
  };
}

function string(name: string): XspiceParamSpec {
  return { name, type: 'string', vector: false, nullAllowed: true };
}

/** rise_delay/fall_delay of the digital gates and the adc_bridge: default 1 ns, at least 1 ps. */
const DIGITAL_DELAYS: readonly XspiceParamSpec[] = [
  real('rise_delay', 1e-9, { limits: [1e-12, undefined] }),
  real('fall_delay', 1e-9, { limits: [1e-12, undefined] }),
];

/** The parameter table every digital gate shares (d_and/ifspec.ifs and siblings). */
const GATE_PARAMS: readonly XspiceParamSpec[] = [
  ...DIGITAL_DELAYS, real('input_load', 1e-12), string('family'), boolean('inertial_delay', false),
];

/** One-input gate (d_buffer, d_inverter). */
function unaryGate(name: string): XspiceCodeModelSpec {
  return { name, connections: [digital('in', 'in'), digital('out', 'out')], params: GATE_PARAMS };
}

/** n-input gate (d_and, d_nand, d_or, d_nor, d_xor, d_xnor): at least two inputs. */
function naryGate(name: string): XspiceCodeModelSpec {
  return { name, connections: [digital('in', 'in', true, [2, undefined]), digital('out', 'out')], params: GATE_PARAMS };
}

/** digital/adc_bridge/ifspec.ifs */
const ADC_BRIDGE: XspiceCodeModelSpec = {
  name: 'adc_bridge',
  connections: [
    { name: 'in', direction: 'in', defaultType: 'v', allowedTypes: ANALOG_IN, vector: true, nullAllowed: false },
    digital('out', 'out', true),
  ],
  params: [real('in_low', 0.1), real('in_high', 0.9), ...DIGITAL_DELAYS, string('family')],
};

/** digital/dac_bridge/ifspec.ifs */
const DAC_BRIDGE: XspiceCodeModelSpec = {
  name: 'dac_bridge',
  connections: [
    digital('in', 'in', true),
    { name: 'out', direction: 'out', defaultType: 'v', allowedTypes: ANALOG_OUT, vector: true, nullAllowed: false },
  ],
  params: [
    real('out_low', 0.0), real('out_high', 1.0), real('out_undef', 0.5), real('input_load', 1e-12),
    real('t_rise', 1e-9, { limits: [1e-12, undefined] }), real('t_fall', 1e-9, { limits: [1e-12, undefined] }),
  ],
};

/** digital/d_pulldown and d_pullup/ifspec.ifs: scalar digital output, no inputs. */
function pull(name: string): XspiceCodeModelSpec {
  return { name, connections: [digital('out', 'out')], params: [real('load', 1e-12)] };
}

/** digital/{d_jkff,d_dff,d_tff,d_srff,d_dlatch,d_srlatch}/ifspec.ifs */
function flipFlop(name: string, data: readonly string[], load: string, latch = false): XspiceCodeModelSpec {
  return {
    name,
    connections: [
      ...data.map(port => digital(port, 'in')), digital(latch ? 'enable' : 'clk', 'in'),
      ...['set', 'reset'].map(port => ({ ...digital(port, 'in'), nullAllowed: true })),
      ...['out', 'nout'].map(port => ({ ...digital(port, 'out'), nullAllowed: true })),
    ],
    params: [
      ...(latch ? [load === 'sr_load' ? 'sr_delay' : 'data_delay', 'enable_delay', 'set_delay', 'reset_delay'] : ['clk_delay', 'set_delay', 'reset_delay']).map(param => real(param, 1e-9, { limits: [1e-12, undefined] })),
      { name: 'ic', type: 'int', defaultValue: [0], limits: [0, 2], vector: false, nullAllowed: true },
      ...DIGITAL_DELAYS,
      ...[load, latch ? 'enable_load' : 'clk_load', 'set_load', 'reset_load'].map(param => real(param, 1e-12)),
    ],
  };
}

/** digital/{d_osc,d_pwm}/ifspec.ifs. Legacy delays are accepted but unused. */
function controlledOscillator(pwm: boolean): XspiceCodeModelSpec {
  return {
    name: pwm ? 'd_pwm' : 'd_osc',
    connections: [{ ...input('cntl_in'), allowedTypes: ['v', 'vd', 'i', 'id'] }, digital('out', 'out')],
    params: [
      { ...real('cntl_array', undefined, { vector: true, vectorBounds: [2, undefined] }), defaultValue: pwm ? [-1, 1] : [0, 1] },
      { ...real(pwm ? 'dc_array' : 'freq_array', undefined, { vector: true, vectorBounds: [2, undefined], limits: [0, pwm ? 1 : undefined] }), defaultValue: pwm ? [0, 1] : [1e6, 2e6] },
      pwm ? real('frequency', 1e6, { limits: [1e-6, undefined] }) : real('duty_cycle', .5, { limits: [1e-6, .999999] }),
      real('init_phase', 0, { limits: [-180, 360] }),
      real('rise_delay', 1e-9, { limits: [0, undefined] }),
      real('fall_delay', 1e-9, { limits: [0, undefined] }),
    ],
  };
}

/** xtraevt real ports use the same scalar connection syntax as digital nodes. */
function realPort(name: string, direction: 'in' | 'out'): XspiceConnectionSpec {
  return { ...digital(name, direction), defaultType: 'real', allowedTypes: ['real'] };
}

const REAL_SPECS: readonly XspiceCodeModelSpec[] = [
  { name: 'd_to_real', connections: [digital('in', 'in'), { ...digital('enable', 'in'), nullAllowed: true }, realPort('out', 'out')], params: [real('zero', 0), real('one', 1), real('delay', 1e-9, { limits: [1e-15, undefined] })] },
  { name: 'real_gain', connections: [realPort('in', 'in'), realPort('out', 'out')], params: [real('in_offset', 0), real('gain', 1), real('out_offset', 0), real('delay', 1e-9), real('ic', 0)] },
  { name: 'real_delay', connections: [realPort('in', 'in'), digital('clk', 'in'), realPort('out', 'out')], params: [real('delay', 1e-9, { limits: [1e-15, undefined] })] },
  { name: 'real_to_v', connections: [realPort('in', 'in'), output('out')], params: [real('gain', 1), real('transition_time', 1e-9, { limits: [1e-15, undefined] })] },
];

/** Implemented code models keyed by lower-case ngspice Spice_Model_Name. */
export const XSPICE_CODE_MODEL_SPECS: ReadonlyMap<string, XspiceCodeModelSpec> = new Map(
  [
    {
      name: 'mlin',
      connections: ['port1', 'port2', 'v1sens', 'v2sens'].map((name, i) => ({
        name, direction: i < 2 ? 'inout' as const : 'in' as const,
        defaultType: i < 2 ? 'hd' : 'vd', allowedTypes: [i < 2 ? 'hd' : 'vd'], vector: false, nullAllowed: false,
      })),
      params: [real('w', 1e-3), real('l', 1e-2), real('er', 9.8), real('h', 1e-3), real('t', 35e-6),
        real('tand', 2e-4), real('rho', .022e-6), real('d', .15e-6),
        ...['model', 'disp', 'tranmodel'].map(name => ({ name, type: 'int' as const, defaultValue: [0], vector: false, nullAllowed: true }))],
    }, {
      name: 'msopen',
      connections: [{ name: 'p1', direction: 'inout' as const, defaultType: 'gd', allowedTypes: ['gd'], vector: false, nullAllowed: false }],
      // ngspice-47 tlines/msopen/ifspec.ifs. Loss parameters are accepted but unused upstream.
      params: [real('w', 1e-3), real('er', 9.8), real('h', 1e-3), real('t', 35e-6),
        real('tand', 2e-4), real('rho', .022e-6), real('d', .15e-6),
        ...['model', 'disp', 'msopen_model'].map(name => ({ name, type: 'int' as const, defaultValue: [0], vector: false, nullAllowed: true }))],
    }, {
      name: 'cpmlin',
      connections: ['p1', 'p2', 'p3', 'p4', 'p1s', 'p2s', 'p3s', 'p4s'].map((name, i) => ({
        name, direction: i < 4 ? 'inout' as const : 'in' as const,
        defaultType: i < 4 ? 'hd' : 'vd', allowedTypes: [i < 4 ? 'hd' : 'vd'], vector: false, nullAllowed: false,
      })),
      // ngspice-47 tlines/cpmlin/ifspec.ifs:111-241.
      params: [real('w', 1e-3), real('l', 1), real('s', 1e-3), real('er', 9.8), real('h', 1e-3), real('t', 35e-6),
        real('tand', 2e-4), real('rho', .022e-6), real('d', .15e-6),
        ...['model', 'disp', 'tranmodel'].map(name => ({ name, type: 'int' as const, defaultValue: [0], vector: false, nullAllowed: true }))],
    }, {
      name: 'cpline',
      connections: ['p1', 'p2', 'p3', 'p4', 'p1s', 'p2s', 'p3s', 'p4s'].map((name, i) => ({
        name, direction: i < 4 ? 'inout' as const : 'in' as const,
        defaultType: i < 4 ? 'hd' : 'vd', allowedTypes: [i < 4 ? 'hd' : 'vd'], vector: false, nullAllowed: false,
      })),
      // ngspice-47 tlines/cpline/ifspec.ifs:111-183.
      params: [real('l', 1), real('ze', 50), real('zo', 50), real('ae', 0), real('ao', 0), real('ere', 1), real('ero', 1)],
    }, ASTATE, {
      name: 'delay',
      connections: [
        { ...input('in'), allowedTypes: ['v', 'vd', 'vnam'] },
        { ...output('out'), allowedTypes: ['v', 'vd'] },
        { ...input('cntrl'), allowedTypes: ['v', 'vd', 'i', 'id'], nullAllowed: true },
      ],
      params: [real('delay', 0), boolean('has_delay_cnt', false), real('delmin', 0, { limits: [0, undefined] }),
        real('delmax', 0, { limits: [0, undefined] }),
        { name: 'buffer_size', type: 'int' as const, defaultValue: [1024], limits: [1, undefined] as const, vector: false, nullAllowed: true }],
    }, GAIN, SUMMER, MULT, DIVIDE, PWL,
    MULTI_INPUT_PWL,
    // analog/pwlts/ifspec.ifs:30-75 shares pwl parameters, but has only an output.
    { name: 'pwlts', connections: [output('out')], params: PWL.params },
    LIMIT, INT, D_DT, S_XFER, XFER, OTA_SPEC, ...REACTIVE_IC_SPECS,

    {
      name: 'lcouple',
      connections: ['l', 'mmf_out'].map((name, i) => ({ name, direction: 'inout' as const, defaultType: 'hd', allowedTypes: i === 0 ? ['h', 'hd'] : ['hd'], vector: false, nullAllowed: false })),
      params: [real('num_turns', 1)],
    },
    {
      name: 'core',
      connections: [{ name: 'mc', direction: 'inout' as const, defaultType: 'gd', allowedTypes: ['g', 'gd'], vector: false, nullAllowed: false }],
      params: [
        ...['h_array', 'b_array'].map(name => real(name, undefined, { vector: true, vectorBounds: [2, undefined], nullAllowed: false })),
        ...['area', 'length'].map(name => real(name, undefined, { nullAllowed: false })),
        real('input_domain', 0.01, { limits: [1e-12, 0.5] }), boolean('fraction', true),
        { name: 'mode', type: 'int' as const, defaultValue: [1], vector: false, nullAllowed: true },
        real('in_low', 0), real('in_high', 1), real('hyst', 0.1), real('out_lower_limit', 0), real('out_upper_limit', 1),
      ],
    },
    {
      name: 'memristor',
      connections: [{ name: 'memris', direction: 'inout' as const, defaultType: 'gd', allowedTypes: ['gd'], vector: false, nullAllowed: false }],
      params: [real('rmin', 10, { nullAllowed: false }), real('rmax', 10000, { nullAllowed: false }),
        real('rinit', 7000, { nullAllowed: false }), real('alpha', 0, { nullAllowed: false }),
        real('beta', 1, { nullAllowed: false }), real('vt', 0, { nullAllowed: false })],
    },
    CLIMIT, HYST, ILIMIT, SLEW, SINE, TRIANGLE, SQUARE, ZENER, SIDIODE, POTENTIOMETER, ONESHOT, CMETER, LMETER, PSWITCH, ASWITCH, SEEGEN_SPEC,

    ...REAL_SPECS, ADC_BRIDGE, DAC_BRIDGE,
    {
      // ngspice-47 digital/bidi_bridge/ifspec.ifs:24-196.
      name: 'bidi_bridge',
      connections: [
        { name: 'a', direction: 'inout', defaultType: 'g', allowedTypes: ['g', 'gd'], vector: true, vectorBounds: [1, undefined], nullAllowed: false },
        { ...digital('d', 'in', true, [1, undefined]), direction: 'inout' },
        { ...digital('dir', 'in', true), nullAllowed: true },
      ],
      params: [
        ...['direction', 'strength', 'smooth'].map((name, i) => ({ name, type: 'int' as const, defaultValue: [i === 0 ? 2 : 0], limits: [0, 2] as const, vector: false, nullAllowed: true })),
        real('input_load', 1e-12), real('in_low', .1), real('in_high', .9), real('out_low', 0), real('out_high', 3.3),
        real('drive_low', .02), real('drive_high', .02),
        ...['r_stl', 'r_sth', 'r_low', 'r_high'].map((name, i) => real(name, i < 2 ? 20 : 10000, { limits: [1e-6, undefined] })),
        ...['t_rise', 't_fall', 'rise_delay', 'fall_delay'].map(name => real(name, 1e-9, { limits: [1e-12, undefined] })),
      ],
    } satisfies XspiceCodeModelSpec,
    pull('d_pulldown'), pull('d_pullup'),
    controlledOscillator(false), controlledOscillator(true),
    {
      name: 'd_ram',
      connections: [digital('data_in', 'in', true, [1, undefined]), digital('data_out', 'out', true, [1, undefined]),
        digital('address', 'in', true, [1, undefined]), digital('write_en', 'in'), digital('select', 'in', true, [1, 16])],
      params: [
        { name: 'select_value', type: 'int' as const, defaultValue: [1], limits: [0, 32767] as const, vector: false, nullAllowed: true },
        { name: 'ic', type: 'int' as const, defaultValue: [2], limits: [0, 2] as const, vector: false, nullAllowed: true },
        real('read_delay', 100e-9, { limits: [1e-12, undefined] }),
        ...['data_load', 'address_load', 'select_load', 'enable_load'].map(param => real(param, 1e-12)),
      ],
    },
    flipFlop('d_jkff', ['j', 'k'], 'jk_load'), flipFlop('d_dff', ['data'], 'data_load'),
    flipFlop('d_tff', ['t'], 't_load'), flipFlop('d_srff', ['s', 'r'], 'sr_load'),
    flipFlop('d_dlatch', ['data'], 'data_load', true), flipFlop('d_srlatch', ['s', 'r'], 'sr_load', true),
    {
      name: 'd_fdiv', connections: [digital('freq_in', 'in'), digital('freq_out', 'out')],
      params: [
        ...([['div_factor', 2, 1], ['high_cycles', 1, 1], ['i_count', 0, 0]] as const).map(([name, value, lower]) => ({ name, type: 'int' as const, defaultValue: [value], limits: [lower, undefined] as const, vector: false, nullAllowed: true })),
        ...DIGITAL_DELAYS, real('freq_in_load', 1e-12),
      ],
    },
    ...([2, 3] as const).map(dimensions => ({
      name: `table${dimensions}d`,
      connections: [...['inx', 'iny', ...(dimensions === 3 ? ['inz'] : [])].map(name => input(name)),
        { ...output('out'), defaultType: 'i' }],
      params: [
        { name: 'order', type: 'int' as const, defaultValue: [3], limits: [2, undefined] as const, vector: false, nullAllowed: true },
        { name: 'verbose', type: 'int' as const, defaultValue: [0], limits: [0, 2] as const, vector: false, nullAllowed: true },
        real('offset', 0), real('gain', 1),
        { name: 'file', type: 'string' as const, defaultValue: [`${dimensions}D-table-model.txt`], vector: false, nullAllowed: true },
      ],
    })),
    unaryGate('d_buffer'), unaryGate('d_inverter'),
    // ngspice-47 digital/{d_open_c,d_open_e}/ifspec.ifs:30-74.
    ...(['d_open_c', 'd_open_e'] as const).map(name => ({
      ...unaryGate(name),
      params: GATE_PARAMS.map(param => param.name === (name === 'd_open_c' ? 'rise_delay' : 'fall_delay')
        ? { ...param, name: 'open_delay' } : param),
    })),
    {
      // ngspice-47 digital/d_tristate/ifspec.ifs:29-62 (default transport-delay mode).
      name: 'd_tristate',
      connections: [digital('in', 'in'), digital('enable', 'in'), digital('out', 'out')],
      params: [real('delay', 1e-9, { limits: [1e-12, undefined] }), real('input_load', 1e-12), real('enable_load', 1e-12)],
    },
    naryGate('d_and'), naryGate('d_nand'), naryGate('d_or'), naryGate('d_nor'), naryGate('d_xor'), naryGate('d_xnor'),
    {
      name: 'd_genlut',
      connections: [digital('in', 'in', true), digital('out', 'out', true)],
      params: [
        real('rise_delay', 1e-9, { vector: true, limits: [1e-12, undefined] }),
        real('fall_delay', 1e-9, { vector: true, limits: [1e-12, undefined] }),
        real('input_load', 1e-12, { vector: true }), real('input_delay', 0, { vector: true }),
        { ...string('table_values'), nullAllowed: false },
      ],
    },
    {
      name: 'd_lut',
      connections: [digital('in', 'in', true, [1, undefined]), digital('out', 'out')],
      params: [...DIGITAL_DELAYS, real('input_load', 1e-12), { ...string('table_values'), nullAllowed: false }],
    },
  ].map(spec => [spec.name, spec]),
);

/**
 * Every code model shipped with ngspice-47 (analog, digital, spice2poly,
 * table, tlines, xtradev and xtraevt libraries). A `.model` card of one of
 * these types that spice-ts does not implement raises
 * {@link UnsupportedCodeModelError} instead of being stored and simulated
 * without a device.
 */
export const NGSPICE_XSPICE_CODE_MODELS: ReadonlySet<string> = new Set([
  // analog
  'astate', 'climit', 'd_dt', 'delay', 'divide', 'filesource', 'gain', 'hyst', 'ilimit', 'int',
  'limit', 'mult', 'multi_input_pwl', 'oneshot', 'ota', 'pwl', 'pwlts', 's_xfer', 'sine', 'slew',
  'square', 'summer', 'triangle', 'xfer',
  // digital
  'adc_bridge', 'bidi_bridge', 'd_and', 'd_buffer', 'd_cosim', 'd_dff', 'd_dlatch', 'd_fdiv',
  'd_genlut', 'd_inverter', 'd_jkff', 'd_lut', 'd_nand', 'd_nor', 'd_open_c', 'd_open_e', 'd_or',
  'd_osc', 'd_process', 'd_pulldown', 'd_pullup', 'd_pwm', 'd_ram', 'd_source', 'd_srff',
  'd_srlatch', 'd_state', 'd_tff', 'd_tristate', 'd_xnor', 'd_xor', 'dac_bridge',
  // spice2poly, table, tlines
  'spice2poly', 'table2d', 'table3d', 'cpline', 'cpmlin', 'mlin', 'msopen', 'tline',
  // xtradev
  'aswitch', 'capacitoric', 'cmeter', 'core', 'inductoric', 'lcouple', 'lmeter', 'memristor',
  'potentiometer', 'pswitch', 'seegen', 'sidiode', 'zener',
  // xtraevt
  'd_to_real', 'real_delay', 'real_gain', 'real_to_v',
]);
