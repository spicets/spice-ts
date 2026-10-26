# BSIM4 static LOD oracle (#1832)

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
evidence only, not a runtime or full-BSIM4 support claim. WPE remains rejected;
nondefault SA/SB/SD remain rejected for AC and transient analyses.
