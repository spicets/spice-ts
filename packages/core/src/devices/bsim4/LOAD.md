# BSIM4 stage-3 static load and integration

The original stage-3 static contract below is extended by the #1367
quasi-static transient section. OP/DC restrictions not explicitly extended
there remain in force.

Pinned ngspice-47 `bsim4/` at
`a80f6e3e95d51534905b1f23410a951802666656`, VERSION=4.8/default.
The supervisor retarget supersedes the decomposed cards' bsim4v7/BSD wording.
This is a bounded static OP/DC implementation, not full BSIM4 or corpus parity.

## Data and registration

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

- TRNQSMOD/ACNQSMOD != 0; body/gate/external resistance network modes,
  RDSMOD/RBODYMOD/RGATEMOD != 0, and positive RSH with given positive NRD/NRS.
- Nonbaseline MOBMOD, CAPMOD, DIOMOD, GEOMOD, PERMOD, TEMPMOD, MTRLMOD,
  MTRLCOMPATMOD, CVCHARGEMOD, GIDLMOD, WPEMOD, FNOIMOD or TNOIMOD selectors.
  Baselines are recorded in SETUP.md; static acceptance is not noise/CV support.
- IGCMOD/IGBMOD != 0. Nonzero effective binned AGIDL/AGISL conservatively reject
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
