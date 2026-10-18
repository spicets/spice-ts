// Run: spice-heavy pnpm exec tsx benchmarks/gear3-enable/trajectory-diff.ts
// Requires python3 and a matching ngspice-47 shared library (NGSPICE_LIBRARY).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTransientSim, type TransientRejection } from '../../packages/core/src/analysis/transient-driver.js';
import type { ChargeIntegration, ChargeTruncation, DeviceModel } from '../../packages/core/src/devices/device.js';
import { VoltageSwitch } from '../../packages/core/src/devices/switch.js';
import { parseNgspiceRaw } from '../comparison-harness.js';

interface NativeTrial { time: number; delta: number; nextDelta: number; rejected: boolean }
interface Bound { device: string; bound: number }
interface Check { time: number; delta: number; order: number; bound: number; limitingDevice: string | null }
// Benchmark-only inspection seam. No solver setting, timestep or return value is changed.
interface Inspection {
  compiled: { devices: DeviceModel[] };
  prevDt: number;
  justCrossedBreakpoint: boolean;
  chargeTruncationTimestep(dt: number, integration: ChargeIntegration, order?: 2): number;
  reactiveTruncation: {
    capacitors: DeviceModel[];
    state: { chargeTruncation(index: number, charge: number, truncation: ChargeTruncation): number };
  };
}
const relative = (a: number, b: number) => a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
const tolerance = 1e-12;
const sourceCommit = 'a80f6e3e95d51534905b1f23410a951802666656';

async function main() {
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gear3-trajectory-'));
  const deck = resolve('benchmarks/corpus/corpus-f/fixtures/examples/p-to-n-examples/switch-oscillators.cir');
  const source = readFileSync(deck, 'utf8');
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== 'dc3029fbeeb8f83b79c1e73d013c556229424e9b95a91f8be975b9d16f0dd65d') throw new Error('Deck changed');
  writeFileSync(join(work, '.spiceinit'), 'set filetype=ascii\nunset interp\n');
  const env = { ...process.env, HOME: work };
  const raw = join(work, 'native.raw');
  const native = spawnSync('ngspice', ['-b', '-r', raw, deck], { env, encoding: 'utf8', timeout: 120_000 });
  writeFileSync(join(work, 'native.log'), native.stdout + native.stderr);
  if (native.status !== 0) throw new Error(`ngspice exited ${native.status}; see ${work}`);
  const plot = parseNgspiceRaw(readFileSync(raw, 'utf8')).find(p => /transient/i.test(p.plotName));
  if (!plot) throw new Error('Missing transient plot');
  const library = process.env.NGSPICE_LIBRARY ?? (process.platform === 'darwin' ? '/opt/homebrew/lib/libngspice.dylib' : 'libngspice.so');
  const observed = JSON.parse(execFileSync('python3', [resolve('benchmarks/gear3-enable/native-trajectory.py'), library, deck],
    { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })) as { trials: NativeTrial[] };
  const accepted = observed.trials.filter(p => !p.rejected);
  // TSTART=50 ps suppresses earlier output; sync observes those accepted steps too.
  // Prove the shared-library observer follows the executable, not a different grid.
  const visible = accepted.filter(p => p.time >= 50e-12);
  const nativeBuildSplit = visible.findIndex((p, i) => i >= plot.grid.length || relative(p.time, plot.grid[i]) > tolerance);
  const rejections: TransientRejection[] = [];
  const checks: Check[] = [];
  const steps = [];
  let bounds: Bound[] = [];
  const sim = await createTransientSim(source, { onReject: rejection => rejections.push(rejection) });
  const debug = sim as unknown as Inspection;
  const state = debug.reactiveTruncation.state;
  const originalCharge = state.chargeTruncation.bind(state);
  state.chargeTruncation = (index, charge, truncation) => {
    const bound = originalCharge(index, charge, truncation);
    bounds.push({ device: debug.reactiveTruncation.capacitors[index].name, bound });
    return bound;
  };
  for (const device of debug.compiled.devices) {
    if (!device.truncateTransientStep) continue;
    const original = device.truncateTransientStep.bind(device);
    device.truncateTransientStep = (ctx, truncation) => {
      const bound = original(ctx, truncation);
      bounds.push({ device: device.name, bound });
      return bound;
    };
  }
  const originalTruncation = debug.chargeTruncationTimestep.bind(debug);
  debug.chargeTruncationTimestep = (delta, integration, order) => {
    bounds = [];
    const bound = originalTruncation(delta, integration, order);
    const limiter = bounds.reduce<Bound | undefined>((a, b) => !a || b.bound < a.bound ? b : a, undefined);
    checks.push({ time: sim.simTime + delta, delta, order: order ?? integration.order ?? (integration.method === 'euler' ? 1 : 2),
      bound, limitingDevice: limiter && Number.isFinite(limiter.bound) ? limiter.device : null });
    return bound;
  };
  let firstNode: unknown = null;
  let firstGrid: unknown = null;
  try {
    for (let i = 0; i < accepted.length; i++) {
      const rejectStart = rejections.length;
      const checkStart = checks.length;
      const point = sim.advance();
      const switches = debug.compiled.devices.filter((d): d is VoltageSwitch => d instanceof VoltageSwitch)
        .map(d => ({ name: d.name, state: d.currentState, conductance: d.conductance }));
      steps.push({ index: i + 1, time: point.time, delta: debug.prevDt, breakpointHit: debug.justCrossedBreakpoint,
        checks: checks.slice(checkStart), rejections: rejections.slice(rejectStart), switches,
        voltages: Object.fromEntries(point.voltages) });
      const gridError = relative(point.time, accepted[i].time);
      if (gridError > tolerance) {
        firstGrid = { index: i + 1, native: accepted[i], ts: steps.at(-1), relativeTimeError: gridError };
        break;
      }
      const row = plot.grid.findIndex(t => relative(t, point.time) <= tolerance);
      if (row >= 0 && firstNode === null) {
        for (const [name, value] of point.voltages) {
          const reference = plot.signals[`v(${name.toLowerCase()})`]?.[row]?.re;
          if (reference !== undefined && relative(value, reference) > tolerance) {
            firstNode = { index: i + 1, time: point.time, node: name, native: reference, ts: value,
              absoluteError: Math.abs(value - reference), relativeError: relative(value, reference) };
            break;
          }
        }
      }
    }
  } finally { sim.dispose(); }
  const comparedVisibleSteps = steps.filter(p => p.time >= 50e-12).length;
  if (nativeBuildSplit >= 0 && nativeBuildSplit < comparedVisibleSteps) {
    throw new Error('Native builds differ before TS divergence; use matching ngspice builds');
  }
  const report = { sha256, sourceCommit, tolerance, nativeVersion: execFileSync('ngspice', ['--version'], { encoding: 'utf8' }).trim(),
    nativeRows: plot.grid.length, nativeObserverAcceptedSteps: accepted.length, preTstartAcceptedSteps: accepted.length - visible.length,
    nativeBuildFirstDifferentOutputRow: nativeBuildSplit < 0 ? null : nativeBuildSplit,
    output: 'No interpolation. dctran.c:415-418 dumps accepted points at/after TSTART; sharedsync location=1 observes earlier accepts.',
    firstObservableNodeDivergence: firstNode, firstGridDivergence: firstGrid,
    classification: 'LTE/CKTtrunc acceptance split; not output interpolation. Device/charge cause requires further isolation.',
    citations: [`${sourceCommit}/src/spicelib/analysis/dctran.c:793-835`, `${sourceCommit}/src/spicelib/analysis/dctran.c:951-968`,
      `${sourceCommit}/src/sharedspice.c:2471-2486`, `${sourceCommit}/src/spicelib/devices/sw/swtrunc.c:23-44`],
    limitation: 'Native pre-TSTART node values, integration orders and limiting devices are not exposed by sharedsync. Strict relative node differences can be sub-femtovolt roundoff, not a physical state split.', work };
  writeFileSync(join(work, 'native-trials.json'), JSON.stringify(observed, null, 2));
  writeFileSync(join(work, 'ts-steps.json'), JSON.stringify(steps, null, 2));
  writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
