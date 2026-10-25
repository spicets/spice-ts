---
"@spice-ts/mcp": patch
---

Recognize single unstepped JSON distortion requests and return actionable UNSUPPORTED_FEATURE errors naming unavailable DISTOF1/DISTOF2 source fields. Preserve structured errors for unsupported analysis combinations and document the SPICE-text workaround.
