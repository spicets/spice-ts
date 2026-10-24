# @spice-ts/circuit-json

Bidirectional conversion between tscircuit `circuit-json` documents and the spice-ts `CircuitIR`.

```ts
import { fromCircuitJSON, toCircuitJSON } from '@spice-ts/circuit-json';
```

`fromCircuitJSON` supports simple resistors, capacitors, inductors, diodes/LEDs, DC voltage/current sources, sinewave/square voltage sources, enhancement-mode MOSFETs, BJTs, source ports, source nets, and source traces. PCB, schematic, and CAD elements produce nonfatal `LAYOUT_ONLY` diagnostics. Unsupported simulation elements or parameters produce error diagnostics and no circuit value.

| circuit-json element | SPICE / IR mapping | Value |
| --- | --- | --- |
| `simple_current_source` | `I`, `{ waveform: 'dc', dc: current }` | `current` in amperes; `wave_shape: 'dc'` (default when omitted) |

`simple_current_source` uses the SPICE sign convention: positive current flows from the positive (`p`, first) terminal through the source to the negative (`n`, second) terminal. Thus `I1 0 n1 1m` with `R1 n1 0 1k` gives V(n1) = +1 V; reversing the source gives -1 V. Port order and connectivity are preserved. Export emits explicit `wave_shape: 'dc'`. Missing/nonfinite current and non-DC or extra waveform fields return `UNSUPPORTED_ELEMENT` with no circuit value. No current is inferred from display text, and a missing value never defaults to 0 A. Explicit finite zero and negative currents are supported.

The `circuit-json` 0.0.525 schema maps `simple_inductor.inductance` (henries) to `L.params.inductance` and DC `simple_voltage_source.voltage` (volts) to `V.params = { waveform: 'dc', dc: voltage }`. Inductor display/rating metadata does not alter simulation. Numeric simulation values must be finite.

For `simple_voltage_source` with `wave_shape: 'sinewave'`, import maps `voltage` to offset VO in volts, `peak_to_peak_voltage / 2` to peak amplitude VA in volts, `frequency` to FREQ in Hz, and `phase` to PHASE in degrees (the pinned schema's normalized rotation unit). Frequency and peak-to-peak voltage must be explicit finite numbers; omitted phase defaults to zero. The waveform is `SIN(VO VA FREQ 0 0 PHASE)`. Export reverses this mapping. Delay TD and damping THETA must be zero or omitted; nonzero values, explicit DC operating-point overrides, AC annotations and extra parameters produce `LOSSY_EXPORT`, never silent loss. Triangle and sawtooth remain unsupported. Without `wave_shape` (or with explicit `dc`), waveform parameters are rejected rather than ignored.

`simple_diode` and `simple_led` map to `D.params = { modelName: '' }`, meaning core's default generic diode (`.model DEFAULT D`, IS=1e-14 A, N=1). This is not an LED-specific forward-drop or optical model. LED color/wavelength and custom diode parameters produce `UNSUPPORTED_PARAMETER`, not a silently approximated model. When constructing a core `Circuit`, use the named anode/cathode ports with `addDiode(name, anode, cathode)` (no model name); port names and connectivity are preserved by the adapter. Export uses canonical `simple_diode` for this generic model, including imported LEDs.

The pinned schema's `simple_battery` has capacity but no voltage. It remains `UNSUPPORTED_ELEMENT`; use `simple_voltage_source` with an explicit voltage instead. No battery voltage is inferred from capacity or display text. `simulation_voltage_source` records remain unsupported.

Export supports L, generic D, DC V/I and representable SIN/PULSE V as well as R/C/M/Q. Custom diode models, other AC/time-varying sources and extra simulation parameters produce `LOSSY_EXPORT`; no model or waveform is silently discarded by default.

`toCircuitJSON` refuses any lossy conversion by default. Pass `{ allowLossy: true }` to receive the representable subset; the result remains marked `lossy` and retains the same ordered `LOSSY_EXPORT` diagnostics.

Diagnostics are deterministic and sorted by `path`, then `code`, then `elementId`.


## Square voltage sources

`simple_voltage_source` with `wave_shape: 'square'` maps to
`PULSE(V1 V2 TD TR TF PW PER)` using these values:

| PULSE field | circuit-json mapping |
| --- | --- |
| V1, V2 | `voltage - peak_to_peak_voltage / 2`, `voltage + peak_to_peak_voltage / 2` |
| PER | `1 / frequency` (Hz to seconds) |
| PW | `duty_cycle * PER`, default duty cycle `0.5` |
| TD | `phase / 360 * PER`, default phase `0` degrees |
| TR, TF | `PER * 1e-6`, explicit nonzero edges independent of transient TSTEP |

Phase uses the same degree unit as sinewave, but defines an initial **delay**,
not a periodic phase advance. Negative phase/delay is rejected; phase is not
reduced modulo 360. The source starts at V1 and rises after TD; PW is the high
plateau duration, excluding TR/TF. Signed peak-to-peak voltage is preserved.
Frequency must be finite and positive; duty cycle must be strictly between 0
and 1. Voltage and peak-to-peak voltage must be explicit finite numbers. Phase
must be finite and nonnegative. Invalid inputs and derived overflow/underflow
return `UNSUPPORTED_PARAMETER` diagnostics with field JSON pointers and no value.

Export reverses this mapping only when re-import reproduces every PULSE level
and timing value exactly in double precision. Unequal edges, equal edges other
than `PER * 1e-6`, omitted/zero edges (which core may default from TSTEP), finite
pulse counts, DC operating-point overrides, AC annotations and extra parameters
produce `LOSSY_EXPORT` diagnostics, not silent approximations. With `allowLossy`,
any returned subset remains explicitly marked lossy. Triangle and sawtooth
continue to return explicit `UNSUPPORTED_PARAMETER` diagnostics.
