import { MNAAssembler } from './assembler.js';
import type { ChargeIntegration, DeviceModel } from '../devices/device.js';
import type { IntegrationMethod } from '../types.js';
import { MOSFET } from '../devices/mosfet.js';
import { stampDynamicDevices, stampStaticDevices } from './linear-stamp.js';

interface DevicePlan {
  readonly devices: readonly DeviceModel[];
  readonly length: number;
  /** Level-1 MOSFETs stamped by {@link MOSFET.batchStamp}. */
  readonly mosfets: MOSFET[];
  /** Every other device, in netlist order, stamped through the context. */
  readonly others: DeviceModel[];
  /** Devices whose C(v) companion comes from `stampDynamic`, in netlist order. */
  readonly dynamic: DeviceModel[];
  /** Devices that stamp their own integrated charge companion, in netlist order. */
  readonly charged: DeviceModel[];
}

interface CompanionWorkspace {
  readonly isDynamic: Uint8Array;
  /** Gear-2 C-history or trapezoidal G*x(n) accumulator. */
  readonly history: Float64Array;
}

const devicePlans = new WeakMap<readonly DeviceModel[], DevicePlan>();
const workspaces = new WeakMap<MNAAssembler, CompanionWorkspace>();
// Like StampContext, this is synchronous stamp-call scratch, not a history snapshot.
// Separate from vector workspaces so Euler does not allocate unused history arrays.
const chargeIntegrations = new WeakMap<MNAAssembler, {
  -readonly [K in keyof ChargeIntegration]: ChargeIntegration[K];
}>();

/** MOSFET/other split of a device list, computed once per list. */
function devicePlan(devices: readonly DeviceModel[]): DevicePlan {
  let plan = devicePlans.get(devices);
  if (plan === undefined || plan.length !== devices.length) {
    const mosfets: MOSFET[] = [];
    const others: DeviceModel[] = [];
    const dynamic: DeviceModel[] = [];
    const charged: DeviceModel[] = [];
    for (const d of devices) {
      if (d instanceof MOSFET) mosfets.push(d);
      else others.push(d);
      // Both flags are fixed at construction, so the split is per list.
      // storesCharge === false: stampDynamic stamps nothing for this instance.
      if (d.integratesTransientCharge) {
        if (d.stampTransientCharge !== undefined) charged.push(d);
      } else if (d.storesCharge !== false && d.stampDynamic !== undefined) {
        dynamic.push(d);
      }
    }
    plan = { devices, length: devices.length, mosfets, others, dynamic, charged };
    devicePlans.set(devices, plan);
  }
  return plan;
}

/** Per-assembler scratch vectors reused across Newton iterations and steps. */
function companionWorkspace(assembler: MNAAssembler): CompanionWorkspace {
  let work = workspaces.get(assembler);
  if (work === undefined) {
    work = {
      isDynamic: new Uint8Array(assembler.systemSize),
      history: new Float64Array(assembler.systemSize),
    };
    workspaces.set(assembler, work);
  }
  return work;
}

/**
 * Build the effective conductance matrix for transient analysis.
 *
 * Backward Euler: (G + C/dt) * x(n+1) = b(n+1) + (C/dt) * x(n)
 * Trapezoidal:    (G + 2C/dt) * x(n+1) = b(n+1) + (2C/dt)*x(n) - i_static(n)
 * Gear-2 (BDF2):  (G + a1*C) * x(n+1) = b(n+1) + a2*C*x(n) - a3*C*x(n-1)  (dynamic rows)
 *
 * For BDF2 with variable timestep, let α = dt(n-1) / dt(n). Then dx/dt at t(n+1)
 * is approximated by the Lagrange-interpolated polynomial through
 * (t(n-1), x(n-1)), (t(n), x(n)), (t(n+1), x(n+1)):
 *   a1 = (2 + α)     / ((1 + α) * dt(n))        // coef of x(n+1) in dx/dt
 *   a2 = (1 + α)     /  (α * dt(n))             // coef of x(n) (moved to RHS)
 *   a3 = 1           / (α * (1 + α) * dt(n))    // coef of x(n-1)
 * At α = 1 (constant step): a1 = 3/(2dt), a2 = 2/dt, a3 = 1/(2dt) — standard BDF2.
 * On the first step (no x(n-1)), BDF2 bootstraps with Backward Euler.
 *
 * IMPORTANT: For trap and gear2, history terms (b(n) for trap, C*x history
 * for gear2) apply only to DYNAMIC rows (rows with non-zero C entries).
 * Algebraic rows (C=0) are solved as G*x(n+1) = b(n+1) without history
 * coupling. This prevents NR oscillation on nonlinear algebraic equations
 * (e.g., diode KCL at nodes without capacitors).
 */
export function buildCompanionSystem(
  assembler: MNAAssembler,
  devices: DeviceModel[],
  dt: number,
  method: IntegrationMethod,
  prevSolution: Float64Array,
  prevB?: Float64Array,
  gmin = 1e-12,
  prevPrevSolution?: Float64Array,
  prevDt?: number,
  staticCurrentHistory = false,
  xmu = 0.5,
): void {
  // Clear and re-stamp at current time
  assembler.clear();
  const ctx = assembler.getStampContext();
  const plan = devicePlan(devices);

  if (assembler.isFastPath && assembler.topologyNnz > 0) {
    // Batch-stamp MOSFETs with direct array writes, fall back for others
    stampStaticDevices(assembler, plan.others, ctx);
    if (plan.mosfets.length > 0) {
      MOSFET.batchStamp(
        plan.mosfets, assembler.gValues, assembler.b, assembler.solution,
        assembler.stampIndex,
      );
    }
  } else {
    for (const device of devices) {
      device.stamp(ctx);
    }
  }

  stampDynamicDevices(assembler, plan.dynamic, ctx);

  // Gear-2 bootstraps with BE when x(n-1) is unavailable.
  // Trapezoidal bootstraps with BE when b(n) is unavailable — this is how
  // the driver resets history after crossing a breakpoint.
  const useGear2 = method === 'gear2' && prevPrevSolution !== undefined && prevDt !== undefined;
  const useTrap = method === 'trapezoidal' && prevB !== undefined;
  // ngspice-47 nicomcof.c:43-44: a0=1/dt/(1-xmu), a1=xmu/(1-xmu).
  const trapFactor = xmu === 0.5 ? 2 / dt : 1 / dt / (1 - xmu);
  const trapWeight = xmu / (1 - xmu);
  const effectiveMethod: IntegrationMethod =
    (method === 'gear2' && !useGear2) || (method === 'trapezoidal' && !useTrap)
      ? 'euler'
      : method;

  if (assembler.isFastPath) {
    // ---- Fast path: typed-array CSC arithmetic ----
    // b already holds b(n+1); the history terms below are added in place.
    const gv = assembler.gValues;
    const cv = assembler.cValues;
    const colPtr = assembler.colPtr;
    const rowIdx = assembler.rowIdx;
    const diag = assembler.diagIdx;
    const n = assembler.systemSize;
    const b = assembler.b;

    // Add GMIN to all node diagonals for numerical stability
    for (let i = 0; i < assembler.numNodes; i++) {
      gv[diag[i]] += gmin;
    }

    // Each method makes one column-major pass over the non-zeros (issue
    // #710). The passes it replaces (dynamic-row mask, G*x(n), G + kC,
    // kC*x(n)) each read or write a slot, or accumulate into a row, in the
    // same column-major order, so every accumulator sees the same additions
    // in the same order and the system is bit-identical. G*x(n) reads each
    // slot before the same iteration adds kC to it, as the separate pass did
    // before the G + kC pass.
    if (effectiveMethod === 'euler') {
      // BE: G_eff = G + C/dt, b_eff = b(n+1) + (C/dt)*x(n)
      const factor = 1 / dt;
      for (let j = 0; j < n; j++) {
        const xj = prevSolution[j];
        const end = colPtr[j + 1];
        if (xj === 0) {
          for (let p = colPtr[j]; p < end; p++) gv[p] += factor * cv[p];
          continue;
        }
        for (let p = colPtr[j]; p < end; p++) {
          const cp = cv[p];
          gv[p] += factor * cp;
          b[rowIdx[p]] += factor * cp * xj;
        }
      }
    } else if (effectiveMethod === 'gear2') {
      // Gear-2 (BDF2) with variable timestep. α = prevDt / dt.
      const alpha = prevDt! / dt;
      const a1 = (2 + alpha) / ((1 + alpha) * dt);
      const a2 = (1 + alpha) / (alpha * dt);
      const a3 = 1 / (alpha * (1 + alpha) * dt);
      const work = companionWorkspace(assembler);

      // Dynamic-row mask (C has at least one non-zero entry in that row),
      // G_eff = G + a1 * C, and the history a2 * C * x(n) - a3 * C * x(n-1).
      const isDynamic = work.isDynamic.fill(0);
      const histDyn = work.history.fill(0);
      const xNm1 = prevPrevSolution!;
      for (let j = 0; j < n; j++) {
        const xj = prevSolution[j];
        const xjm1 = xNm1[j];
        const end = colPtr[j + 1];
        if (xj === 0 && xjm1 === 0) {
          for (let p = colPtr[j]; p < end; p++) {
            const cp = cv[p];
            if (cp !== 0) isDynamic[rowIdx[p]] = 1;
            gv[p] += a1 * cp;
          }
          continue;
        }
        for (let p = colPtr[j]; p < end; p++) {
          const cp = cv[p];
          gv[p] += a1 * cp;
          if (cp === 0) continue;
          const row = rowIdx[p];
          isDynamic[row] = 1;
          histDyn[row] += a2 * cp * xj - a3 * cp * xjm1;
        }
      }

      // Dynamic rows take the BDF2 RHS; algebraic rows keep b(n+1).
      for (let i = 0; i < n; i++) {
        if (isDynamic[i]) b[i] += histDyn[i];
      }
    } else {
      // Trapezoidal: G_eff = G + 2C/dt
      // b_eff depends on whether a row is dynamic (C≠0) or algebraic (C=0):
      //   Dynamic: b(n+1) + (2C/dt)*x(n) - i_static(n)
      //   Algebraic: b(n+1) only
      const factor = trapFactor;
      const work = companionWorkspace(assembler);

      // Dynamic-row mask, G*x(n) (unless the history already holds the
      // static current), G_eff = G + 2C/dt and b += (2C/dt)*x(n).
      const isDynamic = work.isDynamic.fill(0);
      const Gx = work.history;
      if (!staticCurrentHistory) Gx.fill(0);
      for (let j = 0; j < n; j++) {
        const xj = prevSolution[j];
        const end = colPtr[j + 1];
        if (xj === 0) {
          for (let p = colPtr[j]; p < end; p++) {
            const cp = cv[p];
            if (cp !== 0) isDynamic[rowIdx[p]] = 1;
            gv[p] += factor * cp;
          }
          continue;
        }
        if (staticCurrentHistory) {
          for (let p = colPtr[j]; p < end; p++) {
            const cp = cv[p];
            const row = rowIdx[p];
            if (cp !== 0) isDynamic[row] = 1;
            gv[p] += factor * cp;
            b[row] += factor * cp * xj;
          }
          continue;
        }
        for (let p = colPtr[j]; p < end; p++) {
          const cp = cv[p];
          const row = rowIdx[p];
          if (cp !== 0) isDynamic[row] = 1;
          Gx[row] += gv[p] * xj;
          gv[p] += factor * cp;
          b[row] += factor * cp * xj;
        }
      }

      // Subtract the accepted static-device current from the history point.
      for (let i = 0; i < n; i++) {
        if (isDynamic[i]) {
          if (staticCurrentHistory) b[i] -= trapWeight * prevB![i];
          else {
            b[i] -= trapWeight * Gx[i];
            b[i] += trapWeight * prevB![i];
          }
        }
      }
    }
  } else {
    // ---- Slow path: Map-of-Maps sparse operations ----

    // Add GMIN to all node diagonals for numerical stability
    for (let i = 0; i < assembler.numNodes; i++) {
      assembler.G.add(i, i, gmin);
    }

    if (effectiveMethod === 'euler') {
      // BE: G_eff = G + C/dt, b_eff = b(n+1) + (C/dt)*x(n)
      const factor = 1 / dt;
      assembler.G.addMatrix(assembler.C, factor);

      for (let i = 0; i < assembler.systemSize; i++) {
        const row = assembler.C.getRow(i);
        for (const [j, cval] of row) {
          assembler.b[i] += factor * cval * prevSolution[j];
        }
      }
    } else if (effectiveMethod === 'gear2') {
      // Gear-2 (BDF2) with variable timestep — slow-path sparse operations.
      const alpha = prevDt! / dt;
      const a1 = (2 + alpha) / ((1 + alpha) * dt);
      const a2 = (1 + alpha) / (alpha * dt);
      const a3 = 1 / (alpha * (1 + alpha) * dt);

      const bCurrent = new Float64Array(assembler.b);
      assembler.G.addMatrix(assembler.C, a1);

      assembler.b.fill(0);
      const xNm1 = prevPrevSolution!;
      for (let i = 0; i < assembler.systemSize; i++) {
        assembler.b[i] = bCurrent[i];
        const cRow = assembler.C.getRow(i);
        if (cRow.size === 0) continue; // algebraic row — leave as b(n+1)
        for (const [j, cval] of cRow) {
          assembler.b[i] += a2 * cval * prevSolution[j] - a3 * cval * xNm1[j];
        }
      }
    } else {
      // Trapezoidal: G_eff = G + 2C/dt
      // History terms only for dynamic rows (C≠0)
      const factor = trapFactor;

      // Save b(n+1) before modification
      const bCurrent = new Float64Array(assembler.b);
      const Gx = new Float64Array(assembler.systemSize);
      if (!staticCurrentHistory) {
        for (let i = 0; i < assembler.systemSize; i++) {
          for (const [j, gval] of assembler.G.getRow(i)) Gx[i] += gval * prevSolution[j];
        }
      }

      // Modify G: G_eff = G + 2C/dt
      assembler.G.addMatrix(assembler.C, factor);

      // Build b_eff
      assembler.b.fill(0);
      for (let i = 0; i < assembler.systemSize; i++) {
        assembler.b[i] = bCurrent[i]; // b(n+1)

        const cRow = assembler.C.getRow(i);
        const hasDynamic = cRow.size > 0;

        // Add (2C/dt)*x(n) for dynamic rows
        for (const [j, cval] of cRow) {
          assembler.b[i] += factor * cval * prevSolution[j];
        }

        // Subtract the accepted static-device current from the history point.
        if (hasDynamic) {
          if (staticCurrentHistory) assembler.b[i] -= trapWeight * prevB![i];
          else {
            assembler.b[i] -= trapWeight * Gx[i];
            assembler.b[i] += trapWeight * prevB![i];
          }
        }
      }
    }
  }

  // Charge-integrating devices (ngspice NIintegrate) stamp their complete
  // companion into G and b. They are added after the C-matrix history so they
  // neither mark rows dynamic nor enter the G*x(n) history product.
  if (plan.charged.length === 0) return;
  let integration = chargeIntegrations.get(assembler);
  if (integration === undefined) {
    integration = { method: effectiveMethod, xmu, dt, prevDt: undefined };
    chargeIntegrations.set(assembler, integration);
  }
  integration.method = effectiveMethod;
  integration.xmu = xmu;
  integration.dt = dt;
  integration.prevDt = useGear2 ? prevDt : undefined;
  for (const device of plan.charged) device.stampTransientCharge!(ctx, integration);
}
