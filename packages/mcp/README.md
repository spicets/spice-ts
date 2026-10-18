# @spice-ts/mcp

A bounded stdio MCP server exposing the existing spice-ts protocol-v1 adapter. It does not open a network listener and does not add simulator semantics.

## Tools

- `spice_capabilities`: deterministic discovery of supported analyses, input formats, and server limits.
- `spice_validate`: bounded parse/compile/topology validation without solving.
- `spice_convert`: convert `{ netlist: string }` to `{ circuitJson, diagnostics, lossy: false }`, or `{ circuitJson: [...] }` to `{ netlist, diagnostics, lossy: false }`.
- `spice_simulate`: one bounded protocol-v1 simulation.
- `spice_measure`: run the same simulation request once and return scalar measurements only.
- `spice_dc_metrics`: return DC transfer gain, switching threshold, unity-gain points and noise margins without raw vectors.
- `spice_simulation_start`: start a bounded simulation worker and return its opaque job cursor before solving completes.
- `spice_simulation_read`: pull a replayable chunk containing at most 256 points by default (caller-selectable from 1 through the hard cap of 1024).
- `spice_simulation_cancel`: idempotently stop delivery and return the protocol-v1 cancelled terminal with partial analysis counts and `partialEventSha256`.

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
inventing model parameters. Independent sources are unsupported in either direction.
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
coordinate 0; OP crossings are unavailable. Stepped results with repeated analysis
indices return `AMBIGUOUS_ANALYSIS`; run steps separately.

The response is `{ measurements: [{ value, unit } | { error: { code, message } }] }`,
in request order, never vectors. Units are V/A/dB for signal values and s/Hz/the DC
source unit for crossings. Per-item codes include `INVALID_MEASUREMENT`,
`UNKNOWN_SIGNAL`, `UNKNOWN_ANALYSIS`, `AMBIGUOUS_ANALYSIS`, `OUT_OF_RANGE`,
`NO_CROSSING`, and `NON_FINITE_RESULT` (including dB of zero).
Malformed lists fail the tool with `INVALID_REQUEST`; simulation failures use the
usual tool error. Lists contain 1 through 128 items, signals at most 256 characters.
Simulation point/byte/time limits still apply internally. Measurement payload bytes
and scalar response bytes are bounded too. Measurement calls share the one-shot
concurrency quota and the same Circuit JSON conversion/diagnostic path.

Example measurement for an AC low-pass with 1 V input:
`{ kind: 'cross', signal: 'db(v(out))', analysis: 0, value: -3.010299956639812, edge: 'falling' }`.

## Run over stdio

Build the workspace, then configure an MCP client to execute:

    node /absolute/path/to/spice-ts/packages/mcp/dist/stdio.js

The package's scripts do not rebuild `@spice-ts/core` or `@spice-ts/protocol`; they rely on the workspace build order (`pnpm build` at the root builds dependencies first). To build only this package plus its workspace dependencies, use `pnpm --filter @spice-ts/mcp... build`.

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

Each running job has a 30000 ms TTL. Completion, failure, cancellation, or running-job expiry starts a 300000 ms terminal-retention TTL. These values and the reasons for them are documented in [docs/architecture/ai-native-api.md section 8](https://github.com/mfiumara/spice-ts/blob/main/docs/architecture/ai-native-api.md#8-cancellation-isolation-and-resource-limits), which `spice_capabilities` matches. During that window, existing cursors and idempotent cancellation remain replayable. After it expires, reads and cancellation return the same `INVALID_REQUEST` used for an unknown job. Running expiry aborts and terminates isolated worker work, then returns a `RESOURCE_LIMIT` terminal with `details.limit: "runningJobTtlMs"`. Its partial counts and `partialEventSha256` cover only events already delivered to the caller.

Unread retention is capped per job at 256 events and 1048576 UTF-8 bytes. Bytes are the sum of compact `JSON.stringify(event)` byte lengths. A live worker offers one canonical batch at a time and receives its acknowledgement only after that batch is read. A batch that would exceed either ceiling is rejected before any event in it is retained or delivered. The job ends with `RESOURCE_LIMIT`, `details.limit` set to `maxUnreadEvents` or `maxUnreadBytes`, and exact `maximum` and attempted `actual` values. Cancellation and TTL expiry release blocked producers and terminate the worker. They never acknowledge or expose the unread batch.

`spice_simulation_start` returns `{ jobId, status: "running", cursor }` while the isolated worker is live. Pass those identifiers to `spice_simulation_read`. A read made before points are available returns `status: "running"`, no events, and the same cursor. SPICE requests containing only transient or AC analyses forward canonical points from the live solver in internally backpressured two-point batches, before the terminal `SimulationResultV1` exists. The effective `maxResultPoints` ceiling is enforced before each live batch is retained, so an over-limit batch is not delivered and the job ends with a deterministic `RESOURCE_LIMIT` terminal. Other supported requests retain deterministic post-result chunking. Reads use `SimulationReadDataV1` directly with canonical `analysis-start`, contiguous `point`, and `analysis-end` events followed by the existing success terminal. Cancelling after a live batch terminates the worker before its terminal solve and returns `status: "cancelled"`; its partial hash covers only point events already emitted. The internal core backend name is not a public error value; successful metadata uses the protocol backend `spice-ts-js`.

An unexpected isolated-worker error or exit ends the job with the stable public `INTERNAL_ERROR` transport failure; exit codes, signals, and private error text are not parsed or exposed. If no point has been delivered, the terminal contains empty partial analyses and the canonical hash of an empty point-event sequence. If canonical events were retained before the exit, reads continue to obey `maxPoints` and opaque cursor replay until those events are delivered, then return one partial failure whose analysis counts and `partialEventSha256` cover exactly the delivered points. Duplicate exit notifications are ignored, already-exited workers are not terminated again, and reads from the terminal cursor replay byte-equivalent structured content for the terminal retention period.

A request may specify tighter protocol limits but cannot raise the simulation ceilings. Server code can configure stream retention through `createToolExecutor({ streamLimits })` or `createMcpServer({ streamLimits })`. Tests and embedders can also inject a `StreamClock` with `now`, `setTimeout`, and `clearTimeout`; production uses the Node clock. Source directives are preflighted for analysis and point counts with the core parser and core's result-point estimate, so SI suffixes such as `1us` count exactly as core counts them; core applies any `.step` multiplier during validation, and completed results are checked again before serialization. A stream's success metadata reports `resolvedOptions` as the run uses them: request options override netlist `.options`, which override core defaults. `maxTimestep` is the largest transient step cap core applies (`.tran` TMAX, otherwise the request `maxTimestep`, otherwise min(TSTEP, TSTOP/50); a request `maxTimestep` of 0 is unset, as in ngspice, and a negative one is rejected as `INVALID_REQUEST`), or `Number.MAX_VALUE` when the run has no transient analysis. MCP cancellation is observed before and during adapter calls. Stream cancellation aborts the job controller, terminates its isolated worker, and keeps an idempotent partial terminal. A cancelled call returns `CANCELLED`; a ceiling returns `RESOURCE_LIMIT` with the limit name, maximum, and observed value where available.

The executable example proves the current packed Node stdio package's capability, validation, and one-shot tools, JSON-safe results, and one deterministic point-bound recovery path. The packed-consumer and official-client tests additionally exercise live-worker cancellation, normal stream completion, transport backpressure, replay before expiry, terminal expiry, unread-event failure, cancellation under backpressure, malformed cursors, worker-death cleanup, abnormal and duplicate exits, partial worker-death hashing through the official client over an in-process transport, hard chunk bounds, partial cancellation, and backend-name non-leakage. They do not prove the browser worker or WASM facade, network deployment, authentication, or every resource ceiling.

The stdio process writes protocol messages only to stdout. Do not wrap it with a network listener without adding the authentication, isolation, and deployment design that this bounded package intentionally omits.
