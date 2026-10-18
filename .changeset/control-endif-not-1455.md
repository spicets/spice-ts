---
"@spice-ts/core": patch
---

Accept ngspice's built-in `endif` alias in control blocks, including nested `if not` conditions. Support `!` as a condition-only convenience alias for `not`/`~` (an extension to ngspice-47, which rejects this spelling in vector expressions).
