---
"@spice-ts/core": patch
---

Accept ngspice let vector names containing punctuation, including v(/22) and v(+22), and resolve their voltage-probe lookups across control plots. Reject reserved all, device-parameter names, and numeric-prefixed let targets with structured errors.
