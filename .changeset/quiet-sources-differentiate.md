---
"@spice-ts/core": patch
---

Treat absent AC source magnitude as zero in AC sensitivity analysis, retaining its nonzero magnitude derivative. Allow nonlinear devices in the zero-excitation source-transfer calculation without claiming model/instance parameter sensitivity coverage. Retain explicit zero-magnitude source derivatives as well.
