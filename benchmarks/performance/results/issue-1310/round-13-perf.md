# #1310 round 13: hand-written scalar VBIC evaluator

Refs #1310. Base d101a6726eb3eb4627cf9d1586332e5475ad4034. Sources/licences remain in benchmarks/SOURCES.md. No netlist, solver, option, tolerance, timestep, temperature mapping or existing test changes.

## Design and oracle

The new vbic-scalar.ts computes scalar values once and explicit analytic branch partials. Preallocated typed arrays and structural value/derivative outputs replace the hot Dual expression tree. The column loop contains hand-written partial equations, not runtime automatic differentiation. Two instance workspaces separate retained load charges from synchronous evaluations. Arithmetic staging follows the reference, including exponential clamps, sqrt/log/pow floor conventions and the intentionally rounded ngspice VTF slope.

Scalar coverage: transport ITF/ITR and qb, ideal/nonideal junction currents, BE/BC/substrate depletion and diffusion charges, avalanche, RCI/RBI/RBP quasi-saturation and epi, substrate parasitic, WBE/WSP partition, ITF/XTF/VTF bias dependence, temperature mapped parameters, both normalized polarities, instance scaling and gmin.

Retained Dual path: TD > 0 excess-phase models (entire electrical evaluation), noise analysis (unchanged Dual evaluator). Selection is based only on model TD and analysis, never circuit/netlist identity. The scalar output shape has seven rows and nine branch variables, so TD's extra state rows deliberately remain on Dual. Noise analysis also stays unchanged, although the oracle checks the scalar intrinsic noise quantities. The existing Dual evaluator body is unchanged.

The new test first failed on the missing scalar module, then passed. It compiles the untouched production Dual evaluator directly from vbic.ts. 9,600 points and 2,016,000 value/partial comparisons cover both normalized polarities, -40/27/125 C, default/no-substrate and rich substrate models, the actual DFF model card, high injection (IKF/IKR/IKP down to 1e-6), WSP 0/0.3/1, quasi-saturation, avalanche, independent seeded biases, forward/reverse/zero/signed zero, and depletion boundaries +/-1e-15. Instance scale 1/2 and gmin 0/1e-12. Every residual, charge and intrinsic noise value and all nine partials are compared. Relative tolerance 1e-12 with absolute floor 1e-42. Worst absolute and relative errors both zero. A second test verifies output/buffer reuse.

## Predeclared gate: GO

Ten alternating BH/HB pairs. Each run: `spice-heavy /usr/bin/time -p node benchmarks/performance/dff-1310.mjs 1`. Complete saved base/head core dist trees restored before each run. CPU is whole-process user+sys including startup and output hashing, excluding queue waiting, at /usr/bin/time precision 0.01 s. Wall below is the unchanged simulation timer; whole-process real time is also retained in JSON. No extra warmups, no discarded runs. Node v22.23.1 on a shared uncontrolled Mac. Independent replication remains required, and this is not an ngspice superiority claim.

| Pair | Order | Base wall s | Head wall s | Base CPU s | Head CPU s |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 | BH | 17.185925292 | 7.885099750 | 17.68 | 8.32 |
| 1 | HB | 16.855194583 | 10.753005291 | 17.52 | 11.36 |
| 2 | BH | 16.373358167 | 7.802007917 | 16.87 | 8.23 |
| 3 | HB | 15.799886458 | 7.843492833 | 16.29 | 8.26 |
| 4 | BH | 15.779208667 | 7.816862875 | 16.27 | 8.25 |
| 5 | HB | 15.796325625 | 7.846522708 | 16.31 | 8.28 |
| 6 | BH | 15.827938458 | 7.754459042 | 16.33 | 8.20 |
| 7 | HB | 16.117460584 | 7.839588667 | 16.63 | 8.28 |
| 8 | BH | 15.955243000 | 7.822718667 | 16.43 | 8.26 |
| 9 | HB | 20.130070042 | 8.498626125 | 20.81 | 9.03 |

Median simulation wall: 16.036351792 -> 7.841540750 s (-51.101467%). Median process CPU: 16.53 -> 8.27 s (-49.969752%). Zero CPU/wall pairwise losses. Whole-process real medians 16.275 -> 8.080 s. GO threshold (CPU improvement >=10%, <=2 CPU losses, wall not worse) passes. All 20 runs retained.

## Identity

All twenty timed runs and both profile runs retain waveform SHA256 361251b58101652f07fbdc64abdfb3ec8c8a941f92618420b32a2abc2a9a43f7, fixture SHA256 d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6, 40,545 rows, DC Newton 31, transient Newton 85,851, accepted 40,544, rejected 0. Full convergence objects are retained in JSON. Existing default stamp fingerprint bd942ae769ac72c14e81f01dc017fcc2eb2405613f1d1865dbccf12d42c06eea passes. No new ngspice comparison was required because output is bit-identical. Prior accuracy limitations remain, not claimed fixed.

## Profiles

`spice-heavy node --cpu-prof --cpu-prof-dir=<scratch> --cpu-prof-name=r13-<version>.cpuprofile benchmarks/performance/dff-1310.mjs 1`

Unweighted inclusive stack samples, deduplicated by frame label per sample. Resolve function-start positions using matching dist source maps and enclosing TypeScript AST function. Startup/hash/GC remain in total. No timeDelta weighting. Inlining and sampling limit attribution precision.

| Frame | Base | Head |
| --- | ---: | ---: |
| Complete process | 4122 | 2034 |
| Original Dual evaluate | 2554 | 0 |
| VBIC.evaluate selection wrapper | 0 | 756 |
| evaluateScalar | 0 | 743 |

Profile-run simulation times 18.795255666 -> 8.930544375 s. These separate instrumented runs are not gate observations or discarded runs.

## Verification

- pnpm install --frozen-lockfile: passed.
- pnpm build: passed base and head.
- pnpm lint: passed.
- pnpm -C packages/core exec vitest run src/devices/vbic src/mna: 334 passed, 25 files.
- spice-heavy pnpm test: passed. Core 5,593 passed, 10 expected failures, 8 skipped. Other workspace suites passed; root Node tests 221 passed, 4 skipped, zero failed.
- Exact-head GitHub CI and independent review remain required. No merge by worker.

Only the specifically requested round-13 receipts are committed. Raw logs, runner and profiles remain in scratch.
