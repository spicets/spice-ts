# @spice-ts/core/protocol

Environment-neutral protocol v1 types, JSON Schema 2020-12 documents, conformance fixtures, and dependency-free canonical JSON/SHA-256 utilities.

## Canonical JSON

`canonicalJson` accepts only JSON values. It sorts object keys lexicographically by Unicode code point, emits no insignificant whitespace, uses UTF-8 bytes, normalizes `-0` to `0`, and rejects non-finite numbers, unsupported values, sparse arrays, and cycles. `sha256CanonicalJson` returns the lowercase SHA-256 hex digest of those bytes. Consumers must run schema validation and `checkConformanceV1` before canonicalization when non-canonical input such as `-0` must be rejected rather than normalized.

Result hashes cover only canonical `SimulationResultV1`. Partial hashes cover canonical point events in event order. Envelope metadata, timing, request IDs, and job IDs are outside these hash boundaries.

## Schemas and fixtures

Committed schemas are in `schemas/`; the exported `protocolSchemasV1` registry contains the same documents. Shared positive and negative conformance fixtures are in `fixtures/`. Structural constraints live in JSON Schema; cross-field rules (case-insensitive uniqueness, sorted record keys, series lengths, stream point ordering/discriminators, and canonical number diagnostics) are checked by `checkConformanceV1`.

## Native transient Fourier tables

Each native `tran` analysis may request its own Fourier tables:

```json
{ "type": "tran", "timestep": 0.00001, "stopTime": 0.003,
  "fourier": { "fundamentalHz": 1000, "outputs": ["v(out)", "v(out,ref)", "i(V1)"], "harmonics": 9 } }
```

`fundamentalHz` must be finite and positive. `outputs` is nonempty and supports only
`v(node)`, `v(node,reference)`, and `i(voltageSource)` (case-insensitive names,
including expanded subcircuit names; ground is `0` or `gnd`). Arbitrary expressions
and currents through other device kinds are not supported. `harmonics` is a positive
integer, defaults to 9, and is capped at 199 for the fixed 200-point grid. It counts
positive harmonics; the signed DC row is additional, so the default table has 10 rows.

The corresponding `tran` result has optional `fourier` tables, in operand order,
with `vector`, `fundamental` (Hz), `gridSize`, `degree`, `periods`, `thd` (percent),
and `harmonics` rows (`harmonic`, `frequency` in Hz, `magnitude`, `phase` in degrees,
`normalizedMagnitude`, `normalizedPhase` in degrees). Nonfinite numeric results
(for example normalization and THD for zero signal) are represented by JSON `null`.
Netlist `.four` tables are preserved in the same wire shape.

Postprocessing uses the unchanged ngspice-compatible Fourier routine, linear
interpolation of the last complete period, a 200-point endpoint-excluding grid,
and one period. The saved waveform must span at least that period. Invalid
configuration, unresolved nodes/voltage-source branches, or insufficient span
produce `INVALID_REQUEST` with an exact JSON Pointer in `details.path`.
Without `fourier`, native transient requests and results are unchanged; tables do
not leak between analyses. This adds no WASM or Fourier numerical changes.

## Native sensitivity requests

Native documents accept DC and AC sensitivity analyses. AC uses the core sweep field names, for example
`{ "type": "sens", "mode": "ac", "outputNode": "out", "variation": "dec", "points": 10, "startFreq": 10, "stopFreq": 1000 }`.
Use `outputReferenceNode` for differential voltage, or `outputType: "current"` with a voltage-source name in `outputNode` for branch current. Points must be positive integers; frequencies must be finite and positive, with `stopFreq >= startFreq`.

Execute the document with `simulate(circuitFromDocument(document))` from `@spice-ts/core` and read its structured `sensitivity` result, as for DC sensitivity. Generic `simulateProtocolV1` result envelopes still do not support sensitivity. MCP's dedicated `spice_sensitivity` tool consumes the shared request schema and uses its own selectors and result shape.

This is JSON-to-SPICE-text parity within the existing core AC sensitivity slice, not ngspice parity. Nonzero AC excitation with diode/BJT parameter sensitivity remains unsupported; zero-excitation source-magnitude derivatives are supported. Known ngspice losses are tracked in #812.

This subpath has no runtime dependencies and does not import the simulator entry point.
It supersedes the standalone `@spice-ts/protocol@0.3.0` package without changing protocol v1.
Import JSON documents from `@spice-ts/core/protocol/schemas/*` and
`@spice-ts/core/protocol/fixtures/*`.
