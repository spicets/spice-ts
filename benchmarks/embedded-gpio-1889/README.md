# Embedded/maker corpus: GPIO slice (#1889)

Six original MIT project-authored toy circuits model a 3.3 V MCU pin with an
ideal voltage source: LED drive, open-drain output, BJT switch, MOSFET load
switch, inductive load with flyback diode, and a simple RC debounce filter.
These are illustrative idealised circuit-level examples, not validated board
schematics or vendor device models. All six were selected before running either
engine. Both receive the identical committed deck bytes. No third-party netlist
or model card is copied. See [SOURCES.md](../SOURCES.md).

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm build
spice-heavy pnpm exec tsx benchmarks/embedded-gpio-1889/run.ts
node --test benchmarks/embedded-gpio-1889/report.test.mjs
```

The committed test-consumed `report.json` records fixture hashes, machine,
versions, commands, full per-signal comparison metrics and errors, raw outcome
classifications and runtime. The shared corpus reducer uses the same 1% maximum
full-scale-normalized error rule and uniform voltage/current floors as corpus-f;
ngspice is interpolated to spice-ts time points. This is not a guarantee of
waveform agreement at every reference time point. See `matchRule` in the report
for details; RMS/absolute metrics are retained under `comparisons`.

## Observed results

On the machine and versions in `report.json`, all six completed on both engines
and met the shared criterion. The initial baseline for these new fixtures was no
corpus or measurement; no speedup from this change is claimed. Worst normalized
errors and cold process wall times are below. Times include process startup and
adapter overhead, are one sample each, and do **not** predict browser or
steady-state solver performance.

| Deck | Outcome | Worst normalized error | ngspice ms | spice-ts ms |
|---|---|---:|---:|---:|
| gpio-led | matched | 0.000347 | 82.87 | 1052.81 |
| gpio-open-drain | matched | 0.00000759 | 36.42 | 844.01 |
| gpio-npn-switch | matched | 0.0000074 | 48.50 | 704.12 |
| gpio-mosfet-load | matched | 0.0000354 | 32.67 | 757.12 |
| gpio-flyback | matched | 0.000681 | 43.65 | 635.02 |
| gpio-debounce | matched | 3.42e-13 | 30.89 | 710.98 |

This is a **partial GPIO bucket**, not the requested 20–30 circuit corpus.
Buck/boost, H-bridge, ADC anti-alias, RLC and additional embedded circuits remain
in #1889. No simulator gap was found in these six; outcomes would include losses
rather than filtering them out.
