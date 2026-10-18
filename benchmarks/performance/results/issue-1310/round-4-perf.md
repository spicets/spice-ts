# Issue #1310 round 4: fused junction-diode derivatives

Refs #1310, not a closure. Base e620ed8614da1c8afd2a8f0657a73857b58cbc98. No fixture, tolerance, timestep, solver policy, transient-driver.ts, max-timestep.ts or ROADMAP.md changes. Source/license for the unchanged corpus-f fixture remain in benchmarks/SOURCES.md. Raw timings, counters, hashes and profile details are in [round-4-perf.json](round-4-perf.json).

## Profile before selecting the optimization

Full unchanged DFF_Y_ECL.sp, not a shortened deck. Node v22.23.1, Apple M5 Pro, macOS 27.0.1 arm64. Default V8 CPU-prof interval, wrapped in spice-heavy. The process sampled 47.529125 s; its simulate timer was 47.171665 s. The profile and six measurements used the same harness. Timers exclude queue wait, imports/startup and hashing, while the whole-process profile includes them.

| Disjoint bucket | Sampled seconds | Share |
| --- | ---: | ---: |
| VBIC evaluate/derivatives | 31.834691 | 66.979% |
| GC | 7.683529 | 16.166% |
| Stamping | 3.590820 | 7.555% |
| Accepted-point/charge work excluding evaluation | 2.073742 | 4.363% |
| Other/startup/driver | 1.730305 | 3.641% |
| Matrix factor/solve | 0.616038 | 1.296% |
| Output/result construction, separately attributed | 0 | 0% |
| Harness hashing, separately attributed | 0 | 0% |

Each sample's timeDelta is attributed once. Bundled function start coordinates were decoded through the build source map. Precedence is GC, nested VBIC evaluate/derivative helpers, charge work excluding evaluation, stamping, matrix, harness hashing, result construction, other. Thus accepted-point calls into evaluate count under evaluation, not twice. Classifier rules and the largest self frames are recorded in JSON. GC is an unparented V8 frame and cannot be causally charged to VBIC. Output/hash had no separately attributable samples, not proof of zero work. Inlined/unresolved/native frames remain in other; the unusual V8 `set TextDecoder` label is not guessed to be a simulator function. Delayed sampling under host load makes these sampled wall-time shares, not CPU-cycle percentages.

Evaluation/derivatives dominate at 66.979%, with another 16.166% in GC. Self samples include add 4.870 s, constant 4.300 s, sub 4.179 s, evaluate 3.704 s and diode 2.649 s. This justifies removing temporary Dual/derivative allocations inside generic diode evaluation. It does not justify edits to the parallel timestep lane.

## Small generic change and RED/GREEN evidence

Fuse the existing scale -> exp -> subtract-one -> scale composition in the private VBIC diode helper. It now allocates one derivative array/Dual instead of five. Do not skip disabled currents, reassociate derivative products, or remove subtracting +0. Keep the exponential clamp and every floating-point operation in the old order. All diode calls benefit, with no circuit-name checks, parameter tuning, approximations, shared buffers or changed cache lifetime.

The new public-device equivalence test pins binary64 little-endian bytes for every static, transient-charge, dynamic and noise stamp/value. It covers NPN/PNP, seven/nine nodes, three temperatures, repeated limiting and forward/reverse/extreme biases, scale=2, peripheral currents, avalanche, high injection, charge partition, transit-time and excess-phase parameters. The baseline hash is `3324cdb29c46ea0b0be79f64b9a06a767eba5549d997e193df9221f0634944db`.

Before editing production code the numeric fingerprint passes while the allocation contract fails: 81,440 explicit numeric-length Array constructions in this workload versus the <70,000 budget. This is a RED performance-contract test, not a claim that baseline numerics were broken. After fusion both tests pass. All 227 tests in 16 VBIC files pass, including existing ngspice parity and stamp fingerprints. The allocation budget counts only explicit numeric-length Array construction, not all heap allocation or bytes.

## Three before and three after, unchanged full deck

`spice-heavy node benchmarks/performance/dff-1310.mjs 3` at each build. Three simulate calls per process, no extra warmup, sequential before/after groups. Shared-host load is uncontrolled. Publish all runs, including the slower after median.

| Run | Before s | After s |
| --- | ---: | ---: |
| 1 | 46.638647083 | 69.467038833 |
| 2 | 53.435783083 | 54.498113792 |
| 3 | 93.213099583 | 39.839491000 |

Median 53.435783083 -> 54.498113792 s. This is a **1.9881% runtime loss**, not a demonstrated full-deck speedup. The shipped change proves fewer derivative allocations and preserves numerics, but this run does not establish a wall-time benefit. The wide spreads and sequential groups prevent causal claims about the small median difference. No reruns were selected to hide this loss.

All six waveform hashes equal `fa930f7d1b79d8ce7f05a5de675090f44ff445b143b18a85075f530dd52b19fc`; all input hashes equal `d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6`. Every run has 43,273 rows, 31 DC iterations, 100,724 transient Newton iterations, 43,272 accepted advances, 3,139 rejected advances/LTE retries, zero NR retries or source/gmin stepping and minimum accepted dt 2.5e-15 s. No count or waveform change needs an exception. Equality here is before/after repeatability, not equality with ngspice.

Known losses persist: #1309 V(Q) mismatch, 43,273 versus ngspice's 40,545 output rows and runtime far above ngspice. Against the historical round-3 median 1.738080 s, the after median is 31.36x slower. No fresh ngspice timing is claimed.

## Reproduce

At the baseline or PR revision, `pnpm install --frozen-lockfile && pnpm build`, then run the wrapped harness above. Full-deck profile command:

    spice-heavy node --cpu-prof --cpu-prof-dir=<scratch>/r4-profile benchmarks/performance/dff-1310.mjs 1

Use the baseline build source map to resolve minified function coordinates before rebuilding (which deletes old chunks/maps); source grouping rules are in JSON. Run `pnpm -C packages/core exec vitest run src/devices/vbic`, then `pnpm lint`. Build/lint, all targeted tests and `spice-heavy pnpm test` passed locally (full command exit 0). Exact-head CI remains the authoritative full gate. No raw logs or scratch profiles are committed.
