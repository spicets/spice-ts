---
"@spice-ts/wasm": minor
"@spice-ts/core": patch
---

Support circuit TEMP/TNOM for bounded BJT WASM operating points and DC sweeps using core's temperature law. Accept XTI, EG and XTB with OP/DC circuit temperature cards while preserving AC/TRAN rejection. Pass circuit TNOM into core BJT models as a default, preserving model-level overrides.
