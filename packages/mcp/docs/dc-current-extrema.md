# Sampled DC branch-current extrema

`spice_dc_metrics` accepts `includeCurrentExtrema: true` with `currentSignal: "i(Vin)"` for an independent voltage-source DC sweep. The usual `request`, `sweptSource`, and `output` remain required. No `sweepPoints` or current levels are needed. The simulation runs once.

The optional result is `currentExtrema: { min: { currentA, sweepPoint }, max: { currentA, sweepPoint } }`. Currents are signed amperes in the simulator's branch-current convention; coordinates are swept-source voltages in volts. The extrema are selected **only from sampled sweep knots**, without interpolation or a claim about extrema between samples. When values tie, the first sample in the original traversal wins, including for descending sweeps.

The option may be combined with spots and crossings. With the option absent or false, the default response is unchanged. A true flag requires a valid available current signal; malformed or nonfinite traces, non-voltage-source sweeps, and invalid flags return structured errors.

For example, a 1 kΩ resistor from `out` to ground driven by `Vin`, swept from -2 V to 2 V in 1 V steps, has `i(Vin) = -V(out)/1000`: minimum -0.002 A at 2 V and maximum 0.002 A at -2 V.
