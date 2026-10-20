---
"@spice-ts/wasm": minor
---

Add bounded fixed-grid transient simulation for static junction diodes with R/C/L/V/I and SIN sources. Reuse core diode stamps and Newton iteration over the WASM linear solver, with accepted static-current trapezoidal history and structured model/work-limit errors. Only IS, N and RS diode model parameters are supported; charge and breakdown parameters remain unsupported. This slice retains the passive WASM time grid, not core's adaptive timestep/breakpoint driver, so it does not promise identical-timepoint core waveform parity.
