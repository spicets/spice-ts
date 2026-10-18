# #1310 round 6: interleaved generic stamp traces

Refs #1310; it remains open. Base `729b2b89291d072a1291ebde9bc0adc04fe3aeaf` includes round 5. The unchanged fixture and its source/licence remain those recorded in `benchmarks/SOURCES.md`.

## Profile-selected slice

The full unchanged deck was profiled with `spice-heavy node --cpu-prof --cpu-prof-dir=<scratch>/r6-profiles --cpu-prof-name=before.cpuprofile benchmarks/performance/dff-1310.mjs 1`. V8's bundled function-start line/column coordinates were resolved by decoding the matching build's source map before rebuilding. The generic `stampG` closure maps to `packages/core/src/mna/assembler.ts:376` on base (2.294084 sampled self seconds), and line 373 after (1.967080 seconds). It calls `slotOf` on every stamp. Other generic self frames include `buildCompanionSystem` (0.996031 before, 0.853748 after) and `stampStaticDevices` (0.963416 before, 0.869583 after).

One slice changes the trace data shape from three Int32Arrays (rows, columns, slots) to one interleaved Int32Array of row/column/slot triples. A cache hit reads one array property rather than three; constructing/growing a trace allocates one buffer rather than three. Element payload bytes are unchanged. Coordinates retain the same Int32 representation, cache bounds and fallback lookups. No numerical accumulation is reordered, and no device, timestep, tolerance or circuit-specific code changes.

VBIC remains the largest CPU bucket. No forbidden VBIC or driver file was edited.

## RED/GREEN and numeric identity

`pnpm -C packages/core exec vitest run src/mna/stamp-trace-allocation.test.ts` was RED before production edits: 9 Int32Array constructions versus the expected 3. The workload stamps 400 alternating G/C entries, growing the trace twice. After interleaving it is GREEN at 3, a 66.67% reduction in that specific construction counter, not all heap allocations. Replaying the trace adds zero constructions. Existing cache tests cover reordered/shorter/longer sequences, pass kinds, cache limits, invalid positions and topology invalidation.

`pnpm -C packages/core exec vitest run src/mna src/devices/vbic` passed 254 tests in 20 files. This includes the existing binary64 stamp fingerprint `3324cdb29c46ea0b0be79f64b9a06a767eba5549d997e193df9221f0634944db`.

Every one of the six timed full-deck runs has identical fixture hash, waveform hash, row count and convergence counters:

- Fixture SHA256 `d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6`.
- Waveform SHA256 `fa930f7d1b79d8ce7f05a5de675090f44ff445b143b18a85075f530dd52b19fc`.
- 43,273 rows; 43,272 accepted steps; 3,139 rejected steps; 100,724 transient Newton iterations; 31 DC Newton iterations.

## All timed runs, losses included

Command before and after: `spice-heavy node benchmarks/performance/dff-1310.mjs 3`. Node v22.23.1, macOS 27.0.1 arm64, uncontrolled shared host, sequential groups, no extra warmup. The JSON includes every run's complete convergence record.

| Run | Before seconds | After seconds |
| --- | ---: | ---: |
| 0 | 56.320261292 | 44.350986542 |
| 1 | 54.300635417 | 60.024070291 |
| 2 | 53.444069625 | 60.640548834 |
| Median | 54.300635417 | 60.024070291 |

The measured median regresses 10.5403%. No wall-time speedup is demonstrated. One after run is faster; both remaining after runs are slower than every before run. The independently verified benefit is fewer trace buffers and fewer array-property reads on a cache hit, not faster simulation in these noisy measurements. Historical ngspice median 1.738080 seconds was not remeasured; spice-ts remains much slower. The known #1309 mismatch versus ngspice remains, so this is not a correctness-parity claim.

## Before/after profile buckets

Whole-process timeDelta-weighted stack samples include startup and waveform hashing outside simulate. They are not CPU cycles and scheduling gaps can inflate them. GC is not causally attributed. Classification precedence and all MNA self frames are in the JSON. Profiled process totals are 98.502000 seconds before and 95.154167 after; these are separate from the unprofiled timed runs above.

| Bucket | Before seconds (%) | After seconds (%) |
| --- | ---: | ---: |
| VBIC evaluate/derivatives | 52.157759 (52.95%) | 49.338473 (51.85%) |
| GC | 24.335332 (24.71%) | 26.051786 (27.38%) |
| Stamping/assembly | 10.577188 (10.74%) | 9.736249 (10.23%) |
| Accepted-point/charge | 5.945429 (6.04%) | 5.431960 (5.71%) |
| Matrix factor/solve | 4.859542 (4.93%) | 3.990573 (4.19%) |
| Other/startup/driver/hash | 0.626750 (0.64%) | 0.605126 (0.64%) |

## Verification

- `pnpm install --frozen-lockfile`: passed.
- `pnpm build`: passed before and after.
- `pnpm lint`: passed.
- Targeted tests: 254 passed, including allocation GREEN and baseline stamp fingerprint.
- `spice-heavy pnpm test`: tool timed out at 420 seconds; the log ends with WASM vitest terminated by SIGTERM after earlier packages ran. The full suite is not claimed green. Exact-head GitHub CI is the authoritative gate.

No raw profiles, logs or scratch probes are committed. `round-6-perf.json` is the machine-readable performance result with complete timings, identity, buckets and commands.
