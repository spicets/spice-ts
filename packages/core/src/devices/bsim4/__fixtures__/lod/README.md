# BSIM4 LOD oracles (#1832, #1842)

Original project-authored circuits and generator, MIT (repository licence).
No vendor model cards. ngspice-47 source is pinned at
`a80f6e3e95d51534905b1f23410a951802666656`:
[b4temp.c:1574-1702](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4/b4temp.c#L1574-L1702),
ECL-2.0, with attribution in the parent BSIM4 directory.

The small `lod.ts` helper is called from the generated temperature kernel after
neutral instance assignments and before DELVTO/MULU0 and derived electrostatics.
This preserves native ordering without sharing size-dependent stress state
between instances. `generate-temp.py` reproduces the hook.

Important compatibility detail: native b4temp.c:1763 **overwrites** the previously
stress-adjusted mobility with `size.u0temp * MULU0`. This port deliberately does
the same, not the physically tempting `instance.u0temp *= MULU0`. KU0 still
influences the saturation-velocity correction when KVSAT is nonzero.

Six unchanged `.cir` inputs produce six OP points and 36 VGS sweep points,
including NF=1/2/3, asymmetric spacing, hot size/exponent scaling, DELVTO/MULU0,
and inactive SA/SD controls. All saved node voltages and drain source currents
require relative error <=1e-6; exact native zero voltages allow <=1e-15 absolute.
SHA-256 binds each test-consumed oracle case to the input bytes. The neutral
preprocessing result also has a pre-change SHA-256 regression assertion.

Reproduce from the repository root:

```sh
TMPDIR=<managed-scratch> spice-heavy python3 packages/core/src/devices/bsim4/__fixtures__/lod/generate.py
pnpm -C packages/core exec vitest run src/devices/bsim4/lod.test.ts
```

The generator asserts ngspice-47, then executes
`SPICE_ASCIIRAWFILE=1 ngspice -b -r <temporary.raw> <committed.cir>`.
It does not inject control commands or alter deck bytes between engines.
Before the port six parity tests rejected KU0. After the port, maximum measured
relative error across the six OP and 36 DC points is 3.91e-15. This is correctness
evidence only, not a runtime or full-BSIM4 support claim. WPE remains rejected.

## AC and transient (#1842)

`ac.cir` and `tran.cir` are original MIT common-source stages with NF=2,
SA=SB=0.5u and SD=0.2u. They use the same KU0/KVTH0/KVSAT/STK2/STETA0
model parameters as `nf2.cir`. The existing temperature preprocessing feeds
both dynamic load paths without an additional stress correction.

`dynamic-ngspice-47.json` contains 31 complex AC v(out) samples (1kHz to
1GHz) and 1026 transient v(out) samples (PULSE input, 0 to 10ns). Generated
with **ngspice-47**, macOS arm64, using its default SPARSE solver. Input
SHA-256 hashes are checked by the test. Both engines read identical bytes.

```sh
TMPDIR=<managed-scratch> spice-heavy python3 packages/core/src/devices/bsim4/__fixtures__/lod/generate-dynamic.py
pnpm -C packages/core exec vitest run src/devices/bsim4/lod-dynamic.test.ts src/devices/bsim4/lod.test.ts
```

The generator asserts ngspice-47 and runs
`SPICE_ASCIIRAWFILE=1 ngspice -b -r <temporary.raw> <committed.cir>`.
AC magnitude and wrapped phase retain the existing 1e-6 relative bound.
Transient uses the existing `charge.test.ts` 0.01 (1%) peak-normalized bound
with its 1e-4 peak floor, linearly interpolating spice-ts onto native times.
No comparison tolerances changed. The transient deck uses default simulator
options. An initial overly strict reltol=1e-10 attempt failed in ngspice at
the 4.4ns pulse edge and is not used by either engine.

Before removing the guards, both parity tests failed on main with
`UnsupportedModelParameterError: SA/SB/SD stress`. After removal, measured
maximum AC magnitude relative error is 6.66e-16 and wrapped phase error is
zero. Transient maximum error is 2.9901e-5 of peak (9.9438e-6 V absolute).
All eight SCA/SCB/SCC/SC AC/transient rejection checks still pass. This is
correctness coverage for these fixtures, not a speed or full-model claim.
