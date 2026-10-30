# Embedded sensor and ADC front ends (#1889)

Seven original project-authored MIT circuits use ideal voltage sources and
ideal passive components at or within a 3.3 V supply range. The thermistor is
a fixed 6.8 kOhm approximation at one operating point, not a temperature model.
The differential input models two signals, not an ADC. These examples are not
hardware validation, vendor models, or board designs. See [SOURCES.md](../SOURCES.md).
Both engines receive identical committed deck bytes. Decks were chosen before
running either engine.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm build
spice-heavy pnpm exec tsx benchmarks/embedded-sensors-1889/run.ts
node --test benchmarks/embedded-sensors-1889/report.test.mjs
```

The runner checks that core source is clean, rebuilds its bundle, records its
hash and runs each deck three times in fixed ngspice-then-spice-ts order. Each
engine receives the same byte buffer. Times below are medians of three cold
wall-clock samples, including startup and adapter overhead, not solver times.
The prior baseline was no sensor corpus and no measurements, so no speedup is
claimed. The rows report every outcome, including losses. `report.json` is the
authoritative receipt with hashes, individual timings, all signals, errors and
engine failures. Per-signal normalized errors include the reference peaks needed
to audit the summary. Results are one machine's observations, not a speed ranking.

The unchanged corpus-f 1% maximum full-scale-normalized error criterion and
uniform floors decide matches. ngspice is interpolated to spice-ts time points,
not vice versa. The table reports the worst signal max and worst signal RMS
absolute errors separately for voltage (V) and current (A). Pointwise relative
max and RMS, including exclusion of zero references, are in the receipt. These
relative errors can be large near zero even for a matched full-scale result.

## Observed results

| Deck | Outcome | Worst normalized | V max / RMS (V) | I max / RMS (A) | ngspice / spice-ts median (ms) |
|---|---|---:|---:|---:|---:|
| anti-alias | matched | 3.49e-13 | 1.12e-12 / 8.72e-14 | 1.15e-15 / 9.18e-17 | 17.26 / 280.09 |
| two-stage | matched | 3.42e-13 | 1.12e-12 / 7.92e-14 | 1.12e-15 / 7.96e-17 | 16.26 / 270.27 |
| loaded-divider | matched | 3.4e-13 | 1.12e-12 / 7.93e-14 | 1.12e-16 / 7.93e-18 | 17.79 / 298.86 |
| thermistor | matched | 3.4e-13 | 1.12e-12 / 7.92e-14 | 1.12e-16 / 7.93e-18 | 22.40 / 358.58 |
| differential | matched | 3.47e-13 | 3.05e-13 / 2.16e-14 | 3.12e-16 / 2.32e-17 | 20.78 / 612.57 |
| rlc-input | matched | 3.39e-13 | 1.12e-12 / 8.78e-14 | 2.28e-16 / 4.25e-17 | 29.33 / 429.37 |
| shunt-sense | matched | 3.39e-13 | 1.12e-12 / 7.93e-14 | 3.38e-14 / 2.39e-15 | 21.90 / 383.66 |

All seven ran successfully on both engines in this observation. There were no correctness losses under the stated criterion. Every observed spice-ts median was longer than ngspice in this startup-inclusive measurement. This bucket and the six GPIO decks cover 13 of the requested 20 circuits, not the complete corpus.
