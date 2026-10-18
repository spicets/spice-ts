# #1310 round 10: analytic depletion-charge partials

Refs #1310. Base 86de7107c8b198e7227ec8feb925f040a026d1cf. This is the first incremental analytic slice, not a replacement of the whole Dual evaluator. Raw numbers and verification limits are in round-10-perf.json. Fixture sources/licences remain in benchmarks/SOURCES.md. No fixture, solver, tolerance, timestep or option changes.

## Evidence first

Built the exact round-9 base and sampled the unchanged full DFF deck before implementation:

    spice-heavy node --cpu-prof --cpu-prof-dir=<scratch> --cpu-prof-name=r10-base.cpuprofile benchmarks/performance/dff-1310.mjs 1

Resolve function-start locations with the matching dist source maps using node:module SourceMap.findEntry; count inclusive stacks once per frame per sample. These are unweighted sample counts, not wall-clock time or the previous rounds' timeDelta-weighted buckets. Profiles include startup, output hashing and GC. Inlining prevents precise attribution of every evaluate subexpression.

| Inclusive frame | Base samples | Head samples |
| --- | ---: | ---: |
| Whole process | 3864 | 3639 |
| evaluate | 2467 | 2156 |
| depletionCharge | 510 | 114 |

Depletion accounts for 510/2467 evaluate samples, making it a meaningful bounded first slice. Base top self samples include evaluate 438, scale 276, Dual.constant 225, add 207, depletionCharge 146 and diode 135. GC has 356 self samples. Profiled simulate times were 17.691161750 -> 16.357993417 s. CPU shares alone do not establish speed; use the balanced series below.

## Change and oracle

Every supported BE/BC/substrate depletion integral now computes its scalar value and one branch partial directly, then scatters it once into the existing derivative buffer. The low-bias power-law branch and high-bias continuation retain the old arithmetic order. There are no intermediate Dual values or N-wide chain-rule passes inside this integral. Calls explicitly identify the independent branch coordinate. The remaining transport, avalanche and quasi-saturation expressions still use Dual and are future scope.

The test retains the exact pre-analytic Dual depletion expression as a test-only oracle. It substitutes that expression into the complete evaluator and compiles both versions with the installed TypeScript transpiler. This avoids a production test hook and duplication of the rest of the model. Every residual, charge and noise value and derivative is compared, including the effect of depletion on transport/base-charge expressions. This is an oracle for this selected slice, not an independent validation of unchanged equations.

10,800 points and 2,754,000 scalar comparisons cover seeded independent branch biases, forward/reverse/saturation/zero, signed zero, +/-1e-15 around all mapped depletion boundaries, both polarities in normalized branch coordinates, -40/27/125 C, ME/MC/MS=0/0.33/0.95 and FC=0/0.9/0.99, with and without substrate, excess-phase and supported transit-time parameters. RTH is exercised but electrically inert in the supported isothermal subset. Existing device tests separately cover actual PNP stamps and temperature mapping.

Tolerance: relative 1e-12 with absolute floor 1e-42. Worst observed relative and absolute errors: both zero. This is a performance change, not a reproduced correctness fix; no RED correctness claim is made.

## All balanced timing runs

Each entry is a fresh `spice-heavy node benchmarks/performance/dff-1310.mjs 1` process. Alternating pair order, no extra warmup. Saved complete matching base/head dist trees are restored before each run. Queue waiting and waveform hashing are outside the simulate timer. Node v22.23.1, Darwin 27.0.0 arm64, Apple M5 Pro; shared uncontrolled host.

| Pair | Order | Base s | Head s |
| --- | --- | ---: | ---: |
| 0 | base, head | 23.084268833 | 18.926379000 |
| 1 | head, base | 22.425646333 | 22.624212000 |
| 2 | base, head | 21.720284708 | 19.317812583 |
| 3 | head, base | 28.044069334 | 43.325399958 |
| 4 | base, head | 20.944529625 | 21.486520041 |
| 5 | head, base | 20.511750750 | 18.256998208 |
| Median | | 22.072965521 | 20.402166312 |

Median change: -7.569437%. Three pairs lose; the 43.3254 s head run is included. No completed run is discarded. The host variance is substantial; independent balanced replication is required. This does not close the roughly 20x ngspice gap or establish superiority.

## Identity and verification

All twelve timed outputs and both profile outputs have waveform SHA256 361251b58101652f07fbdc64abdfb3ec8c8a941f92618420b32a2abc2a9a43f7. Fixture SHA256 d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. All have 40545 rows, 40544 accepted advances, zero rejects/retries, 85851 transient Newton iterations and 31 DC iterations. DFF output is bit-identical to round 9. No changed-waveform accuracy exception is needed; previous ngspice losses remain unchanged and are not claimed fixed. A new ngspice run was not performed.

The existing default DC/AC/transient device stamp fingerprint remains bd942ae769ac72c14e81f01dc017fcc2eb2405613f1d1865dbccf12d42c06eea (`vbic-vtf.test.ts`). This is a device-test fingerprint, not a full DFF stamp-stream hash.

- pnpm install --frozen-lockfile: passed.
- pnpm build: passed base and head.
- pnpm lint: passed, including the final expanded oracle.
- pnpm -C packages/core exec vitest run src/devices/vbic src/mna: 332 passed, 24 files.
- spice-heavy pnpm test: attempted. Core passed 5562 tests with 10 expected failures and 8 skipped; other workspace vitest suites passed. The combined timing/full-suite terminal call reached its 420 s tool limit during root Node benchmark tests. The root suite did not finish. No local full-suite-green claim.
- Exact-head CI, including accuracy, and independent review remain the publication gate. The worker does not merge.

Requested receipts are the only committed evidence files. Raw logs/profiles stay in scratch. Remaining analytic conversion is deliberately deferred to the supervisor rather than expanding this slice.
