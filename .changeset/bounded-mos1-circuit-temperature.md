---
"@spice-ts/wasm": minor
"@spice-ts/core": patch
---

Support circuit TEMP/TNOM for bounded MOS1 WASM operating points and DC sweeps using core's existing temperature law, including RD/RS/RSH. Inherit circuit TNOM in core MOS1 models while preserving explicit model overrides. Keep circuit temperature cards unsupported for WASM AC/TRAN.
