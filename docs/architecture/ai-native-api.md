# AI-native API architecture

Status: accepted design target for M3

Issue: [#57](https://github.com/mfiumara/spice-ts/issues/57)
Related: [#35](https://github.com/mfiumara/spice-ts/issues/35) (`circuit-json` adapter)

## 1. Goals and non-goals

This API lets an agent validate and simulate a circuit without scraping console text, grants long-running work an explicit lifecycle, and returns deterministic JSON with actionable diagnostics. The same versioned request and event contracts are used by direct TypeScript clients, MCP, and browser/WASM clients.

The first implementation must preserve the existing `@spice-ts/core` analysis semantics. This design does not add devices, change numerical methods, claim cross-backend bit equality, expose arbitrary host files, or replace the existing ergonomic TypeScript API (`simulate`, `simulateStream`, and `Circuit`). MCP is a transport adapter, not a second simulator.

## 2. Package ownership

The dependency direction is fixed:

```text
@spice-ts/core/protocol         JSON-safe types, JSON Schemas, canonicalization
          ^                                  ^
          |                                  |
@spice-ts/core          @spice-ts/circuit-json (#35)
          ^                     ^
          +----------+----------+
                     |
              @spice-ts/mcp

@spice-ts/wasm -> @spice-ts/core/protocol + a pinned core/WASM build
```

- `@spice-ts/core/protocol` is an environment-neutral subpath with no runtime dependencies. It owns protocol version `1`, JSON Schema 2020-12 documents, canonical JSON rules, request/result/event types, error codes, and conformance fixtures. It does not import simulator types; structurally compatible protocol types keep this entry point independent of the simulator.
- `@spice-ts/core` remains the source of parser and simulator behavior. A protocol adapter in core maps protocol documents to the current `CircuitIR`, analyses, models, and subcircuits and maps `Map`/typed-array results into JSON-safe values. Existing TypeScript return types remain source-compatible.
- `@spice-ts/circuit-json` remains exactly the adapter proposed by #35 and is the only package that depends on `circuit-json` or Zod. It maps `circuit-json` to/from `CircuitIR`; it does not own analyses, simulation, MCP, or the native schema. #35 must add conversion diagnostics so unsupported elements are never silently discarded.
- `@spice-ts/mcp` is Node-only. It depends on the official MCP TypeScript SDK, protocol, core, and circuit-json adapter. It owns tool registration, job storage, worker isolation, quotas, and stdio transport. HTTP authentication/deployment is out of scope for M3.
- `@spice-ts/wasm` is the browser/worker distribution boundary. It exposes the protocol API rather than core classes. The M3 slice runs the TypeScript engine as backend `spice-ts-js` in a module worker and must not advertise `spice-ts-wasm`. A later slice may add a real Rust/C/C++ WASM numeric artifact and only then advertise `spice-ts-wasm`, without changing protocol v1. The existing optional `ngspice-wasm` backend remains a distinct backend and is not renamed or bundled into this package.

Core and UI must not acquire MCP, Zod, or circuit-json runtime dependencies.

## 3. Versioned JSON circuit document

Every request carries `apiVersion: "1"`. The native JSON input has `format: "spice-ts"` and `schemaVersion: "1.0"`. Major protocol or schema versions change only for incompatible wire changes. Minor schema revisions may add optional fields and enum members; consumers must reject unsupported major versions and ignore unknown optional fields only after schema validation permits them.

A simulation request accepts one of three tagged inputs:

```ts
type SimulationInput =
  | {
      format: 'spice'
      source: string
      virtualFiles?: Record<string, string>
    }
  | {
      format: 'spice-ts'
      document: SpiceTsCircuitDocumentV1
    }
  | {
      format: 'circuit-json'
      circuit: unknown[]
      analyses: AnalysisV1[]
    }
```

`virtualFiles` is an in-memory, POSIX-style include namespace. Include names are normalized, may not be absolute, and may not contain `..`. The MCP server never resolves host paths or URLs. The entry netlist is `source`; `.include` and `.lib` may read only entries present in `virtualFiles`.

The native document is the lossless JSON counterpart of the current parser output. Maps are arrays so order and duplicate validation are explicit:

```json
{
  "format": "spice-ts",
  "schemaVersion": "1.0",
  "circuit": {
    "components": [
      {
        "type": "V",
        "id": "V1",
        "name": "V1",
        "ports": [{ "name": "p", "net": "in" }, { "name": "n", "net": "0" }],
        "params": { "waveform": "dc", "dc": 5 }
      },
      {
        "type": "R",
        "id": "R1",
        "name": "R1",
        "ports": [{ "name": "p", "net": "in" }, { "name": "n", "net": "0" }],
        "params": { "resistance": 1000 }
      }
    ],
    "nets": ["in"]
  },
  "analyses": [{ "type": "op" }],
  "models": [],
  "subcircuits": []
}
```

A native document may include `"temperatureSweep": { "values": [0, 27, 75] }` to run its OP analyses once per listed Celsius temperature, in order. The list must contain 1–16 finite values strictly above −273.15 °C. Only OP analyses are supported with this sweep; nested, range, parameter and component sweeps are not supported. Do not combine it with `options.temperature`; the request is rejected as ambiguous. `options.nominalTemperature` remains independent. Result entries carry the existing `step` coordinate, and normal resource and cancellation limits apply. This field is not available on `circuit-json` input.

The schemas use JSON numbers in SI base units and forbid `NaN`, infinities, and `-0` after canonicalization. Ground is always `"0"` and is omitted from `circuit.nets`, matching `CircuitIR`. Component IDs, model names, and subcircuit names must be unique under SPICE's case-insensitive comparison.

A `circuit-json` input is validated and converted by #35, then paired with protocol-owned analyses. Geometry, PCB elements, and other non-simulation elements may remain available to the adapter but do not enter core. #35 owns the normative `ConversionResultV1<T>` shape, ordered per-element diagnostics, and `allowLossy` option. Every simulation-relevant element or parameter that cannot be represented is reported as a conversion diagnostic with severity `error` and code `UNSUPPORTED_ELEMENT` or `UNSUPPORTED_PARAMETER` (ignored layout-only elements are `LAYOUT_ONLY` info); when any error is present `fromCircuitJSON` returns no `value`, so no circuit exists and simulation cannot start. MCP accepts `spice`, `spice-ts`, and `circuit-json` inputs. For `circuit-json`, MCP invokes `@spice-ts/circuit-json` at its bounded request boundary and passes the converted native document to core or its isolated worker. Fatal conversion diagnostics appear in `error.details.diagnostics`; the first error maps to API `UNSUPPORTED_ELEMENT` for unsupported elements, otherwise `INVALID_CIRCUIT`. Nonfatal diagnostics are returned as `_meta.conversionDiagnostics` on validation, simulation, and stream-start results. Core itself does not import the converter. Export returns no value when it would be lossy unless the caller explicitly sets `allowLossy: true`, and opt-in never suppresses the per-loss diagnostics. This avoids duplicating #35 while making its contract usable by agents.

## 4. Requests and serializable results

The common one-shot request is:

```json
{
  "apiVersion": "1",
  "input": { "format": "spice", "source": "V1 in 0 5\nR1 in 0 1k\n.op" },
  "options": {
    "backend": "spice-ts-js",
    "determinism": "strict",
    "limits": { "maxResultPoints": 10000 }
  }
}
```

`options` exposes the existing numerical controls (`abstol`, `vntol`, `reltol`, `maxIterations`, `maxTransientIterations`, `maxTimestep`, `integrationMethod`, `trtol`, and `gmin`) plus protocol controls. Missing numerical options are resolved to explicit values before execution and echoed in metadata.

All responses are JSON-safe envelopes:

```ts
interface SuccessEnvelope<T> {
  apiVersion: '1'
  ok: true
  requestId: string
  data: T
  diagnostics: DiagnosticV1[]
  metadata: RunMetadataV1
}

type PartialRunMetadataV1 = Partial<Omit<RunMetadataV1, 'resultSha256'>>

interface FailureEnvelope {
  apiVersion: '1'
  ok: false
  requestId: string
  error: SpiceApiErrorV1
  diagnostics: DiagnosticV1[]
  metadata?: PartialRunMetadataV1
}
```

`PartialRunMetadataV1` is a distinct schema with `additionalProperties: false`; `resultSha256` is not one of its properties. Failed and cancelled envelopes containing that property must fail schema validation even when a full result happened to be assembled internally.

The following interfaces are the normative protocol-v1 wire shape. JSON Schema names and generated TypeScript names must match them; implementations may not substitute current core classes, `Map`, typed arrays, or row-oriented records.

```ts
interface StepCoordinateV1 {
  index: number
  parameter: string
  value: number
}

interface OperatingPointResultV1 {
  type: 'op'
  analysisIndex: number
  step?: StepCoordinateV1
  voltagesV: Record<string, number>
  currentsA: Record<string, number>
}

interface DcResultV1 {
  type: 'dc'
  analysisIndex: number
  step?: StepCoordinateV1
  axis: { name: string; unit: 'V' | 'A'; values: number[] }
  voltagesV: Record<string, number[]>
  currentsA: Record<string, number[]>
}

interface TransientResultV1 {
  type: 'tran'
  analysisIndex: number
  step?: StepCoordinateV1
  timeS: number[]
  voltagesV: Record<string, number[]>
  currentsA: Record<string, number[]>
}

interface ComplexPolarV1 {
  magnitude: number
  phaseDegrees: number
}

interface AcResultV1 {
  type: 'ac'
  analysisIndex: number
  step?: StepCoordinateV1
  frequencyHz: number[]
  voltagePhasors: Record<string, ComplexPolarV1[]>
  currentPhasors: Record<string, ComplexPolarV1[]>
}

type AnalysisResultV1 =
  | OperatingPointResultV1
  | DcResultV1
  | TransientResultV1
  | AcResultV1

interface SimulationResultV1 {
  status: 'complete'
  analyses: AnalysisResultV1[]
}
```

`analysisIndex` is the zero-based declaration order after expansion and is never reused within a request. A stepped analysis repeats that index and adds `step`; steps are ordered by `step.index`. Object keys in every voltage/current record are lexicographically sorted by Unicode code point. Every series array has exactly the same length as its axis. OP has no synthetic axis or point. Empty analyses are represented by empty axes and series, not omitted fields. These invariants are schema-plus-conformance-test requirements.

Metadata includes protocol version, native schema version when applicable, spice-ts version, `engineBuildId`, backend name/version, resolved options, input SHA-256, result SHA-256, runtime family/version, architecture, and deterministic profile. `resultSha256` covers only canonical `SimulationResultV1`, not its envelope or metadata. Timing and timestamps are excluded from hashed result data and omitted in strict mode.

The public protocol backend for the TypeScript engine is always `spice-ts-js`. Core may retain its existing internal `spice-ts` adapter name, but protocol boundaries must translate it to `spice-ts-js`; `spice-ts` is not a valid protocol-v1 backend value and must never appear in requests, capabilities, events, or metadata.

## 5. Structured errors and diagnostics

MCP transport failures are reserved for malformed MCP calls or server failure. Validation and simulation failures are normal tool results with `ok: false`, so agents receive the full structured payload.

```ts
interface SpiceApiErrorV1 {
  code:
    | 'INVALID_REQUEST'
    | 'PARSE_ERROR'
    | 'INVALID_CIRCUIT'
    | 'UNSUPPORTED_FEATURE'
    | 'UNSUPPORTED_ELEMENT'
    | 'SINGULAR_MATRIX'
    | 'CONVERGENCE_FAILED'
    | 'TIMESTEP_TOO_SMALL'
    | 'RESOURCE_LIMIT'
    | 'CANCELLED'
    | 'BACKEND_UNAVAILABLE'
    | 'INTERNAL_ERROR'
  message: string
  retryable: boolean
  phase: 'validation' | 'parse' | 'compile' | 'solve' | 'serialize' | 'transport'
  details: Record<string, unknown>
}

interface DiagnosticV1 {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string
  source?: { file: string; line: number; column?: number; excerpt?: string }
  related?: Array<{ path?: string; message: string }>
  suggestions?: Array<{ action: string; replacement?: unknown }>
}
```

Core errors map without parsing their message strings: `ParseError` to `PARSE_ERROR` with its line/context, `InvalidCircuitError` to `INVALID_CIRCUIT`, `SingularMatrixError` to `SINGULAR_MATRIX` with involved nodes, `ConvergenceError` to `CONVERGENCE_FAILED` with kind/time/oscillating nodes/dt/gmin, `TimestepTooSmallError` to `TIMESTEP_TOO_SMALL`, and `CycleError` to `INVALID_CIRCUIT` with the dependency chain. A native-document model whose type no device implements (`UnsupportedCircuitModelTypeError`) maps to `UNSUPPORTED_FEATURE` with `details.reason: "UNSUPPORTED_MODEL_TYPE"`, `modelName` and `modelType`; an instance whose model belongs to another device kind (`ModelTypeMismatchError`, e.g. an `M` card naming an `NPN` model) maps to `INVALID_CIRCUIT` with `details.reason: "MODEL_TYPE_MISMATCH"`, `deviceName`, `deviceKind`, `modelName`, `modelType` and `expectedTypes`. Raw solution vectors are not returned by default because they can be large; `details.solutionSummary` carries bounded extrema and changed-node summaries. Unknown exceptions become `INTERNAL_ERROR` with an opaque incident ID, never a stack trace in MCP output.

This is a required core change, not a claim about the current implementation. Today the real and complex sparse solvers throw plain `Error` for singular pivots, so they cannot be mapped by type. #60 owns replacing every such solver throw site with `SingularMatrixError`, preserving source node/branch identity through matrix assembly, and adding exact mapping tests. No adapter may classify errors by matching `Error.message`.

`spice_validate` performs schema validation, parse, compile, and a deterministic topology preflight; it does not numerically solve. Its successful result includes a `diagnostics` array of advisory warnings with `severity: 'warning'`, `code`, `nodes`, `elements`, and a one-line `hint`. The codes are `FLOATING_NODE` (fewer than two distinct connected elements), `NO_DC_PATH_TO_GROUND` (DC-connected node set without a conductive path to node 0; capacitors/current sources do not count), and `VOLTAGE_SOURCE_LOOP` (first ideal V/E/H/L loop in element-id order). `.options rshunt` suppresses missing-DC-path warnings. Warnings are sorted by code then node ids; ids use code-point order and lists are capped at 32. Direct core validation remains strict by default; MCP opts into warnings. Simulation behavior is unchanged. Validation must not promise numerical convergence or that all numerical singularities are found before solving.

Clean validation results omit the optional `diagnostics` array. `retryable` is false for schema, parse, topology, unsupported-feature, and backend-unavailable failures; true for cancellation; and true for convergence/resource failures only when a diagnostic supplies a concrete changed option that stays inside server limits.

## 6. Determinism contract

`determinism: "strict"` is the default for protocol clients.

- The same validated input, resolved options, backend artifact, `engineBuildId`, runtime family/version, and architecture must produce byte-identical canonical result JSON and identical chunk boundaries.
- Components preserve document order for solving. Externally visible object keys, node names, branch names, diagnostics, and warnings are sorted by documented stable keys. No locale-sensitive sort is used.
- JSON is canonicalized with UTF-8, lexicographic object keys, no insignificant whitespace, normalized `-0` to `0`, and rejected non-finite numbers. SHA-256 hashes cover this canonical form.
- Adaptive steps and generated sweep points are emitted in solver order. Chunking is by a fixed point count, never elapsed time or byte timing.
- No wall-clock timestamp, random ID, duration, thread race, or host path enters hashed data. `requestId`/`jobId` are envelope fields outside result hashing.
- Worker concurrency may change throughput but not solve order inside one job.

The contract deliberately does not promise bit-identical numbers across different runtime versions, architectures, backends, core builds, or future numeric WASM kernels. Metadata makes those boundaries visible. Cross-environment conformance uses documented numerical tolerances and identical topology/point ordering; it must never be advertised as bit equality.

## 7. MCP tool surface

Tool names are namespaced and frozen for protocol v1:

1. `spice_capabilities` — no circuit input; returns supported protocol/schema versions, backends, analyses, devices, hard limits, defaults, and optional features.
2. `spice_validate` — validates, parses, compiles, and runs the topology preflight described in section 5 for any `SimulationInput`; returns normalized metadata, diagnostics, estimated point count, and unsupported features without numerically solving.
3. `spice_simulate` — bounded one-shot simulation. It rejects work whose estimate exceeds synchronous limits and points the caller to `spice_simulation_start`.
4. `spice_simulation_start` — starts an isolated job and returns `jobId`, status, and the first cursor.
5. `spice_simulation_read` — accepts `jobId`, opaque cursor, and optional `maxPoints` up to the server cap; returns ordered `events`, `nextCursor`, status, and a terminal success/error envelope when complete.
6. `spice_simulation_cancel` — idempotently requests cancellation; returns the current terminal or cancelling state.

MCP `structuredContent` contains these envelopes. A short text summary is also returned for clients that do not render structured content, but it is not an API and must not be parsed. Tool input schemas reference the published protocol schemas.

`spice_simulation_read` is pull-based because MCP does not guarantee portable arbitrary tool-result streaming. Cursors are job-scoped, opaque, single-direction, and replayable: reading the same cursor returns the same chunk until job expiry. Events are:

```ts
type StreamPointV1 =
  | {
      type: 'dc'
      axis: { name: string; unit: 'V' | 'A'; value: number }
      voltagesV: Record<string, number>
      currentsA: Record<string, number>
    }
  | {
      type: 'tran'
      timeS: number
      voltagesV: Record<string, number>
      currentsA: Record<string, number>
    }
  | {
      type: 'ac'
      frequencyHz: number
      voltagePhasors: Record<string, ComplexPolarV1>
      currentPhasors: Record<string, ComplexPolarV1>
    }

type SimulationEventV1 =
  | {
      type: 'analysis-start'
      analysis: 'op' | 'dc' | 'tran' | 'ac'
      analysisIndex: number
      step?: StepCoordinateV1
    }
  | {
      type: 'point'
      analysisIndex: number
      step?: StepCoordinateV1
      pointIndex: number
      point: StreamPointV1
    }
  | {
      type: 'analysis-end'
      analysis: 'op' | 'dc' | 'tran' | 'ac'
      analysisIndex: number
      step?: StepCoordinateV1
      pointCount: number
    }
  | { type: 'diagnostic'; diagnostic: DiagnosticV1 }

interface PartialAnalysisV1 {
  analysis: 'dc' | 'tran' | 'ac'
  analysisIndex: number
  step?: StepCoordinateV1
  emittedPointCount: number
  complete: boolean
}

interface PartialSimulationResultV1 {
  status: 'partial'
  analyses: PartialAnalysisV1[]
  // SHA-256 of the canonical point events emitted so far, in event order.
  partialEventSha256: string
}

type StreamTerminalV1 =
  | SuccessEnvelope<SimulationResultV1>
  | (FailureEnvelope & { partial: PartialSimulationResultV1 })

interface SimulationReadDataV1 {
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  events: SimulationEventV1[]
  nextCursor: string | null
  terminal?: StreamTerminalV1
}
```

Within an analysis/step pair, `pointIndex` starts at zero and is contiguous. The `point.type` must equal the enclosing analysis type. OP data appears only in a successful terminal `SimulationResultV1`, not as a fake point. `terminal` is absent while running and required otherwise; `nextCursor` is null exactly when terminal. On failure or cancellation, already-read points remain valid and `partialEventSha256` authenticates only emitted canonical point events. A partial result never has `status: 'complete'` or `metadata.resultSha256`, and cannot be substituted for the one-shot result hash.

## 8. Cancellation, isolation, and resource limits

The protocol accepts an `AbortSignal` in direct TypeScript adapters; core checks it before parse/compile, between analyses, between Newton iterations, and at each accepted/rejected streamed point. MCP cancellation terminates a dedicated worker if cooperative cancellation does not finish within one second. A killed worker yields `CANCELLED`, not `INTERNAL_ERROR`.

Server defaults are conservative. The `@spice-ts/mcp` server enforces exactly the following defaults and returns them, under the same keys, from `spice_capabilities` (`limits.*` and `streaming.*`). A server embedder may configure them (`createToolExecutor({ limits, streamLimits })`); `spice_capabilities` then reports the configured values. This table is the contract: `packages/mcp/src/server.test.ts` parses it and fails if it drifts from the server.

| Capability key | Default | Meaning |
|---|---:|---|
| `limits.maxDocumentBytes` | 262,144 | UTF-8 bytes of the request `input` (source plus virtual files), 256 KiB |
| `limits.maxAnalyses` | 8 | analyses per request |
| `limits.maxResultPoints` | 100,000 | result points, one-shot and streamed |
| `limits.maxSerializedResultBytes` | 4,194,304 | serialized `SimulationResultV1`, 4 MiB |
| `limits.maxWallTimeMs` | 10,000 | solve wall time of one call or job, including time a stream job is paused under backpressure |
| `streaming.defaultChunkPoints` | 256 | points per `spice_simulation_read` when `maxPoints` is omitted |
| `streaming.maxChunkPoints` | 1,024 | largest accepted `maxPoints` |
| `streaming.maxRetainedJobs` | 16 | jobs retained per server, running or terminal; the oldest terminal job is evicted first |
| `streaming.maxConcurrentJobs` | 2 | jobs solving at once per server: live stream jobs plus in-flight `spice_simulate` calls |
| `streaming.runningJobTtlMs` | 30,000 | a stream job not terminal by then is cancelled with `RESOURCE_LIMIT` |
| `streaming.terminalJobTtlMs` | 300,000 | completed, failed, cancelled, or expired jobs stay replayable for 5 min, then are deleted |
| `streaming.maxUnreadEvents` | 256 | unread events retained per job |
| `streaming.maxUnreadBytes` | 1,048,576 | unread event bytes retained per job (compact `JSON.stringify`), 1 MiB |

Why these values ([#792](https://github.com/mfiumara/spice-ts/issues/792) reconciled an earlier draft of this table with the server):

- Concurrency is 2. It is the only cap on how many isolated workers solve at once, so it bounds CPU and memory on a shared host. `spice_simulation_start` or `spice_simulate` beyond it fails before any worker starts with `RESOURCE_LIMIT`, `phase: "transport"`, `retryable: true`, and `details` `{ limit: "maxConcurrentJobs", configured, observed, maximum, actual }`, where `configured`/`maximum` is the cap and `observed`/`actual` the running count the call would have made. A slot frees when the job turns terminal (completion, failure, cancellation, or running-TTL expiry), whether or not its data has been read. `spice_validate` does not take a slot.
- The completed-job TTL is 5 min, not the earlier 60 s. An agent may spend more than a minute between starting a job and reading its terminal, and a terminal job holds memory (bounded by `maxRetainedJobs` and `maxSerializedResultBytes`, with oldest-terminal eviction) but no worker or concurrency slot.
- The running TTL stays 30 s instead of a 5 min job wall time. `maxWallTimeMs` (10 s) already ends the solve, backpressure pauses included, so a longer running TTL would only keep a hung job's concurrency slot occupied for longer.
- Unread retention stays 256 events / 1 MiB per job instead of 32 MiB. A live worker offers one two-point batch at a time and waits for it to be read, so a small buffer does not slow streaming, and 16 retained jobs then pin at most 16 MiB of unread data. Requests that are not streamed live (OP/DC analyses or `spice-ts` JSON input) are chunked from the finished result, which is already bounded by `maxResultPoints` and `maxSerializedResultBytes`; its events are derived lazily and released in cap-sized batches as reads drain the unread window ([#794](https://github.com/mfiumara/spice-ts/issues/794)).

Design targets not yet enforced by the MCP server, and so not reported by `spice_capabilities`: virtual files 64 (hard 256), include depth 16 (32), components after expansion 25,000 (100,000), subcircuit expansion depth 32 (64), synchronous result points 10,000 (50,000), and hard maxima above server policy.

Callers may lower limits but not raise them above server policy. Estimates do not replace runtime enforcement. MCP-layer limit failures identify `limit`, `maximum` (the configured cap), and `actual` (the observed or attempted value) in `details`; core protocol-adapter failures use `limit`, `configured`, and `observed`; the concurrent-job failure carries both pairs. Jobs apply backpressure: a live producer pauses until its retained unread batch is read; a batch that would exceed the unread caps fails the job with `RESOURCE_LIMIT`, and a job not terminal within the running TTL is cancelled. Completed and abandoned jobs are deleted after the terminal TTL. Workers have no network access or ambient filesystem access and receive only validated input bytes.

## 9. WASM path

`@spice-ts/wasm` exports asynchronous `createSpiceEngine(options)` and runs in browsers, Node, and Web Workers. Its methods are protocol-shaped: `validate`, `simulate`, `simulateStream`, and `cancel`. The M3 implementation supports only `{ backend: 'spice-ts-js' }`: initialization verifies a build manifest containing the module-worker asset SHA-256 and reports capabilities plus `engineBuildId` before accepting work. A corrupt/mismatched JS worker asset maps to `BACKEND_UNAVAILABLE`.

`spice-ts-wasm` is a reserved backend ID and is unavailable until the package contains a real numeric WASM artifact. Requesting it in the M3 slice deterministically returns `BACKEND_UNAVAILABLE`; capabilities must not list it. The later artifact-bearing slice must pin and verify one exact WASM SHA-256 before execution, increment `engineBuildId` for a different numeric kernel, and expose memory controls then. Its private ABI may change in minor releases because consumers bind to the JavaScript protocol facade, not raw exports. It may import no WASI, filesystem, socket, clock, or random capability. WASM memory begins at 64 MiB, may grow to a caller-configured ceiling no higher than 512 MiB, and failed growth maps to `RESOURCE_LIMIT`.

Backend IDs remain explicit: `spice-ts-js`, reserved `spice-ts-wasm`, and existing `ngspice-wasm`. There is no implicit or facade-selected fallback. A caller may retry a different backend in its own code; each attempt has its actual backend in metadata and any failed attempt remains visible to that caller. The facade accepts one backend per engine creation, not an ordered fallback list.

## 10. Agent workflows

### Workflow A: repair a floating-node circuit

Executable: [`examples/floating-node-repair`](../../examples/floating-node-repair/README.md), run in CI by [`examples/agent-workflows/issue-63`](../../examples/agent-workflows/issue-63/README.md).

1. The agent calls `spice_validate` with a SPICE netlist.
2. The MCP topology preflight returns `status: 'valid'` with a `NO_DC_PATH_TO_GROUND` warning, `nodes: ["sense"]`, incident element ids and a hint to add a DC path. Strict simulation preflight can still reject the topology with `INVALID_CIRCUIT`; a singularity discovered only while solving returns `SINGULAR_MATRIX`.
3. The agent edits the netlist, validates again, then calls `spice_simulate` for OP.
4. It asserts the returned `out` voltage and records input/result hashes in its engineering log.

No console-message parsing or host file access is required.

### Workflow B: simulate a large tscircuit transient

Executable: [`examples/circuit-json-threshold-cancellation`](../../examples/circuit-json-threshold-cancellation/README.md) and the partial-terminal schema checks in [`examples/agent-workflows/issue-63`](../../examples/agent-workflows/issue-63/README.md).

1. The agent exports a tscircuit design as circuit-json, converts it client-side with `fromCircuitJSON`, and calls `spice_validate` on the resulting `CircuitIR` as a `spice-ts` document with explicit transient analysis.
2. The #35 adapter reports every ignored layout-only element as `LAYOUT_ONLY` info and rejects any unsupported simulation-relevant device with an error diagnostic `UNSUPPORTED_ELEMENT` (unsupported parameters: `UNSUPPORTED_PARAMETER`) and no converted value, so no MCP request is sent.
3. After a clean validation and point estimate, the agent calls `spice_simulation_start`.
4. It repeatedly calls `spice_simulation_read`, checks ordered point indexes, persists chunks, and cancels when a voltage safety threshold is crossed.
5. It records the terminal partial status, backend/build metadata, and hashes of received canonical chunks.

## 11. Implementation slices and acceptance tests

Implementation is split into independently testable M3 issues:

1. [#59 Protocol package and JSON Schema](https://github.com/mfiumara/spice-ts/issues/59): schema fixtures round-trip, invalid unions/versions/non-finite values fail, and canonical hashes are stable on Node 20 and 22.
2. [#60 Core protocol adapter, structured errors, cancellation, and guards](https://github.com/mfiumara/spice-ts/issues/60): topology preflight catches independently tested floating-node/DC-path/source-loop fixtures; every singular solver throw site becomes a typed `SingularMatrixError` with involved nodes; each error maps by type; cancellation stops bounded solver fixtures; and every hard limit has a failing test.
3. Circuit-json interop remains [#35](https://github.com/mfiumara/spice-ts/issues/35): its normative `ConversionResultV1` diagnostics and explicit `allowLossy` export gate are tested for lossless R/C/M/Q round-trips, layout-only information, unsupported simulation elements, and refused lossy export. Do not create a competing adapter issue.
4. [#61 MCP package](https://github.com/mfiumara/spice-ts/issues/61): all six tools pass an in-process MCP client contract test; cursor replay, cancellation, TTL, worker death, and backpressure are covered.
5. [#62 WASM/worker facade](https://github.com/mfiumara/spice-ts/issues/62): browser and Node tests run the same conformance fixtures on `spice-ts-js`, verify the JS worker build manifest/build ID, prove reserved `spice-ts-wasm` is unavailable rather than falling back, and defer WASM checksum/memory tests until a real WASM artifact exists.
6. [#63 End-to-end agent examples](https://github.com/mfiumara/spice-ts/issues/63): both workflows above run headlessly in CI and snapshot only canonical structured outputs.

Each implementation issue may land independently behind protocol v1 fixtures. No implementation may publish a package or version as part of its acceptance test.

## 12. Rejected alternatives

- Putting MCP in core was rejected because it would make a transport dependency part of every browser bundle.
- Making circuit-json the native simulation schema was rejected because it does not own SPICE analyses/models and would force Zod into core; #35 remains an explicit adapter.
- Returning current core classes and `Map` objects over MCP was rejected because they are not JSON values.
- Push-only MCP progress notifications were rejected as the sole streaming mechanism because support and replay behavior vary by client.
- Silent WASM-to-JS fallback was rejected because it invalidates reproducibility claims.
- Cross-platform bit-identical claims were rejected because JavaScript engines, architectures, and numeric backends can legitimately differ.