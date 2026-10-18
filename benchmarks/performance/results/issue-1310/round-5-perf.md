# #1310 round 5: locally owned VBIC accumulators

Refs #1310, not closure. Base `d8b0f1ce` (round 4). Full unchanged `DFF_Y_ECL.sp`, Node v22.23.1, macOS 27.0.1 arm64, Apple M5 Pro. [Machine-readable evidence](round-5-perf.json) includes all six run times, counters, profile buckets and commands.

## Profile first, then one generic change

The unchanged full-deck profile attributes 67.710% of sampled wall time to VBIC evaluation/derivatives, 12.547% to GC, 9.282% to stamping, 5.523% to charge, 4.190% to matrix and 0.747% to other. The largest evaluation self frames are add (5.057 s), evaluate (4.017 s), constant (2.977 s), sub (2.875 s) and scale (2.168 s). This selects add/sub accumulation as the slice, without touching timestep policy.

Only the locally owned residual/charge rows are mutated by private addInto/subInto helpers. Each row starts with a distinct zero Dual/derivative array. Neither inputs, branch expressions nor noise quantities alias those rows. Buffers escape only as the completed evaluation result; there is no module-level/shared scratch buffer. Excess-phase row replacement stays unchanged. The private Dual value becomes writable for this purpose; other arithmetic helpers remain allocating and do not mutate inputs.

Each derivative still executes the same binary64 add or subtract, then the value does likewise. No multiplication by a sign, reassociation, omitted zero operations, exp-clamp changes, approximation, tolerance/parameter tuning or circuit-specific logic.

## RED/GREEN

The unchanged baseline produces 67,040 explicit numeric-length Array constructions in the allocation workload. The initial <50,000 trial fails at baseline and still fails after this slice (59,360). The final <60,000 contract was independently RED with the old accumulation calls (67,040), then GREEN with the new calls (59,360). This is an 11.4558% reduction in that counter, not a measurement of all heap allocations or bytes. The original numeric stamp fingerprint remains `3324cdb29c46ea0b0be79f64b9a06a767eba5549d997e193df9221f0634944db`.

All 227 tests in 16 VBIC files pass, including existing ngspice parity tests. Helpers are private to VBIC; no other device uses them. Install, build, lint and wrapped full suite pass locally (exit 0). Exact-head GitHub CI is the authoritative merge gate.

## Three before and three after

`spice-heavy node benchmarks/performance/dff-1310.mjs 3` at each build, sequential groups, three simulate calls per process, no extra warmup. Shared-host load was not controlled. Every run is published; none was discarded or replaced.

| Run | Before s | After s |
| --- | ---: | ---: |
| 1 | 40.985040708 | 79.220899625 |
| 2 | 66.703690667 | 121.906112583 |
| 3 | 38.614749708 | 78.409874625 |

Median 40.985040708 -> 79.220899625 s, a **93.2922% runtime loss**. This change proves fewer temporary arrays, not a wall-time speedup. Host variability is visible, but these measurements cannot distinguish its effect from a regression. The separate after profile took 48.363090041 s; it is not substituted into the benchmark group.

All six hashes equal `fa930f7d1b79d8ce7f05a5de675090f44ff445b143b18a85075f530dd52b19fc`. Fixture SHA-256 is `d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6`. Every run has 43,273 rows, 31 DC iterations, 100,724 transient Newton iterations, 43,272 accepted advances, 3,139 rejects/LTE retries, zero NR retries and no source/gmin stepping, minimum accepted timestep 2.5e-15 s. Both profile runs also match these hashes/counters. This is before/after identity, not ngspice waveform equality.

Known losses remain: #1309 V(Q) mismatch and 43,273 vs ngspice's 40,545 rows. The after median is 45.58x slower than the historical ngspice median 1.738080 s. No new ngspice run or superiority claim.

## After profile

Whole-process timeDelta-weighted samples, 48.850584 s total, including startup/hash outside the simulate timer. Resolve bundled function starts with matching build source maps before rebuilding. Detailed precedence and top self frames are in JSON. GC cannot be assigned causally to VBIC. Inlined/unresolved frames are classified only by available ancestors; native labels such as set TextDecoder are not guessed. Output/hashing had no separately attributed samples, not proof of zero work.

| Bucket | Sampled s | Share |
| --- | ---: | ---: |
| VBIC evaluate/derivatives | 30.783565 | 63.016% |
| GC | 6.127182 | 12.543% |
| Stamping | 5.651411 | 11.569% |
| Accepted-point/charge work | 3.116708 | 6.380% |
| Matrix factor/solve | 2.732759 | 5.594% |
| Other/startup/driver | 0.438959 | 0.899% |

## Reproduce

Build each revision with `pnpm install --frozen-lockfile && pnpm build`. Run the three-run command above at each revision. Profile using `spice-heavy node --cpu-prof --cpu-prof-dir=<scratch>/profile benchmarks/performance/dff-1310.mjs 1`. Run `pnpm -C packages/core exec vitest run src/devices/vbic`, `pnpm lint` and `spice-heavy pnpm test`. No raw logs/profiles or scratch notes are committed.
