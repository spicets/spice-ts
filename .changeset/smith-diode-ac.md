---
"@spice-ts/core": patch
---

Use ratio-based complex division in sparse AC factorization, pivot reuse and substitution to avoid squaring finite pivots. This fixes reverse-biased diode JS/WASM phase disagreement on the bounded diode RC regression and handles large finite pivots without modulus-squared overflow. This does not establish universal ngspice parity.
