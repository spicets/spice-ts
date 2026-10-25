import type { CompiledCircuit } from '../circuit.js';
import { BJT } from '../devices/bjt.js';
import { BSIM3v3 } from '../devices/bsim3v3.js';
import { ClassicBsimMosfet } from '../devices/bsim12-load.js';
import { CurrentSource } from '../devices/current-source.js';
import { Diode } from '../devices/diode.js';
import { HFET1 } from '../devices/hfet1.js';
import { JFET } from '../devices/jfet.js';
import { MOS2 } from '../devices/mos2.js';
import { MOS3 } from '../devices/mos3.js';
import { MOSFET } from '../devices/mosfet.js';
import { Resistor } from '../devices/resistor.js';
import { SwitchBase } from '../devices/switch.js';
import { VoltageSource } from '../devices/voltage-source.js';
import { otaNoiseSources } from '../devices/xspice/ota-model.js';
import { gainNoiseSources } from '../devices/xspice/gain-noise.js';
import { VBIC } from '../devices/vbic.js';
import { VDMOS } from '../devices/vdmos.js';
import { InvalidCircuitError } from '../errors.js';
import { createMatrixVariableIdentities, MNAAssembler } from '../mna/assembler.js';
import { NoiseResult } from '../results.js';
import { frequencyGrid } from './frequency-grid.js';
import { toCsc } from '../solver/csc-matrix.js';
import { ComplexSparseSolver } from '../solver/complex-sparse-solver.js';
import type { NoiseAnalysis, ResolvedOptions } from '../types.js';

const BOLTZMANN_CONSTANT = 1.380649e-23;
const ELEMENTARY_CHARGE = 1.602176634e-19;
const CELSIUS_TO_KELVIN = 273.15;
const DEFAULT_TEMPERATURE_KELVIN = CELSIUS_TO_KELVIN + 27;
/** ngspice-47 noisedef.h: the smallest |gain|^2 input-referred noise divides by (#767). */
const N_MINGAIN = 1e-20;
/**
 * BJT model parameters whose effect on .noise matches ngspice-47. bjtnoise.c
 * sources are RC/RB/RE thermal, cc/cb shot and KF/AF flicker noise; everything
 * else here only shapes the operating point (cc, cb) or the bjtacld.c
 * small-signal transfer (capacitances, transit times, Early voltages), which
 * the DC solve and the AC stamp already model (#736). The substrate diode has
 * no bjtnoise.c source and no bjtacld.c conductance, so ISS/NS and the CJS
 * junction only act through the operating point and the substrate capacitance;
 * TNOM, XTI, XTB and EG move the bjttemp.c parameters those solves use,
 * including the temperature-adjusted currents used by shot/flicker noise.
 * RBM/IRB use the same operating-point gx as the small-signal stamp.
 */
const BJT_NOISE_MODEL_PARAMETERS = new Set([
  'LEVEL', 'BF', 'BR', 'IS', 'NF', 'NR', 'VAF', 'VA', 'IKF', 'IK', 'ISE', 'C2', 'NE',
  'VAR', 'VB', 'IKR', 'ISC', 'C4', 'NC', 'NKF', 'NK', 'RB', 'RBM', 'IRB', 'RC', 'RE', 'KF', 'AF',
  'CJE', 'VJE', 'PE', 'MJE', 'ME', 'TF', 'XTF', 'VTF', 'ITF',
  'CJC', 'VJC', 'PC', 'MJC', 'MC', 'XCJC', 'TR', 'FC',
  'XTI', 'XTB', 'EG', 'polarity',
  'ISS', 'NS', 'CJS', 'CSUB', 'CCS', 'VJS', 'PS', 'MJS', 'MS', 'SUBS', 'TNOM', 'TREF',
]);

/** Reject devices whose noise sources are not part of the bounded slice. */
export function assertNoiseDevicesSupported(compiled: CompiledCircuit): void {
  const hasDifferentialOutput = compiled.analyses.some(analysis =>
    analysis.type === 'noise' && analysis.outputReferenceNode !== undefined
  );
  for (const device of compiled.devices) {
    if (device instanceof Resistor && device.noisy) {
      const { flickerCoefficient: kf, flickerExponent: af, flickerFrequencyExponent: ef,
        effectiveNoiseArea: area, multiplier: m } = device;
      if (!(kf >= 0) || !Number.isFinite(kf)
        || (kf !== 0 && (![af, ef, area, m].every(Number.isFinite) || !(area > 0) || !(m > 0)))) {
        throw new InvalidCircuitError(`.noise requires finite resistor KF >= 0, AF, EF and positive noise geometry and M for '${device.name}'`);
      }
    }
    if (hasDifferentialOutput && isSemiconductorNoiseDevice(device)) {
      throw new InvalidCircuitError(
        '.noise differential voltage output only supports resistor noise',
      );
    }
    if (device instanceof Diode && (device.params.RS ?? 0) > 0) {
      throw new InvalidCircuitError(
        `.noise does not support diode series-resistance noise for '${device.name}'`,
      );
    }
    let kind: string | undefined;
    if (device instanceof BJT) {
      for (const parameter of Object.keys(device.suppliedParams)) {
        if (!BJT_NOISE_MODEL_PARAMETERS.has(parameter)
          && !(parameter === 'PTF' && device.suppliedParams.PTF === 0)) {
          throw new InvalidCircuitError(
            `.noise does not support BJT model parameter '${parameter}' for '${device.name}'`,
          );
        }
      }
    } else if (device instanceof BSIM3v3) {
      device.assertQuasiStaticSmallSignal(false);
      kind = 'MOSFET';
    }
    // b1noi.c / b2noi.c are not ported; reject rather than treat the channel as noiseless.
    else if (device instanceof ClassicBsimMosfet) kind = `MOSFET ${device.setup.kind}`;
    // ngspice HFETA has no noise routine, so its RD/RS are noiseless; reject
    // rather than add thermal noise from the expanded series resistors.
    else if (device instanceof HFET1) kind = 'HFET';
    else if (device instanceof VDMOS) {
      if (!Number.isFinite(device.model.kf) || device.model.kf < 0 || !Number.isFinite(device.model.af)) {
        throw new InvalidCircuitError(`.noise requires finite VDMOS KF >= 0 and AF for '${device.name}'`);
      }
    }

    if (device instanceof MOS2 || device instanceof MOS3) {
      const { KF, AF, NLEV, oxideCapFactor } = device.model;
      const { length, width } = device.noiseOperatingPoint();
      if (!(device instanceof MOS3 && device.model.level === 9) && ![0, 1, 2].includes(NLEV)) {
        throw new InvalidCircuitError(`.noise only supports MOS2/MOS3 NLEV=0, 1 or 2 for '${device.name}'`);
      }
      if (![KF, AF, oxideCapFactor, length, width, device.instance.M].every(Number.isFinite)
        || KF < 0 || oxideCapFactor <= 0 || length <= 0 || width <= 0 || device.instance.M <= 0) {
        throw new InvalidCircuitError(`.noise requires finite MOS2/MOS3/MOS9 KF >= 0, AF and positive noise geometry, Cox and M for '${device.name}'`);
      }
    }
    if (device instanceof MOSFET) {
      if (device.getTemperature() !== 27) {
        throw new InvalidCircuitError(
          `.noise does not support MOSFET noise at TEMP=${device.getTemperature()} C for '${device.name}' (noise sources are evaluated at 27 C)`,
        );
      }
      if (device.params.LEVEL !== 1) {
        throw new InvalidCircuitError(
          `.noise only supports MOSFET level 1 for '${device.name}'`,
        );
      }
      for (const parameter of ['RD', 'RS'] as const) {
        if (device.suppliedParams[parameter] !== undefined) {
          throw new InvalidCircuitError(
            `.noise does not support MOSFET model parameter '${parameter}' for '${device.name}'`,
          );
        }
      }
      const sourceNode = device.nodes[2];
      const bulkNode = device.nodes[3] ?? sourceNode;
      if (
        bulkNode !== sourceNode
        || device.suppliedParams.GAMMA !== undefined
        || device.suppliedParams.PHI !== undefined
      ) {
        throw new InvalidCircuitError(
          `.noise does not support MOSFET bulk/body-effect form for '${device.name}'`,
        );
      }
      const { W, L, KF, AF, NLEV, TOX } = device.params;
      if (!(W > 0) || !Number.isFinite(W) || !(L > 0) || !Number.isFinite(L)) {
        throw new InvalidCircuitError(`.noise requires positive finite MOSFET W and L for '${device.name}'`);
      }
      if (!(KF >= 0) || !Number.isFinite(KF) || !(AF > 0) || !Number.isFinite(AF)) {
        throw new InvalidCircuitError(`.noise requires finite MOSFET KF >= 0 and AF > 0 for '${device.name}'`);
      }
      if (NLEV !== 2) {
        throw new InvalidCircuitError(`.noise only supports MOSFET NLEV=2 for '${device.name}'`);
      }
      if (TOX !== undefined && (!(TOX > 0) || !Number.isFinite(TOX))) {
        throw new InvalidCircuitError(`.noise requires a positive finite MOSFET TOX for '${device.name}'`);
      }
    }
    if (kind) {
      throw new InvalidCircuitError(
        `.noise does not support ${kind} noise for '${device.name}'`,
      );
    }
  }
}

/**
 * Solve the bounded noise slice at the circuit/device temperature (MOS1 is
 * restricted to ngspice's default 27 C circuit temperature):
 * resistor and S/W switch thermal noise, diode junction shot/flicker noise, BJT level-1
 * collector/base shot, base-current KF/AF flicker noise, and RB/RC/RE
 * thermal noise, VBIC thermal/shot/KFN noise, MOS1/2/3/9 channel thermal/KF/AF flicker,
 * and non-self-heated VDMOS RD/RS/channel thermal and KF/AF flicker noise.
 * Controlled and independent ideal sources are noiseless.
 */
export function solveNoise(
  compiled: CompiledCircuit,
  analysis: NoiseAnalysis,
  options: ResolvedOptions,
  dcSolution: Float64Array,
): NoiseResult {
  const { devices, nodeCount, branchCount, nodeNames, branchNames } = compiled;
  const outputIndex = findNodeIndex(compiled, analysis.outputNode);
  const outputReferenceIndex = analysis.outputReferenceNode === undefined
    ? -1
    : findNodeIndex(compiled, analysis.outputReferenceNode);
  if (analysis.outputReferenceNode !== undefined && devices.some(isSemiconductorNoiseDevice)) {
    throw new InvalidCircuitError(
      '.noise differential voltage output only supports resistor noise',
    );
  }
  const inputSource = devices.find(device =>
    (device instanceof VoltageSource || device instanceof CurrentSource)
      && device.name.toLowerCase() === analysis.inputSource.toLowerCase(),
  );
  if (!(inputSource instanceof VoltageSource || inputSource instanceof CurrentSource)) {
    throw new InvalidCircuitError(
      `.noise input source '${analysis.inputSource}' is not an independent voltage or current source`,
    );
  }

  const assembler = new MNAAssembler(nodeCount, branchCount, { deviceGmin: options.deviceGmin });
  assembler.solution.set(dcSolution);
  const ctx = assembler.getStampContext();
  for (const device of devices) {
    if (device.stampSmallSignal) device.stampSmallSignal(ctx);
    else device.stamp(ctx);
  }
  for (const device of devices) device.stampDynamic?.(ctx);
  for (let i = 0; i < nodeCount; i++) assembler.G.add(i, i, options.gmin);

  const { csc: gCsc } = toCsc(assembler.G);
  const { csc: cCsc } = toCsc(assembler.C);
  const solver = new ComplexSparseSolver();
  solver.analyzePattern(
    gCsc,
    cCsc,
    createMatrixVariableIdentities(nodeNames, branchNames),
  );

  const systemSize = nodeCount + branchCount;
  const zeroImaginary = new Float64Array(systemSize);
  const gainRhs = new Float64Array(systemSize);
  if (inputSource instanceof VoltageSource) {
    gainRhs[nodeCount + inputSource.branchIndex] = 1;
  } else {
    const [positiveNode, negativeNode] = inputSource.nodes;
    if (positiveNode >= 0) gainRhs[positiveNode] -= 1;
    if (negativeNode >= 0) gainRhs[negativeNode] += 1;
  }

  // vbicnoise.c evaluates RS/ICCP but excludes them from VBICTOTNOIZ.
  // Both still contribute to integrated totals (the per-source loop).
  const vbicSubstrateResistors = new Set(devices
    .filter((device): device is VBIC => device instanceof VBIC)
    .map(device => `${device.name}.RS`));
  // Fixed RB is compiler-expanded, variable RB (or split CJC) is self-stamped.
  // Both use bjtnoise.c's 4*k*T*gx source below, never a second resistor source.
  const bjtBaseResistors = new Map(devices
    .filter((device): device is Resistor => device instanceof Resistor)
    .map(device => [device.name, device]));
  const expandedBjtBaseNames = new Set(devices
    .filter((device): device is BJT => device instanceof BJT && device.params.RB > 0)
    .map(device => `${device.name}.RB`));
  const resistorSources = devices
    .filter((device): device is Resistor => device instanceof Resistor && device.noisy
      && !expandedBjtBaseNames.has(device.name))
    .map(resistor => {
      if (!(resistor.resistance > 0) || !Number.isFinite(resistor.resistance)) {
        throw new InvalidCircuitError(
          `.noise requires a positive finite resistance for '${resistor.name}'`,
        );
      }
      // ngspice resnoise.c: thermal noise uses the DC conductance RESconduct even with ac=,
      // at the instance temperature REStemp + RESdtemp (model TEMP/DTEMP, #846).
      const kelvin = resistor.getTemperature() + CELSIUS_TO_KELVIN;
      const voltage = (resistor.nodes[0] < 0 ? 0 : dcSolution[resistor.nodes[0]])
        - (resistor.nodes[1] < 0 ? 0 : dcSolution[resistor.nodes[1]]);
      // resnoise.c: REScurrent is the total DC current, including temperature, SCALE and M.
      const current = Math.abs(voltage * resistor.conductance / resistor.multiplier);
      const flicker = resistor.flickerCoefficient === 0 ? 0
        : resistor.multiplier * resistor.flickerCoefficient * Math.pow(current, resistor.flickerExponent)
          / resistor.effectiveNoiseArea;
      if (!Number.isFinite(flicker)) {
        throw new InvalidCircuitError(`.noise requires finite resistor flicker density for '${resistor.name}'`);
      }
      return {
        excludeFromSpectrum: vbicSubstrateResistors.has(resistor.name),
        positive: resistor.nodes[0],
        negative: resistor.nodes[1],
        currentPowerDensity: (frequency: number) =>
          4 * BOLTZMANN_CONSTANT * kelvin * resistor.conductance
          + (flicker === 0 ? 0 : flicker / Math.pow(frequency, resistor.flickerFrequencyExponent)),
      };
    });
  const mosfetSources = devices
    .filter((device): device is MOSFET => device instanceof MOSFET)
    .flatMap(mosfet => {
      const operatingPoint = mosfet.noiseOperatingPoint(dcSolution);
      const { W, KF, AF, TOX, M } = mosfet.params;
      // mos1noi.c (NLEV=2): KF * gm^2 / M over W * (L - 2*LD); gm already carries M.
      const L = mosfet.effectiveLength;
      const oxideCapacitance = 3.9 * 8.854214871e-12 / (TOX ?? 1e-7);
      const sources = [{
        positive: operatingPoint.drainNode,
        negative: operatingPoint.sourceNode,
        currentPowerDensity: (_frequency: number) => 4 * BOLTZMANN_CONSTANT * DEFAULT_TEMPERATURE_KELVIN
          * (2 / 3) * Math.abs(operatingPoint.transconductance),
      }];
      if (KF > 0) {
        sources.push({
          positive: operatingPoint.drainNode,
          negative: operatingPoint.sourceNode,
          currentPowerDensity: (frequency: number) => KF
            * operatingPoint.transconductance * operatingPoint.transconductance
            / (M * Math.pow(frequency, AF) * W * L * oxideCapacitance),
        });
      }
      return sources;
    });
  // ngspice-47 mos2noi.c/mos3noi.c/mos9noi.c. RD/RS/RSH sources are
  // already carried by the compiler-expanded resistors, never counted twice.
  const classicMosSources = devices
    .filter((device): device is MOS2 | MOS3 => device instanceof MOS2 || device instanceof MOS3)
    .flatMap(device => {
      const { gm, cd, length, width } = device.noiseOperatingPoint();
      const { KF, AF, NLEV, oxideCapFactor: cox } = device.model;
      const { M } = device.instance;
      const legacy = device instanceof MOS3 && device.model.level === 9;
      const sources = [{
        positive: device.nodes[0], negative: device.nodes[2],
        currentPowerDensity: (_frequency: number) => 4 * BOLTZMANN_CONSTANT
          * (device.getTemperature() + CELSIUS_TO_KELVIN) * (2 / 3) * Math.abs(gm),
      }];
      if (KF > 0) {
        sources.push({
          positive: device.nodes[0], negative: device.nodes[2],
          currentPowerDensity: (frequency: number) => {
            if (!legacy && NLEV === 2) {
              return KF * gm * gm / (M * Math.pow(frequency, AF) * width * length * cox);
            }
            const area = !legacy && NLEV === 0 ? length * length : width * length;
            return M * KF * Math.exp(AF * Math.log(Math.max(Math.abs(cd / M), 1e-38)))
              / (frequency * area * cox * (legacy ? cox : 1));
          },
        });
      }
      return sources;
    });
  const bjtSources = devices
    .filter((device): device is BJT => device instanceof BJT)
    .flatMap(bjt => {
      const operatingPoint = bjt.noiseOperatingPoint(dcSolution, options.deviceGmin);
      const externalBase = bjt.nodes[4] ?? bjtBaseResistors.get(`${bjt.name}.RB`)?.nodes[0];
      const sources = [{
        positive: operatingPoint.collectorNode,
        negative: operatingPoint.emitterNode,
        currentPowerDensity: (_frequency: number) => 2 * ELEMENTARY_CHARGE
          * operatingPoint.collectorCurrent,
      }, {
        positive: operatingPoint.baseNode,
        negative: operatingPoint.emitterNode,
        currentPowerDensity: (_frequency: number) => 2 * ELEMENTARY_CHARGE
          * operatingPoint.baseCurrent,
      }];
      if (externalBase !== undefined && operatingPoint.baseConductance !== 0) {
        sources.push({
          positive: externalBase,
          negative: operatingPoint.baseNode,
          currentPowerDensity: (_frequency: number) => 4 * BOLTZMANN_CONSTANT
            * (bjt.getTemperature() + CELSIUS_TO_KELVIN) * operatingPoint.baseConductance,
        });
      }
      if (bjt.params.KF > 0) {
        sources.push({
          positive: operatingPoint.baseNode,
          negative: operatingPoint.emitterNode,
          currentPowerDensity: (frequency: number) => bjt.params.KF
            * Math.pow(Math.max(operatingPoint.baseCurrent, 1e-38), bjt.params.AF)
            / frequency,
        });
      }
      return sources;
    });
  const diodeSources = devices
    .filter((device): device is Diode => device instanceof Diode)
    .flatMap(diode => {
      if (!diode.supportsNoise) {
        throw new InvalidCircuitError('Self-heating diode noise is not implemented');
      }
      const operatingPoint = diode.noiseOperatingPoint(dcSolution, options.deviceGmin);
      const current = Math.abs(operatingPoint.current);
      const sources: Array<{
        nodes: number[];
        powerDensity: (frequency: number) => number;
      }> = [{
        nodes: diode.nodes,
        powerDensity: () => 2 * ELEMENTARY_CHARGE * current,
      }];
      if (operatingPoint.flickerCoefficient > 0) {
        const multiplier = operatingPoint.parallelMultiplier;
        sources.push({
          nodes: diode.nodes,
          powerDensity: (frequency: number) => operatingPoint.flickerCoefficient
            * Math.pow(Math.max(current / multiplier, Number.MIN_VALUE), operatingPoint.flickerExponent)
            * multiplier / frequency,
        });
      }
      return sources;
    });
  // ngspice swnoise.c / cswnoise.c: thermal noise of the small-signal
  // switch conductance (the MODEINITSMSIG state, see SwitchBase).
  const switchSources = devices
    .filter((device): device is SwitchBase => device instanceof SwitchBase)
    .map(sw => ({
      positive: sw.nodes[0],
      negative: sw.nodes[1],
      currentPowerDensity: (_frequency: number) =>
        4 * BOLTZMANN_CONSTANT * DEFAULT_TEMPERATURE_KELVIN * sw.smallSignalConductance,
    }));
  const vbicSources = devices
    .filter((device): device is VBIC => device instanceof VBIC)
    .flatMap(device => device.noiseOperatingPoint(dcSolution, options.deviceGmin,
      devices.find(part => part instanceof Resistor && part.name === `${device.name}.RE`)?.nodes[0],
    ).flatMap(source => [{
      excludeFromSpectrum: source.excludeFromSpectrum,
      positive: source.positive,
      negative: source.negative,
      currentPowerDensity: (_frequency: number) => 4 * BOLTZMANN_CONSTANT
        * (device.getTemperature() + CELSIUS_TO_KELVIN) * source.conductance
        + 2 * ELEMENTARY_CHARGE * source.shotCurrent,
    }, {
      excludeFromSpectrum: source.excludeFromSpectrum,
      positive: source.positive,
      negative: source.negative,
      currentPowerDensity: (frequency: number) =>
        source.flickerCoefficient / Math.pow(frequency, device.params.BFN),
    }]));
  const vdmosSources = devices
    .filter((device): device is VDMOS => device instanceof VDMOS)
    .flatMap(device => {
      const op = device.noiseOperatingPoint(dcSolution);
      const [d, , s, dp, , sp] = device.nodes;
      const thermalPower = 4 * BOLTZMANN_CONSTANT * op.temperatureKelvin;
      // vdmosnoi.c assumes TOX=1e-7; no W/L or extra M normalization.
      // The channel current already includes the parallel multiplier.
      const cox = 3.9 * 8.854214871e-12 / 1e-7;
      return [
        { positive: dp, negative: d,
          currentPowerDensity: (_frequency: number) => thermalPower * op.drainConductance },
        { positive: sp, negative: s,
          currentPowerDensity: (_frequency: number) => thermalPower * op.sourceConductance },
        { positive: dp, negative: sp,
          currentPowerDensity: (_frequency: number) => thermalPower * (2 / 3) * Math.abs(op.gm) },
        { positive: dp, negative: sp,
          currentPowerDensity: (frequency: number) => op.kf
            * Math.exp(op.af * Math.log(Math.max(Math.abs(op.id), 1e-38))) / (frequency * cox * cox) },
      ];
    });
  const noiseSources = [...resistorSources, ...switchSources, ...mosfetSources, ...classicMosSources, ...vdmosSources, ...bjtSources, ...vbicSources, ...devices.flatMap(otaNoiseSources), ...devices.flatMap(gainNoiseSources)];

  const frequencies = frequencyGrid(analysis, options.reltol, 'noise');
  const hasIntegratedTotals = analysis.stopFreq > analysis.startFreq;
  const outputNoiseDensity: number[] = [];
  const inputNoiseDensity: number[] = [];
  const gainSquaredInverse: number[] = [];
  const sourceOutputPowerDensity = noiseSources.map(() => [] as number[]);
  const diodeOutputPowerDensity = diodeSources.map(() => [] as number[]);

  for (const frequency of frequencies) {
    solver.factorize(gCsc, cCsc, 2 * Math.PI * frequency);
    const [gainReal, gainImaginary] = solver.solve(gainRhs, zeroImaginary);
    const gain = differentialMagnitude(
      gainReal, gainImaginary, outputIndex, outputReferenceIndex,
    );
    if (!Number.isFinite(gain)) {
      const outputName = analysis.outputReferenceNode === undefined
        ? analysis.outputNode
        : `${analysis.outputNode},${analysis.outputReferenceNode}`;
      throw new InvalidCircuitError(
        `.noise input source '${analysis.inputSource}' has non-finite gain to '${outputName}'`,
      );
    }
    // ngspice-47 noisean.c: GainSqInv = 1 / MAX(|gain|^2, N_MINGAIN).
    gainSquaredInverse.push(1 / Math.max(gain * gain, N_MINGAIN));

    let outputPowerDensity = 0;
    for (let index = 0; index < noiseSources.length; index++) {
      const { positive, negative, currentPowerDensity } = noiseSources[index];
      // ngspice sums noise powers, so a source below 0 K (T_ABS=-273.15 parsed one ulp
      // under absolute zero, #846) adds its tiny negative power instead of a NaN amplitude.
      const powerDensity = currentPowerDensity(frequency);
      const currentDensity = Math.sqrt(Math.abs(powerDensity));
      const rhs = new Float64Array(systemSize);
      if (positive >= 0) rhs[positive] -= currentDensity;
      if (negative >= 0) rhs[negative] += currentDensity;
      const source = noiseSources[index];
      if ('branch' in source && typeof source.branch === 'number') rhs[nodeCount + source.branch] += currentDensity;
      const [real, imaginary] = solver.solve(rhs, zeroImaginary);
      const contribution = Math.sign(powerDensity) * differentialMagnitudeSquared(
        real, imaginary, outputIndex, outputReferenceIndex,
      );
      sourceOutputPowerDensity[index].push(contribution);
      if (!('excludeFromSpectrum' in source && source.excludeFromSpectrum)) {
        outputPowerDensity += contribution;
      }
    }
    for (let index = 0; index < diodeSources.length; index++) {
      const { nodes, powerDensity } = diodeSources[index];
      const rhs = new Float64Array(systemSize);
      const [positive, negative] = nodes;
      const currentDensity = Math.sqrt(powerDensity(frequency));
      if (positive >= 0) rhs[positive] -= currentDensity;
      if (negative >= 0) rhs[negative] += currentDensity;
      const [real, imaginary] = solver.solve(rhs, zeroImaginary);
      const contribution = differentialMagnitudeSquared(
        real, imaginary, outputIndex, outputReferenceIndex,
      );
      diodeOutputPowerDensity[index].push(contribution);
      outputPowerDensity += contribution;
    }

    const outputDensity = Math.sqrt(outputPowerDensity);
    outputNoiseDensity.push(outputDensity);
    inputNoiseDensity.push(outputDensity * Math.sqrt(gainSquaredInverse[gainSquaredInverse.length - 1]));
  }

  const integratedOutputNoise = hasIntegratedTotals
    ? Math.sqrt(sumIntegratedOutputPower(
      frequencies,
      [...sourceOutputPowerDensity, ...diodeOutputPowerDensity],
    ))
    : undefined;
  const integratedInputNoise = hasIntegratedTotals
    ? Math.sqrt(sumIntegratedInputPower(
      frequencies,
      [...sourceOutputPowerDensity, ...diodeOutputPowerDensity],
      gainSquaredInverse,
    ))
    : undefined;

  return new NoiseResult(
    frequencies,
    analysis.outputNode,
    analysis.inputSource,
    outputNoiseDensity,
    inputNoiseDensity,
    integratedOutputNoise,
    integratedInputNoise,
    analysis.outputReferenceNode,
  );
}

function isSemiconductorNoiseDevice(device: CompiledCircuit['devices'][number]): boolean {
  return device instanceof Diode
    || device instanceof VDMOS
    || device instanceof VBIC
    || device instanceof BJT
    || device instanceof JFET
    || device instanceof MOSFET
    || device instanceof MOS2
    || device instanceof MOS3
    || device instanceof BSIM3v3;
}

function findNodeIndex(compiled: CompiledCircuit, name: string): number {
  for (const [nodeName, index] of compiled.nodeIndexMap) {
    if (nodeName.toLowerCase() === name.toLowerCase()) return index;
  }
  // ngspice-47 inp2dot.c:53-64 inserts output terminals even if no element
  // references them. Such a terminal has no matrix entries or excitation and
  // its noise/AC solution is zero. Keep it out of our compact MNA system and
  // read zero, just as for ground, rather than adding a singular unknown.
  return -1;
}

function differentialMagnitude(
  real: Float64Array,
  imaginary: Float64Array,
  positive: number,
  negative: number,
): number {
  return Math.sqrt(differentialMagnitudeSquared(real, imaginary, positive, negative));
}

function differentialMagnitudeSquared(
  real: Float64Array,
  imaginary: Float64Array,
  positive: number,
  negative: number,
): number {
  const realDifference = (positive < 0 ? 0 : real[positive]) - (negative < 0 ? 0 : real[negative]);
  const imaginaryDifference = (positive < 0 ? 0 : imaginary[positive])
    - (negative < 0 ? 0 : imaginary[negative]);
  return realDifference * realDifference + imaginaryDifference * imaginaryDifference;
}

function sumIntegratedOutputPower(frequencies: number[], sources: number[][]): number {
  return sources.reduce((total, powerDensity) => {
    for (let index = 1; index < frequencies.length; index++) {
      total += integratePowerLawInterval(
        frequencies[index - 1],
        frequencies[index],
        powerDensity[index],
        Math.log(Math.max(powerDensity[index - 1], 1e-38)),
        Math.log(Math.max(powerDensity[index], 1e-38)),
      );
    }
    return total;
  }, 0);
}

function sumIntegratedInputPower(
  frequencies: number[],
  sources: number[][],
  gainSquaredInverse: number[],
): number {
  return sources.reduce((total, outputPowerDensity) => {
    for (let index = 1; index < frequencies.length; index++) {
      // ngspice refers each source contribution to the input with the gain at
      // the current point before applying its log-log interval integration.
      const logGainInverse = Math.log(gainSquaredInverse[index]);
      total += integratePowerLawInterval(
        frequencies[index - 1],
        frequencies[index],
        outputPowerDensity[index] * gainSquaredInverse[index],
        Math.log(Math.max(outputPowerDensity[index - 1], 1e-38)) + logGainInverse,
        Math.log(Math.max(outputPowerDensity[index], 1e-38)) + logGainInverse,
      );
    }
    return total;
  }, 0);
}

function integratePowerLawInterval(
  previousFrequency: number,
  frequency: number,
  powerDensity: number,
  previousLogPowerDensity: number,
  logPowerDensity: number,
): number {
  const logFrequency = Math.log(frequency);
  const previousLogFrequency = Math.log(previousFrequency);
  let exponent = (logPowerDensity - previousLogPowerDensity)
    / (logFrequency - previousLogFrequency);
  if (Math.abs(exponent) < 1e-10) {
    return powerDensity * (frequency - previousFrequency);
  }

  const coefficient = Math.exp(logPowerDensity - exponent * logFrequency);
  exponent += 1;
  if (Math.abs(exponent) < 1e-10) {
    return coefficient * (logFrequency - previousLogFrequency);
  }
  return coefficient * (
    Math.exp(exponent * logFrequency) - Math.exp(exponent * previousLogFrequency)
  ) / exponent;
}
