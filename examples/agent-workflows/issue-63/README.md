# Issue #63: executable AI-agent simulation workflows

This directory is the CI entry point for the two agent workflows described in
[`docs/architecture/ai-native-api.md` §10](../../../docs/architecture/ai-native-api.md#10-agent-workflows).
Both run headlessly against public package entry points only (the built
`@spice-ts/mcp` stdio server, and the exported `@spice-ts/circuit-json`,
`@spice-ts/mcp`, and `@spice-ts/core/protocol` APIs, loaded through their
`exports["."].import` dist entry). Nothing imports workspace source files or
private helpers.

    pnpm install --frozen-lockfile
    pnpm build
    pnpm -C examples test:agent-workflows

`pnpm -C examples test` (the CI "Run examples" step) includes this suite.

## Workflow A: floating-node repair

Implemented in [`../../floating-node-repair`](../../floating-node-repair/README.md)
and snapshotted byte-for-byte against its `expected-output.json`:

- `spice_validate` on a floating `sense` node returns topology-preflight
  `INVALID_CIRCUIT` (`phase: "validation"`, `kind: "NO_DC_REFERENCE"`,
  `involvedNodes: ["sense"]`, source JSON pointers) without a numerical solve,
  and the workflow records the DC-path suggestion.
- The agent inserts `Rbleed sense 0 1Meg`, revalidates, and runs OP through
  the streaming tools; the terminal carries `spice-ts-js` backend/build
  metadata, `inputSha256`, and `resultSha256`, re-derived by canonical hashing.
- A separate, topology-valid fixture fails only at solve time with
  `SINGULAR_MATRIX` (`phase: "solve"`).
- A request naming the internal backend `spice-ts` is rejected with
  `BACKEND_UNAVAILABLE`, and `spice-ts` never appears in public output.

## Workflow B: circuit-json transient with threshold cancellation

The full circuit-json contract (ordered `ConversionResultV1` diagnostics,
layout-only diagnostics are nonfatal, an unsupported inductor blocks
conversion before any job starts, cursor replay, completed-run metadata) is
exercised by the packed-consumer example
[`../../circuit-json-threshold-cancellation`](../../circuit-json-threshold-cancellation/README.md).

[`partial-terminal.mjs`](./partial-terminal.mjs) adds the schema evidence the
issue requires, snapshotted in [`expected-output.json`](./expected-output.json):

- The same circuit-json fixture is converted, a transient job is started, and
  one-point chunks are read with consecutive `analysisIndex`/`pointIndex`
  until `V(out) >= 0.2 V` (point 26 at about 0.245 µs), then the job is cancelled.
- The cancelled read data and terminal validate against the published
  `simulation-read-data` and `stream-terminal` JSON Schemas. The terminal's
  `partialEventSha256` equals the canonical hash of the received point events,
  and no `resultSha256` key appears anywhere.
- Positive control: partial metadata with only `inputSha256` is valid.
- Negative fixtures: adding `resultSha256` to partial metadata, or to partial
  data, is rejected (`additionalProperties: resultSha256`), and the packaged
  `@spice-ts/core/protocol/fixtures/negative-v1.json#/partialWithResultHash`
  fixture is rejected too.

Snapshots contain no timing, timestamps, random identifiers, runtime versions,
or host paths. Job IDs are deterministic per executor (`job-1`).

The workflow B snapshot pins the transient point sequence (threshold point
index, emitted point count, `partialEventSha256`). A deliberate change to
transient timestep control will change it; regenerate with
`node examples/agent-workflows/issue-63/partial-terminal.mjs > examples/agent-workflows/issue-63/expected-output.json`
and explain the shift in that PR. The script's own assertions (schema
validity, hash re-derivation, consecutive indexes) do not depend on the
snapshot.

## Timeouts

Following #411, no workflow has a per-request wall-clock deadline. Each test
has only a 120 s hang guard, so a loaded CI runner makes the suite slower,
never wrong. Locally the suite takes about 2 s.

## Limits

The circuits are small authored demonstrations. They are not benchmark or
ngspice-parity evidence, and this example makes no accuracy or performance
claim.
