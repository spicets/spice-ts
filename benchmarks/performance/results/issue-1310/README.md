# Issue #1310: VBIC DFF performance

Base: 931cd22563e5bfb0d557f638d0af9a063caa4d48. Node v22.23.1, macOS 27.0.1 arm64, Apple M5 Pro, shared host. All full-deck runs used spice-heavy. Wall times exclude queue wait, startup/import and output hashing. Each group runs three simulate calls in one process, without an extra warmup. The baseline process loaded the original build before the optimized build was produced and retained that loaded module for all three runs. Host load was uncontrolled; the baseline spread makes that limitation visible.

## Profile before changes

V8 CPU profile via source imports through tsx. Only for profiling, TRAN 0.25p 10n was shortened to TRAN 0.25p 0.1n, leaving other options and deck contents unchanged. The profile sampled 7058.4 ms. VBIC evaluate accounts for 83.3% inclusive time. The three largest self-time frames are all in VBIC automatic differentiation: map 32.7% self / 35.6% inclusive, add 16.7% / 19.2%, sub 12.1% / 14.3%. Inclusive frames overlap and must not be summed. This, not the solver or OP selection, is the bucket optimized.

Matrix: 122 unknowns, 832 structural nonzeros in the G/C union, inspected at MNAAssembler.lockTopology. The shortened run had 437 accepted steps, 28 rejected steps and 999 transient Newton iterations: 2.2860 iterations per accepted step or 2.1484 per attempted step. DC required 31 iterations with no source/gmin stepping. The full deck consistently has 100724 transient Newton iterations / 43272 accepted steps (2.3277 per accepted step), with 3139 rejected steps.

## Change

Only private VBIC Dual derivative storage and elementwise arithmetic changed. Ordinary JavaScript number arrays replace short Float64Arrays, avoiding their backing-store allocation overhead; indexed loops replace Float64Array.from callbacks. Both store binary64 values. Arithmetic expression order is unchanged, buffers are not shared, and no math approximations were introduced.

No OP/homotopy/initial-state logic, solver policy, timestep, tolerance, corpus fixture or ROADMAP.md changes. A loop-only typed-array candidate was explored but has no completed full-deck timing receipt and is not the shipped implementation. No performance claim is made for that candidate.

## Full unchanged deck: every run

Fixture: benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp. SHA-256: d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. Source/license are already recorded for corpus-f in benchmarks/SOURCES.md.

| Run | Before seconds | After seconds |
| --- | ---: | ---: |
| 1 | 1028.621798 | 72.579638 |
| 2 | 994.508378 | 77.611627 |
| 3 | 726.366138 | 76.027358 |

Median: 994.508378 s -> 76.027358 s. Reduction: 92.3553%, or 13.0809x speedup. The >=25% gate passes. These are shared-host observations, not isolated-machine throughput claims.

All six runs contain 43273 rows with identical convergence telemetry and bit-identical time points, returned node voltages and branch currents. SHA-256 over binary64 little-endian values, in returned order, is fa930f7d1b79d8ce7f05a5de675090f44ff445b143b18a85075f530dd52b19fc in every run. Maximum absolute before/after difference is zero. No tolerance exception is needed.

Remaining losses are explicit: this does not fix the known V(Q) parity loss tracked by #1309. The issue's ngspice-47 reference was 1.3-3.9 s / 40545 rows; optimized spice-ts still takes tens of seconds. No new ngspice timing or superiority claim is made here.

## Reproduction and validation

At each revision, run pnpm install --frozen-lockfile and pnpm -C packages/core build, then:

    spice-heavy node benchmarks/performance/dff-1310.mjs 3

Optional shortened independent timing:

    spice-heavy node benchmarks/performance/dff-1310.mjs 3 0.1n

For readable source profiles, use node --import tsx --cpu-prof with simulate imported from packages/core/src/simulate.ts and the same shortened deck. Summarize with benchmarks/performance/profile-summary.mjs. Profiling preceded simulator edits.

pnpm build and pnpm lint pass. All 217 tests in 14 src/devices/vbic*.test.ts files pass on the final implementation. Exact-head CI is the full-suite gate; no local root test suite was run for this card. Machine-readable timings, counters and output identity are in results.json.

## Round 2: reuse the static load's charge evaluation

Base: 8e148427b2ed15d715bb1c6089d9410a710fa079 (#1326). Same Node version and shared host as above. The previous receipt is preserved, not used as this round's timing baseline. This round's measurements are in round-2.json.

### Profile first

The unchanged harness was CPU-profiled with only its tstop argument set to 0.1n. A second source-readable profile used `node --import tsx --cpu-prof --cpu-prof-interval=100` and the same deck substitution, before simulator edits. The table below uses 501.084 ms of samples whose stack contains simulate. It excludes loader activity and unparented GC; whole-process GC was 5.2%. This is a short cold profile, not a steady-state throughput measurement. Inclusive frames overlap and must not be summed. Anonymous and TextDecoder frames retain V8's labels rather than guessing attribution.

| Top self frame | Self % | Top inclusive frame | Inclusive % |
| --- | ---: | --- | ---: |
| VBIC add | 12.315 | root | 100.000 |
| VBIC constant | 10.852 | simulate | 100.000 |
| VBIC evaluate | 9.430 | solveCompiledAnalyses | 98.146 |
| VBIC anonymous | 7.118 | solveTransient | 94.213 |
| VBIC sub | 6.752 | advanceSolution | 93.373 |
| VBIC diode | 5.838 | VBIC evaluate | 75.528 |
| VBIC scale | 4.848 | attemptStep | 57.801 |
| VBIC depletionCharge | 4.158 | buildCompanionSystem | 54.699 |
| VBIC stamp | 3.750 | stampStaticDevices | 39.390 |
| set TextDecoder (V8 label) | 3.734 | VBIC stamp | 38.101 |

VBIC evaluation/allocation remains dominant, not sparse factorization. The 122-unknown / 832-nnz topology is unchanged. The shortened run has the same 31 DC iterations, 437 accepted steps, 28 LTE rejections, 999 transient Newton iterations and zero NR retries as round 1. No iteration-count or convergence-policy change is attempted.

Static stamp already computes both residual and charge at the limited load voltages. Transient charge stamping immediately re-evaluated both at those same voltages. Retain only that charge array per device and reuse it. Every static stamp replaces it; temperature changes and transient reset invalidate it. Standalone charge stamping still evaluates normally. Charge does not depend on gmin. AC, noise and accepted-step evaluation are unchanged. No arithmetic expressions, tolerances, timestep, OP/homotopy, corpus or ROADMAP changes.

### Full unchanged deck, three runs per revision

Both groups used `spice-heavy node benchmarks/performance/dff-1310.mjs 3` after building the respective revision. Queue time, module loading and hashing are outside the harness timer. No extra warmup. Host load is uncontrolled, so compare this round's paired groups rather than the previous round's 76 s result.

| Run | Before seconds | After seconds |
| --- | ---: | ---: |
| 1 | 58.984534 | 36.027890 |
| 2 | 49.178943 | 37.015348 |
| 3 | 51.971084 | 38.190369 |

Median: 51.971084 s -> 37.015348 s, a 28.7770% reduction. The >=10% gate passes. All six hashes are fa930f7d1b79d8ce7f05a5de675090f44ff445b143b18a85075f530dd52b19fc with 43273 rows, on the same fixture hash recorded above. All convergence telemetry is identical: 31 DC iterations, 43272 accepted steps, 3139 LTE rejections, 100724 transient Newton iterations, zero NR retries, no source/gmin stepping and minimum accepted dt 2.5e-15 s. No tolerance exception is needed.

Remaining loss: the issue's ngspice-47 reference is still 1.3-3.9 s. This round's 37.015348 s median remains about 9.49-28.47x slower. This is a comparison with the existing reference, not a fresh ngspice timing or a superiority claim.

### Validation

The new evaluation-reuse tests first failed in four cases (17 duplicate exponential calls per charge stamp), with four output-equivalence cases passing before changes. After the fix all 225 tests in 15 files pass via `pnpm -C packages/core exec vitest run src/devices/vbic`. Tests cover both polarities, seven/nine-node models, changed bias, temperature invalidation, reset, standalone charge stamps, gmin independence and bit-identical cached/uncached stamps. Existing fingerprint and ngspice parity tests also pass. `pnpm build` and `pnpm lint` pass. No local root test suite was run; exact-head GitHub CI is the full gate.

## Round 4: fused junction-diode derivatives

Round 5 follow-up: [locally owned residual/charge accumulation](round-5-perf.md), with [JSON evidence](round-5-perf.json), reduces the explicit derivative-array counter from 67,040 to 59,360 (11.4558%). All 227 VBIC tests and stamp/waveform hashes/counters remain unchanged. This is not a demonstrated runtime win: all three before/after runs are published, with median 40.985041 -> 79.220900 s, a 93.2922% loss on the uncontrolled shared host. Exact-head CI and independent review remain required. Refs #1310.

The [full-deck profile and 3+3 receipt](round-4-perf.md), with [machine-readable data](round-4-perf.json), identifies VBIC evaluation/derivatives as the largest bucket (66.979% sampled wall time, plus 16.166% GC). Fuse the generic diode helper's five derivative arrays into one while preserving arithmetic order, stamps, waveform hashes and all Newton/step counters. RED-first allocation coverage and all 227 VBIC tests pass. This is an allocation reduction, **not a demonstrated runtime win**: the shared-host median is 53.435783 -> 54.498114 s, a 1.9881% loss. All six raw times and the remaining ngspice/parity losses are published in the receipt. Refs #1310; no closure or superiority claim.
