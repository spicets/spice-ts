---
"@spice-ts/core": minor
---

Support EKV 2.6 intrinsic device temperature scaling of threshold voltage, mobility, critical field, surface potential, impact-ionization coefficient and thermal voltage using the EPFL equations. Preserve nominal current/charges and reject explicit off-nominal junction terms with named UNSUPPORTED_TEMPERATURE errors. Impact-ionization current remains unsupported; default compatibility diffusion leakage remains nominal and is reported in model warnings.
