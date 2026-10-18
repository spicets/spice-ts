# #1310 round 8: reuse VBIC Dual evaluation storage

Refs #1310. Base e858c1d4a7735a185ab4e81285a09cc57b466b8c. Fixture bytes, source and licence are unchanged (benchmarks/SOURCES.md). Node v22.23.1, macOS 27.0.1 arm64, shared uncontrolled host.

## Change and ownership

DualWorkspace retains one Dual and ordinary number[] derivative buffer per expression slot. A monotonic cursor resets at evaluation entry and only grows capacity at a new high-water mark. All helpers overwrite every derivative; constants clear every element before setting a variable seed. No slot is recycled within an evaluation, so outputs cannot alias operands, even repeated operands such as mul(q1, q1). Expressions, operands, intermediate arithmetic and derivative accumulation order are unchanged. No model-equation, tolerance, timestep, solver or per-circuit changes.

Each device has two lazy-growing workspaces. Static stamps use loadWorkspace because their cached charge Duals live until the next static load. Noise, dynamic stamps, accepted-point evaluation and uncached charge evaluation use evaluationWorkspace, whose Duals are consumed synchronously. Temperature/reset clears the cached load references as before; retained capacity is safe because every subsequent evaluation fully writes used slots. Devices never share storage. Retained memory per device increases to two expression high-water marks in exchange for removing repeated object churn; this is not a claim of lower live heap.

## RED / GREEN

The new test counts explicit new Array(9/11) derivative constructions in 80 warmed loads across two devices (TD off/on and opposite polarities). Every such array belongs to exactly one new Dual. Array.from result-row containers are excluded by binding it to the native constructor. The test first visits both depletion paths, then varies bias during measured loads.

Unchanged base RED: 18,840 paired Dual/derivative-array constructions, expected zero. Head GREEN: zero. This excludes warmup, evaluation wrappers, result-row arrays and typed Jacobians; it is not a total heap measurement. The initial probe also counted 80 Array.from row containers; the final test excludes those and was rerun RED on base before GREEN on head.

Two additional tests compare binary64 charge-stamp hashes with and without interleaved noise/dynamic evaluations at different voltages and another device's stamp. They cover temperature changes, reset, repeated loads, accepted steps and TD off/on. The existing broad fingerprint also covers polarity, limiting, avalanche, high injection, instance scaling and charge/noise quantities.

## Identity

The unchanged mandated base matches the current reference, not the historical round-6 result. Existing stamp fingerprint 3324cdb29c46ea0b0be79f64b9a06a767eba5549d997e193df9221f0634944db passes before and after. All six unprofiled timing runs and both profiled runs have waveform SHA256 361251b58101652f07fbdc64abdfb3ec8c8a941f92618420b32a2abc2a9a43f7, 40,545 rows, 40,544 accepted steps, zero rejected steps, 85,851 transient Newton iterations and 31 DC Newton iterations. Fixture SHA256 d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. Full convergence records are in the paired JSON.

## Every unprofiled timing, losses included

Command before and after: `spice-heavy node benchmarks/performance/dff-1310.mjs 3`. Sequential groups, unchanged full deck, no extra process warmup, same benchmark hashing outside the simulation timer.

| Run | Before seconds | After seconds |
| --- | ---: | ---: |
| 0 | 36.048163667 | 39.513938166 |
| 1 | 35.097760834 | 36.322910250 |
| 2 | 35.688225875 | 45.855921000 |
| Median | 35.688225875 | 39.513938166 |

Measured median change is +10.7198% (slower). Every after run is slower than every before run. No wall-time speedup, causal regression attribution or ngspice superiority is claimed on this noisy host. The verified improvement is elimination of repeated Dual/derivative-array construction, not elapsed time. The profile below also shows increased VBIC time despite lower GC time. Independent review must consider this loss. ngspice was not remeasured; the #1309 waveform mismatch remains and #1310 stays open.

## Matching CPU/heap profile buckets

Command before and after: `spice-heavy node --heap-prof --heap-prof-dir=<scratch>/<phase>-profile --cpu-prof --cpu-prof-dir=<scratch>/<phase>-profile --cpu-prof-name=cpu.cpuprofile benchmarks/performance/dff-1310.mjs 1`.

Whole-process timeDelta-weighted stack samples include startup and hashing, separate from unprofiled timings. Bundle coordinates are mapped using the matching base/head build maps via Node's module.SourceMap.findEntry (zero-based CPU profile line/column). Classification precedence matches round 7: GC frame, any devices/vbic.ts or vbic-temperature.ts frame, any mna frame, any solver frame, charge/integration/accept function name, other. GC is not attributed to an allocator; sampling and scheduling gaps can inflate buckets. Retained-heap files are not a churn counter.

| Bucket | Before seconds (%) | After seconds (%) |
| --- | ---: | ---: |
| VBIC | 27.435879 (80.26%) | 30.850487 (88.05%) |
| GC | 3.949643 (11.55%) | 1.220924 (3.48%) |
| stamping | 0.921496 (2.70%) | 1.041891 (2.97%) |
| factorSolve | 0.609593 (1.78%) | 0.572163 (1.63%) |
| acceptedPointCharge | 0.103501 (0.30%) | 0.070330 (0.20%) |
| other | 1.163804 (3.40%) | 1.282913 (3.66%) |
| Total | 34.183916 | 35.038708 |

## Verification

- pnpm install --frozen-lockfile passed.
- pnpm build passed before and after. Unchanged chunk-size warnings remain.
- pnpm lint passed.
- pnpm -C packages/core exec vitest run src/devices/vbic-allocation.test.ts passed on base, including the fingerprint.
- pnpm -C packages/core exec vitest run src/devices/vbic-dual-workspace.test.ts failed as expected on base (18,840 versus zero).
- pnpm -C packages/core exec vitest run src/devices/vbic src/mna passed on head: 331 tests in 23 files, including GREEN and fingerprint.
- spice-heavy pnpm test exited 1: 5,551 passed, 10 expected failures, 8 skipped, one 30-second timeout in transient-convergence.test.ts (half-wave rectifier). 414 files passed, one skipped. It is unrelated to VBIC.
- pnpm -C packages/core exec vitest run src/analysis/transient-convergence.test.ts passed both tests on isolated rerun, rectifier 9,309 ms. No timeout changes were made. Exact-head CI is authoritative for the full gate.

Only the model's allocation plumbing, its new regression test and these explicitly requested round-8 reports change. No raw logs, profiles or scratch scripts are committed.

## Remediation: typed slabs (supersedes original head above)

The revised workspace uses Float64Array slabs of 256 derivative rows and stable per-Dual subarray views instead of holey ordinary arrays. Old views survive slab growth. Arithmetic, expression order and two-workspace cached-charge ownership remain unchanged. Slab capacity is allocation granularity, not circuit-dependent tuning. Retained memory is still a tradeoff, not a lower-live-heap claim.

Command: `spice-heavy node benchmarks/performance/dff-1310.mjs 3`, alternating base/slab batches. Same Node/OS/fixture as above. Complete matching dist trees were retained locally to avoid rebuilding between timings.

| Batch | Phase | Run 0 s | Run 1 s | Run 2 s |
| --- | --- | ---: | ---: | ---: |
| 0 | base | 29.824331958 | 27.050253542 | 40.369860584 |
| 0 | slab | 41.382253709 | 28.656063458 | 46.647203833 |
| 1 | base | 24.501982250 | 24.678742125 | 22.771497958 |
| 1 | slab | 21.662883292 | 23.680807500 | 23.897284917 |
| 2 | base | 22.275897791 | 19.403888917 | 19.782294542 |
| 2 | slab | 18.587173458 | 18.422372875 | 18.316839583 |

Pooled medians (nine each): base 24.501982250 s; slab 23.680807500 s; change -3.3515%. No completed runs discarded. All 18 retain the identity/convergence records above.

Every exploratory pilot, chronological order, one unchanged full-deck run each:
- Slab: 31.747830792 s.
- Base: 26.491011917 s.
- Packed-double ordinary arrays (push NaN instead of holey allocation): 36.034515833 s; not selected.

Shared-host caveat: a strong downward time trend is visible. Slab loses the first batch and both variant pilots lose to the base pilot. Pooled medians satisfy the requested gate, but do not establish a causal speedup or eliminate regression risk. Independent review must repeat. The first slab batch launch failed before simulation because the initial build snapshot omitted split chunks; complete dist snapshots fixed it. The completed first base batch was retained, not rerun or discarded.

RED/GREEN rerun: base 18,840 ordinary derivative-array constructors versus expected zero; slab zero ordinary derivative-array and typed-slab backing constructors in 80 warmed loads. Existing per-node typed Jacobians, row containers and warmup are excluded, not eliminated. Stable subarray views are created during workspace growth; this is not a total heap counter. An intermediate overbroad typed-array counter also counted 640 unrelated Jacobians (19,480 on base); the final counter excludes those and RED was rerun.

- `pnpm build`: passed on candidate; base core build passed.
- `pnpm lint`: passed on candidate.
- `pnpm -C packages/core exec vitest run src/devices/vbic src/mna`: 331 passed in 23 files.
- Identity/workspace targeted rerun: 5 passed in 2 files, including unchanged stamp hash.
- `spice-heavy pnpm test`: all workspace suites passed; core 5,552 passed, 10 expected failures, 8 skipped.

No new profile claim: the profile table above describes the original rejected ordinary-array head only. Exact-head CI and independent review remain required before merging. #1310 stays open; #1309 and ngspice comparison are unchanged.
