# BSIM4 constant sheet-resistance OP/DC oracle (#1792)

These single-device fixtures and their generator are authored under the repository's
MIT license. Both engines consume the checked-in `.cir` deck unchanged; native
control commands only select analysis/output vectors. SHA-256 binds every oracle
case to its deck. No third-party model card is included.

Pinned source: ngspice-47, commit `a80f6e3e95d51534905b1f23410a951802666656`:

- [b4set.c:2434–2515](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4/b4set.c#L2434-L2515):
  with RDSMOD/RGEOMOD disabled, allocate each prime node only for positive RSH
  and explicitly given positive squares. Omitted NRD/NRS do not allocate, even
  though setup defaults their values to 1.
- [b4temp.c:2041–2101](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4/b4temp.c#L2041-L2101):
  conductance is `1/(RSH * NRD)` or `1/(RSH * NRS)` for distinct prime nodes.
- [b4ld.c](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4/b4ld.c):
  parallel multiplicity `M * MULT_I` scales static series and intrinsic stamps.

The MNA adapter preserves external D/G/S/B and existing gate/body offsets,
appending enabled DP then SP. All intrinsic currents and physical junctions use
prime D/S. Body-node slicing excludes appended series nodes. RDSMOD and RGEOMOD
remain unsupported. Enabled series nodes explicitly reject AC and transient;
this fixture claims only OP/DC support.

Regenerate from the repository root (ngspice-47 required):

```sh
NGSPICE=/opt/homebrew/bin/ngspice spice-heavy python3 packages/core/src/devices/bsim4/__fixtures__/series-resistance/generate.py
pnpm -C packages/core exec vitest run src/devices/bsim4/series-resistance.test.ts
```

Set `TMPDIR` to the session-managed scratch directory when required by the host.
The generator uses `tempfile` and leaves no native logs/raw files in the repository.
It explicitly saves requested vectors **without `all`**: native `outitf.c` filters
`#drain`/`#source` from save-all output. Internal voltages are actual saved solver
nodes, not reconstructed values.

Coverage: nine OP cases and 45 DC points: RSH=10/NRD=NRS=2, PMOS/asymmetry,
reverse operation, each single-side network, omitted squares, zero RSH,
M/MULT_I/NF, and RGATEMOD=3 plus RBODYMOD=1. Tests require drain-current relative
error <=1e-6 and internal-voltage relative error <=1e-6 away from zero, with a
1e-12 absolute floor for numerical-zero terminal currents/voltages.
