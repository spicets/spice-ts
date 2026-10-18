# Issue #1310 round 3: count gap versus cost per Newton iteration

Refs #1310. Measurement only, at afefa01b5aac9377231c40b38f9fc06e9efb7b0c (merged #1329). No simulator, tolerance, timestep, fixture, or ROADMAP changes. Raw counters, individual timings, commands, version banner, and derived values are in [round-3-counters.json](round-3-counters.json).

## Conclusion

The remaining gap is mainly **(b), cost per iteration**, not a many-times-larger number of steps. On this shared-host run spice-ts takes 51.827138 s median versus ngspice's reported 1.738080 s median transient analysis time: **29.8186x slower**. There are only **1.2360x** as many transient Newton iterations, leaving an effective **24.1248x cost-per-iteration ratio**. This is a loss, not a superiority claim. The newer 51.8 s observation is worse than the preceding 37–46 s receipt; host load is not controlled and no code changed between those observations.

These are effective end-to-end costs, not direct measurements of a VBIC evaluation. The existing short pre-#1329 profile in [README.md](README.md#round-2-reuse-the-static-loads-charge-evaluation) makes VBIC evaluation/allocation the leading next profiling target. This counter comparison alone cannot assign the entire residual to VBIC, distinguish derivative arithmetic from stamping/GC/output, or establish a causal runtime share for each subsystem.

## Measurements: all runs

Node v22.23.1; Darwin 27.0.0 arm64; Apple M5 Pro; shared Mac. ngspice-47 reports SPARSE 1.3 as the solver actually used, although the version banner says compiled with KLU. Groups are sequential, not alternating; there is no extra warmup. Every full-deck run uses spice-heavy, excluding queue wait from simulator timings.

| Run | ngspice transient s | ngspice transient load s | factor s | solve s | spice-ts simulate s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.750580 | 1.080220 | 0.284096 | 0.140347 | 53.184229 |
| 2 | 1.738080 | 1.091600 | 0.273669 | 0.143910 | 51.488293 |
| 3 | 1.494220 | 0.930005 | 0.244418 | 0.132555 | 51.827138 |

The ngspice counters are emitted by `rusage all` (equivalent accounting fields to `.option acct`), with full matrix and transient sub-timers retained in JSON. spice-ts's timer encloses `simulate(deck)`, including parsing, OP and result construction, but excludes imports/startup and output hashing. ngspice's transient analysis timer excludes deck parsing and separately accounts for OP: total iterations 81517 minus transient iterations 81491 = 26 non-transient iterations. Thus the two timing scopes are not identical. The per-iteration quotient is an effective average that also includes non-Newton work; it is not an instrumented stamp-only or CPU-cycle measurement. Do not use its precision to imply an isolated-machine throughput guarantee.

| Counter (identical in each simulator's three runs) | ngspice | spice-ts |
| --- | ---: | ---: |
| Output rows, including initial point | 40545 | 43273 |
| Accepted timepoints, including initial point | 40545 | 43273 |
| Accepted advances, excluding initial point | 40544 | 43272 |
| Rejected trial timepoints | 0 | 3139 |
| Attempted advances, accepted + rejected | 40544 | 46411 |
| Transient Newton iterations | 81491 | 100724 |
| Non-transient/DC Newton iterations | 26 | 31 |
| spice-ts NR / LTE retries | not separately reported | 0 / 3139 |
| spice-ts minimum accepted dt | not reported by rusage | 2.5e-15 s |

ngspice's `Accepted timepoints` includes the initial point: [dctran.c, lines 373–402](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L373-L402). spice-ts increments acceptedSteps only on advances: [transient-driver.ts, line 527](../../../../packages/core/src/analysis/transient-driver.ts#L527). Iteration accounting includes rejected attempts: [spice-ts lines 405–431](../../../../packages/core/src/analysis/transient-driver.ts#L405-L431), [ngspice dctran.c stats macros](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L44-L65).

spice-ts's three returned-waveform hashes remain fa930f7d1b79d8ce7f05a5de675090f44ff445b143b18a85075f530dd52b19fc, matching the preceding receipt. This is repeatability within spice-ts, **not** equality with ngspice. The known V(Q) parity loss (#1309) remains outside this measurement card.

## How much does each factor explain?

Using medians T and transient iteration counts N:

- Accepted-advance ratio = 43272 / 40544 = 1.067285 (6.73% more).
- Attempted-advance ratio = 46411 / 40544 = 1.144707 (14.47% more).
- Newton-count ratio C = 100724 / 81491 = 1.236014 (23.60% more).
- ngspice effective time per Newton iteration = 1.73808 / 81491 = 21.3285 microseconds.
- spice-ts effective time per Newton iteration = 51.827137708 / 100724 = 514.5461 microseconds.
- Runtime ratio R = 29.818615 = C × P = 1.236014 × 24.124824.

There is no unique additive causal percentage for multiplicative factors. A symmetric log decomposition gives count log(C)/log(R) = **6.24%**, cost log(P)/log(R) = **93.76%** of the log runtime gap. An explicitly ordered additive decomposition, pricing extra iterations at ngspice's average cost first, gives (C−1)/(R−1) = **0.819%** of excess time to count and **99.181%** to cost plus interaction. Neither is a measured subsystem CPU share.

A more actionable counterfactual: if spice-ts reached ngspice's iteration count while keeping its own average cost unchanged, it would take about **41.9309 s**, saving **19.09%** of its current runtime, but still be **24.12x** slower. Hence count parity alone cannot close this gap. This assumes constant average cost and is not a promised optimization result.

## Same deck; statistics do not tune numerics

Input: benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp, SHA-256 d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. Source/license are already recorded under corpus-f in benchmarks/SOURCES.md.

Neither fixture nor `.control` TRAN is edited. The ngspice stats wrapper sources the original bytes, allowing the original `TRAN 0.25p 10n` to execute, then calls `rusage all` and `quit`. These commands run after the analysis and set no numerical options. In batch mode the deck's graphical `plot` is ignored (no UI/focus use). The standalone unchanged-deck control run and all three wrapper runs each emit 40545 rows. This is a row-count check, not an ngspice waveform-hash check. The harness hashes the fixture before/after and checks the spice-ts harness input hashes.

Exact reproduction, after `pnpm install --frozen-lockfile && pnpm build`, from the repository root:

    TMPDIR=<your scratch directory> node benchmarks/performance/dff-1310-counters.mjs > round-3-counters.json

The harness executes three separate `spice-heavy ngspice -b <scratch>/stats.cir` processes, then `spice-heavy node benchmarks/performance/dff-1310.mjs 3` (three simulate calls in one process). Its stats.cir content is recorded verbatim in JSON. It also executes `ngspice --version` and `git rev-parse HEAD`. Standalone row-count control:

    spice-heavy ngspice -b benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp

Initial unsuccessful interactive invocation probes did not yield accounting and are not included in the three measured runs. They too used spice-heavy. Generated raw logs stay in scratch, not git. The committed JSON includes derived arithmetic and the standalone row-count check in addition to the harness's raw output.

## Defaults and algorithm differences (no tuning)

The deck supplies no `.options`, no UIC, and no explicit TMAX. Do not assume differing RELTOL/TRTOL caused the count difference:

| Setting | ngspice-47 | spice-ts at measured revision | Evidence |
| --- | --- | --- | --- |
| RELTOL, ABSTOL, VNTOL, CHGTOL | 1e-3, 1e-12 A, 1e-6 V, 1e-14 C | same | [ngspice cktntask.c 93–104](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/cktntask.c#L93-L104); [types.ts 351–365](../../../../packages/core/src/types.ts#L351-L365) |
| TRTOL | 7 | 7 | same sources; ngspice's [XSPICE override](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/cktdojob.c#L76-L91) requires A devices, absent here |
| Method / order / XMU | trapezoidal, max order 2, 0.5 | trapezoidal, first-order startup/recovery then second order, 0.5 | [ngspice defaults 109–119](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/cktntask.c#L109-L119); types.ts above; [driver order selection](../../../../packages/core/src/analysis/transient-driver.ts#L899-L921) |
| Default maximum step | min(TSTEP, (TSTOP−TSTART)/50) = 2.5e-13 s, unless nostepsizelimit set | min(TSTEP, TSTOP/50) = 2.5e-13 s | [ngspice traninit.c 26–36](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/traninit.c#L26-L36); [max-timestep.ts 40–46](../../../../packages/core/src/analysis/max-timestep.ts#L40-L46); TSTART absent here |
| DC / transient iteration limit | 100 / nominal 10 raised to 100 by NIiter | 100 / 100 | [ngspice defaults 106–107](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/cktntask.c#L106-L107), [niiter.c 38–39](https://github.com/imr/ngspice/blob/ngspice-47/src/maths/ni/niiter.c#L38-L39); types.ts above; neither hits the limit here |
| Device GMIN | 1e-12 | deviceGmin 1e-12, distinct from global gmin=0 | ngspice defaults above; [device.ts](../../../../packages/core/src/devices/device.ts), [VBIC branch conductances](../../../../packages/core/src/devices/vbic.ts#L446-L458); global gmin=0 is not absent VBIC junction GMIN |

Real implementation-policy differences remain even with equal option values:

- ngspice's minimum dt is maxStep × 1e-11 = 2.5e-24 s ([traninit.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/traninit.c#L36)); spice-ts has a fixed 1e-15 s floor and bypasses LTE below 100 × that floor or after ten consecutive LTE rejects ([driver lines 31–62](../../../../packages/core/src/analysis/transient-driver.ts#L31-L62), [charge truncation gating](../../../../packages/core/src/analysis/transient-driver.ts#L923-L950)). The observed spice-ts minimum, 2.5e-15 s, is not proof that ngspice reaches its floor.
- Breakpoint proximity policies differ: spice-ts MIN_BREAK=1e-14 s; ngspice's [dctran.c 160–170](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L160-L170) sets minBreak to 10×delmin in XSPICE builds, or maxStep×5e-5 otherwise. These source-level policies differ; this receipt does not attribute particular rejections to them.
- spice-ts applies a voltage-predictor LTE check as well as device-charge truncation ([checkLTE](../../../../packages/core/src/analysis/transient-driver.ts#L869-L897), [rejection decision](../../../../packages/core/src/analysis/transient-driver.ts#L476-L487)); ngspice's default newtrunc=0 uses device charge truncation ([VBICtrunc](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/vbic/vbictrunc.c#L25-L38), [dctran.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L775-L889)). Equal TRTOL does not make these acceptance algorithms identical. The 3139 LTE retries versus zero ngspice rejections motivate a parity investigation, not a per-deck tolerance adjustment.

## Recommended next slices

1. Profile the post-#1329 unchanged DFF, separating VBIC evaluation/derivative allocation, accepted-point/charge work, stamping, matrix factor/solve, and output construction. Optimize the largest generic bucket with RED-first equivalence tests, three wrapped before/after runs and unchanged waveform hashes/counters. Vectorized/reusable derivative storage is a candidate, not a preselected fix or a promised speedup. Count parity is not a prerequisite for this cost work.
2. Independently reproduce the 3139 LTE rejects with voltage-versus-charge rejection telemetry and compare ngspice's charge/order/breakpoint policy. Fix a generic timestep-policy discrepancy only if shown by a failing parity test; preserve correctness coverage and report any waveform loss. Do not disable LTE or tune this fixture to match counts.

## Validation

`pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `node --check benchmarks/performance/dff-1310-counters.mjs`, and `pnpm -C packages/core exec vitest run src/devices/vbic` pass (15 files, 225 tests). The actual harness completed three ngspice and three full-deck spice-ts runs. No local root test suite was run: this card requests targeted tests only, and exact-head CI is the full-suite gate. No simulator behavior changed, so there is no RED/GREEN behavioral fix claim. The downstream review card independently checks this measurement and the PR's exact-head CI.
