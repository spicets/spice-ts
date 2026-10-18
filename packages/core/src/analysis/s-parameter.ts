import type { CompiledCircuit } from '../circuit.js';
import type { DeviceModel } from '../devices/device.js';
import { Capacitor } from '../devices/capacitor.js';
import { CCCS } from '../devices/cccs.js';
import { CCVS } from '../devices/ccvs.js';
import { CurrentSource } from '../devices/current-source.js';
import { Inductor } from '../devices/inductor.js';
import { MutualInductor } from '../devices/mutual-inductor.js';
import { Resistor } from '../devices/resistor.js';
import { VCCS } from '../devices/vccs.js';
import { VCVS } from '../devices/vcvs.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { InvalidCircuitError } from '../errors.js';
import type { ProtocolExecutionGuard } from '../protocol/execution-guard.js';
import { type ComplexValue, SParameterResult } from '../results.js';
import type { ResolvedOptions, SParameterAnalysis } from '../types.js';
import { createLinearizedFrequencySystem } from './ac.js';
import { frequencyGrid } from './frequency-grid.js';

/** ngspice-47 const.h CONSTboltz (the SP noise path normalizes Cy by the same 4kT). */
const NGSPICE_BOLTZMANN = 1.38064852e-23;
const CELSIUS_TO_KELVIN = 273.15;
/** ngspice's default circuit temperature in degrees Celsius. */
const NOMINAL_TEMPERATURE_C = 27;

/** Devices whose only `.sp` noise is resistor thermal noise; anything else is rejected with donoise. */
const SP_NOISE_DEVICES = [
  Resistor, Capacitor, Inductor, MutualInductor, VoltageSource, CurrentSource, VCVS, VCCS, CCVS, CCCS,
];

type Matrix = ComplexValue[][];

/**
 * S-parameter analysis (ngspice-47 span.c / cktspdum.c, RFSPICE).
 *
 * At each frequency every port k is excited in turn with a unit source behind
 * its z0 (all other AC excitations off). Each port p's power waves
 * `a = (v + z0 i) / (2 sqrt(z0))`, `b = (v - z0 i) / (2 sqrt(z0))` (v across the
 * port's outer terminals, i into the circuit) fill column k of A and B, and
 * `S = B A^-1`; Z and Y follow from S with the diagonal reference impedances.
 *
 * With `donoise`, each noisy resistor's thermal current noise is propagated to
 * the port voltages and converted to port noise currents
 * `in_d = vn_d / z0_d + sum_s Y_ds vn_s`, accumulated into `Cy = sum in in^H`
 * (span.c / nevalsrc.c). Two-port circuits also get NF, SOpt, NFmin and Rn.
 * ngspice adds no SP-mode noise for flicker terms, so resistor KF is ignored.
 */
export function solveSParameters(
  compiled: CompiledCircuit,
  analysis: SParameterAnalysis,
  options: ResolvedOptions,
  dcSolution: Float64Array,
  guard?: ProtocolExecutionGuard,
): SParameterResult {
  const ports = rfPorts(compiled);
  assertSingleExcitationKind(compiled);
  if (analysis.noise) assertNoiseDevicesSupported(compiled.devices);

  const { nodeCount } = compiled;
  const system = createLinearizedFrequencySystem(compiled, options, dcSolution);
  const frequencies = frequencyGrid(analysis, options.reltol, 'sp');
  const n = ports.length;
  const z0 = ports.map(port => port.port!.z0);
  const ki = z0.map(z => 0.5 / Math.sqrt(z));
  const gn = ki.map(k => 2 * k);
  const names = (prefix: string) => ports.flatMap((_, row) => ports.map((__, col) => `${prefix}_${row + 1}_${col + 1}`));
  const vectors = new Map<string, ComplexValue[]>();
  for (const prefix of ['S', 'Y', 'Z', ...(analysis.noise ? ['Cy'] : [])]) {
    for (const name of names(prefix)) vectors.set(name, []);
  }
  const twoPortNoise = analysis.noise && n === 2;
  if (twoPortNoise) for (const name of ['NF', 'SOpt', 'NFmin', 'Rn']) vectors.set(name, []);
  const noiseSources = analysis.noise ? resistorNoiseSources(compiled.devices) : [];
  const noiseKelvin = twoPortNoise ? circuitKelvin(compiled.devices) : 0;

  const portVoltage = (x: { real: Float64Array; imaginary: Float64Array }, port: VoltageSource): ComplexValue => {
    const [positive, negative] = port.nodes;
    const at = (values: Float64Array, node: number) => (node >= 0 ? values[node] : 0);
    return {
      real: at(x.real, positive) - at(x.real, negative),
      imaginary: at(x.imaginary, positive) - at(x.imaginary, negative),
    };
  };

  for (const frequency of frequencies) {
    guard?.checkpoint('solve:ac-point');
    guard?.recordResultPoint();
    const omega = 2 * Math.PI * frequency;
    const a = zeros(n);
    const b = zeros(n);
    for (let active = 0; active < n; active++) {
      const rhs = { real: new Float64Array(system.size), imaginary: new Float64Array(system.size) };
      rhs.real[nodeCount + ports[active].branchIndex] = 1;
      const x = system.solve(omega, rhs);
      for (let row = 0; row < n; row++) {
        const v = portVoltage(x, ports[row]);
        const branch = nodeCount + ports[row].branchIndex;
        const i = { real: -x.real[branch], imaginary: -x.imaginary[branch] };
        a[row][active] = {
          real: ki[row] * (v.real + z0[row] * i.real),
          imaginary: ki[row] * (v.imaginary + z0[row] * i.imaginary),
        };
        b[row][active] = {
          real: ki[row] * (v.real - z0[row] * i.real),
          imaginary: ki[row] * (v.imaginary - z0[row] * i.imaginary),
        };
      }
    }

    // cktspdum.c CKTspCalcSMatrix.
    const s = multiply(b, inverse(a));
    const sz0 = scaleColumns(s, z0);
    const sz0PlusZ0 = addDiagonal(sz0, z0, 1);
    const eMinusS = addDiagonal(negate(s), Array(n).fill(1), 1);
    const z = scaleRows(multiply(inverse(eMinusS), scaleColumns(sz0PlusZ0, gn)), gn.map(g => 1 / g));
    const y = scaleRows(multiply(inverse(sz0PlusZ0), scaleColumns(eMinusS, gn)), gn.map(g => 1 / g));
    push(vectors, 'S', s);
    push(vectors, 'Y', y);
    push(vectors, 'Z', z);

    if (analysis.noise) {
      const cy = zeros(n);
      for (const source of noiseSources) {
        const rhs = { real: new Float64Array(system.size), imaginary: new Float64Array(system.size) };
        if (source.positive >= 0) rhs.real[source.positive] = 1;
        if (source.negative >= 0) rhs.real[source.negative] -= 1;
        const x = system.solve(omega, rhs);
        const amplitude = Math.sqrt(source.powerDensity);
        const vn = ports.map(port => {
          const v = portVoltage(x, port);
          return { real: v.real * amplitude, imaginary: v.imaginary * amplitude };
        });
        const inoise = vn.map((value, d) => {
          let real = value.real / z0[d];
          let imaginary = value.imaginary / z0[d];
          for (let k = 0; k < n; k++) {
            real += y[d][k].real * vn[k].real - y[d][k].imaginary * vn[k].imaginary;
            imaginary += y[d][k].real * vn[k].imaginary + y[d][k].imaginary * vn[k].real;
          }
          return { real, imaginary };
        });
        for (let d = 0; d < n; d++) {
          for (let k = 0; k < n; k++) {
            cy[d][k].real += inoise[d].real * inoise[k].real + inoise[d].imaginary * inoise[k].imaginary;
            cy[d][k].imaginary += inoise[d].imaginary * inoise[k].real - inoise[d].real * inoise[k].imaginary;
          }
        }
      }
      push(vectors, 'Cy', cy);
      if (twoPortNoise) pushTwoPortNoise(vectors, cy, y, 1 / z0[0], noiseKelvin);
    }
  }

  return new SParameterResult(frequencies, ports.map(port => port.name), vectors, z0);
}

/** RF port sources ordered by port number; ngspice span.c needs at least two. */
function rfPorts(compiled: CompiledCircuit): VoltageSource[] {
  const ports = compiled.devices
    .filter((device): device is VoltageSource => device instanceof VoltageSource && device.port !== undefined)
    .sort((left, right) => left.port!.number - right.port!.number);
  if (ports.length < 2) {
    throw new InvalidCircuitError(
      `.sp needs at least two RF ports (V sources with portnum); found ${ports.length}`,
    );
  }
  return ports;
}

/**
 * ngspice-47 vsrcacld.c switches every V-source AC excitation off in SP mode,
 * but isrcacld.c keeps current-source AC terms, which span.c then mixes with
 * an uninitialized imaginary RHS. Reject that instead of guessing.
 */
function assertSingleExcitationKind(compiled: CompiledCircuit): void {
  for (const device of compiled.devices) {
    if (!(device instanceof CurrentSource)) continue;
    const excitation = device.getACExcitation();
    if (excitation && excitation.magnitude !== 0) {
      throw new InvalidCircuitError(
        `.sp does not support the AC excitation of current source '${device.name}'`,
      );
    }
  }
}

function assertNoiseDevicesSupported(devices: DeviceModel[]): void {
  for (const device of devices) {
    if (!SP_NOISE_DEVICES.some(kind => device instanceof kind)) {
      throw new InvalidCircuitError(
        `.sp donoise only supports resistor thermal noise; '${device.name}' has unsupported S-parameter noise`,
      );
    }
  }
}

function resistorNoiseSources(devices: DeviceModel[]): Array<{ positive: number; negative: number; powerDensity: number }> {
  return devices
    .filter((device): device is Resistor => device instanceof Resistor && device.noisy)
    .map(resistor => {
      if (!Number.isFinite(resistor.conductance)) {
        throw new InvalidCircuitError(`.sp donoise requires a finite resistance for '${resistor.name}'`);
      }
      // nevalsrc.c NevalSrcInstanceTemp THERMNOISE: 4 k (CKTtemp + dtemp) RESconduct.
      const kelvin = resistor.getTemperature() + CELSIUS_TO_KELVIN;
      return {
        positive: resistor.nodes[0],
        negative: resistor.nodes[1],
        powerDensity: 4 * NGSPICE_BOLTZMANN * kelvin * resistor.conductance,
      };
    });
}

/**
 * The circuit temperature (CKTtemp) in kelvin that ngspice span.c normalizes
 * Cy with. Resistors are the only `.sp` noise sources and `.options temp`
 * sets every resistor's circuit temperature; an instance or `.model`
 * TEMP/DTEMP (#846) changes only that resistor's noise power, not CKTtemp.
 */
function circuitKelvin(devices: DeviceModel[]): number {
  const resistor = devices.find((device): device is Resistor => device instanceof Resistor);
  return (resistor?.getCircuitTemperature() ?? NOMINAL_TEMPERATURE_C) + CELSIUS_TO_KELVIN;
}

/** span.c CKTspnoise N_CALC for two ports, referred to port 1's reference admittance; Cy / (4 k CKTtemp). */
function pushTwoPortNoise(vectors: Map<string, ComplexValue[]>, cy: Matrix, y: Matrix, y0: number, kelvin: number): void {
  const knorm = 4 * NGSPICE_BOLTZMANN * kelvin;
  const c = cy.map(row => row.map(value => ({ real: value.real / knorm, imaginary: value.imaginary / knorm })));
  let rn = c[1][1].real / modulusSquared(y[1][0]);
  if (Math.abs(rn) < 1e-30) rn = 1e-30;
  if (Math.abs(c[1][1].real) < 1e-30 && Math.abs(c[1][1].imaginary) < 1e-30) c[1][1].real = 1e-30;
  const ycor = subtract(y[0][0], mul(divide(c[0][1], c[1][1]), y[1][0]));
  const gu = c[0][0].real - rn * modulusSquared(subtract(y[0][0], ycor));
  const ysopt = { real: Math.sqrt(ycor.real * ycor.real + gu / rn), imaginary: -ycor.imaginary };
  const y0c = { real: y0, imaginary: 0 };
  const sopt = divide(subtract(y0c, ysopt), add(y0c, ysopt));
  const fmin = 1 + 2 * rn * (ycor.real + ysopt.real);
  const nf = fmin + (rn / y0) * modulusSquared(subtract(y0c, ysopt));
  vectors.get('NF')!.push({ real: 10 * Math.log10(nf), imaginary: 0 });
  vectors.get('SOpt')!.push(sopt);
  vectors.get('NFmin')!.push({ real: 10 * Math.log10(fmin), imaginary: 0 });
  vectors.get('Rn')!.push({ real: rn, imaginary: 0 });
}

function push(vectors: Map<string, ComplexValue[]>, prefix: string, matrix: Matrix): void {
  matrix.forEach((row, r) => row.forEach((value, c) => vectors.get(`${prefix}_${r + 1}_${c + 1}`)!.push(value)));
}

function zeros(n: number): Matrix {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => ({ real: 0, imaginary: 0 })));
}

function add(left: ComplexValue, right: ComplexValue): ComplexValue {
  return { real: left.real + right.real, imaginary: left.imaginary + right.imaginary };
}

function subtract(left: ComplexValue, right: ComplexValue): ComplexValue {
  return { real: left.real - right.real, imaginary: left.imaginary - right.imaginary };
}

function mul(left: ComplexValue, right: ComplexValue): ComplexValue {
  return {
    real: left.real * right.real - left.imaginary * right.imaginary,
    imaginary: left.real * right.imaginary + left.imaginary * right.real,
  };
}

function modulusSquared(value: ComplexValue): number {
  return value.real * value.real + value.imaginary * value.imaginary;
}

function divide(left: ComplexValue, right: ComplexValue): ComplexValue {
  const denominator = modulusSquared(right);
  return {
    real: (left.real * right.real + left.imaginary * right.imaginary) / denominator,
    imaginary: (left.imaginary * right.real - left.real * right.imaginary) / denominator,
  };
}

function multiply(left: Matrix, right: Matrix): Matrix {
  return left.map(row => right[0].map((_, col) =>
    row.reduce((sum, value, k) => add(sum, mul(value, right[k][col])), { real: 0, imaginary: 0 })));
}

function negate(matrix: Matrix): Matrix {
  return matrix.map(row => row.map(value => ({ real: -value.real, imaginary: -value.imaginary })));
}

/** `matrix + scale * diag(values)`. */
function addDiagonal(matrix: Matrix, values: number[], scale: number): Matrix {
  return matrix.map((row, r) => row.map((value, c) =>
    (r === c ? { real: value.real + scale * values[r], imaginary: value.imaginary } : value)));
}

/** `matrix * diag(values)`. */
function scaleColumns(matrix: Matrix, values: number[]): Matrix {
  return matrix.map(row => row.map((value, c) => ({ real: value.real * values[c], imaginary: value.imaginary * values[c] })));
}

/** `diag(values) * matrix`. */
function scaleRows(matrix: Matrix, values: number[]): Matrix {
  return matrix.map((row, r) => row.map(value => ({ real: value.real * values[r], imaginary: value.imaginary * values[r] })));
}

/** Gauss-Jordan inverse with partial pivoting; port matrices are small and dense. */
function inverse(matrix: Matrix): Matrix {
  const n = matrix.length;
  const work = matrix.map((row, r) => [
    ...row.map(value => ({ ...value })),
    ...Array.from({ length: n }, (_, c) => ({ real: r === c ? 1 : 0, imaginary: 0 })),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (modulusSquared(work[r][col]) > modulusSquared(work[pivot][col])) pivot = r;
    }
    if (modulusSquared(work[pivot][col]) === 0) {
      throw new InvalidCircuitError('.sp port matrix is singular');
    }
    [work[col], work[pivot]] = [work[pivot], work[col]];
    const scale = divide({ real: 1, imaginary: 0 }, work[col][col]);
    work[col] = work[col].map(value => mul(value, scale));
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = work[r][col];
      work[r] = work[r].map((value, c) => subtract(value, mul(factor, work[col][c])));
    }
  }
  return work.map(row => row.slice(n));
}
