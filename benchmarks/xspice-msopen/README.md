# XSPICE msopen parity

Run from the repository root with ngspice-47 on PATH:

```
pnpm exec tsx benchmarks/xspice-msopen/compare.ts
pnpm exec tsx benchmarks/xspice-msopen/compare.ts --update-reference
pnpm -C packages/core exec vitest run src/devices/xspice/msopen.test.ts
```

The first command checks live ngspice output. The second also regenerates the
numeric reference used by the unit test. Each case uses identical netlist bytes
in both simulators. The observer runs the deck's OP and AC analyses and exports
ASCII raw data; no component or model is changed for either simulator.

The fixture is an mlin terminated by msopen behind a 50-ohm source resistor.
The sweep is `.ac dec 20 1e8 2e10` (47 points). Variants cover all three
`msopen_model` values and zero metal thickness. The archived JSON contains each
exact netlist and ngspice's OP values and complex line-input voltage samples.
The harness checks the matched frequency grid, exact OP equality and maximum
per-point magnitude, phase and complex relative errors against 1e-4. Phase
error is wrapped modulo 360 degrees and divided by the absolute reference
phase; these fixtures do not contain a zero phase point.

Supported scope is quasi-static `model=0`, dispersion `disp=0` and open-end
`msopen_model=0` (Kirschning), `1` (Hammerstad), or `2` (Alexopoulos).
`model` and `msopen_model` are different selectors. `tand`, `rho`, and `d` are
accepted for compatibility but unused by msopen, as in ngspice. Alexopoulos is
calibrated near er=9.9; ngspice warns when abs(er-9.9)>0.2. This implementation
does not emit that warning. The benchmark uses er=9.8.

DC is an exact open circuit. Transient is deliberately rejected with
`UNSUPPORTED_XSPICE_MSOPEN`, rather than copying upstream's silent no-op in
transient. Other quasi-static/dispersion selectors and unknown end models use
the same structured unsupported error. There is no claim of support for those
modes, transient capacitance, or physical accuracy outside the upstream model.

Runtime measurements include different process boundaries and are not speed
claims. All source and licence details are in ../SOURCES.md.
