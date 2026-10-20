---
"@spice-ts/core": patch
---

Reuse unchanged VDMOS temperature states, channel evaluations, voltage reads and thermal current buffers during self-heating loads, avoiding redundant calculations and allocations without changing simulation results.
