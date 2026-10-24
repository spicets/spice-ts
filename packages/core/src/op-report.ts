import { parseTitlelessAsync } from './parser/index.js';
import type { Circuit } from './circuit.js';
import { solveDCOperatingPoint } from './analysis/dc.js';
import { resolveOptions, withNetlistOptions } from './types.js';
import { InvalidCircuitError } from './errors.js';
import { deviceOutputVector } from './control-device-output.js';
import type { SimulationOptions } from './types.js';
import type { StampContext } from './devices/device.js';

export interface OperatingPointDevice {
  name: string;
  /** Amps entering each terminal, keyed by node name (repeated nodes are combined). */
  terminalCurrents: Record<string, number>;
  /** Watts absorbed, using the passive sign convention. */
  powerW: number;
}
export interface OperatingPointReport {
  nodeVoltages: Record<string, number>;
  devices: OperatingPointDevice[];
  sourceDeliveredPowerW: number;
  dissipatedPowerW: number;
}

/** Read the existing DC model loads at the converged OP; no second solve or model equations. */
export async function operatingPointReport(input: string | Circuit, options?: SimulationOptions): Promise<OperatingPointReport> {
  const circuit = typeof input === 'string' ? await parseTitlelessAsync(input) : input;
  const compiled = circuit.compile();
  if (compiled.steps.length) throw new InvalidCircuitError('OP report requires an unstepped circuit');
  const resolved = resolveOptions(withNetlistOptions(compiled.simulationOptions, options));
  const { assembler, result } = solveDCOperatingPoint(compiled, resolved);
  const { solution } = assembler;
  const { nodeCount, nodeNames } = compiled;
  const state = { devices: compiled.devices, solution, nodeCount, deviceGmin: resolved.deviceGmin };
  const voltage = (node: number): number => node < 0 ? 0 : solution[node];
  const devices = compiled.devices.map(device => {
    const currents = new Map<number, number>(device.nodes.map(node => [node, 0]));
    const add = (node: number, value: number): void => {
      if (node >= 0 && node < nodeCount) currents.set(node, (currents.get(node) ?? 0) + value);
    };
    const deviceState = { ...state, devices: [device] };
    const saved = ['i', 'id', 'current'].map(parameter => deviceOutputVector(deviceState, device.name, parameter)).find(value => value !== undefined);
    if (saved && device.nodes.length === 2) {
      currents.set(device.nodes[0], (currents.get(device.nodes[0]) ?? 0) + saved[0]);
      currents.set(device.nodes[1], (currents.get(device.nodes[1]) ?? 0) - saved[0]);
    } else {
      // A DC model's terminal load is G*x-b. Branch-equation rows constrain
      // voltages, not terminal currents, and are deliberately excluded.
      const ctx: StampContext = {
        stampG: (row, col, value) => add(row, value * solution[col]),
        stampB: (row, value) => add(row, -value),
        stampC: () => {}, getVoltage: voltage,
        getCurrent: branch => solution[nodeCount + branch],
        time: 0, dt: 0, numNodes: nodeCount, sourceScale: 1,
        useDcSourceValue: true, gmin: resolved.deviceGmin,
      };
      device.stamp(ctx);
      // Ground has no matrix row. Recover its current by device KCL.
      currents.set(-1, -[...currents.entries()].reduce((sum, [node, current]) => sum + (node < 0 ? 0 : current), 0));
    }
    const terminalCurrents = Object.fromEntries([...currents].map(([node, current]) => [node < 0 ? '0' : nodeNames[node], current]));
    const powerW = [...currents].reduce((sum, [node, current]) => sum + voltage(node) * current, 0);
    if (!Number.isFinite(powerW) || Object.values(terminalCurrents).some(current => !Number.isFinite(current))) {
      throw new InvalidCircuitError(`Non-finite OP current for '${device.name}'`);
    }
    return { name: device.name, terminalCurrents, powerW };
  });
  return {
    nodeVoltages: Object.fromEntries(result.voltages), devices,
    sourceDeliveredPowerW: devices.reduce((sum, device) => sum + Math.max(0, -device.powerW), 0),
    dissipatedPowerW: devices.reduce((sum, device) => sum + Math.max(0, device.powerW), 0),
  };
}
