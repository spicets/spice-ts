# Embedded PWM and power circuits (#1889)

Seven original project-authored MIT decks: PWM RC DAC, PWM RLC output,
complementary MOS half-bridge, diode-clamped inductive load, PNP high-side
driver, ideal-switch buck and ideal-switch boost. These use idealized sources,
switches and simplified device models. They are not hardware validation or
board designs; boost output can exceed its 3.3 V input. No external models
or netlists were copied. See [SOURCES.md](../SOURCES.md).

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm build
spice-heavy pnpm exec tsx benchmarks/embedded-power-1889/run.ts
node --test benchmarks/embedded-power-1889/report.test.mjs
```

The runner rebuilds clean core and supplies identical deck bytes to ngspice-47
and spice-ts. Each median uses three cold wall-clock runs, including process
startup and adapter overhead, not solver-only time. The prior baseline had no
power bucket or measured runtimes; no speedup is claimed. The unchanged
corpus-f 1% full-scale normalized maximum error criterion with uniform floors
is used. ngspice is interpolated to spice-ts time points. The receipt reports each signal's absolute max and RMS errors. Pointwise relative max/RMS and excluded zero references are in the
receipt; they may be large near zero even for a match.

<!-- BEGIN GENERATED RESULTS -->
## Observed results

** ngspice-47 : Circuit level simulation program; spice-ts 0.4.0; Node v22.23.4; darwin 27.0.0 arm64, Apple M5 Pro.

| Deck | Outcome | Worst normalized | ngspice / spice-ts median (ms) |
|---|---|---:|---:|
| pwm-rc-dac | matched | 6.83e-13 | 49.30 / 1986.55 |
| pwm-rlc | matched | 6.78e-13 | 45.40 / 2218.97 |
| mos-half-bridge | matched | 0.000568 | 37.75 / 2168.45 |
| diode-inductive | matched | 0.00121 | 47.61 / 2358.65 |
| bjt-high-side | matched | 0.00112 | 46.71 / 2460.85 |
| switch-buck | matched | 0.0000395 | 40.02 / 2293.02 |
| switch-boost | matched | 0.000484 | 43.23 / 2877.05 |

Matched: 7 of 7. All outcomes, including failures, are shown above.
Times include process startup and adapter overhead; they are not solver-only timings.
<!-- END GENERATED RESULTS -->

The receipt contains per-signal metrics, individual timings, errors and engine failures. Results are a single-machine observation, not hardware proof. The offline test verifies 20 unique deck hashes across all three buckets.
