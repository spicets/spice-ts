# #1310 round 7: reuse generic charge integration contexts

Refs #1310. Base b27f315e5ead2dfb20ff984ba702e19527e50540. Fixture and source/licence remain unchanged, as recorded in benchmarks/SOURCES.md.

## Baseline contract correction

The historical round-6 waveform contract does NOT hold on the mandated current-main base. Merged #1344 (b8a9f6bc) declared VBIC charge truncation coverage before this branch. All six timed runs instead give waveform SHA256 361251b58101652f07fbdc64abdfb3ec8c8a941f92618420b32a2abc2a9a43f7, 40,545 rows, 40,544 accepted steps, zero rejects, 85,851 transient Newton iterations and 31 DC iterations. Fixture SHA256 is d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. Historical fa930f7d..., 43,273 rows, 3,139 rejects and 100,724 iterations are not claimed. No forbidden code was changed to restore old behavior. Supervisor/reviewer were notified on the card. This PR preserves actual base numerics exactly; acceptance against the historical contract requires supervisor reconciliation.

The existing binary64 stamp fingerprint remains 3324cdb29c46ea0b0be79f64b9a06a767eba5549d997e193df9221f0634944db (passing vbic-allocation.test.ts). No accumulation order, tolerance, timestep policy or device logic changes.

## Allocation profiling and selected slice

Initial CLI heap profiling mostly retains output arrays (transient-columns.ts flush, about 58 MB), not churn. A separate inspector sampling run includes objects collected by BOTH minor and major GC at interval 32,768 bytes. Bundled frame coordinates were resolved with the matching build maps and @jridgewell/trace-mapping. These are estimated sampled allocated bytes, not live memory or deterministic counters.

Forbidden VBIC arithmetic dominates, for example vbic.ts:223 at 23.79 GB estimated before. The largest generic frame is assembler.ts:380 (getVoltage, 830.74 MB), which returns primitive numbers with no explicit buffer/object creation to remove in this small identity-counter slice. Output flush (148.42 MB) is outside integration/charge-helper scope. Driver stampPrevB (123.12 MB) and charge truncation (65.24 MB) are forbidden; transient-step (76.66 MB) is outside the permitted integration/charge-helper slice. These larger sites are deferred, not claimed fixed.

The next explicit generic charge-helper allocation is the per-Newton ChargeIntegration literal in buildCompanionSystem, mapped to companion.ts:89 before. Whole-frame sampled self allocation is 18,289,560 bytes before and 10,416,224 after. This also includes boxing and other allocations, so the difference is NOT an exact measurement of context bytes.

One WeakMap-owned mutable context per assembler replaces the per-call literal. It is separate from vector workspaces so Euler does not allocate unused history vectors. All four fields refresh on every charge stamp, including clearing prevDt after Gear-2. No context is created for device lists without charged devices. Like the already-reused StampContext, it is synchronous call scratch, not a retainable history snapshot. No circuit-specific tuning or forbidden-file edits.

## RED / GREEN

The test delivers 40 charge stamps across two assemblers and alternating bootstrap Euler, variable-step Gear-2, trapezoidal, and Euler rules. It snapshots values at the callback boundary and counts distinct actual context identities, not a mocked factory. Base RED is 40 versus expected 2. Head GREEN is 2. This proves targeted object reuse, not total heap reduction. Separate assemblers do not share state.

## All unprofiled timings

Before and after command: spice-heavy node benchmarks/performance/dff-1310.mjs 3. Node v22.23.1, macOS 27.0.1 arm64, sequential groups, no extra warmup, uncontrolled shared host. Every run is included with full convergence in JSON.

| Run | Before seconds | After seconds |
| --- | ---: | ---: |
| 0 | 59.183249500 | 23.651545542 |
| 1 | 39.465513625 | 27.658177375 |
| 2 | 37.043298875 | 33.417891083 |
| Median | 39.465513625 | 27.658177375 |

Measured median change is -29.9181%. All three after runs are faster, but host load varied substantially. No causal wall-time speedup or ngspice superiority is claimed for this small object-reuse change. Historical ngspice timings were not remeasured and the known #1309 mismatch remains. No losses or runs were dropped.

## Before / after profile buckets

Identical CPU+heap profiling flags before and after, separate from unprofiled timings and inspector churn sampling. Whole-process timeDelta-weighted stack samples include startup and hashing. Precedence: GC, any VBIC frame, any MNA frame, any solver frame, charge/integration/accepted-point name, other. Classification differs from round 6 and is not directly comparable. GC is not causally attributed and scheduling gaps can inflate samples. Sampled totals are 107.329500 seconds before and 41.972292 after.

| Bucket | Before seconds (%) | After seconds (%) |
| --- | ---: | ---: |
| Other/startup/driver/hash | 3.688651 (3.44%) | 1.376879 (3.28%) |
| VBIC | 68.558879 (63.88%) | 33.129861 (78.93%) |
| Stamping/assembly | 2.448334 (2.28%) | 1.210624 (2.88%) |
| Matrix factor/solve | 1.902253 (1.77%) | 0.647993 (1.54%) |
| GC | 30.668593 (28.57%) | 5.569310 (13.27%) |
| Accepted-point/charge | 0.062790 (0.06%) | 0.037625 (0.09%) |

The large profile-time/GC differences are noisy observations, not evidence that this small context reuse removes that fraction of runtime. An exploratory after CPU-only profile was superseded by matching CPU+heap instrumentation and is not used in the table.

## Verification and commands

- pnpm install --frozen-lockfile passed. Initial pre-install build failed because tsup was missing; subsequent baseline build passed.
- pnpm build before and after passed.
- pnpm lint passed.
- pnpm -C packages/core exec vitest run src/mna/charge-context-allocation.test.ts: RED 40 versus 2 on base.
- pnpm -C packages/core exec vitest run src/mna src/solver src/devices/vbic src/analysis/companion: 443 tests in 35 files passed, including GREEN and stamp fingerprint.
- spice-heavy pnpm test: passed, exit 0. Exact-head GitHub CI is authoritative.
- CPU/retained heap command: spice-heavy node --heap-prof --heap-prof-dir=<scratch>/<phase> --cpu-prof --cpu-prof-dir=<scratch>/<phase> --cpu-prof-name=cpu.cpuprofile benchmarks/performance/dff-1310.mjs 1.
- Churn command: PROFILE_OUT=<scratch>/<phase>/allocation.json spice-heavy node <scratch>/sample.mjs. Scratch harness calls HeapProfiler.startSampling with the JSON parameters, imports the unchanged benchmark with runs=1, then stopSampling and saves its profile.

No raw profiles, logs or scratch probes are committed. Paired JSON includes full timings, identity, allocation top frames, bucket values and commands.
