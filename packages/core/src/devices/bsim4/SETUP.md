# BSIM4 stage-1 setup contract

This is setup/defaulting only, not a registered transistor or a simulator accuracy
claim. LEVEL=14/54 still need the downstream temperature, channel and MNA ports.
Use the pinned ngspice-47 `bsim4/` family, SHA
`a80f6e3e95d51534905b1f23410a951802666656`. Its default is VERSION=4.8.3.
The supervisor's 4.8/default retarget supersedes the card's bsim4v7 wording.

## API and data shape

- `setupBsim4Model(card, options?)` resolves lowercase model-card keys. `level`
  accepts 14 or 54; polarity is `type: 1` for NMOS or `type: -1` for PMOS. The
  parser/model wrapper owns conversion from the NMOS/PMOS model type.
- `values` contains every field enumerated in `model-parameters.json` and
  `MODEL_PARAMETER_NAMES` in `params.ts`. The ordered translation covers the
  entire model-default block `b4set.c:78-2304`, including L/W/P fields, diode
  defaults, asymmetric gate-current inheritance, geometry constants and
  original given-flag decisions. `type` and `v48intversion` are internal fields;
  the latter is output-only. The former is the explicit polarity seam.
- TNOM on input is Celsius, output Kelvin. Absent TNOM inherits
  `options.nominalTemperatureK` (default 300.15 K). Doping threshold conversions
  follow `b4mpar.c` for NDEP/NSD/NGATE and their L/W/P forms.
- `given` is an immutable read-only facade over original canonical card keys.
  Explicit zero remains given; inherited/defaulted fields do not become given.
  Alias collisions reject. Values and returned records are frozen too.
- K1/K2 and the overlap-capacitance fields remain zero-initialized when not
  given, as at this point in C setup. They are NOT claimed as fully resolved
  physical defaults. Downstream b4temp must honor their given flags.
- Known 4.8 version spellings retain `b4set.c:207`'s broad-prefix behavior,
  including resolving 4.8.2 to integer version 483. Do not silently "fix" this
  source behavior independently of the native reference.
- `setupBsim4Instance(model, card, externalNodes)` ports `b4set.c:2321-2432`.
  Individual IC values are supported; a raw IC vector rejects until the parser
  wrapper has unpacked it. Instance geometry is SI, already scaled by the caller.
  SD inherits `2*dmcg`; `mult_fn` inherits `mult_i`; original given flags survive.
- `geometry` contains DMCGeff/DMCIeff/DMDGeff (`b4set.c:2306-2308`), not effective
  channel dimensions or junction area/perimeter. Downstream b4temp/b4geo own
  those computations. Supported nodes alias external terminals and Q is absent.

## Guard inventory

All guards reuse `UnsupportedModelParameterError`, exported here as
`UnsupportedModel`; code `UNSUPPORTED_MODEL_PARAMETER`. No new error class.

- Static OP/DC only. TRAN, AC, noise and unknown analysis requests reject.
- Nonbaseline selectors reject before upstream warning/reset branches.
  Baselines are MOBMOD=0, CAPMOD=2, DIOMOD=1, RDSMOD=0, RBODYMOD=0,
  RGATEMOD=0, GEOMOD=0, PERMOD=1, TEMPMOD=0, IGCMOD=0, IGBMOD=0,
  TRNQSMOD=0, ACNQSMOD=0, MTRLMOD=0, MTRLCOMPATMOD=0,
  CVCHARGEMOD=0, GIDLMOD=0, WPEMOD=0, FNOIMOD=1, TNOIMOD=0.
  BINUNIT accepts 1/2; PARAMCHK accepts 0/1. Baselines do not imply noise or
  capacitive support. IGCMOD=1 and IGBMOD=1 additionally support static tunneling.
  Alternate CAPMOD/PERMOD values conservatively reject.
- Every explicitly nondefault model stress/WPE parameter in `LAYOUT_DEFAULTS`
  rejects, including L/W/P coefficients. This is conservative even where another
  activation input is absent. Defaults such as SAREF=1e-6 and LODK2=1 are neutral.
- Instance TRNQSMOD/ACNQSMOD/RBODYMOD/RGATEMOD/GEOMOD/RGEOMOD/WNFLAG
  must be zero. SA/SB/SD/SCA/SCB/SCC/SC must match their resolved defaults.
- Positive RSH plus explicitly given positive NRD or NRS rejects, because
  `b4set.c:2434-2515` then needs an unported source/drain node. Positive RSH alone
  does not create those nodes with baseline RGEOMOD and absent squares.
- Unsupported version families, LEVEL values, unknown/internal keys, duplicate
  canonical aliases and unparsed instance IC vectors reject. Invalid finite,
  integer, polarity, temperature, dimension or node inputs use InvalidCircuitError.

Setup acceptance means a parameter has been preserved/defaulted for later
preprocessing. It does NOT mean its current term is implemented. The channel
stage must port or reject every enabled contribution (GIDL/GISL, trap leakage,
velocity effects etc.) before registration. No fallback MOS1/BSIM3 model exists.

## Verification

Executed in this stage:

- RED targeted test import failed because setup.ts did not exist.
- GREEN targeted setup suite: 124 tests. Existing junction suite: 43 tests.
- `pnpm build` and `pnpm lint` passed workspace-wide. Existing CJS import.meta,
  browser-node externalization and chunk-size warnings remain.
- `PYTHONDONTWRITEBYTECODE=1 python3 verify-setup.py PINNED_SOURCE_CHECKOUT`:
  65 cases, 57,655 exact numerical/string comparisons against actual compiled
  original C default statements. Includes polarity, original given dependencies,
  selector fallback branches at the low-level translation seam, and version
  handling. Wrapper tests separately prove those fallback inputs fail closed.
- `generate-setup.py PINNED_SOURCE_CHECKOUT --check` verifies the full generated
  schema/default/manifest artifacts against a clean exact-SHA source checkout.

No full-suite run or CI claim. No changes to simulator registration, parser,
benchmark references, aggregate metrics or public bundle. Therefore no circuit
before/after accuracy or speed claim. This stage is a verified foundation for the
already-created stage-2 temperature/size card, not completion of issue #3.

## Provenance

Original University of California ECL-2.0 notices are retained verbatim in the
ported TypeScript files with modification notices. Full licence already lives
at `LICENSE-ECL-2.0`; the prior junction commit recorded the exact three source
files in `benchmarks/SOURCES.md`. This stage adds no provenance collision edits.
Distribution/licence metadata and npm publication remain owner-gated.
