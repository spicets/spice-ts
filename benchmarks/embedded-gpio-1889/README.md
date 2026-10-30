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

The committed `report.json` is the authoritative source of observed outcomes,
errors and timings; inspect its `fixtures` array for all six decks, including
any losses. The initial baseline was no corpus or measurement; no speedup is
claimed. Timings are single samples in fixed engine order, include process
startup and adapter overhead, and do **not** predict browser or steady-state
solver performance.

The runner rejects dirty core inputs, removes the ignored core build output,
rebuilds it, and records both the clean core tree and built bundle SHA-256.

This is a **partial GPIO bucket**, not the requested 20–30 circuit corpus.
Buck/boost, H-bridge, ADC anti-alias, RLC and additional embedded circuits remain
in #1889. Outcomes include losses rather than filtering them out.
