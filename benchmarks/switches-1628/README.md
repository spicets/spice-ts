# S/W truncation parity (#1628)

Run `spice-heavy pnpm exec tsx benchmarks/switches-1628/compare.ts` from the repo root with ngspice-47 installed. It runs the byte-identical original deck twice, checks determinism, then interpolates ngspice v(10) onto spice-ts points. No netlist, tolerance or option changes. Source/licence: existing corpus-f ngspice fixture provenance in `benchmarks/SOURCES.md` (manual example, pinned upstream revision).

Measured on macOS arm64, Node 22.23.1, ngspice-47 with KLU:

| Measurement | Before (27b5805b) | After |
| --- | ---: | ---: |
| ngspice points | 2514 | 2514 |
| spice-ts points | 2607 | 2514 |
| v(10) max absolute error (V) | 0.7198560132066533 | 3.3203691532368573e-17 |
| v(10) max error / reference peak | 0.7198560132066533 | 3.3203691532368573e-17 |
| v(10) RMS absolute error (V) | not recorded | 6.622221971631174e-19 |

Uniform corpus-f threshold: 0.01. Both original ngspice runs have identical time/v(10) arrays, zero disagreement, and binary waveform SHA256 `a150daf8076cca7485fc5ffd15547f5f4673f2c40d7ee270f9675aeebcc5bf9f`. Fixture SHA256: `93417fb9b2aed529530fdedc3e008ffe09bae7230fc16d6bb50a2dfd4fe44270`.

CSW's accepted hysteresis state was classified as untruncated transient state because its complete no-op DEVtrunc port was missing. Node-voltage LTE then refined an algebraic discontinuity, changing the global grid. The fix exposes the no-op port rather than changing switch thresholds or relaxing the comparison.

RED/GREEN: `pnpm -C packages/core exec vitest run src/devices/switch.test.ts src/devices/switch-csw-truncation-1628.test.ts src/analysis/transient-node-truncation.test.ts`. New reduced-deck test fails before the fix and passes after; 24 targeted tests pass. References were captured independently with `ngspice -n -b -r reference.raw reduced.cir` on the test's unchanged deck. Existing switching-time upper bounds allow only floating-point rounding (relative 1e-12), as the neighbouring assertion already did.

`pnpm build` and `pnpm lint` passed. Local `spice-heavy pnpm test` exceeded the 120-second command budget under shared-host load and was terminated; no full local pass is claimed. Required CI on the PR's exact head is the full gate. Corpus-f outcomes are intentionally untouched. No speed comparison is claimed.
