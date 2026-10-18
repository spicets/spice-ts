---
"@spice-ts/core": minor
"@spice-ts/mcp": patch
---

Move the standalone protocol package into `@spice-ts/core/protocol`, preserving protocol v1 types, schemas, conformance checks and canonical JSON utilities. JSON documents are available at `@spice-ts/core/protocol/schemas/*` and `@spice-ts/core/protocol/fixtures/*`. MCP now consumes this subpath instead of `@spice-ts/protocol`. The existing npm protocol package remains available and will be deprecated by the owner after release.
