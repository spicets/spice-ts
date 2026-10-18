# #1310 round 9: fuse constant operands in VBIC evaluation

Refs #1310. Base 173f6b8269b66c2fc9705040c353f1fbacca7c91. Source/licence and the unchanged corpus-f DFF_Y_ECL.sp fixture remain recorded in benchmarks/SOURCES.md. Raw timings, profiles and counters are in round-9-perf.json. Node v22.23.1, Darwin 27.0.0 arm64, Apple M5 Pro, shared uncontrolled host.

## Evidence first

The full-deck base CPU profile places 86.20% in VBIC evaluation. The largest named self frames include evaluate (2.120512 s), add (1.799507 s), constant (1.701009 s), scale (1.313951 s), sub (0.781042 s) and diode (0.679833 s). These are sampled self times, not isolated evaluation microbenchmarks.

Command before and after, after building the matching revision:

    spice-heavy node --cpu-prof --cpu-prof-dir=<scratch>/<phase> --cpu-prof-name=cpu.cpuprofile benchmarks/performance/dff-1310.mjs 1

Whole-process timeDelta-weighted stack samples include startup and output hashing. Resolve bundle function-start line/column coordinates with the matching dist/*.map and Node module.SourceMap.findEntry. Classify in order: GC frame; any devices/vbic.ts or vbic-temperature.ts frame; any mna frame; any solver frame; charge/integrat/accept function name; other. Thus VBIC includes its own charge and stamp work, not just algebra; other includes Newton/driver/startup/output work. Sampling gaps and host scheduling can inflate time. GC is not attributed to a particular allocator.

| Bucket | Before s (%) | After s (%) |
| --- | ---: | ---: |
| VBIC | 16.869800 (86.20%) | 17.493079 (86.99%) |
| GC | 1.120913 (5.73%) | 1.041799 (5.18%) |
| Other / driver / output | 0.586327 (3.00%) | 0.607958 (3.02%) |
| Stamping | 0.557666 (2.85%) | 0.578247 (2.88%) |
| Factor / solve | 0.403085 (2.06%) | 0.373875 (1.86%) |
| Accepted-point charge | 0.033167 (0.17%) | 0.015167 (0.08%) |
| Total | 19.570958 | 20.110125 |

The after profile is slower, including the VBIC bucket. Do not infer a causal CPU-share reduction from these two runs. The balanced unprofiled series below measures the selected candidate's elapsed-time improvement; independent review must repeat it.

## Identical-deck ngspice-47 counters

Reproduction: `TMPDIR=<scratch> node benchmarks/performance/dff-1310-counters.mjs`. This existing harness runs three `spice-heavy ngspice -b <scratch>/stats.cir` processes and three base spice-ts simulations. Its wrapper sources the untouched original deck (including TRAN), then calls rusage all and quit. No options, steps or tolerances change. Plot commands are ignored in batch mode, without foreground UI.

| Counter, identical in each simulator's three runs | ngspice-47 | spice-ts base and head |
| --- | ---: | ---: |
| Accepted timepoints including initial | 40545 | 40545 |
| Accepted advances | 40544 | 40544 |
| Rejected timepoints | 0 | 0 |
| Total Newton iterations | 81517 | 85882 |
| Transient Newton iterations | 81491 | 85851 |
| Non-transient Newton iterations | 26 | 31 |

ngspice transient seconds: 0.894385, 0.888759, 0.890097, median 0.890097. Base spice-ts simulate seconds: 19.179603750, 19.292193500, 19.585715750, median 19.292193500. The transient iteration ratio is only 1.053503, versus a 21.674260 elapsed ratio and an effective 20.573518 cost-per-iteration ratio. The gap is predominantly per-iteration cost, not excess steps. This does not justify an algorithm/timestep change. Timing scopes differ: spice-ts includes parsing, OP and result construction; ngspice's transient timer excludes parsing and OP. These are effective end-to-end ratios, not stamp-cycle measurements. The head remains much slower than ngspice, and existing ngspice waveform parity losses are not claimed fixed.

## Selected change

Fuse scalar add/subtract operands directly into a result Dual instead of taking and zero-filling another constant Dual first. Keep every derivative +0, -0 or 0-minus operation, rather than copying or negating derivatives and changing signed zeros. The new helpers take Dual + number, Dual - number and number - Dual. Addition's constant-left sites use the commutative binary64 addition, with the same two operands and no reassociation. No derivative accumulation, nonlinear expression, tolerance, timestep, solver or fixture changes. Cached-load ownership and the two workspace lifetimes are untouched.

This optimizes existing generic VBIC equations, not a DFF-specific path. Existing workspace, temperature, scaling, polarity, excess-phase and broad binary64 fingerprint tests exercise these paths. This is a performance optimization, not a newly reproduced correctness bug; no new RED correctness claim is made.

## Balanced timings, every run

Each run is a fresh process: `spice-heavy node benchmarks/performance/dff-1310.mjs 1`. Complete matching dist trees were saved in scratch after base/head builds and restored before each run, including split chunks and source maps. Twelve processes, no extra warmup, six runs per revision. Each pair alternates its starting revision; queue wait is outside the simulation timer. Hashing is also outside that timer.

| Pair | Order | Base s | Head s |
| --- | --- | ---: | ---: |
| 0 | base, head | 18.902228958 | 18.780139334 |
| 1 | head, base | 20.560448416 | 19.157829584 |
| 2 | base, head | 21.152760750 | 19.063119625 |
| 3 | head, base | 19.576056792 | 17.621228166 |
| 4 | base, head | 20.094567209 | 19.140463166 |
| 5 | head, base | 21.148597791 | 20.066004458 |
| Median | | 20.327507813 | 19.101791395 |

Median change is -6.029841%. All six adjacent pairs favor head, but the uncontrolled shared host still prevents a throughput guarantee. Independent balanced replication is required.

Rejected experiments are included in JSON, not silently discarded. First a workspace-size loop-bound/constant-clearing pilot took 19.802419292 s. Then unrolled map/add/sub took 19.387900709 s in its pilot, but lost balanced runs: medians 22.714714876 -> 23.394770583 s (+2.993899%). One rejected head run took 49.994476666 s; it remains in the receipt. Both experiments were reverted before the selected scalar-fusion series. Their outputs retained the reference hash. No completed timing was discarded.

## Identity and verification

All twelve selected timings retain waveform SHA256 361251b58101652f07fbdc64abdfb3ec8c8a941f92618420b32a2abc2a9a43f7, 40545 rows, 40544 accepted advances, zero rejects and 85851 transient Newton iterations. Both CPU-profile runs also retain that identity. Fixture SHA256 d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. Existing stamp fingerprint remains 3324cdb29c46ea0b0be79f64b9a06a767eba5549d997e193df9221f0634944db. These are spice-ts before/after identities, not equality with ngspice.

- pnpm install --frozen-lockfile: passed.
- pnpm build: passed on base and head.
- pnpm lint: passed.
- pnpm -C packages/core exec vitest run src/devices/vbic src/mna: 331 passed in 23 files.
- spice-heavy pnpm test: passed across workspaces. Core: 5561 passed, 10 expected failures, 8 skipped; 416 files passed, one skipped.
- Exact-head GitHub CI and independent review remain the publication gate. No merge is performed by this worker.

Only VBIC scalar arithmetic and these requested receipts change. Raw logs and CPU profiles remain scratch artifacts, not committed logs. #1310 stays open.
