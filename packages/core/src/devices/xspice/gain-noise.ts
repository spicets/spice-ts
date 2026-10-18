import type { DeviceModel } from '../device.js';
import { real, type ResolvedXspiceParams } from './models.js';
import type { XspiceInputPort, XspiceOutputPort } from './xspice-device.js';

/** An independent current source, or a voltage source in an output branch equation. */
interface GainNoiseSource {
  readonly positive: number;
  readonly negative: number;
  readonly branch?: number;
  readonly currentPowerDensity: (frequency: number) => number;
}

const sources = new WeakMap<DeviceModel, readonly GainNoiseSource[]>();

/**
 * ngspice-47 src/xspice/mif/mifnoise.c:262-321,340-364,383-411:
 * noise_voltage acts at the output branch, noise_current across the input.
 * Integrate the independent white/flicker powers separately, as ngspice does.
 * gain/cfunc.mod only defines the noiseless transfer, not this noise law.
 */
export function registerGainNoise(
  device: DeviceModel, params: ResolvedXspiceParams,
  input: XspiceInputPort, output: XspiceOutputPort,
): void {
  const corner = real(params, 'noise_corner');
  const exponent = real(params, 'noise_exponent');
  const pair = (amplitude: number, positive: number, negative: number, branch?: number): GainNoiseSource[] => {
    if (amplitude === 0) return [];
    const power = amplitude * amplitude;
    return [
      { positive, negative, branch, currentPowerDensity: () => power },
      { positive, negative, branch, currentPowerDensity: frequency =>
        corner > 0 && frequency > 0 ? power * (corner / frequency) ** exponent : 0 },
    ];
  };
  sources.set(device, [
    ...(output.kind === 'voltage' ? pair(real(params, 'noise_voltage'), -1, -1, output.branch) : []),
    ...pair(real(params, 'noise_current'), input.positive, input.negative),
  ]);
}

export function gainNoiseSources(device: DeviceModel): readonly GainNoiseSource[] {
  return sources.get(device) ?? [];
}
