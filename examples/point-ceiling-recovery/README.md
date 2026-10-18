# Point-ceiling recovery

This packed-consumer example demonstrates deterministic recovery from a protocol-v1 `maxResultPoints` rejection.

The external workflow calls `spice_capabilities` first, submits a valid request whose four estimated result points exceed a ceiling of three, clones the request, changes only `options.limits.maxResultPoints` to the reported `actual` value, and completes the corrected request through `spice_simulation_start` / `spice_simulation_read`. It verifies exact error shape and ordering, replay, diagnostics, public metadata, canonical hashes, and a second-run stable terminal snapshot.

Run from the repository root after building the packages:

```sh
pnpm -C packages/mcp build
pnpm -C examples test:point-ceiling-recovery
```

`packed-consumer.mjs` packs and installs `@spice-ts/core`, `@spice-ts/circuit-json`, and `@spice-ts/mcp` into a temporary external project. Only `workflow.mjs` is copied into that project; its imports use the packed public `@spice-ts/mcp` and `@spice-ts/core/protocol` entrypoints.
