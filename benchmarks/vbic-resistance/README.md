# VBIC explicit resistance preprocessing (#1309)

`reference.ts` generates an original project-authored MIT single-transistor
probe. It copies the model card unchanged from the already sourced corpus-f
`examples/vbic/DFF_Y_ECL.sp` fixture (provenance/licence: `benchmarks/SOURCES.md`,
corpus-f). No new third-party circuit is imported. The JSON is read by
`packages/core/src/devices/vbic-resistance.test.ts`; its embedded deck and hash
ensure both engines use identical bytes.

Regenerate from the repository root:

    spice-heavy pnpm exec tsx benchmarks/vbic-resistance/reference.ts

Reference: ngspice-47. Source pinned to
[a80f6e3e95d51534905b1f23410a951802666656](https://github.com/ngspice/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656).
The relevant preprocessing is
[vbicmpar.c:20,42-120](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vbic/vbicmpar.c#L20):
all seven explicitly supplied resistances below 0.01 ohm are clamped.
[vbicsetup.c:44-73](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vbic/vbicsetup.c#L44)
sets omitted RCX/RBX/RE/RS to zero and RCI/RBI/RBP to 0.1 ohm instead.
`vbictemp.c:57` propagates the processed RBP; the `vbicload.c:3787-3805`
zero-resistance branch is therefore unreachable from an explicit RBP=0 card.

This corrects the open-RBP interpretation in #1302 and the historical
`benchmarks/SOURCES.md` discussion: inspecting `vbicload.c` alone missed the
model setter. The bounded implementation still rejects negative/nonfinite
resistances rather than expanding its accepted input domain.

The DC localization probe clamps Q3's external terminals to the reference DFF
operating point. Before the fix its base current is 28.77759 microamperes,
versus 0.68669 picoamperes in ngspice. This is not a transient integration error.
The regression checks all four terminal source currents with 10 pA absolute
accuracy. Separate tests cover all seven resistances at zero, sub-minimum,
minimum and ordinary positive values, and unchanged omitted defaults.

Full unchanged DFF measurements (including losses):

    spice-heavy pnpm exec tsx benchmarks/vbic-rbp/dff.ts

No fixture, solver tolerance or per-circuit simulator branch is changed.
