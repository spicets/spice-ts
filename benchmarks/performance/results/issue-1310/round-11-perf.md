# #1310 round 11: analytic diode/junction-current partials

Refs #1310. Base 5db8e29000d27848bee5c3251b1accad1d371c4a. Sources/licences remain in benchmarks/SOURCES.md. No solver, fixture, timestep, tolerance or option changes.

## Result and scope

No measured speedup. The final six-pair median is 16.8382905625 -> 16.90365625 s (+0.388197%). Two of six pairs lose. This is a bounded structural conversion, not a performance win or a claim of superiority over ngspice. Independent review should weigh whether to land this slice without a measured runtime benefit.

The diode helper now computes one branch partial directly and scatters it into its existing buffer. Its scalar exponential, clamp and partial arithmetic order are unchanged. All callers supply independent branch coordinates, including junction leakage and the same helper calls feeding transport; transport ITF/ITR, avalanche and quasi-saturation expressions themselves are unchanged. The inactive partial retains its original zero arithmetic. An initial TypedArray.fill scatter regressed; the final simple loop avoids that API overhead on these tiny buffers. Both series are retained below and in JSON, with no completed run discarded.

## Main profile before implementation

    spice-heavy node --cpu-prof --cpu-prof-dir=<scratch> --cpu-prof-name=base.cpuprofile benchmarks/performance/dff-1310.mjs 1

Same command for head. Match each generated chunk to its own dist source map using node:module SourceMap.findEntry. Count each frame once per sample in the inclusive stack, without timeDelta weights. Includes startup, GC and waveform hashing. Inlining limits attribution of evaluate subexpressions. Current-main diode has 139/2136 evaluate samples, a meaningful bounded slice.

| Inclusive frame | Base | Final head |
| --- | ---: | ---: |
| Whole process | 3407 | 3593 |
| evaluate | 2136 | 2243 |
| diode | 139 | 118 |

Base top self samples: evaluate 468, scale 274, add 165, diode 139, depletionCharge 115, Dual.constant 107. A smaller diode sample count does not establish an end-to-end speedup; evaluate inclusive samples increase.

## Complete-evaluator oracle

The exact pre-round-11 N-wide Dual diode helper is retained test-only and substituted into the full evaluator through the installed TypeScript transpiler. The existing depletion oracle remains a separate independent substitution. No production test hook. Every residual, charge and noise value and derivative is compared.

Per slice: 10,800 points and 2,754,000 scalar comparisons. Total: 5,508,000 comparisons, worst relative and absolute errors both zero. Relative tolerance 1e-12 with absolute floor 1e-42. Seeded independent biases include forward/reverse/saturation, zero/signed zero, depletion boundaries and both exponential clamp endpoints with neighbors. Both polarities in normalized branch coordinates, -40/27/125 C, with/without substrate and excess phase, and nondefault supported transport/avalanche parameters. Existing stamp tests separately exercise PNP transformation. This is an identity oracle for this slice, not an independent validation of unchanged physics. No RED correctness claim is made for this performance refactor.

## Balanced timing series

Each entry is a fresh `spice-heavy node benchmarks/performance/dff-1310.mjs 1`. Six pairs per implementation, alternating order, no warmup. Complete matching saved base/head dist trees restored before each run. Queue wait and waveform hashing are outside the simulation timer. Node v22.23.1, Darwin arm64 on a shared uncontrolled host. JSON retains every output and counter.

### initial_fill

| Pair | Order | Base s | Head s |
| --- | --- | ---: | ---: |
| 0 | base, head | 15.604874709 | 16.321061166 |
| 1 | head, base | 15.575712709 | 16.267494000 |
| 2 | base, head | 15.614047917 | 16.211610750 |
| 3 | head, base | 16.208637750 | 16.328674542 |
| 4 | base, head | 16.293241125 | 17.047932708 |
| 5 | head, base | 16.371158375 | 17.217536625 |
| Median | | 15.911342834 | 16.324867854 |

Median change +2.598932%. Losing pair indices [0, 1, 2, 3, 4, 5].

### final_loop

| Pair | Order | Base s | Head s |
| --- | --- | ---: | ---: |
| 0 | base, head | 16.382846375 | 16.331580042 |
| 1 | head, base | 16.453287792 | 16.285259875 |
| 2 | base, head | 16.715819875 | 16.875891333 |
| 3 | head, base | 16.960761250 | 16.931421167 |
| 4 | base, head | 17.040164666 | 17.243519958 |
| 5 | head, base | 17.572941208 | 17.467105459 |
| Median | | 16.838290562 | 16.903656250 |

Median change +0.388197%. Losing pair indices [2, 4].

## Identity and verification

All 24 timing outputs and all three profile outputs have waveform SHA256 361251b58101652f07fbdc64abdfb3ec8c8a941f92618420b32a2abc2a9a43f7. Fixture SHA256 d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. Each has 40,545 rows, 31 DC iterations, 85,851 transient Newton iterations, 40,544 accepted steps, zero rejected steps and zero retries. No ngspice rerun is needed for a changed-waveform exception because no waveform changed. Prior ngspice losses remain unchanged, not fixed.

Default device DC/AC/transient stamp fingerprint remains bd942ae769ac72c14e81f01dc017fcc2eb2405613f1d1865dbccf12d42c06eea. This is not a full-DFF stamp-stream fingerprint.

- pnpm install --frozen-lockfile passed.
- pnpm build passed on base and final head.
- pnpm lint passed on final head.
- pnpm -C packages/core exec vitest run src/devices/vbic src/mna: 333 passed, 24 files.
- spice-heavy pnpm test passed (exit 0): core 5,592 passed, 10 expected failures, 8 skipped; other workspace suites passed; root Node tests 221 passed, 4 skipped, 0 failed. Exact-head CI remains the authoritative publication gate.
- Independent exact-SHA review required. Worker does not merge.

Only the explicitly requested receipts are committed. Logs and profiles remain in scratch. Further analytic conversions are deferred to later cards.
