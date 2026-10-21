# BSIM4 stage-3 static load and integration

## RBODYMOD=1 OP/DC and quasi-static AC extension (#1386)

This section supersedes the historical AC/body-network restrictions below.
The documented transient voltage failures remain unchanged.

The compiler preallocates `M1.dbody`, `M1.body`, `M1.sbody`, after the optional
RGATEMOD=1 gate. RBPD/RBPS connect DB/SB to BP; RBPB connects BP to external B;
RBDB/RBSB connect DB/SB to B. Conductance follows b4temp.c:1870-1890 and the
b4ld/b4acld stamps: G=GBMIN+1/R, or the native 1e3 mho fallback below 1 milliohm.
Model defaults and instance overrides are supported. Nonpositive resistance,
negative GBMIN and selectors outside 0/1 give structured errors.

Intrinsic channel/substrate/gate currents use BP. Physical junction currents
and capacitances use DB-D and SB-S without reverse-mode swapping. AC evaluates
the exact OP bias without Newton limiting and stamps the capMod=2 Jacobian.
Conductance scales with M*MULT_I, charge with M*MULT_Q. RBODYMOD=1 transient
is rejected until independent junction charge states are ported.
RBODYMOD=0 static OP branch currents and transient waveforms remain bit-identical
to main a7b08165. The regression pins all 1014 time samples, external/internal
voltages and source currents of the unchanged RGATEMOD=1 transient deck.

Authored MIT fixtures, generation script and ngspice-47 oracle live in
`__fixtures__/rbodymod1/`. Regenerate with
`python3 packages/core/src/devices/bsim4/__fixtures__/rbodymod1/generate.py`.
Run `pnpm -C packages/core exec vitest run src/devices/bsim4`.
Two identical decks cover NMOS, PMOS, instance overrides and RGATEMOD=1
coexistence. All external/body voltages and four branch currents are checked
at OP and seven AC frequencies from 1 kHz to 1 MHz. Bounds are abs <= 1e-12
or rel <= 1e-6, stricter than the uniform corpus 1% criterion.

AC exposed the missing default CF from b4temp.c:173-175, outside the generated
static extraction. It is applied only to the new AC adapter, unless CF is given,
using separate lazily cached preprocessing (invalidated on temperature changes).
The static/transient preprocessing retains its original CF behavior, including
the known inverter-output (~3.37%) and intrinsic-gate (~1.85%) voltage losses.
Correcting those transient losses is a separate compatibility-changing slice;
this is not full BSIM4/corpus parity.

The original stage-3 static contract below is extended by the #1367
quasi-static transient section. OP/DC restrictions not explicitly extended
there remain in force.

Pinned ngspice-47 `bsim4/` at
`a80f6e3e95d51534905b1f23410a951802666656`, VERSION=4.8/default.
The supervisor retarget supersedes the decomposed cards' bsim4v7/BSD wording.
This is a bounded static OP/DC implementation, not full BSIM4 or corpus parity.

## IGCMOD=1 extension

The generated load kernel additionally ports b4ld.c:2527-2801: oxide voltage,
Igc partition into Igcs/Igcd (automatic or given PIGCD), physical Igs/Igd
overlap currents, exponential limiting, and their analytic derivatives.
Temperature preprocessing adds b4temp.c:1363-1379,1401-1405 (ToxRatio,
ToxRatioEdge, Aechvb/Bechvb and source/drain edge prefactors). Negative
DLCIG/DLCIGD corrections are rejected rather than silently reset.
The 4.8.0 and later prefactor formulas coincide for nonnegative overlaps.
Enabled NIGC/POXEDGE/PIGCD fatal domains follow b4check.c:331-347.

Operating-point fields igcs/igcd are gate-to-oriented-source/drain currents;
igs/igd belong to physical terminals, independent of mode. All include NF,
not M/MULT_I. gigcs*/gigcd* are derivatives with respect to oriented
Vgs/Vds/Vbs; gigsg/gigdg are physical overlap gate conductances.
The device stamps conservative terminal pairs, matching the forward/reverse
gate-current assembly at b4ld.c:4764-4800,4855-4891. Tests check KCL and the
complete four-terminal Jacobian by finite differences, in both polarities and
orientations with NF/M/MULT_I scaling.

Self-authored `benchmarks/bsim4-igc/*.cir` provide 164 native ngspice-47 sweep
points, including negative gate bias, asymmetric overlaps, given PIGCD,
poly depletion and nonnominal temperature. Run:

    spice-heavy python3 benchmarks/bsim4-igc/generate.py
    pnpm -C packages/core exec vitest run src/devices/bsim4

The parity tests read the native oracle and print maximum normalized gate and
drain branch-current errors. Before this extension the same IGCMOD=1 cards
throw UnsupportedModelParameterError. IGCMOD=2, nonbaseline RBODYMOD
and RGATEMOD=3 transient remain unsupported; see below for the gate extensions.

### RGATEMOD=2 extension (#1427)

RGATEMOD=2 (#1427) shares the intrinsic gate topology for OP/DC/AC and adds
the b4ld.c:2191-2225 bias-dependent intrinsic input conductance in series with
the electrode conductance. Its analytic derivatives are stamped in both channel
orientations, including the DC gate-current voltage drop. The authored MIT
common-source fixtures and ngspice-47 generator in `__fixtures__/rgatemod2/`
cover NMOS, PMOS instance override, reverse operation, NF/M and RSHG=0.
`gate-resistance2.test.ts` uses the existing OP/AC component bound (relative
1e-6 or absolute 1e-12), and the five-node tests check KCL/Jacobians.
RGATEMOD=2 transient (#1513) uses the same GP charge topology, including native
default fringe capacitance, as AC. The nonlinear gate resistor remains in the
static Newton stamp; charge companions, accepted currents and LTE use GP.
`generate-transient.py` runs identical `transient.cir` bytes with ngspice-47.
`gate-resistance2-transient.test.ts` checks v(out) and i(vdd) at 201 shared
timepoints with the standard 1%-of-peak bound and no solver/tolerance overrides.
It also checks GP Jacobians and accepted currents for both polarities and channel
orientations. RGATEMOD=0/1 retain their existing transient preprocessing and
known residuals. RGATEMOD=3 transient and RBODYMOD=2 remain structured unsupported errors.

### RGATEMOD=3 static and AC extensions (#1598, #1636)

The compiler allocates GP (`M1.gate`) and GM (`M1.midgate`). The constant
electrode resistor connects GE-GM; native intrinsic `gcrg` connects GM-GP.
Its analytic derivatives use GP bias and reverse channel orientation, as for
mode 2, without mode 2's series-electrode reduction. Tunneling remains at GP.
Model and instance selectors, multiplicity, geometry, zero-RSHG fallback,
reverse operation and the RBODYMOD=1 combination are covered by five identical
authored MIT decks in `__fixtures__/rgatemod3/`. Their ngspice-47 oracle covers
five OP cases, 20 DC sweep points and 95 AC frequency points (1 kHz to 1 GHz),
including both internal gate voltages and all four terminal currents. The NMOS
deck includes nonzero CGBO and nonlinear CGSL/CGDL overlap terms. Regenerate with `spice-heavy python3
packages/core/src/devices/bsim4/__fixtures__/rgatemod3/generate.py`.
AC follows the `b4acld.c` mode-3 topology: intrinsic capacitances and tunneling
remain on GP; overlap capacitances use GM bias and connect GM to physical D/S/BP.
Junction capacitances retain their physical bulk or DB/SB endpoints. The same
OP/AC component bound applies (relative 1e-6 or absolute 1e-12), with no solver
or tolerance tuning. Transient still rejects with `UNSUPPORTED_MODEL_PARAMETER`;
GM charge integration is outside this slice.

### RGATEMOD=1 extension (#1370)

The compiler allocates an observable `M1.gate` intrinsic gate (ngspice's
`m1#gate`); the BSIM4 adapter stamps the constant electrode conductance from
b4temp.c:1926-1938 between that node and the external gate. All intrinsic
terminal currents and derivatives use the internal gate. M and MULT_I scale
the resistor and device together. RSHG=0 retains the node with ngspice's
1e3 mho fallback. Model defaults, instance overrides of RGATEMOD/XGW/NGCON,
and the first all-zero OP/DC junction seed (b4ld.c:304-312) are supported.
RGATEMOD=0 keeps the existing four-terminal path unchanged.

Authored MIT single-device fixtures, regeneration script, and pinned
ngspice-47 OP/DC oracle live in `__fixtures__/rgatemod1/`. Regenerate with
`python3 packages/core/src/devices/bsim4/__fixtures__/rgatemod1/generate.py`.
The same decks feed both engines, with rel <= 1e-6 or abs <= 1e-12 bounds
on external/internal voltages and all four terminal currents. Five-node
stamp tests also check KCL and finite-difference Jacobians in both modes.

## Data and registration

### IGBMOD=1 extension (#1321)

`generate-load.py` also extracts b4ld.c:2803-2921, without changing equation
order. This adds Igbacc/Igbinv, exponential limiting and the native analytic
derivatives. Existing b4temp ToxRatio and L/W/P binning are reused.
`igb` includes NF, not M/MULT_I, and is polarity-normalized. `gigbg/gigbd/gigbb`
refer to oriented Vgs/Vds/Vbs. The MNA pair always connects physical gate
and bulk, with derivatives remapped for reverse Vds (b4ld.c:4801-4811,
4892-4902). IGBMOD=0 does not add a terminal stamp. Nonpositive enabled
NIGBACC/NIGBINV fail per b4check.c:319-330.

Run `spice-heavy python3 benchmarks/bsim4-igb/generate.py` and the BSIM4
tests for the four identical-deck ngspice-47 current sweeps. Run
`python3 packages/core/src/devices/bsim4/verify-load.py SOURCE` to compare
IGB and derivatives directly with unmodified C, including reverse mode,
both polarities, NF, temperature and simultaneous IGCMOD.
The native bulk derivative applies dVbseff/dVb to the raw (Vgs - Vbs)
prefactor as well as the effective-bias terms. We preserve that approximate
Jacobian rather than change ngspice's law. Resistor-loaded gate tests check
Newton convergence; existing IGCMOD finite-difference tests remain strict.

`evaluateBsim4(preprocessed, originalModelGiven, bias, gmin?)` returns an immutable
`Bsim4OperatingPoint`. Input Vgs/Vds/Vbs is polarity-normalized relative to the
physical source. The channel is oriented to nonnegative Vds; `mode` is +1/-1.
Ids/gm/gds/gmbs and substrate current/derivatives include NF, but not M or MULT_I.
The source/drain junction identities do not swap. Cbs/Cbd are normalized
bulk-to-physical-source/drain currents; Gbs/Gbd are their derivatives.

`BSIM4` implements the existing DeviceModel MNA interface. Its wrapper handles
polarity, reverse orientation, channel/substrate/junction KCL, M*MULT_I scaling,
Newton voltage limiting and temperature changes. `Circuit.compile()` selects
this class for LEVEL=14 and LEVEL=54, passes the separate VERSION string and
rejects nonstatic analysis directives. No parser implementation was changed.
Direct dynamic device hooks reject too, including transient drivers created
without a `.tran` directive. Ground numbering is adapted explicitly between
native setup (0) and MNA (-1).

## Full subset across the three stages

1. Setup (`SETUP.md`): all ordered model default statements from
   b4set.c:78-2304, including canonical aliases, original given flags, L/W/P
   coefficient defaults, nominal temperature/doping conversions, polarity,
   instance defaults and baseline aliased-node setup. The schema inventory is
   `model-parameters.json`; raw inactive fields are preserved, not evaluated.
2. Preprocessing (`TEMPERATURE.md`): silicon oxide reconciliation, effective
   dimensions and all ordered L/W/P binning, BINUNIT=1/2, TEMPMOD=0 mobility,
   velocity and internal resistance temperature laws, nominal body/threshold
   terms, DELVTO/MULU0, GEOMOD=0 junction geometry, source/drain junction density
   temperature laws, and DIOMOD=1 saturation currents/forward limiting.
3. Channel (`load-kernel.ts`): ordered b4ld.c:1004-2189 and polynomial gate
   depletion at 5413-5431. Includes source/drain reversal, smooth Vbseff,
   short/narrow-channel threshold, body effect, temperature shift and DIBL,
   pocket-implant DITS threshold shifts, poly depletion, Vgsteff, effective
   width/internal Rds, Abulk, MOBMOD=0 mobility, Vdsat/Vdseff, given-LAMBDA
   overshoot, charge-centroid correction to the DC oxide factor, Idl,
   pocket degradation, CLM, output DIBL, DITS, SCBE, substrate impact-ionization
   current, source-end given-VTL velocity limit and analytic derivatives.
4. Junctions reuse the independently C-verified DIOMOD=1 helper. Includes gmin,
   reverse exponential clamp and linear forward tail, not breakdown DIOMOD=0/2.
5. Relevant DC b4check fatal checks run before load. Unported PARAMCHK correction
   domains explicitly reject rather than applying partial post-temperature
   corrections. Shared DEVfetlim/DEVlimvds/DEVpnjlim ports implement the baseline
   b4ld Newton limiter chain. Roundoff-only reverse reconstruction does not keep
   the device nonconverged.

`generate-load.py SOURCE [--check]` checks exact clean upstream SHA and records
its extracted range. `verify-load.py SOURCE` compiles the original unmodified
C statements with cc -O0. It shares preprocessing inputs, not translated channel
logic, with TS. This isolates channel fidelity; it is not full ngspice execution.

## Explicit unsupported requests

All use existing UnsupportedModelParameterError, alias `UnsupportedModel`,
code `UNSUPPORTED_MODEL_PARAMETER`. Invalid numeric/physical domains instead
use InvalidCircuitError.

- Direct capacitance/charge introspection, AC/small-signal, noise and other non-OP/DC/TRAN
  analyses (including PZ/TF/sensitivity/distortion/SP). No zero dynamic stamps.

## Quasi-static transient extension (#1367)

The device now integrates physical gate, drain and bulk charge using the shared
TransientChargeState (BE, trapezoidal and Gear history, acceptance and truncation).
The generated kernel additionally ports b4ld.c:3339-3913, guarded by a charge-only
flag; the public adapter permits only capMod=2. Both rows and columns reverse
with channel orientation. Charge uses M*MULT_Q; current uses M*MULT_I.
Overlap/fringe follows b4ld.c:4149-4177 including CF, CGSL/CGDL and CKAPPAS/D.
Bulk junction charge follows b4ld.c:3947-4128 with temperature-scaled bottom,
sidewall and gate-sidewall capacitances. This is not AC/NQS/noise support.

charge.test.ts checks finite-difference Jacobians, NF, both orientations,
charge conservation, the unchanged FD corpus deck through 1ns, and inverter
voltages against the committed native ngspice-47 grid. The voltage peak floor
is 100uV and the acceptance criterion is the uniform corpus-f 1%, not a widened
inverter tolerance. The input and supply voltages pass; the output remains a
known 3.372941% peak-normalized mismatch, recorded with `it.fails`. Run with
`ISSUE1367_RED=1` to expose that failure as an ordinary failing test. Simulation
and finite-value checks run outside the expected-failure assertion.
The native reference is generated from the identical inverter string with
`ngspice -b -r inverter.raw inverter.cir`, ASCII raw output. It is not synthetic.
This uses the card's bounded-slice fallback, not full circuit parity: inverter
output voltage and gate/supply currents, and FD input currents, remain above
the shared 1% corpus threshold. See #1367 for every signal and runtime; the
remaining waveform/current parity work is not solved by charge integration alone.

Other unsupported selectors and model paths:

- TRNQSMOD/ACNQSMOD != 0; RDSMOD != 0, RBODYMOD outside 0/1, RGATEMOD=3 transient,
  and positive RSH with given positive NRD/NRS.
- Nonbaseline MOBMOD, CAPMOD, DIOMOD, GEOMOD, PERMOD, TEMPMOD, MTRLMOD,
  MTRLCOMPATMOD, CVCHARGEMOD, GIDLMOD, WPEMOD, FNOIMOD or TNOIMOD selectors.
  Baselines are recorded in SETUP.md; static acceptance is not noise/CV support.
- IGCMOD/IGBMOD outside 0/1. Nonzero effective binned AGIDL/AGISL conservatively reject
  GIDL/GISL currents even when another activation coefficient would disable them.
  Substrate impact ionization is fully ported and stamped, not silently dropped.
- Nondefault stress/WPE model fields and instance SA/SB/SD/SCA/SCB/SCC/SC;
  nonzero instance mode selectors and WNFLAG/RGEOMOD.
- Trap-assisted junction densities JTSS/JTSD/JTSSWS/JTSSWD/JTSSWGS/JTSSWGD,
  nonzero DTEMP, OFF and nonzero ICVGS/ICVDS/ICVBS initialization requests.
- With PARAMCHK=1: A2 outside [0.01,1], negative PRWG/RDSW/RDS0/RDSWMIN,
  and enabled given-VTL with XN<3 or model LC<0. PARAMCHK=0 skips these native
  optional corrections but not fatal checks or finite-result validation.
- Unknown/internal keys, duplicate aliases/case-insensitive keys, unparsed IC
  vectors, unported VERSION families (including 4.3/4.6/4.7), invalid LEVEL,
  BINUNIT outside 1/2 and PARAMCHK outside 0/1.

Individual IC values are retained by standalone setup; accepting them there
is not a claim of initialization support in the integrated device.

## Executed verification

- RED load and device test imports failed on absent modules before implementation.
- Five targeted BSIM4 files pass 247 tests, including NMOS/PMOS OP, unknown
  resistor-loaded drains, signed current checks, reverse-mode KCL/Jacobian,
  NF/M/MULT_I, nonnominal temperature, guards and analytic finite differences.
- Two unchanged minimal default model oracles cover 216 ngspice-47 points;
  Ids/gm/gds/gmbs meet a shared 1e-8 relative limit (1e-18 floor).
- Original-C channel comparison passes 120 cases / 960 numeric comparisons,
  maximum relative error 8.4696079344519274e-14, fixed shared limit 2e-12.
  Covers two polarities, two temperatures, NF=1/3, five bias points, baseline,
  given-LAMBDA/VTL, and enabled substrate/pocket/DITS terms.
- Workspace build and lint pass; existing import.meta/browser externalization/
  chunk-size warnings remain. Full monorepo tests and CI were not run.
- Built ESM core chunk and all three core CJS bundles retain the exact complete
  ECL licence text and University of California copyright in a legal comment.
  No build config, package metadata, npm publication, tag, release or PR change.

## Losses and unresolved integration work

The following stage-3 status receipt is historical and superseded by
`benchmarks/bsim4-validation-3/after.json` and `TABLES.md`. Current-main DC TEMP
support plus the static port run all six unchanged BSIM482 DC commands, including
both temperature sweeps. The validation publishes every native solution signal
at all 1236 matched points. Binning remains unsupported (now a typed
UnsupportedModelParameterError), as do the 4.3-family AC and G transient decks.
Do not use the old four-loss statement below as the current result.
Historical raw-log references in this document are superseded by scalar
README/JSON receipts under the owner’s later agent-artifact policy.

The existing `baseline.ts` status probe was run unchanged with `spice-heavy`
against the four unchanged original corpus-F/G inputs; its new output is
`integration-after.json`. Historical `__fixtures__/bsim4/baseline.json` records
four unsupported-level failures. After registration all four original decks
still fail: the 4.8.2 example reaches an unsupported `dc temp` sweep, the binning
regression reaches missing `nmos_tst` bin selection, the 4.3 gain-stage model
rejects its unported version, and the G transient example rejects TRAN.
Recorded ngspice success statuses are historical, not newly executed ngspice.
There are no matched waveforms, numeric errors or speed wins for these decks.
The generic status probe labels non-LEVEL errors `failed`, including typed
unsupported-parameter errors; keep that raw evidence rather than relabel it.
The receipt's sourceHead is the upstream HEAD on which this uncommitted stage-3
working tree ran, not a claim of clean-commit execution.

A separate RED run of the two legacy regression files passed 20 tests and
failed four stale assertions. The supervisor subsequently authorized narrow
expectation-only migration in `parser/bsim-model-version.test.ts` and
`devices/mosfet-body-effect.test.ts`. These now assert registered static
LEVEL=14/54, dotted VERSION=4.8.2 operating points, typed rejection of unported
4.5.0 revisions and the updated supported-level list. All other assertions
remain intact. No parser implementation changed. Main was merged before this
migration, retaining both sides of the additive SOURCES.md conflict. This is
not a claim of full-suite-green or release readiness; exact-head CI and the
precreated independent review remain the full gate.

## Provenance

All copied/ported implementation files retain original University of California
ECL-2.0 notices and modification notes. `NOTICE-BSIM4.txt` inventories the five
upstream implementation files. The existing single SOURCES.md row is extended
with b4geo/b4check and all three stages; no duplicate or false BSD row is added.
`load-kernel.ts` includes the full ECL text in a bundler-preserved legal comment
so integration does not discard notices. Publication remains owner-gated.
