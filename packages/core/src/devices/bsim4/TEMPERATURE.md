# BSIM4 static size/temperature preprocessing

Stage 2 for issue #3. This module is not registered as a simulator device and
makes no full-transistor parity or speed claim. Use the pinned ngspice-47
`bsim4/` source family at `a80f6e3e95d51534905b1f23410a951802666656`, VERSION=4.8/default,
not the superseded bsim4v7 wording on the decomposed cards.

## API

`preprocessBsim4(modelSetup, instanceSetup, temperatureK = 300.15)` accepts
outputs of `setupBsim4Model` and `setupBsim4Instance`. Operating temperature and
resolved model TNOM are Kelvin. Raw model TNOM is Celsius only at the setup
boundary. Returned `model`, `size`, `instance`, `sourceJunction` and
`drainJunction` records are immutable. No shared size/temperature cache exists.
Keep the original setup alongside this result when b4ld needs given flags.

Model-card fields retain setup's lowercase canonical keys. Computed model,
size and instance fields retain C member spelling without the `BSIM4` prefix.
For example `size.sqrtPhi`, `size.Xdep0`, `size.theta0vb0`, `instance.Pseff`,
`instance.SourceSatCurrent` and `instance.IVjsmFwd`.
`sourceJunction`/`drainJunction` can be passed directly to the existing
`evaluateBsim4Junction` helper. The wrapper does not scale already-adjusted
junction densities a second time.

## Ported

`temperature-kernel.ts` is generated from the original ordered C statements.
`generate-temp.py` pins the clean source SHA and lists every extracted range.
Warnings are omitted, but their numerical clamps/defaults are retained.

- Silicon oxide reconciliation using original TOXE/TOXP/DTOX/TOXM given flags,
  COXE/COXP, nominal silicon bandgap/intrinsic concentration, thermal voltages,
  FACTOR1 and native VCRIT limiting constant.
- Drawn XL/XW offsets, per-finger width, LL/LW/LWL and WL/WW/WWL power-law
  corrections, effective L/W and junction width, including CV effective
  dimensions needed to preserve upstream geometry validation.
- Full ordered L/W/P binning block, with BINUNIT=1 (microns) and 2 (SI).
  Charge-only and inactive-mode card fields are preserved as binned values,
  not advertised as a charge/current implementation.
- TEMPMOD=0 UA/UB/UC/UD temperature laws, U0 conversion and length/UTE scaling,
  UCS/UCSTE, VSAT/AT, internal RDSW/PRT width scaling, VOFF/VFBSDOFF,
  NFACTOR/TNFACTOR, ETA0/TETA0 and given-VTL source-end velocity factor.
- Nominal PHI/sqrtPhi/phis3, Xdep0/sqrtXdep0, LITL, VBI/VFBSD, CDEP0,
  GAMMA1-derived NDEP, K1/K2 calculation and individual-given fallback defaults,
  VFB/VTH0 resolution, K1OX, theta0vb0/thetaRout, DVT terms, vfbzbfactor,
  MSTAR/VOFFCBN/LDEB and limited DITS dvtp2factor.
- DELVTO/MULU0, instance VTFBPHI1/2, VBSC/K2OX/VFBZB, TOXP/COXP.
- Source/drain junction densities with separate XTIS/XTID and NJS/NJD,
  negative-density clamp and all six built-in-potential temperature/clamp laws.
- GEOMOD=0 `b4geo.c:28-88` diffusion counts and area/perimeter formulas,
  original integer-cast parity semantics for fractional NF, MIN selection,
  given-zero vs absent geometry, PERMOD=1 gate-edge subtraction and final clamps.
- DIOMOD=1 area/perimeter/gate-edge saturation currents, Nvtms/Nvtmd,
  forward limiting voltages and exponential currents via the existing
  independently C-verified junction helper. Baseline terminal prime nodes alias
  external nodes, so source/drain network conductances are zero as in C.

VTH0 and PHI remain nominal values in this stage. The temperature shift is
precomputed in vfbzbfactor and KT1/KT1L/KT2 are retained for b4ld's bias-dependent
threshold law. Do not add the temperature shift to VTH0 a second time.

## Skipped and fail-closed

Static LOD stress now runs through `lod.ts` before DELVTO/MULU0 and derived
electrostatics. See `__fixtures__/lod/README.md` for native ordering, scope and
identical-deck OP/DC evidence. WPE remains rejected. The original stage-only
limitations below describe the baseline extraction, not later adapter extensions.

The existing setup guards remain authoritative. In particular TEMPMOD=1/2/3,
nonbaseline MOBMOD/DIOMOD/RDSMOD, material modes, alternate geometry/perimeter,
stress/WPE/NQS/body/gate networks and dynamic analyses remain unsupported.
This stage additionally rejects nonzero JTSS/JTSD/JTSSWS/JTSSWD/JTSSWGS/JTSSWGD
(enable unported trap-assisted junction current) and nonzero instance DTEMP.
Errors use the existing `UnsupportedModelParameterError`, alias `UnsupportedModel`.
Nonpositive effective dimensions, invalid physical domains or nonfinite results
use `InvalidCircuitError`. No selector is silently reset to a supported model.

Charge, capacitance, overlap/fringing capacitance, gate-tunnelling prefactors,
noise, inactive material/stress/MOBMOD=3/network blocks and TAT scaling are not
implemented. Retaining raw binned charge fields does not provide dynamic support.

`b4check.c` is NOT part of this b4temp port. The channel/integration stage must
apply its relevant fatal checks and PARAMCHK-dependent DC numerical corrections
(for example A2/PRWG/RDSW/RDS0/RDSWMIN and VTL/XN/LC) before simulator registration,
or reject those domains explicitly. This module returns pre-check b4temp values.
Channel currents, derivatives, terminal-current completeness, Newton limiting,
MNA, polarity/orientation and registration remain stage 3 work.

## Verification

- RED targeted test failed on missing `temp.ts` before implementation.
- 28 hand-formula/guard tests cover TNOM/non-nominal temperature, dimension
  corrections, both bin units, K1/K2/NDEP given flags, polarity, geometry/NF/MIN,
  explicit zero, diode temperature laws, oxide reconciliation and immutability.
  Fixed relative tolerance is 2e-12 with a 1e-30 denominator floor.
- `verify-temp.py SOURCE` compiles unmodified original pinned C statement slices,
  original GEOMOD=0 helper and diode limiting code with `cc -O0`. Runs 320 cases
  across NMOS/PMOS, four operating temperatures, five NF values, both MIN values,
  given/absent threshold/geometry and populated L/W/P coefficients. Compared
  311,360 numerical fields, including preserved inputs and computed outputs.
  Maximum relative error was 3.3306690738753765e-15 against a shared 2e-12 limit.
  This is isolated C preprocessing verification, not full ngspice execution.
- Targeted setup/junction/temp suite, workspace build and lint pass. No full
  monorepo test suite, benchmark corpora, aggregate report or CI run in this stage.

Reproduce:

    pnpm -C packages/core exec vitest run src/devices/bsim4/temp.test.ts src/devices/bsim4/setup.test.ts src/devices/bsim4-junction.test.ts
    pnpm build && pnpm lint
    PYTHONDONTWRITEBYTECODE=1 python3 packages/core/src/devices/bsim4/generate-temp.py SOURCE --check
    PYTHONDONTWRITEBYTECODE=1 python3 packages/core/src/devices/bsim4/verify-temp.py SOURCE

Original University of California ECL-2.0 headers are retained in ported TS files.
Full licence is `LICENSE-ECL-2.0`. Stage 3 should include `b4geo.c` in the existing
additive ECL-2.0 provenance inventory. This stage changes only new bsim4 files,
not SOURCES.md, parser, benchmark references, package metadata or public exports.
No PR, npm publication, tags, releases or version changes.
