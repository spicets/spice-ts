---
"@spice-ts/core": minor
"@spice-ts/mcp": minor
---

Expose documented readonly machine-readable codes on every SpiceError, preserving existing subclass codes, messages and inheritance. MCP errors now retain the thrown core code across worker and in-process execution instead of replacing specific codes with broad protocol categories. The protocol-v1 schema and its error mapping are unchanged.
