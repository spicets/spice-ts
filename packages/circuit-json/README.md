# @spice-ts/circuit-json

Bidirectional conversion between tscircuit `circuit-json` documents and the spice-ts `CircuitIR`.

```ts
import { fromCircuitJSON, toCircuitJSON } from '@spice-ts/circuit-json';
```

`fromCircuitJSON` supports simple resistors, capacitors, inductors, diodes/LEDs, DC voltage/current sources, enhancement-mode MOSFETs, BJTs, source ports, source nets, and source traces. PCB, schematic, and CAD elements produce nonfatal `LAYOUT_ONLY` diagnostics. Unsupported simulation elements or parameters produce error diagnostics and no circuit value.

| circuit-json element | SPICE / IR mapping | Value |
| --- | --- | --- |
| `simple_current_source` | `I`, `{ waveform: 'dc', dc: current }` | `current` in amperes; `wave_shape: 'dc'` (default when omitted) |

`simple_current_source` uses the SPICE sign convention: positive current flows from the positive (`p`, first) terminal through the source to the negative (`n`, second) terminal. Thus `I1 0 n1 1m` with `R1 n1 0 1k` gives V(n1) = +1 V; reversing the source gives -1 V. Port order and connectivity are preserved. Export emits explicit `wave_shape: 'dc'`. Missing/nonfinite current and non-DC or extra waveform fields return `UNSUPPORTED_ELEMENT` with no circuit value. No current is inferred from display text, and a missing value never defaults to 0 A. Explicit finite zero and negative currents are supported.

The `circuit-json` 0.0.525 schema maps `simple_inductor.inductance` (henries) to `L.params.inductance` and `simple_voltage_source.voltage` (volts) to `V.params = { waveform: 'dc', dc: voltage }`. Inductor display/rating metadata does not alter simulation. Numeric simulation values must be finite. Voltage-source waveform fields (including frequency, phase and pulse timing) are unsupported, even when a DC voltage is also present.

`simple_diode` and `simple_led` map to `D.params = { modelName: '' }`, meaning core's default generic diode (`.model DEFAULT D`, IS=1e-14 A, N=1). This is not an LED-specific forward-drop or optical model. LED color/wavelength and custom diode parameters produce `UNSUPPORTED_PARAMETER`, not a silently approximated model. When constructing a core `Circuit`, use the named anode/cathode ports with `addDiode(name, anode, cathode)` (no model name); port names and connectivity are preserved by the adapter. Export uses canonical `simple_diode` for this generic model, including imported LEDs.

The pinned schema's `simple_battery` has capacity but no voltage. It remains `UNSUPPORTED_ELEMENT`; use `simple_voltage_source` with an explicit voltage instead. No battery voltage is inferred from capacity or display text. `simulation_voltage_source` records remain unsupported.

Export supports L, generic D and DC V/I as well as R/C/M/Q. Custom diode models, AC/time-varying sources and extra simulation parameters produce `LOSSY_EXPORT`; no model or waveform is silently discarded by default.

`toCircuitJSON` refuses any lossy conversion by default. Pass `{ allowLossy: true }` to receive the representable subset; the result remains marked `lossy` and retains the same ordered `LOSSY_EXPORT` diagnostics.

Diagnostics are deterministic and sorted by `path`, then `code`, then `elementId`.
