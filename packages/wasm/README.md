# @spice-ts/wasm

Protocol-v1 module-worker facade with explicit TypeScript and bounded numeric WebAssembly backends.

```ts
import { createSpiceEngine } from '@spice-ts/wasm';

const engine = await createSpiceEngine({ backend: 'spice-ts-wasm' });
const response = await engine.simulate({
  apiVersion: '1',
  input: { format: 'spice', source: 'V1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 3 10 10k' },
}, { requestId: 'ac-1' });
await engine.close();
```

## Backends

`spice-ts-js` runs the existing TypeScript engine. It supports the facade's established OP, DC, transient and AC protocol slice.

`spice-ts-wasm` runs real and split-complex WebAssembly dense f64 Gaussian-elimination kernels for four deliberately narrow subsets:

- SPICE text input only
- exactly one unstepped analysis
- `.op` with resistors, independent constant/DC voltage and current sources, linear VCCS, CCCS, VCVS, and CCVS controlled sources, and bounded diode/BJT/MOS1 models (`R`, `V`, `I`, `G`, `F`, `E`, `H`, `D`, `Q`, `M`)
- `.dc` with one linear sweep of one independent constant/DC voltage or current source, resistors and bounded diodes/BJTs/MOS1 (`R`, `V`, `I`, `D`, `Q`, `M`)
- `.tran` with resistors, capacitors, four-token constant-value linear inductors, and independent constant/DC or `PULSE` voltage and current sources (`R`, `C`, `L`, `V`, `I`); each inductor adds one branch unknown and starts from its DC short-circuit operating point
- `.ac lin|dec|oct` with positive finite resistors, capacitors and inductors plus independent voltage and current sources (`R`, `C`, `L`, `V`, `I`)
- AC sources may use constant, `DC`, `AC magnitude [phase]`, or `DC value AC magnitude [phase]` forms
- at most 65,536 source bytes, 256 components and 64 numeric unknowns
- at most 1,025 AC frequency points, further reduced by the caller's `maxResultPoints`
- passive transients use at most 4,096 fixed-step trapezoidal points; diode transients use an adaptive point budget (see below), both further reduced by the caller's `maxResultPoints`
- at most 4,096 DC-sweep points, further reduced by the caller's `maxResultPoints`
- fixed three-page WebAssembly memory with no imports or growth

The WebAssembly backend does not support native/circuit-json input, virtual files, includes, subcircuits, models other than the bounded diode/BJT/MOS1 models below, parameters, controlled sources other than six-token linear `G`, five-token linear `F`, six-token linear `E`, and five-token linear `H` forms in OP, nonlinear devices other than bounded OP/DC-sweep diodes/BJTs/MOS1, switches, `.step`, nested/stepped DC sweeps, nonlinear DC source forms, transient UIC/initial conditions, start/max-time controls, adaptive timesteps, or non-trapezoidal integration. CCCS and CCVS controlling sources must resolve to a preceding independent voltage-source branch; missing, branchless and forward references return a structured `INVALID_CIRCUIT` validation error. Each VCVS or CCVS contributes one branch unknown to the 64-unknown ceiling. Coupled inductors (`K`) return `UNSUPPORTED_FEATURE` with feature `inductor-coupling`, inductor `IC=` returns `inductor-initial-condition`, and inductor models, instance parameters, and expression or nonlinear values return `inductor-form`. SIN, PWL, AC, and compound transient source forms remain unsupported. Unsupported input returns `UNSUPPORTED_FEATURE`; invalid grids return `INVALID_CIRCUIT`; exceeded bounds return `RESOURCE_LIMIT`. There is no automatic fallback. A caller that wants the TypeScript path must select `spice-ts-js` explicitly.

The dense kernels are intentionally bounded and are not a speed claim. AC has O(points × n³) runtime and O(n²) memory, and transferring the verified 4,418-byte artifact with each one-shot worker request adds overhead. Sparse WASM remains unsupported.

Diode operating points, DC sweeps and transients accept four-token `Dname anode cathode model` instances and `.model name D(IS=... N=... RS=...)` (all three parameters optional). Newton iteration reuses core's diode companion model, ngspice-style junction limiting and convergence tolerances around the WASM linear solve, with no TypeScript solver fallback. DC sweeps warm-start Newton from the previous point. The OP/DC per-point iteration budget defaults to 100, capped at 1,000; exhausted budgets return `CONVERGENCE_FAILED`. Other diode model parameters (including BV and CJO), instance parameters and diode AC analyses return `UNSUPPORTED_FEATURE`. The diode fixtures are original project-authored circuits under this repository's MIT licence, not imported benchmark material.

Diode transient exception to the passive limitations above: `SIN` sources and adaptive timesteps are supported through core's transient driver, including WASM-backed DC initialization. Every linear solve uses the dense WASM kernel, not the JS solver. Set `createSpiceEngine({ backend: 'spice-ts-wasm', maxPoints: 12000 })` to change the adaptive accepted-point budget. The default is 4096, including t=0; positive safe integers only. Exceeding it returns a typed protocol `RESOURCE_LIMIT` error with `details: { limit: 'maxPoints', configured, observed }`. `options.limits.maxResultPoints` remains an independent, potentially smaller limit. Passive transient, OP/DC and AC bounds are unchanged. Transient Newton budgets and rejection/recovery follow the shared core driver.

Known limitation (#1606, residual strict parity in #1571): the rectifier in `src/numeric-wasm-diode-tran.test.ts` has identical 2008-point grids at default options and measured maximum absolute signal delta `1.2212453270876722e-15` against core (test bound `1e-12`). With unchanged `reltol=1e-10`, `vntol=1e-13`, `abstol=1e-16`, both paths finish at 10215 points with `maxPoints: 12000`, but dense/sparse rounding feeds adaptive LTE decisions. Measured index-wise maximum signal delta is `8.979594845470729e-10` (expected-difference bound `9e-10`, explicitly greater than `1e-10`) and maximum time delta is `1.0431846358960328e-13` s (bound `1.1e-13`). This is not strict tight-tolerance parity.

Reproduce the original MIT rectifier comparison on identical netlist bytes with `spice-heavy pnpm exec tsx packages/wasm/scripts/diode-tran-accuracy.ts` (ngspice-47 required). On arm64 Apple M5 Pro, all node voltages and source currents compared to ngspice interpolated onto WASM times gave default-options max/RMS absolute error `5.8778753319055355e-5 / 5.518338202772876e-6` before versus `5.564847601946532e-6 / 2.715901086240641e-7` after. The tight-options comparison against the same default-options ngspice run is a loss: `5.8778752727972616e-5 / 5.518483580695964e-6` before versus `8.164889731205292e-5 / 1.2181421220621299e-5` after. Before had 2001 points; after has 2008/default or 10215/tight. No speed or tight-ngspice-parity claim is made.

BJT operating points and DC sweeps accept five-token `Qname collector base emitter model` instances and `.model name NPN(...)` or `PNP(...)`, with optional `IS`, `BF`, `BR`, `NF`, `NR`, and `VAF` only. This Gummel-Poon DC subset reuses core's companion model and junction-based Newton step limiter around the WASM linear solve with the same bounded per-point iteration budget. DC sweeps retain device state and warm-start Newton from the previous solution. Charge, temperature, parasitic resistance, other model parameters (including CJE, TF, RB and XTI), substrate/area/instance options and BJT AC/transient analyses are rejected with `UNSUPPORTED_FEATURE`; unsupported model parameters identify feature `bjt-model-parameter`. Other nonlinear devices remain unsupported. The original MIT fixtures in `src/numeric-wasm-bjt.test.ts` compare NPN/PNP forward-active, saturation, cutoff and reverse-active resistor bias networks against core at a uniform 1e-9 relative plus 1e-12 absolute tolerance. `src/numeric-wasm-bjt-dc.test.ts` compares every node voltage and source branch current in mirrored common-emitter VBE/VCE sweeps, in both directions, at 1e-9 relative or 1e-12 absolute tolerance. These are correctness checks, not speed or ngspice-parity claims.

MOS1 operating points and DC sweeps accept six-token `Mname drain gate source bulk model` instances with optional numeric `W` and `L`. Models are `.model name NMOS(...)` or `PMOS(...)`, with optional `LEVEL=1`, `VTO`, `KP`, `LAMBDA`, `GAMMA` and `PHI`; omitted parameters use core's ngspice-compatible defaults. Newton reuses core's MOS1 companion equations, body-junction limiting and convergence checks around the existing WASM linear solve, with the same bounded per-point iteration budget and no fallback. DC sweeps retain device state and warm-start Newton from the previous solution. Other levels/model parameters (including capacitance, TOX, RD and temperature), instance options other than W/L, and MOSFET AC/transient analyses return structured `UNSUPPORTED_FEATURE` (`mosfet-model-parameter`, `mosfet-form` or `device-or-directive`). The numeric kernel/artifact is unchanged.

`src/numeric-wasm-mos1-dc.test.ts` compares every node voltage and source branch current against core for NMOS/PMOS Id-Vgs and Id-Vds resistor-bias sweeps and a CMOS inverter VTC, all in both directions. These original MIT fixtures use the unchanged BJT DC tolerance of `max(1e-12, 1e-9 * abs(reference))`. They establish core correctness parity, not ngspice parity or a speed claim.

The [MOS1 receipt](../../benchmarks/wasm-mos1-op/report.json) covers 12 original MIT fixtures (NMOS/PMOS saturation, triode, cutoff, reverse conduction; CMOS inverter at three biases; defaults). All 68 node-voltage/source-current samples pass uniform core tolerance `1e-12 + 1e-9 * abs(reference)` and ngspice-47 OP tolerance `1e-9 + 1e-6 * abs(reference)` using identical netlist bytes. Reproduce after `pnpm build` with `spice-heavy pnpm exec tsx benchmarks/wasm-mos1-op/compare.ts`. Baseline main rejected all 12 MOS1 fixtures; this slice accepts all 12. Per-engine cold worker runtimes are reported, not a speed claim.

### Measured cost of this slice

Measured on 2026-10-10 with Node 22.23.1, pnpm 10.28.1, ngspice-47, LLVM/LLD 23.1.3 and an arm64 Apple M5 Pro. The fixed five-circuit AC suite uses byte-identical netlists for both spice-ts backends and ngspice. Its 29 WASM frequency points produced these aggregate rectangular-complex errors:

| Reference | Compared samples | Max absolute | RMS absolute | Max relative | RMS relative |
| --- | ---: | ---: | ---: | ---: | ---: |
| `spice-ts-js` | 64 | 4.4492e-16 | 1.5426e-16 | 1.7826e-15 | 2.9435e-16 |
| ngspice-47 | 63 | 1.1571e-15 | 2.1615e-16 | 1.3279e-15 | 3.7118e-16 |

The identical-netlist LIN regressions match ngspice-47 exactly: N=1 yields `[100]` Hz and N=4 yields `[100, 400, 700, 1000]` Hz. One ngspice endpoint was excluded because its floating frequency landed just below spice-ts's final OCT point; the complete per-fixture grids and every signal metric are retained in `ac-accuracy-results.json`. No zero-reference samples were excluded.

Five samples each ran 20 one-shot worker simulations after five warmups. Median time was 1,490.678 ms for `spice-ts-js` (74.5339 ms/run) and 1,492.458 ms for `spice-ts-wasm` (74.6229 ms/run), a 0.1194% WASM loss. This worker-dominated difference is noise-level and is not a speed claim. The measured size losses are larger: the artifact grows from 1,190 to 2,900 bytes (+143.70%), worker.js from 355,517 to 377,009 bytes (+6.05%), index.js from 41,878 to 42,815 bytes (+2.24%), and their combined uncompressed size grows 24,139 bytes (+6.06%). Larger or sparse circuits cannot use this backend at all.

Reproduce the receipt with `pnpm --filter @spice-ts/wasm bench:ac`. It records tool versions, hashes, full samples, commands, per-fixture metrics and ngspice runtimes in `ac-accuracy-results.json`.

The passive RLC transient receipt is `benchmarks/results/issue-368/report.json`; it compares WASM, the TypeScript engine and ngspice-47 on byte-identical series and parallel RLC netlists and records the unsupported inductor forms ngspice completes as losses. The passive RC transient receipt is `benchmarks/wasm-rc-transient/report.json`. It records matched-timepoint maximum/RMS absolute and relative errors, convergence, point counts, five fresh-process runtime and peak-RSS samples, and every measured size loss against native ngspice-47. The WASM process includes pnpm and Node startup, so this is a correctness and embeddability check rather than a speed claim.

The bounded passive DC-sweep receipt is `benchmarks/wasm-dc-sweep/report.json`. It compares identical project-owned fixture bytes against native ngspice-47, including matched point counts, maximum/RMS absolute and relative errors, fresh-process runtime medians, artifact-size delta, exclusions, and retained losses. Reproduce it with `pnpm --filter @spice-ts/wasm bench:dc`.

The bounded linear CCCS OP receipt is `benchmarks/wasm-cccs-op/report.json`. It compares identical project-authored fixture bytes against native ngspice-47, including scalar errors, fresh-process runtime medians, artifact-size delta, exclusions, and retained losses. Reproduce it with `pnpm --filter @spice-ts/wasm bench:cccs-op`.

The bounded linear VCVS OP receipt is `benchmarks/results/issue-355/report.json`. It compares identical project-authored fixture bytes against native ngspice-47, including scalar errors, fresh-process runtime medians, process boundaries, artifact-size delta, exclusions, and retained losses. Reproduce it with `pnpm --filter @spice-ts/wasm bench:vcvs-op`.

The bounded linear CCVS OP receipt is `benchmarks/results/issue-362/report.json`. It compares identical project-authored fixture bytes against native ngspice-47, including the OP grid and every voltage/current signal, scalar errors, fresh-process runtime medians, process boundaries, artifact-size delta, exclusions, and retained losses. Reproduce it with `pnpm --filter @spice-ts/wasm bench:ccvs-op`.

## Integrity and isolation

`createSpiceEngine` verifies `dist/worker.js` and, for `spice-ts-wasm`, `dist/dense-solver.wasm` against `dist/manifest.json` before constructing a worker. Missing, malformed or mismatched assets fail with `BACKEND_UNAVAILABLE`. Build IDs use the first 16 hexadecimal characters of the selected artifact's SHA-256.

The checked-in numeric artifact is copied during package builds, not rebuilt using an ambient toolchain. Its reviewable C source, pinned regeneration command, expected hash, size and ABI v2 are documented in `native/README.md`. ABI v2 exposes bounded linear VCCS, CCCS, VCVS, and CCVS stamps plus the real and split-complex solver entry points.

The worker receives request values and the already verified numeric bytes only. It exposes no WASI, socket, host-filesystem, clock, randomness or ambient fallback API. Package build and test scripts do not publish or deploy anything.

## Streaming and cancellation

`simulateStream` emits fixed point-count chunks after the one-shot worker returns. OP has no point events. AC arrays are bounded to 1,025 points and DC/transient arrays to 4,096 points before allocation. `cancel(requestId)` terminates the operation's one-shot worker; cancellation before asynchronous worker construction is also registered. Caller wall-time expiry terminates the worker. The fixed 64-unknown ceiling bounds each non-interruptible solve.
