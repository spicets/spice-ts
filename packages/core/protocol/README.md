# @spice-ts/core/protocol

Environment-neutral protocol v1 types, JSON Schema 2020-12 documents, conformance fixtures, and dependency-free canonical JSON/SHA-256 utilities.

## Canonical JSON

`canonicalJson` accepts only JSON values. It sorts object keys lexicographically by Unicode code point, emits no insignificant whitespace, uses UTF-8 bytes, normalizes `-0` to `0`, and rejects non-finite numbers, unsupported values, sparse arrays, and cycles. `sha256CanonicalJson` returns the lowercase SHA-256 hex digest of those bytes. Consumers must run schema validation and `checkConformanceV1` before canonicalization when non-canonical input such as `-0` must be rejected rather than normalized.

Result hashes cover only canonical `SimulationResultV1`. Partial hashes cover canonical point events in event order. Envelope metadata, timing, request IDs, and job IDs are outside these hash boundaries.

## Schemas and fixtures

Committed schemas are in `schemas/`; the exported `protocolSchemasV1` registry contains the same documents. Shared positive and negative conformance fixtures are in `fixtures/`. Structural constraints live in JSON Schema; cross-field rules (case-insensitive uniqueness, sorted record keys, series lengths, stream point ordering/discriminators, and canonical number diagnostics) are checked by `checkConformanceV1`.

This subpath has no runtime dependencies and does not import the simulator entry point.
It supersedes the standalone `@spice-ts/protocol@0.3.0` package without changing protocol v1.
Import JSON documents from `@spice-ts/core/protocol/schemas/*` and
`@spice-ts/core/protocol/fixtures/*`.
