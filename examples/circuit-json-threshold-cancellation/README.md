# Circuit-json transient threshold cancellation

This executable example converts a circuit-json RC network with the public `@spice-ts/circuit-json` API, adds a protocol-v1 pulse source and transient analysis, then uses the public `@spice-ts/mcp` tool executor to read deterministic one-point chunks. It cancels at the declared `0.2 V` output threshold and verifies the exact partial terminal and canonical event hash. A second control job is allowed to finish so backend, build, runtime, input-hash, and result-hash boundaries can be checked without inventing metadata for a cancelled job.

## `/poteto-mode` receipt

The feature and architecture playbooks were loaded before implementation. Existing circuit-json conversion, protocol-v1 types and canonical hashing, MCP stream cursor replay, cancellation, and packed-consumer patterns were traced end to end.

Two seams were considered. The rejected design sent circuit-json directly to MCP stdio, but MCP intentionally accepts only public `spice` and `spice-ts` inputs, while conversion belongs to `@spice-ts/circuit-json`. The chosen design keeps conversion in an external consumer, constructs the public native document from `ConversionResultV1.value`, and calls the exported MCP tool executor. This uses fewer transport concepts and preserves package ownership.

The blocking work was the external-consumer contract and deterministic fixture. There were no independent implementation workstreams because the fixture, threshold loop, and packed assertion form one small acceptance slice and own the same new directory. No existing parser, simulator, backend, benchmark, model, roadmap, release, or deployment file is changed.

RED commit `a149b47add809cc436b43f83aa6559eac59d181f` added the executable test before the consumer existed. `node --test examples/circuit-json-threshold-cancellation/workflow.test.mjs` failed with `MODULE_NOT_FOUND` for `packed-consumer.mjs`. GREEN runs the same test against packages built and packed from this worktree.

## Reproduce

From the repository root, with Node.js 20 or newer and pnpm installed:

    pnpm install --frozen-lockfile
    pnpm build
    node examples/circuit-json-threshold-cancellation/packed-consumer.mjs
    node --test examples/circuit-json-threshold-cancellation/workflow.test.mjs

The packed command creates a temporary project, packs and installs `@spice-ts/core`, `@spice-ts/circuit-json`, and `@spice-ts/mcp`, copies only the standalone fixture and workflow into that project, and executes from the external project. It does not import workspace source files or private helpers.

## Verified contract

The workflow asserts:

- ordered `/0` and `/13` layout diagnostics are informational and nonfatal;
- the ordered `/0` layout and `/1` unsupported-inductor diagnostics block conversion before any job starts;
- internal backend name `spice-ts` is rejected, while requests and metadata use `spice-ts-js`;
- transient points expose `timeS`, `voltagesV`, and `currentsA` units, exact node and branch paths, and consecutive analysis and point indexes;
- a repeated opaque cursor returns an identical chunk;
- threshold cancellation returns an exact partial terminal with `partialEventSha256`, and contains no `resultSha256` anywhere;
- a completed control job reports protocol/native schema versions, package/build/backend metadata, runtime family, architecture, determinism, canonical input hash, and canonical result hash.

## Known limits

This example covers one small linear RC transient on the JavaScript backend. It does not establish circuit-json support for voltage sources, inductors, every layout element, every analysis, WASM, ngspice correctness parity, accuracy, performance, security isolation, network transport, package publication, or deployment. The pulse source and transient analysis are added through the public `spice-ts` protocol document because the current circuit-json adapter supports only the documented passive/transistor subset. Runtime version and architecture are asserted by shape but excluded from snapshots so the workflow remains portable. Cancellation is cooperative and occurs only after already emitted points; it does not retract buffered or computed points.
