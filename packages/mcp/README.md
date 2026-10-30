# @spice-ts/mcp

A bounded stdio MCP server exposing the existing spice-ts protocol-v1 adapter. It does not open a network listener and does not add simulator semantics.

## Tools

### DC and AC sensitivity

Call `spice_sensitivity` with `{ netlist, output: "v(out)", analysis: "dc", top: 5 }`.
Instead of `netlist`, pass `request: { apiVersion: "1", input: ... }` for SPICE,
spice-ts JSON, or circuit-json input. Supply exactly one of `netlist` or `request`.
DC and AC use the same selectors and ranked result format. The circuit-json
converter does not currently represent AC source magnitudes; use SPICE or spice-ts
JSON for driven AC sensitivity.
`netlist` is a title-less SPICE fragment (a leading `*` comment is fine), like
the protocol tools. `analysis` defaults to `dc`.
`output` accepts `v(node)`, `v(a,b)` and `i(vsrc)` (independent voltage sources only).
Existing analysis directives are replaced, not executed; `.step`, `.control` and
`.pz` decks are rejected. Includes must be inlined before calling this tool.

The DC response contains `output`, `analysis`, `outputUnit` (`V` or `A`) and `entries`.
Each entry contains `device`, `parameter`, nominal `value`, signed `absolute`
(`dOut/dParam`), signed `normalised` (`value*dOut/dParam`), `parameterUnit` and
`absoluteUnit`. Normalised sensitivity has the output unit; it is not divided by
the nominal output. Entries sort by descending `abs(normalised)`, then by device
and parameter code-point order for exact ties. `top` is optional (1–10000); omitting
it returns all supported parameters, including instance multiplier and scale.
For AC, call with `analysis: "ac"` and a required
`sweep: { type: "dec", points: 10, fstart: 10, fstop: 100000 }`.
Sweep types are `dec`, `oct` and `lin`; `points` is an integer from 1 through
10000, `fstart` is finite and positive, and `fstop` is finite and at least
`fstart` (frequencies in Hz). Extra sweep fields and sweeps on DC requests are rejected.
The AC response is `{ schemaVersion: "1", output, analysis: "ac", outputUnit,
points: [{ frequency, entries }] }`. Entries have the same metadata as DC, but
`absolute` and `normalised` are complex `{ real, imaginary }` objects:
`absolute` is the core complex derivative and `normalised` is nominal parameter
value times that derivative, not divided by the output. Each frequency is ranked
independently by descending complex norm of `normalised`, with the same lexical
tie-breaks and optional `top` per frequency. The result-point ceiling counts all
computed parameter entries times the frequency count, before applying `top`.

Core's bounded `.sens` device/parameter coverage applies; this is not a claim of
full ngspice model-parameter sensitivity support. Errors use the usual `{ error }`
structured result. Worker time, document size, concurrency and result ceilings apply.

Reproduce the identical-deck ngspice-47 cross-check after building core:
`spice-heavy pnpm exec tsx benchmarks/mcp-sensitivity/compare.mts`.

### Tool inventory

S-parameter keys use `Sij` when both one-based indices are single digits (for example, `S11`, `S21`). If either index has multiple digits, keys use `S_<output>_<input>` (for example, `S_1_11`, `S_11_1`, `S_10_10`) so every ordered pair remains distinct. The same naming applies to the full matrix and `portPair` selections; single-digit pairs retain their conventional names even in larger matrices.

- `spice_sparams`: run one unstepped `.sp` sweep. Supply exactly one of a titleless `{ netlist }` or `{ request: { apiVersion: "1", input, options? } }`. The request boundary accepts `spice`, `spice-ts`, and `circuit-json`; native `spice-ts` documents must be objects, not JSON strings, and `circuit-json` requires an `analyses` array. **Current limitation:** protocol-v1 native analysis schemas do not yet represent `.sp`, and native/circuit-json conversion does not preserve RF source port metadata; successful S-parameter requests currently require `input: { format: "spice", source: "..." }` (or legacy `netlist`). Original request options and resource limits are retained. Optional `portPair: [output,input]` selects one Sij with one-based indices; omit it for the full matrix. Optional positive finite `frequenciesHz: [100, 1000]` replaces the sweep grid with exact independent frequency evaluations in input order, without interpolation. Returns `ports` (RF source names in core port order), `referenceImpedancesOhm`, and per-frequency `points: [{ frequencyHz, parameters: { S11: { magnitude, magnitudeDb, phaseDeg, returnLossDb, vswr }, S21: { magnitude, magnitudeDb, phaseDeg, insertionLossDb }, ... } }]`. dB is `20 log10(abs(Sij))`; return/insertion loss is its negative, and reflection VSWR is `(1+abs(Sii))/(1-abs(Sii))`. Zero magnitude has null dB, loss and phase; VSWR is null for magnitude >= 1 (infinite or not a passive standing-wave ratio). No rounding/clamping is applied near zero or unity. Missing/multiple/conflicting analyses, control blocks, steps and out-of-range port indices return the usual structured errors (`INVALID_REQUEST` for analysis/selector validation). Core requires at least two RF voltage-source ports. Includes must be inlined. Port noise is not computed. Document, wall-time, cancellation, concurrency, result-byte and point bounds apply; point accounting counts the full computed S matrix, even with a port selector.
- `spice_capabilities`: deterministic discovery of supported analyses, input formats, and server limits.
- `spice_validate`: bounded parse/compile/topology validation without solving.
- `spice_convert`: convert `{ netlist: string }` to `{ circuitJson, diagnostics, lossy: false }`, or `{ circuitJson: [...] }` to `{ netlist, diagnostics, lossy: false }`.
- `spice_simulate`: one bounded protocol-v1 simulation.
- `spice_measure`: run the same simulation request once and return scalar measurements only.
- `spice_dc_metrics`: return DC transfer gain, switching threshold, unity-gain points and noise margins without raw vectors.
- `spice_op_report`: return operating-point node voltages, terminal currents, device powers and top dissipators.
- `spice_power_metrics`: summarize transient average power, RMS current, peak power/time and optional efficiency without returning vectors. Accepts exactly one of `netlist` (legacy SPICE text) or `request` (a protocol-v1 simulation request with `spice`, `spice-ts`, or `circuit-json` input), plus optional `elements: ["V1", "Rload"]`, `window: [tStart, tStop]`, `input: ["V1"]`, and `output: ["Rload"]`. Native `spice-ts` documents must be objects, not JSON strings. Request solver options and resource limits are preserved; original input bytes remain bounded before conversion. Nonfatal circuit-json conversion diagnostics are returned in `_meta.conversionDiagnostics`, outside the scalar report; fatal conversion errors retain their diagnostics. Times are seconds; names are case-insensitive. Returns `window`, `elements` (`name`, `averagePowerW`, `rmsCurrentA`, `peakPowerW`, `peakTimeS`) and `efficiency` (ratio, not percent). Power is signed absorption: negative source power means delivery. Efficiency is total designated output absorption divided by total designated input delivery, or `null` when undesignated or input delivery is nonpositive. Input/output lists must both be provided, be disjoint, and refer to selected elements. Defaults to all IR elements (at most 128); supports two-terminal R/C/L/V/I/D/H/F elements. Other selected device types return `INVALID_REQUEST`. Requires exactly one transient in a flat, unstepped SPICE deck without includes/subcircuits/control blocks. No transient returns `NOT_TRANSIENT`; unknown elements and invalid windows return `INVALID_REQUEST`. Uses native V/L branch currents and zero-volt series current probes for other devices; averages power and squared current trapezoidally over accepted timepoints. Window boundaries linearly interpolate sampled power and squared current; no extrapolation. Peak is the maximum signed sampled/interpolated power (not maximum absolute power), with the earliest time on ties. Resource/solver errors propagate unchanged. Example: `V1 in 0 10\nRs in out 1k\nRload out 0 3k\n.tran 10u 1m` with input V1/output Rload returns efficiency 0.75.
- `spice_sensitivity`: DC or complex AC `.sens` derivatives for voltage/differential voltage or independent voltage-source current, ranked by normalised magnitude (per frequency for AC).
- `spice_tf`: native small-signal gain and input/output resistances. Accepts exactly one of `netlist` (legacy SPICE text) or `request` (a protocol-v1 simulation request with `spice`, `spice-ts`, or `circuit-json` input), plus `output: "v(out)"` or `"i(vsrc)"` and `input_source: "V1"` (an independent voltage/current source). For example: `{ request: { apiVersion: "1", input: { format: "spice", source: "V1 in 0 1\nR1 in out 1k\nR2 out 0 3k" } }, output: "v(out)", input_source: "V1" }`. Native documents must be objects, not JSON strings; circuit-json requires an `analyses` array (use `[]` to let the tool select TF). Returns exact selector names, `transfer_function`, `input_resistance`, `output_resistance`, and `units` (V/V, V/A, A/V or A/A; resistances in ohm). Optional `params: { name: number }` uses case-insensitive top-level SPICE parameter overrides; non-SPICE inputs reject `params`, including `{}`. Request solver options and resource limits are preserved. Nonfatal conversion diagnostics appear in `_meta.conversionDiagnostics`; fatal conversion errors retain `error.details.diagnostics`. A matching `.tf` is allowed; conflicting analyses, steps and control blocks are rejected.
- `spice_sweep`: sweep one parameter with bounded, ordered per-point statuses and optional scalar measurements.
- `spice_corners`: run protocol-v1 `spice`, `spice-ts` JSON, or `circuit-json` input across up to 64 uniquely named deterministic corners with `{ request, corners: [{ name, params?, temp? }], measurement }`. Native documents must be objects, not JSON strings; circuit-json requires an explicit `analyses` array. Parameter overrides require SPICE text. Temperature overrides support SPICE text and native `spice-ts` JSON; circuit-json temperature overrides and JSON parameter overrides return per-corner `INVALID_REQUEST` errors without preventing other corners from running. `params` contains finite numeric top-level `.param` overrides; `temp` is Celsius above absolute zero and overrides earlier temperature cards for SPICE text or request-level `options.temperature` for native JSON. Uses one `spice_measure` selector. Returns ordered `{ name, status, value, unit }` or `{ name, status: 'failed', error }` entries and `summary: { min: { name, value }, max: { name, value }, spread, unit }` over successful corners only (null if none succeed, first corner wins ties). Shares the existing worker quota, response cap and one wall-time budget. Unlike a single-parameter sweep or random sampling, corners are explicit heterogeneous cases.
- `spice_compare`: compare two waveform sets or completed simulation results without solving again.
- `spice_ac_metrics`: run an AC sweep and return gain, half-power bandwidth, sampled peaking, and loop stability margins without vectors.
- `spice_impedance`: measure differential port impedance with `{ request, port: { positive: "in", negative: "0" }, sweep?: { variation: "dec", points: 100, startFreq: 10, stopFreq: 100000 }, params?: { name: number } }`. Accepts the usual SPICE or circuit-json protocol request. Use one existing AC sweep or supply `sweep` to override it. Injects a collision-free 1 A AC current from negative to positive on an isolated copy, zeroes all other independent-source AC magnitudes (including subcircuit sources), and preserves DC bias and dependent sources. Returns `points` with `frequencyHz`, `magnitudeOhm`, `phaseDeg`, `resistanceOhm`, and `reactanceOhm`; `summary.min`/`max` are sampled magnitude extrema with frequencies. `summary.resonanceHz` estimates isolated phase-zero crossings by phase interpolation in log frequency (DEC/OCT) or linear frequency (LIN), never extrapolates, and excludes flat zero-phase regions and phase wraps. Increase sweep density to resolve narrow resonances. Ground aliases `0`/`gnd` and node names are case-insensitive. Stable tool-local errors are `UNKNOWN_NODE`, `SHORTED_PORT` (identical terminals), and `MISSING_AC_SWEEP`; invalid/conflicting analyses, steps, and control blocks are rejected. Parameter overrides apply before elaboration and require SPICE text. All normal document, point, output, concurrency, wall-time and cancellation limits apply.
- `spice_tran_metrics`: run a transient step and return rise/fall time, overshoot/undershoot, settling time and peak without vectors.
- `spice_fourier`: return DC, harmonic magnitudes/phases and THD percent from the last transient period.
- `spice_noise_metrics`: run one unstepped `.noise` analysis and return integrated output/input noise and spot densities without vectors.
- `spice_pz_metrics`: run one unstepped `.pz` analysis and return finite poles/zeros, damping, Q and a pole-based stability verdict.
- `spice_disto_metrics`: run exactly one unstepped `.disto` using `{ request: SimulationRequestV1, output: "v(out)" }` (SPICE text or native `spice-ts` JSON). Returns `output`, `magnitudeUnit: "V"`, `decibelReference: "1 V"`, fixed `f2Hz` (null for single-tone), and `products`. Each HD2/HD3 (single-tone) or SIM2/DIM2/DIM3 (two-tone) product contains points with swept F1 `frequencyHz`, `real`, `imaginary`, `magnitude`, `magnitudeDb` (20 log10 volts, dBV, not dBc), and `phaseDeg` (atan2 in degrees). Exact zero has null dB and phase. F2 is fixed at start-F1 times F2OVERF1, not swept with F1. Core's bounded diode/RLC support applies; BJT distortion remains unsupported. Native `spice-ts` JSON uses `analyses: [{ type: "disto", variation: "dec", points: 5, startFreq: 1000, stopFreq: 100000, f2OverF1: 0.9 }]` (omit `f2OverF1` for single-tone). Independent V/I source params accept `distortionF1: { magnitude: 0.01, phase: 30 }` and optional `distortionF2: { magnitude: 0.005, phase: -20 }`; phase defaults to 0 degrees and an excitation-only source defaults to DC 0. These terms coexist with DC/AC/transient waveform params and are never inferred from AC amplitudes. Malformed excitation or sweep fields return structured `INVALID_INPUT` naming the field. `circuit-json` remains unsupported with `details.missingFields: ["DISTOF1", "DISTOF2"]`; use SPICE text or native JSON instead. The protocol-v1 generic result/stream union is unchanged; use this dedicated metrics tool for distortion output. Missing/wrong/multiple or stepped JSON analyses, control blocks and .pz return tool-local `UNSUPPORTED_ANALYSIS`; malformed F2OVERF1/steps return `PARSE_ERROR`; unknown output nodes return `INVALID_REQUEST`; unsupported devices/models return `INVALID_CIRCUIT`. Standard cancellation and resource bounds apply.
- `spice_simulation_start`: start a bounded simulation worker and return its opaque job cursor before solving completes.
- `spice_simulation_read`: pull a replayable chunk containing at most 256 points by default (caller-selectable from 1 through the hard cap of 1024).
- `spice_simulation_cancel`: idempotently stop delivery and return the protocol-v1 cancelled terminal with partial analysis counts and `partialEventSha256`.

### Fourier analysis

Call `spice_fourier` with `{ request: SimulationRequestV1, signal: "v(out)", fundamentalHz: 1000 }`.
The same input formats and resource limits as `spice_tran_metrics` apply, including circuit-json conversion restrictions.
Optional `analysis` selects one transient by zero-based index; stepped or ambiguous results must be split into separate requests.
Signals are case-insensitive `v(node)` or `i(branch)`. `harmonicCount` counts positive harmonics, defaults to 9 and is bounded to 1 through 64.
The result contains signed `dc`, `unit` (V or A), `thdPercent` and `harmonics` numbered 1 through the requested count.
Each row has `frequency` in Hz, `magnitude`, sine-referenced `phase` in degrees, `normalizedMagnitude` and `normalizedPhase` relative to the fundamental.
Like ngspice's default `.four`, it uses a 200-point grid excluding the endpoint and linear interpolation over the last period ending at the last sample.
Optional `windowStartS` is an eligibility lower bound, not a new Fourier origin; the full last period must fit after it. Earlier samples remain interpolation support.
THD includes only the requested harmonics. Zero/non-finite fundamental arithmetic returns `INVALID_DATA`, not JSON nulls.
Domain errors set `isError` with `UNKNOWN_SIGNAL`, `NO_TRANSIENT`, `INSUFFICIENT_PERIOD` or `INVALID_DATA`; request and resource failures retain the standard API envelope.

### Operating-point power report

Call `spice_op_report` with exactly one of a titleless SPICE `netlist` or a
protocol-v1 `request`, plus optional `topN` (integer 0–10000; default 10).
The request input accepts the same `spice`, `spice-ts` and `circuit-json` union
as `spice_pz_metrics`. For example:

```json
{"netlist":"V1 in 0 10\nR1 in out 1k\nR2 out 0 1k","topN":2}
```

JSON callers use `{ "request": { "apiVersion": "1", "input": {
"format": "spice-ts", "document": { ... } } }, "topN": 2 }`, or
`{ "request": { "apiVersion": "1", "input": { "format": "circuit-json",
"circuit": [ ... ], "analyses": [] } } }`. These are JSON objects, not
JSON-encoded strings. Native documents retain their models and subcircuits;
circuit-json uses the shared converter without a SPICE serialization round-trip.
Malformed documents return `INVALID_REQUEST` validation errors; unsupported
circuit-json elements return conversion diagnostics in the structured error.
Supplying both `netlist` and `request`, or neither, is invalid.

This returns `nodeVoltages` (`out: 5` V), `devices` with `terminalCurrents`
(amps entering each node terminal) and `powerW` (watts absorbed),
`sourceDeliveredPowerW: 0.05`, `dissipatedPowerW: 0.05`, and `topDissipators`
(`R1` and `R2`, each 0.025 W). Negative device power means delivery; totals sum
negative and positive device powers separately, including absorbing sources.
Repeated terminals are combined by node; internal model nodes may also appear.
The report runs one DC OP regardless of analysis/control commands, rejects
`.step`, and returns structured errors on convergence failures. It reuses core
device-current readouts and DC loads, not separate device equations. Runtime,
document and output limits and cancellation apply as for other tools.

### DC transfer metrics

Call `spice_dc_metrics` with `{ request: SimulationRequestV1, sweptSource: "Vin", output: "v(out)", input?: "v(in)" }`.
The request accepts the same SPICE, spice-ts JSON and circuit-json formats as `spice_simulate`,
with their existing conversion restrictions. Exactly one DC result must match the source
(case-insensitive). Split repeated/stepped sweeps into separate requests. Expressions are
case-insensitive `v(node)` signals. The input voltage must be strictly monotonic; when
omitted, it is the sweep axis, which must be a voltage sweep.

Every numeric metric is `{ value: number | null, unit: string, reason?: string }`.
Undefined values always include a reason. `gainMax` is the maximum absolute adjacent-sample
secant gain in V/V, with `input` and `sweepPoint` at that interval's midpoint (volts and
the swept source's SI unit, respectively). `switchingThreshold` is the input voltage at
the first interpolated Vout = Vin crossing in sweep order. A boundary equality by itself,
such as a divider at zero, is not a crossing; an equality reached from a nonzero difference is.
`voh` and `vol` are outputs at sweep start and end, not extrema, even for descending sweeps.
`vil` and `vih` are the lowest/highest input voltages at interpolated gain = -1 crossings
between interval midpoints; fewer than two crossings makes both undefined.
`nmL = vil - vol` and `nmH = voh - vih`. All six voltage metrics plus the threshold use V.
`monotonic` reports whether output samples are entirely nondecreasing or nonincreasing.
These are sampled-transfer estimates, not guarantees of inverter behavior; use a sufficiently
fine sweep for the desired accuracy. Invalid requests or unavailable signals use the existing
`isError` / `SpiceApiErrorV1` envelope with code `INVALID_REQUEST` and phase `validation`.

The validation, one-shot simulation, and stream-start tools accept `{ "request": SimulationRequestV1 }`. Successful results are returned as MCP `structuredContent` and as compact JSON text. Failures set `isError` and return `{ "error": SpiceApiErrorV1 }`; implementation backend names are removed from public errors.

The server supports protocol-v1 `spice`, `spice-ts`, and `circuit-json` inputs and `op`, `dc`, `tran`, and `ac` analyses. For Circuit JSON, use `input: { format: 'circuit-json', circuit, analyses }`. Conversion is performed by `@spice-ts/circuit-json` before validation or worker execution; its supported element set applies (currently R/C/M/Q, not independent sources). Fatal conversion diagnostics are returned in `error.details.diagnostics`, with `UNSUPPORTED_ELEMENT` for unsupported elements. Nonfatal conversion diagnostics (including ignored layout elements) are exposed in the MCP result's `_meta.conversionDiagnostics` by all three request tools, without changing the protocol simulation result shape.

## Parameter overrides

`spice_simulate` and `spice_simulation_start` accept an optional sibling of
`request`: `params: Record<string, number>`, for example
`{ request, params: { rval: 3000 } }`. This overrides declared top-level `.param`
values in `request.input.source` before elaboration, including dependent expressions
and conditional selection. Names are case-insensitive. The input must use
`format: 'spice'`; JSON circuit formats do not have `.param` declarations.
Subcircuit-local parameters, control variables, and declarations only in virtual
include files are not override targets. Omission or an empty object preserves defaults.

Values must be finite numbers. Malformed values, duplicate case-insensitive keys,
and non-SPICE inputs return `INVALID_REQUEST`. Unknown names return the MCP-local
error code `UNKNOWN_PARAMETER` with `details.unknown` and `details.available`
(sorted, lower-case available names). This extends the MCP error surface, not the
protocol-v1 error-code set. `spice_capabilities.parameterOverrides` describes this
contract. Neither the caller's request nor its source string is mutated.

## Monte Carlo tolerance statistics

Call `spice_monte_carlo` with `{ request, runs, seed, tolerances, measurements }`.
For a divider with `.op`, an example is
`{ request, runs: 200, seed: 12345, tolerances: [{ element: 'R1', sigma: 0.01, distribution: 'gaussian' }, { element: 'R2', sigma: 0.01, distribution: 'gaussian' }], measurements: [{ kind: 'at', signal: 'v(out)', analysis: 0, at: 0 }] }`.
The usual `spice_measure` selectors also support transient, DC and AC reductions.

`runs` is an integer from 1 through 1000; `seed` is an explicit unsigned 32-bit integer.
Each of 1–128 case-insensitive, unique tolerance targets must be a positive literal
top-level R/C/L scalar in SPICE text, with no extra card parameters or continuation.
Numeric engineering suffixes T/G/MEG/K/M/U/N/P/F are supported. Expressions,
includes, model cards, subcircuit-local targets and JSON inputs are not supported.
Each draw starts from the original nominal value, independently per target and run,
in caller-supplied target order. Inputs are not mutated.

`sigma` is relative standard deviation, with `0 <= sigma < 0.5`.
`gaussian` uses an untruncated standard-normal Box-Muller draw; `uniform` spans
`[-sqrt(3)*sigma, +sqrt(3)*sigma]` relative to nominal, so both have the same sigma.
A nonpositive or non-finite draw aborts with `INVALID_REQUEST`, rather than clipping
or resampling and biasing the distribution. Reduce sigma if that happens.

The result is `{ runs, seed, statistics }`, in measurement order. Each entry contains
`count`, `unit`, `mean`, sample `std` (N−1 denominator, zero for N=1), `min`, `max`,
`p5` and `p95`. Percentiles linearly interpolate sorted samples at `(N−1)*p`.
Same request and seed produce byte-identical successful JSON on the same runtime;
there are no timestamps or runtime measurements. No cross-runtime math-bit guarantee.

Bad counts, seeds, targets (including unknown elements), tolerances or measurements
return stable `INVALID_REQUEST`; counts above 1000 return `RESOURCE_LIMIT` with
`details.limit: 'maxMonteCarloRuns'`, `maximum: 1000`, and `actual`.
All runs share one wall-time budget and reuse simulation worker/concurrency,
cancellation, per-run point and result-size limits. The first simulation or measure
failure aborts the whole request. No failed samples are silently discarded.
Large batches can exhaust the default shared wall-time limit. The server owner can
raise `ToolExecutionOptions.limits.maxWallTimeMs` (the 200-run integration test uses
120000 ms); a client request cannot raise the server's ceiling.

## Bounded parameter optimization

Call `spice_optimize` with `{ request, parameters: [{ name: 'rval', min: 100, max: 100000 }], objective: { kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -3.010299956639812, edge: 'falling' }, target: 1000 }`
to tune an RC low-pass cutoff to 1 kHz. The SPICE request must declare the named
top-level `.param` values; names are case-insensitive and bounds are inclusive.
`objective` uses the existing `spice_measure` scalar selector contract.

One parameter uses golden-section search on absolute target error; two or three
use two coordinate-descent passes from the bounds' midpoint. Endpoints are sampled
and repeated parameter tuples are cached. `maxEvaluations` defaults to 40 and has a
hard cap of 100 across all coordinates. `tolerance` is absolute objective error,
defaulting to `max(abs(target) * 0.001, 1e-9)`. One shared wall-time budget and the
normal cancellation, simulation and output limits apply to the entire search.

Results contain `bestParams`, `achievedValue`, `target`, `tolerance`, `converged`,
`evaluations` and ordered `history` entries `{ params, value, error }`. Equal-error
ties keep the earliest evaluation. An unreachable target or exhausted budget returns
`isError: true` and `error.code: 'TARGET_NOT_REACHED'` alongside the best result and
history, not a thrown exception. This is not proof of global infeasibility: golden
section assumes a unimodal error landscape and coordinate descent can miss coupled
or local optima. Measurement failures use `OBJECTIVE_ERROR`; simulation failures
preserve their structured error code. If no evaluation succeeds, best values are null.
Search output contains no timing fields and is deterministic for identical requests.

## Parameter sweeps

Call `spice_sweep` with `{ request: SimulationRequestV1, parameter, values, measurements? }`.
`request` supplies the netlist, analyses and solver options, just as for `spice_measure`.
`parameter` is `{ kind: 'param', name: 'rval' }` for declared top-level SPICE
`.param` overrides, or `{ kind: 'component', name: 'R1' }` for a top-level R/C/L
scalar value. Component targets support SPICE text and native `spice-ts` JSON IR;
Circuit JSON and other component types are not sweep targets in this version.
Names are case-insensitive. Includes and subcircuit-local targets are not supported.
The original request is not mutated, and each point starts from that original.

Provide exactly one of a nonempty finite-number `values` list or
`range: { scale: 'lin' | 'dec', start, stop, points }`.
For `lin`, `points` is the total integer sample count including both endpoints
(one point requires equal endpoints; descending ranges are supported).
For `dec`, `points` is a positive integer samples-per-decade count, with
`0 < start <= stop`; the exact stop is included for partial decades too.
There is a hard cap of 100 sweep points, checked before allocation or solving.
Exceeding it returns `RESOURCE_LIMIT` with `details.limit: 'maxSweepPoints'`,
`maximum: 100`, and `actual`. Malformed sweep arguments return `INVALID_REQUEST`.

Example for an RC low-pass with an existing AC analysis and 1 V AC input:
`{ request, parameter: { kind: 'param', name: 'rval' }, values: [1000, 2000, 3000], measurements: [{ kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -3.010299956639812, edge: 'falling' }] }`.

The response is `{ parameter, points: [{ value, status: 'complete', measurements? } | { value, status: 'failed', error }] }`.
Points preserve input order and duplicates. Measurements use the `spice_measure`
contract, including independent measurement errors. Without measurements, the tool
returns simulation status only, never vectors. A simulation failure retains its
public failure-envelope code, phase, retryability and details, and does not stop
later points. Invalid targets fail the whole tool. Cancellation, the shared
wall-time budget and aggregate response-byte limit fail the whole tool rather
than returning a misleading partial table. Each point uses existing simulation
limits, worker termination and concurrency quotas. Sweeps execute sequentially.

## Topology preflight warnings

`spice_validate` returns `{ status: 'valid', nodeCount, branchCount, analysisCount, diagnostics? }` after parsing and compiling without a numerical solve. `diagnostics` is omitted for a clean deck. Each entry has `severity: 'warning'`, a `code`, `nodes`, `elements` (compiled element ids, including expanded subcircuit names), and a one-line `hint`.

- `FLOATING_NODE`: a non-ground node connected to fewer than two distinct elements.
- `NO_DC_PATH_TO_GROUND`: a DC-connected node set without a conductive path to node `0`. Capacitors and current sources do not provide that path. `.options rshunt` suppresses this warning.
- `VOLTAGE_SOURCE_LOOP`: an ideal loop of V/E/H/L elements, including inductors even for transient-only decks. The first loop in element-id order is reported.

Warnings are sorted by code then node ids; node/element lists use code-point order and are capped at 32 ids. DC islands are reported separately. These are advisory graph checks, not a guarantee of numerical convergence. Simulation and strict direct-core validation retain their existing behavior. A dangling terminal can produce both a floating-node and a missing-DC-path warning. Conversion diagnostics remain separate in `_meta.conversionDiagnostics`.

## Circuit conversion

`spice_convert` requires exactly one input field. It uses the core titleless SPICE
parser and `@spice-ts/circuit-json`, without solving. Circuit JSON represents circuit
connectivity and component values, not analysis directives, solver options, or model
cards. Reattach analyses (for example `.op`) when simulating the returned netlist.
SPICE export currently supports passive resistors and capacitors. M/Q import cannot
produce a runnable SPICE model from circuit-json alone and is rejected rather than
inventing model parameters. The adapter supports DC V/I sources in both directions
and sinewave voltage sources with zero delay/damping. `spice_convert` emits DC and
sinewave V sources as SPICE; current-source SPICE serialization remains unsupported.
Lossy exports are rejected. Fatal errors use the usual `isError` and
`error.details.diagnostics` shape, including `UNSUPPORTED_ELEMENT` for unsupported
components and `UNSUPPORTED_PARAMETER` diagnostics for unrepresentable parameters
(including resistor instance `M`, `AC`, temperature coefficients, and capacitor `IC`).
These parameters are rejected, not silently stripped or approximated. For a powered
passive-network round-trip, attach the same external source and analysis after conversion.
Successful conversions include nonfatal diagnostics (such as `LAYOUT_ONLY`).
The compact JSON input and output obey `maxDocumentBytes` and
`maxSerializedResultBytes`, respectively; oversize calls return `RESOURCE_LIMIT`.


## Scalar measurements

Call `spice_measure` with `{ request: SimulationRequestV1, measurements: [...] }`.
Each item has `kind` (`min`, `max`, `avg`, `rms`, `pp`, `at`, `cross`, or `when`),
`signal`, and a zero-based `analysis` index. Signals are case-insensitive `v(node)`
or `i(branch)`; AC uses magnitude by default and also supports `mag(v(node))`,
`db(v(node))` and the corresponding current projections. dB is 20 log10 of the
magnitude relative to 1 V or 1 A, not a transfer-function ratio.

Optional `from`/`to` delimit an inclusive axis window. `at` needs an `at` coordinate.
`cross` and `when` are aliases, need a `value`, and return the first crossing
coordinate, optionally filtered by `edge: rising | falling | either` (default either).
A crossing requires a segment starting strictly below/above the target and ending
at or beyond it; an initial point equal to the target alone is not a crossing.
Interpolation is linear in the published axis and signal, including AC Hz/dB.
Window boundaries are interpolated. `avg` is axis-weighted; `rms` integrates the
square of the piecewise-linear signal, not the mean square of unevenly spaced samples.
Descending DC axes are supported. OP reductions treat the signal as one sample at
coordinate 0; OP crossings are unavailable. Optional `step` is a nonnegative integer
matching the zero-based `step.index` metadata in `SimulationResultV1`. Select each
corner in the same request, for example `{ kind: 'max', signal: 'v(out)', analysis: 0, step: 2 }`.
Omitting `step` for repeated analysis indices returns `AMBIGUOUS_ANALYSIS` with the
available step count. An unavailable step returns `UNKNOWN_STEP`. Unstepped analyses
accept an omitted `step` or `step: 0` and reject other indices with `UNKNOWN_STEP`.

The response is `{ measurements: [{ value, unit } | { error: { code, message } }] }`,
in request order, never vectors. Units are V/A/dB for signal values and s/Hz/the DC
source unit for crossings. Per-item codes include `INVALID_MEASUREMENT`,
`UNKNOWN_SIGNAL`, `UNKNOWN_ANALYSIS`, `AMBIGUOUS_ANALYSIS`, `UNKNOWN_STEP`, `OUT_OF_RANGE`,
`NO_CROSSING`, and `NON_FINITE_RESULT` (including dB of zero).
Malformed lists fail the tool with `INVALID_REQUEST`; simulation failures use the
usual tool error. Lists contain 1 through 128 items, signals at most 256 characters.
Simulation point/byte/time limits still apply internally. Measurement payload bytes
and scalar response bytes are bounded too. Measurement calls share the one-shot
concurrency quota and the same Circuit JSON conversion/diagnostic path.

Example measurement for an AC low-pass with 1 V input:
`{ kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -3.010299956639812, edge: 'falling' }`.

## Waveform comparison

Call `spice_compare` with `{ reference, actual, signals: ['v(out)'], absTolerance: 0,
relTolerance: 0, phaseToleranceDegrees: 0 }`. Tolerances are optional, nonnegative,
finite, and default to zero. Each source is one of:

- `{ x: [0, 1, 2], signals: { 'v(out)': [0, 1, 2] }, axisUnit: 's' }`.
  `axisUnit` is optional; when both sources specify it, units must match.
- `{ result: SimulationResultV1, analysis: 0 }` for a complete protocol-v1 result.
  Signal names are `v(node)` and `i(branch)`, exactly as spelled in the result.
- `{ jobId: '...', analysis: 0 }` for a completed job in this server session.
  Drain `spice_simulation_read` until complete first. Pending, failed, cancelled,
  unknown, and expired jobs are not usable. Comparing does not consume job events.

`analysis` is a zero-based analysis index. Repeated indices in stepped results
return `AMBIGUOUS_ANALYSIS`; absent indices return `UNKNOWN_ANALYSIS`.
Unlike `spice_measure`, comparison accepts stored results, not a simulation request.

Axes must be finite and strictly increasing. The tool linearly interpolates each
signal onto the sorted union of both axes, restricted to their inclusive overlap.
It never extrapolates; a single shared endpoint is a valid one-point comparison.
The reference peak is the maximum absolute reference value on this common grid.
A sample fails when `abs(actual - reference) > absTolerance + relTolerance * peak`.

The response contains `pass`, `overlap: [from, to]`, `pointsCompared` (grid size),
and `comparisons` in selection order. Each comparison has `signal`, `maxAbsError`,
`maxRelError` (maximum error divided by reference peak), `xAtWorstError` (earliest
sample on ties), `firstExceededX` (first failing grid sample, or null), and `pass`.
These are sampled metrics, not continuous threshold-crossing locations.
Zero peak with zero error gives relative error 0; an undefined or unrepresentable
relative error is JSON null, never Infinity or NaN. An ordinary tolerance failure
is a successful tool response with `pass: false`, not `isError`.

Complex AC samples use protocol-v1 `{ magnitude, phaseDegrees }` objects.
Magnitude and unwrapped phase are interpolated separately, linearly in x (Hz for
AC, not log Hz). Phase unwrapping takes the shortest arc, with 180-degree ties
resolved toward -180. Phase differences wrap to [-180, 180) degrees. Magnitude
uses the normal absolute/relative tolerances. The additional `phase` metrics use
`phaseToleranceDegrees` as an absolute tolerance; their relative error is reported
against peak absolute unwrapped reference phase. Both magnitude and phase must pass.
Phase is compared as supplied even at zero magnitude. Real/complex mixing is rejected.

Invalid comparisons set `isError` with `{ error: { code, message, phase: 'validation',
retryable: false, details: {} } }`. Codes include `AXIS_MISMATCH` (lengths, units,
or real/complex shape), `UNKNOWN_SIGNAL`, `NON_MONOTONIC_AXIS`, `EMPTY_OVERLAP`,
and `INVALID_REQUEST` (malformed/nonfinite data or tolerances).
Select 1 through 128 unique signals, each at most 256 characters. Input/output
byte limits apply; union grid size times selected signal count is bounded by
`maxResultPoints`, returning `RESOURCE_LIMIT` when exceeded. No solver or benchmark
semantics are changed by this tool.

## Pole-zero metrics

Call `spice_pz_metrics` with `{ request: { apiVersion: "1", input: { format: "spice", source: "R1 in 0 1k\nC1 in 0 1u\n.pz in 0 in 0 cur pz" } } }`.

JSON inputs use optional `poleZeroAnalyses`, separate from the ordinary `analyses`
and result/stream unions. The equivalent RC lowpass request is:

```json
{
  "request": {
    "apiVersion": "1",
    "input": {
      "format": "spice-ts",
      "document": {
        "format": "spice-ts", "schemaVersion": "1.0",
        "circuit": {
          "nets": ["in"],
          "components": [
            { "type": "R", "id": "R1", "name": "R1", "ports": [{ "name": "p", "net": "in" }, { "name": "n", "net": "0" }], "params": { "resistance": 1000 } },
            { "type": "C", "id": "C1", "name": "C1", "ports": [{ "name": "p", "net": "in" }, { "name": "n", "net": "0" }], "params": { "capacitance": 0.000001 } }
          ]
        },
        "analyses": [], "models": [], "subcircuits": [],
        "poleZeroAnalyses": [{ "type": "pz", "inputPositive": "in", "inputNegative": "0", "outputPositive": "in", "outputNegative": "0", "inputType": "cur", "mode": "pz" }]
      }
    }
  }
}
```

For `format: "circuit-json"`, supply `circuit`, `analyses: []`, and the same
`poleZeroAnalyses` array directly on `input`. Conversion preserves the analysis;
unsupported simulation elements return structured conversion diagnostics.
Use titleless SPICE text (a leading `*` comment is fine), with exactly one
`.pz in+ in- out+ out- {cur|vol} {pol|pz}` directive. Other analyses are not
executed. Includes, netlist options/temperature, request option overrides,
worker wall-time/cancellation and the shared concurrency/resource bounds apply.
JSON IR has no pole-zero directive; use SPICE text. No separate node selectors
are provided. Missing/multiple directives and zeros-only mode return
`INVALID_REQUEST`; unsupported JSON input returns `UNSUPPORTED_FEATURE`.
Invalid directive forms and stepped decks retain core's `PARSE_ERROR`;
singular/disconnected circuits retain the structured core error (for example
`INVALID_CIRCUIT` from topology preflight). All errors use the usual error envelope.

`poles` and `zeros` contain `{ re, im, frequencyHz }`. `re` and `im` are
components of s in rad/s; `frequencyHz = hypot(re, im)/(2*pi)` is the root
magnitude in Hz, not the signed imaginary component. `conjugatePairs` has one
entry per pair, tagged `kind: "pole" | "zero"`, with zero-based `indices` into
that root array, `naturalFrequencyRadPerSec = hypot(re, im)`,
`naturalFrequencyHz`, `dampingRatio = -re/wn`, and signed `q = 1/(2*zeta)`.
Zero damping gives `q: null` (infinite Q); real roots are not conjugate pairs.
`dominantPole` is the pole with largest real part, ties resolved by core order,
or null if there are no finite poles. `rightHalfPlaneCount` counts poles with
`re > 0`; `stable` requires every returned pole to have `re < 0`. Imaginary-axis
poles are not strictly stable. A static transfer with no finite poles is
vacuously stable. RHP zeros do not affect this verdict. This describes the
requested finite transfer poles, not a proof about unobservable internal modes.

## Noise metrics

Call `spice_noise_metrics` with `{ request, bandHz: [10, 100000], spotFrequenciesHz: [10, 1000] }`.
Both selectors are optional. The default band is the entire simulated sweep;
at most 128 positive spot frequencies are accepted. The request must contain
exactly one unstepped noise analysis. Supply exactly one of `{ netlist: "..." }`
or `{ request: { apiVersion: "1", input: ... } }`. Protocol inputs accept
`spice`, `spice-ts`, and `circuit-json`. Native documents use optional
`noiseAnalyses` (separate from `analyses`, like `poleZeroAnalyses`):

```json
"noiseAnalyses": [{
  "type": "noise", "outputNode": "out", "inputSource": "V1",
  "variation": "dec", "points": 100, "startFreq": 1, "stopFreq": 1000000
}]
```

`outputReferenceNode` optionally selects differential voltage output. The sweep
uses `dec`, `oct`, or `lin`, positive integer `points`, and positive finite
`startFreq`/`stopFreq` in Hz with `stopFreq >= startFreq`. Invalid fields return
`INVALID_REQUEST` with a JSON pointer in `error.details.path`. For `circuit-json`,
place `noiseAnalyses` directly on `input`; conversion preserves it and reports
unsupported components through structured conversion diagnostics. Native noise
uses the same solver/device limitations as SPICE `.noise`.

Other analysis directives are not executed by this tool. Includes, netlist temperature/options, request
overrides, worker cancellation, wall-time limits and resource limits are retained.

`integratedOutputNoiseVrms` is output RMS voltage. `integratedInputNoiseRms`
is RMS in `inputUnit` (`V` for voltage-source input, `A` for current-source input).
Integration squares the density samples to PSD, clips segments to `bandHz`
with linear PSD interpolation, sums trapezoids in linear frequency, then takes
the square root. This differs from core's native noise integration method.
Each `spots` entry contains `frequencyHz`, `outputNoiseVPerSqrtHz`,
`inputNoisePerSqrtHz`, and `outOfRange`. Densities interpolate linearly against
log frequency, including zero density; spots outside the sweep return null
densities and `outOfRange: true`, never extrapolation. `method` records these
choices. SPICE rejects `.step` with `.noise` as a structured `PARSE_ERROR`.
Missing/ambiguous noise analyses, malformed selectors, and a
band outside the sweep return the standard structured `INVALID_REQUEST` error.

## Transient step metrics

Call `spice_tran_metrics` with `{ request, signal: "v(out)" }`. The request is the
same `SimulationRequestV1` used by `spice_simulate`. Signals are case-insensitive
`v(node)` or `i(branch)`. Optional `analysis` is a zero-based analysis index;
otherwise exactly one transient analysis must exist. Run stepped analyses separately.

Example tool arguments:

```json
{
  "request": {
    "apiVersion": "1",
    "input": {
      "format": "spice",
      "source": "V1 in 0 PWL(0 0 100u 0 100.001u 1)\nR1 in out 1k\nC1 out 0 1u\n.tran 5u 15m\n.end"
    }
  },
  "signal": "v(out)",
  "finalValue": 1,
  "settlingBandPercent": 2
}
```

The response contains `initialValue`, `finalValue`, `unit` (`V` or `A`),
`riseTimeS`, `fallTimeS`, `overshootPercent`, `undershootPercent`, `settlingTimeS`,
`peakValue`, and `peakTimeS`. The RC example has about 2.197 ms rise time.
Rise/fall times use the first directed 10% and 90% crossings with linear time
interpolation; the opposite direction's field is `null`. Overshoot is excursion
beyond the final level and undershoot is excursion behind the initial level,
both normalized to the absolute step amplitude. Peak is the maximum excursion
in the step direction (minimum value for a falling step), at the first sampled
extremum. `peakTimeS` and `settlingTimeS` are absolute times on the simulation
axis, not durations measured from an inferred stimulus onset.

Optional `initialValue` and `finalValue` specify known step levels. Defaults are
the first and last samples, not extrapolated DC levels. Use a sufficiently long
single-step trace, or provide known levels; endpoint estimates cannot prove a
truncated response has reached its true asymptote. Settling is the final entry
into a band of `settlingBandPercent` of the step amplitude (default 2, strictly
between 0 and 100), interpolated after the last out-of-band sample. The trace
must remain in band for at least the final 10% of its sampled duration.

Metric failures set MCP `isError` and return `{ error: { code, message } }` with
`NOT_TRANSIENT` (no unique transient selection), `SIGNAL_NOT_FOUND`,
`NO_TRANSITION` (equal levels or missing ordered 10/90 crossings), `NOT_SETTLED`
(insufficient in-band hold), or `INVALID_DATA` (invalid vectors/arithmetic).
Malformed arguments and simulation/resource failures retain the standard API
error shape. This tool changes no solver or benchmark semantics.

## AC metrics

Call `spice_ac_metrics` with the same `request` as `spice_simulate`, a required
`output` voltage node name, optional `input` voltage node name, and optional
zero-based `analysis` index. Names are case-insensitive, without `v(...)` wrappers.
Without an input node the output is relative to 1 V; with one it uses the complex
ratio V(output)/V(input). By default exactly one AC analysis must exist. Select an
index when there are multiple analyses; run stepped analyses separately.

Example tool arguments:

```json
{
  "request": {
    "apiVersion": "1",
    "input": {
      "format": "spice",
      "source": "V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac dec 100 0.1 100k\n.end"
    }
  },
  "output": "out",
  "input": "in"
}
```

The response contains `dcGainDb`, `f3dbHz`, `unityGainHz`, `phaseMarginDeg`,
`gainMarginDb`, `peakingDb`, `peakFrequencyHz`, `referenceFrequencyHz`, and `reasons`. Despite its conventional
name, `dcGainDb` is explicitly the gain at the lowest sampled frequency, reported
in `referenceFrequencyHz`, NOT an extrapolation to DC. Start sufficiently below
the first pole to estimate DC gain; high-pass/band-pass sweeps have no inferred
DC plateau. `f3dbHz` is the first descending half-power crossing (3.0103 dB below
that reference gain). The RC example gives approximately 159.15 Hz.

Crossings interpolate dB and unwrapped phase linearly in log-frequency, never
outside the sweep. Unity gain uses the first descending 0 dB crossing; phase
margin is 180 degrees plus phase there. Gain margin is minus the dB gain at the
first descending -180 degree unwrapped-phase crossing. These are conventional
negative-feedback loop-gain metrics: supply a loop-gain transfer function to
interpret them as stability margins, not an arbitrary closed-loop response.
Phase starts on [-180, 180) and unwraps between adjacent samples; sample densely
enough to avoid phase aliasing. Exact target samples at either endpoint count
when part of a strictly descending segment; flat or rising segments do not.
`peakingDb` is the maximum sampled gain minus the lowest-frequency gain;
`peakFrequencyHz` is the first sampled frequency attaining that maximum. These
do not estimate peaks between samples. A monotone low-pass has zero peaking.
Missing or non-finite metrics are `null` with a stable code in `reasons`:
`NON_FINITE_GAIN`, `NO_HALF_POWER_CROSSING`, `NO_UNITY_GAIN_CROSSING`, or
`NO_PHASE_CROSSING`, not infinity or extrapolated values. Unknown nodes produce the usual
structured `INVALID_REQUEST` error with `details.reason: "UNKNOWN_NODE"` and
`details.node`; a zero input phasor produces `UNDEFINED_TRANSFER`. Simulation,
worker time, concurrency, point, and response byte limits still apply.

Reproduce the two-pole op-amp macromodel comparison against ngspice-47 `.meas ac`
with `spice-heavy pnpm exec tsx benchmarks/mcp-ac-metrics/compare.mts` from the
repository root after building. Both engines use the committed identical circuit
and sweep. The check allows 0.5% UGF error and 0.5 degrees phase-margin error;
ngspice interpolates crossings in frequency while this tool uses log-frequency.

## Run over stdio

Build the workspace, then configure an MCP client to execute:

    node /absolute/path/to/spice-ts/packages/mcp/dist/stdio.js

The package's scripts do not rebuild `@spice-ts/core`; they rely on the workspace build order (`pnpm build` at the root builds dependencies first). To build only this package plus its workspace dependencies, use `pnpm --filter @spice-ts/mcp... build`.

For the executable bounded-agent workflow:

    pnpm -C packages/mcp build
    pnpm -C packages/mcp example

The example launches the built `dist/stdio.js` server. It calls `spice_capabilities`, validates an authored voltage divider, and intentionally requests zero result points. The resulting `RESOURCE_LIMIT` has stable public fields under `error.code`, `error.phase`, and `error.details`. The client recovers using `error.details.maximum` and `error.details.actual`, then runs `spice_simulate` again. It never branches on an implementation backend name or parses display text.

The stable output fields and order are recorded in `examples/agent-output.json`. Test the packed package-consumer form with:

    pnpm -C packages/mcp test:packed-consumer

That command packs the MCP, protocol, and core packages, installs them into an isolated project, starts the installed stdio server through the packaged example, and compares stdout byte-for-byte with the expected output.

Expected stable fields are `capabilities.protocolVersion: "1"`, validation counts `2` nodes, `1` branch, and `1` analysis, then `boundedFailure.error.code: "RESOURCE_LIMIT"` with `details.limit: "maxResultPoints"`, `maximum: 0`, and `actual: 1`. Recovery raises only that client limit to the observed point count. The completed OP result contains `out: 5` V and `V1: -0.005` A.

## Resource and cancellation policy

The default simulation ceilings are:

- document: 262144 UTF-8 bytes
- analyses: 8
- result points: 100000
- serialized result: 4194304 UTF-8 bytes
- wall time: 10000 ms

Streaming applies the same document, analysis, point, serialized-result, and wall-time ceilings. Request limits are checked before a job is retained, then result limits are checked when its worker finishes. Read chunks are point-counted rather than time- or byte-timed. The default chunk is 256 points and `maxPoints` cannot exceed 1024. Each server retains at most 16 jobs; starting a seventeenth evicts the oldest terminal job or returns `RESOURCE_LIMIT` when all retained jobs are unfinished. At most 2 jobs solve at once per server (`streaming.maxConcurrentJobs`): live stream jobs and in-flight `spice_simulate` calls share the quota, and `spice_validate` does not use it. A start or one-shot simulation beyond it fails before any worker starts with a retryable `RESOURCE_LIMIT` (`phase: "transport"`, `details: { limit: "maxConcurrentJobs", configured: 2, observed: 3, maximum: 2, actual: 3 }`). A slot frees as soon as the job completes, fails, is cancelled, or expires, whether or not its data has been read. A cursor is job-scoped, forward-only, and replayable: once it emits a chunk, the same cursor returns the identical chunk even if a later call supplies a different `maxPoints`.

Each running job has a 30000 ms TTL. Completion, failure, cancellation, or running-job expiry starts a 300000 ms terminal-retention TTL. These values and the reasons for them are documented in [docs/architecture/ai-native-api.md section 8](https://github.com/spicets/spice-ts/blob/main/docs/architecture/ai-native-api.md#8-cancellation-isolation-and-resource-limits), which `spice_capabilities` matches. During that window, existing cursors and idempotent cancellation remain replayable. After it expires, reads and cancellation return the same `INVALID_REQUEST` used for an unknown job. Running expiry aborts and terminates isolated worker work, then returns a `RESOURCE_LIMIT` terminal with `details.limit: "runningJobTtlMs"`. Its partial counts and `partialEventSha256` cover only events already delivered to the caller.

Unread retention is capped per job at 256 events and 1048576 UTF-8 bytes. Bytes are the sum of compact `JSON.stringify(event)` byte lengths. A live worker offers one canonical batch at a time and receives its acknowledgement only after that batch is read. A batch that would exceed either ceiling is rejected before any event in it is retained or delivered. The job ends with `RESOURCE_LIMIT`, `details.limit` set to `maxUnreadEvents` or `maxUnreadBytes`, and exact `maximum` and attempted `actual` values. Cancellation and TTL expiry release blocked producers and terminate the worker. They never acknowledge or expose the unread batch.

`spice_simulation_start` returns `{ jobId, status: "running", cursor }` while the isolated worker is live. Pass those identifiers to `spice_simulation_read`. A read made before points are available returns `status: "running"`, no events, and the same cursor. SPICE requests containing only transient or AC analyses forward canonical points from the live solver in internally backpressured two-point batches, before the terminal `SimulationResultV1` exists. The effective `maxResultPoints` ceiling is enforced before each live batch is retained, so an over-limit batch is not delivered and the job ends with a deterministic `RESOURCE_LIMIT` terminal. Other supported requests retain deterministic post-result chunking. Reads use `SimulationReadDataV1` directly with canonical `analysis-start`, contiguous `point`, and `analysis-end` events followed by the existing success terminal. Cancelling after a live batch terminates the worker before its terminal solve and returns `status: "cancelled"`; its partial hash covers only point events already emitted. The internal core backend name is not a public error value; successful metadata uses the protocol backend `spice-ts-js`.

An unexpected isolated-worker error or exit ends the job with the stable public `INTERNAL_ERROR` transport failure; exit codes, signals, and private error text are not parsed or exposed. If no point has been delivered, the terminal contains empty partial analyses and the canonical hash of an empty point-event sequence. If canonical events were retained before the exit, reads continue to obey `maxPoints` and opaque cursor replay until those events are delivered, then return one partial failure whose analysis counts and `partialEventSha256` cover exactly the delivered points. Duplicate exit notifications are ignored, already-exited workers are not terminated again, and reads from the terminal cursor replay byte-equivalent structured content for the terminal retention period.

A request may specify tighter protocol limits but cannot raise the simulation ceilings. Server code can configure stream retention through `createToolExecutor({ streamLimits })` or `createMcpServer({ streamLimits })`. Tests and embedders can also inject a `StreamClock` with `now`, `setTimeout`, and `clearTimeout`; production uses the Node clock. Source directives are preflighted for analysis and point counts with the core parser and core's result-point estimate, so SI suffixes such as `1us` count exactly as core counts them; core applies any `.step` multiplier during validation, and completed results are checked again before serialization. A stream's success metadata reports `resolvedOptions` as the run uses them: request options override netlist `.options`, which override core defaults. `maxTimestep` is the largest transient step cap core applies (`.tran` TMAX, otherwise the request `maxTimestep`, otherwise min(TSTEP, TSTOP/50); a request `maxTimestep` of 0 is unset, as in ngspice, and a negative one is rejected as `INVALID_REQUEST`), or `Number.MAX_VALUE` when the run has no transient analysis. MCP cancellation is observed before and during adapter calls. Stream cancellation aborts the job controller, terminates its isolated worker, and keeps an idempotent partial terminal. A cancelled call returns `CANCELLED`; a ceiling returns `RESOURCE_LIMIT` with the limit name, maximum, and observed value where available.

The executable example proves the current packed Node stdio package's capability, validation, and one-shot tools, JSON-safe results, and one deterministic point-bound recovery path. The packed-consumer and official-client tests additionally exercise live-worker cancellation, normal stream completion, transport backpressure, replay before expiry, terminal expiry, unread-event failure, cancellation under backpressure, malformed cursors, worker-death cleanup, abnormal and duplicate exits, partial worker-death hashing through the official client over an in-process transport, hard chunk bounds, partial cancellation, and backend-name non-leakage. They do not prove the browser worker or WASM facade, network deployment, authentication, or every resource ceiling.

The stdio process writes protocol messages only to stdout. Do not wrap it with a network listener without adding the authentication, isolation, and deployment design that this bounded package intentionally omits.
