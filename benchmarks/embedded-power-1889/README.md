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
is used. ngspice is interpolated to spice-ts time points. Each row reports the
worst signal's absolute max and worst signal RMS, separately for voltage and
current. Pointwise relative max/RMS and excluded zero references are in the
receipt; they may be large near zero even for a match.

## Observed results

** ngspice-47 : Circuit level simulation program, spice-ts 0.4.0, Node v22.23.4; darwin 27.0.0 arm64, Apple M5 Pro.

| Deck | Outcome | Worst normalized | V max / RMS (V) | I max / RMS (A) | ngspice / spice-ts median (ms) |
|---|---|---:|---:|---:|---:|
| pwm-rc-dac | matched | 6.83e-13 | 2.24e-12 / 2.48e-13 | 2.26e-16 / 2.49e-17 | 32.67 / 533.40 |
| pwm-rlc | matched | 6.78e-13 | 2.24e-12 / 3.50e-13 | 8.60e-16 / 3.11e-16 | 30.47 / 509.33 |
| mos-half-bridge | matched | 0.000568 | 0.00244 / 0.000219 | 0.00000909 / 8.81e-7 | 25.83 / 486.47 |
| diode-inductive | matched | 0.00121 | 0.00678 / 0.00257 | 5.78e-7 / 5.47e-8 | 28.57 / 469.89 |
| bjt-high-side | matched | 0.00112 | 0.00620 / 0.000584 | 0.000174 / 0.0000248 | 23.54 / 454.65 |
| switch-buck | matched | 0.0000395 | 0.000197 / 0.0000188 | 1.21e-8 / 7.28e-9 | 28.85 / 464.22 |
| switch-boost | matched | 0.000484 | 0.00212 / 0.000220 | 0.0000173 / 0.00000962 | 25.58 / 420.94 |

All seven engines succeeded in this run; all seven matched under the stated
criterion. Each spice-ts median was slower in these startup-inclusive runs.
The receipt contains each signal's metrics, individual timings, errors, and
engine failures. Results are a single-machine observation, not hardware proof.
The offline test verifies 20 unique deck hashes across the six GPIO, seven
sensor and seven power decks; this is not a claim that all 20 match.
