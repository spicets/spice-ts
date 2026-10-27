# Benchmark sources

## MOS9 instance temperature (#1846)

`fixtures/issue-1846/*.cir` are original project-authored MIT bias decks for
https://github.com/spicets/spice-ts/issues/1846. No third-party netlists copied.
The tests consume the identical decks used by ngspice-47 to generate
`reference.json`: NMOS and PMOS, instance TEMP=75, DTEMP=30 at circuit TEMP=40,
and both (TEMP wins). Each includes OP and 61 gate-bias DC points, including
cutoff, with loaded drain/source nodes and body bias. All saved node voltages
and source currents are checked at every point with a strict 1e-6 relative
bound (zero references must match exactly).

Regenerate with `spice-heavy python3 benchmarks/fixtures/issue-1846/generate.py`.
It checks ngspice-47 and runs `ngspice -b -r <temporary-reference.raw> <deck.cir>`
in ASCII mode. The shared temperature law is unchanged; only the LEVEL=9
instance override guard is removed. The precedence rule is ngspice-47
[`mos9temp.c:135-140`](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/mos9/mos9temp.c#L135-L140).
Unported model temperature parameters remain rejected.

## MOS9 circuit temperature (#1812)

`fixtures/issue-1812/*.cir` are original project-authored MIT bias decks for
https://github.com/spicets/spice-ts/issues/1812. No third-party netlists copied.
`reference.json` contains ngspice-47 OP and DC vectors for NMOS/PMOS at circuit
TEMP=27/50/100 C and model TNOM=27/50 C. Every deck is consumed unchanged by
both simulators. Regenerate with
`spice-heavy python3 benchmarks/fixtures/issue-1812/generate.py`, which runs
`ngspice -b -r <temporary-reference.raw> <deck.cir>` in ASCII mode.

Source audit against the ngspice-47 tag in https://github.com/imr/ngspice
(BSD-3-Clause, not copied here): `src/spicelib/devices/mos9/mos9temp.c:44-50,
135-149,220-345` has the same temperature equations as
`src/spicelib/devices/mos3/mos3temp.c:44-50,131-145,214-339`.
After normalizing MOS3/MOS9 names, whitespace and comments, the only semantic
difference is MOS9's effective length/width rejection below 1 um
(`mos9temp.c:203-215`), versus MOS3's rejection at or below zero
(`mos3temp.c:198-210`). The existing MOS3 constructor already applies this
LEVEL=9 geometry floor. No separate temperature law is necessary.

Before: 11 of 16 new tests fail with `UnsupportedTemperatureError` (including
direct DC TEMP hooks); 5 pass. After: all 16 pass. Across the 12 identical decks,
636 OP/DC scalar comparisons have maximum relative error 1.8367661135279044e-8
(threshold 1e-6, no absolute-error floor). This is correctness evidence, not a
speed claim or an aggregate-corpus result. Existing unsupported instance
TEMP/DTEMP and unported dialect temperature-field guards are unchanged.

## MOS6 instance TEMP/DTEMP (#1847)

`fixtures/issue-1847/*.cir` are original project-authored MIT decks from
https://github.com/spicets/spice-ts/issues/1847. No third-party fixture bytes.
The test-consumed `reference.json` records SHA-256 of each identical deck and
ngspice-47 OP/DC outputs. Six cases cover NMOS/PMOS, circuit TEMP=40 C,
instance TEMP=75 C, DTEMP=30 C, and both. Each has 61 gate-sweep points
(0 to 3 V in 0.05 V increments for NMOS, mirrored for PMOS).
Regenerate with `spice-heavy python3 benchmarks/fixtures/issue-1847/generate.py`.
Each invocation is `ngspice -b -r <temporary-reference.raw> <fixture.cir>`.
Semantic reference is Berkeley-licensed ngspice-47 commit
`a80f6e3e95d51534905b1f23410a951802666656`,
[`mos6par.c:25-32`](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/mos6/mos6par.c#L25-L32)
and [`mos6temp.c:130-138`](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/mos6/mos6temp.c#L130-L138).
TEMP is Celsius, DTEMP is a temperature difference. Explicit TEMP ignores DTEMP;
otherwise the effective temperature is circuit TEMP plus DTEMP.
Generated on Darwin arm64 with Homebrew ngspice-47 (KLU). Before: all six decks
rejected. After: all six run, with worst relative OP/DC error 6.327e-8 for i(Vd)
and 1.025e-10 for node voltages, below 1e-6 at every point with exact zeros.
Other temperature-law guards remain. No speed or aggregate-corpus claim.

## MOS6 circuit temperature (#1806)

`fixtures/issue-1806/*.cir` are original project-authored MIT decks from
https://github.com/spicets/spice-ts/issues/1806. `reference.json` contains
ngspice-47 OP and gate-voltage DC sweep outputs from those identical bytes.
The 12 cases cover NMOS/PMOS, circuit TEMP=27/50/100 C and model TNOM=27/50 C.
Regenerate with `spice-heavy python3 benchmarks/fixtures/issue-1806/generate.py`.
Each invocation is `ngspice -b -r <temporary-reference.raw> <fixture.cir>`.
Temperature semantics follow Berkeley-licensed ngspice-47
[`mos6temp.c`](https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/spicelib/devices/mos6/mos6temp.c).
Generated on Darwin arm64 with Homebrew ngspice-47 (KLU).
The existing device temperature equations already match this oracle; #1806
enables circuit dispatch and rejects unported temperature parameters.
Before: 8/12 non-nominal decks rejected. After: 12/12 run, maximum relative
OP/DC error 1.933e-12 across 636 values (required <=1e-6, zero references exact).
No runtime superiority claim is made.

## XSPICE core mode=2 hysteresis (#1802)

| Fixture | Source | Licence | Oracle |
| --- | --- | --- | --- |
| `xspice-core-hysteresis/loop.cir` | Original project-authored triangular MMF deck with two full hysteresis loops, https://github.com/spicets/spice-ts/issues/1802 | Repository MIT | ngspice-47, identical committed netlist bytes |

Model semantics follow ngspice-47's Public Domain
[`xtradev/core/cfunc.mod`](https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/xtradev/core/cfunc.mod),
mode=2 (lines 366-510). This mode uses the input and output limits directly,
without mode=1's geometry scaling. The non-unit geometry in the fixture checks
that distinction. The existing `hyst` state machine supplies accepted-timepoint
state, initialization, limits, derivatives and quadratic smoothing.

Reproduce with `spice-heavy pnpm exec tsx benchmarks/xspice-core-hysteresis/compare.ts`.
The harness requires ngspice-47, sources the unmodified fixture, observes
`i(vdrive)` (negative core flux/output), and compares both time grids with linear
interpolation. It reports point counts, peak, max/RMS absolute and peak-normalized
errors plus single-run wall times (not a performance claim). Both directions must
remain within 1% of the oracle peak. No solver tolerances are overridden.


## Corpus-f control-only transient export (#1221)

`benchmarks/corpus/corpus-f/control-transient.test.ts` contains original
project-authored RC decks under the repository MIT licence (source:
https://github.com/spicets/spice-ts/issues/1221). Live ngspice-47 receives the
identical bytes; a harness-side wrapper sources the control-only deck and
exports retained plots without changing analyses or solver tolerances.
The rescored upstream `examples/xspice/pwm-osc/pwm-sin.cir` retains the
BSD-3-Clause provenance and checksum in `corpus/corpus-f/SOURCES.md` and
`corpus/corpus-f/manifest.json`. Only that fixture is rescored; all other
committed outcome rows are retained, not claimed as fresh measurements.

## XSPICE file-driven digital source (#1685)

| Fixture | Source | Licence | Oracle |
| --- | --- | --- | --- |
| Inline `deck`/`data` in `packages/core/src/devices/xspice/d-source.test.ts` | Original project-authored source -> open-collector/emitter -> DAC decks and vector files, https://github.com/spicets/spice-ts/issues/1685 | Repository MIT | Live ngspice-47; identical deck and vector bytes, default solver tolerances |

Semantics are independently expressed from the Public Domain ngspice-47
[`d_source/cfunc.mod`](https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/d_source/cfunc.mod):
token separators 178-210, timing suffixes 379-465, vector tokens and strict
monotonicity 728-823, initial/terminal behavior and 100ps advance/delay
scheduling 1084-1191. The
[`ifspec.ifs`](https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/d_source/ifspec.ifs)
lines 30-63 declare the vector output, `source.txt` default and `input_load`;
the latter is not used by upstream `cfunc.mod`.

Reproduce: `spice-heavy env NGSPICE_SOURCE_REFERENCE=1 pnpm -C packages/core exec vitest run src/devices/xspice/d-source.test.ts`.
Four oracle cases cover a time-zero vector and a delayed first vector with
pull-up/open-collector and pull-down/open-emitter loads. They assert exact
source and buffer event histories (including strengths), compare DAC voltage
at every ngspice timestamp by linear interpolation, and report max/RMS absolute
error and point counts. The unchanged acceptance bound is 1e-6 V; no fixture-
specific solver settings. Before #1685 these decks reject `d_source` as
unsupported; this is new bounded correctness coverage, not a speed claim.

## JFET OFF and IC initialization (#1695, slice 2)

`benchmarks/jfet-off-ic/compare.ts` and
`packages/core/src/devices/jfet-off-ic-1695.test.ts` contain original
project-authored netlists under the repository MIT licence. The live comparison
runs identical bytes with default options on ngspice-47 and spice-ts, reporting
OP voltage/current errors, transient max/RMS relative errors at interpolated
matched times (denominator floor 1e-12), first-point values and runtimes.
Run `spice-heavy pnpm exec tsx benchmarks/jfet-off-ic/compare.ts`.
It exits nonzero when any deck exceeds the unchanged 1e-6 OP or 1% transient
gate, including known losses. No generated receipts are committed.

Semantic source pin: [ngspice a80f6e3e95d51534905b1f23410a951802666656](https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices).
`jfet/jfetpar.c:JFETparam` and `jfet2/jfet2par.c:JFET2param` set OFF and IC;
`jfet/jfetload.c:JFETload` and `jfet2/jfet2load.c:JFET2load` select the
MODEINITJCT/MODEINITFIX and MODETRANOP+MODEUIC local junction biases;
`jfet/jfetic.c:JFETgetic` and `jfet2/jfet2ic.c:JFET2getic` supply unspecified
ICs from external terminal voltages. These sources carry their upstream
Berkeley/SPICE notices; they are referenced, not redistributed here.

LEVEL=2 PScharge (#1698 slice 1): independently implemented the coupled,
path-dependent Statz gate-charge equations and PScharge rectangular-path
partition for the supported parameter subset (XI=1000, XC=ACGAM=0).
Reference: [ngspice-47 source archive](https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/47/ngspice-47.tar.gz),
`src/spicelib/devices/jfet2/psmodel.c:qgg/PScharge/PSinstanceinit` and
`jfet2parm.h` defaults. The upstream PS model carries the Macquarie University
copyright notice (1994-1996); upstream C is referenced, not redistributed.
`packages/core/src/devices/jfet-pscharge-1698.test.ts` uses original MIT decks,
static charge/capacitance values evaluated by that release's qgg function, and
ngspice-47 transient first points. The unchanged comparison still labels these
cases as known-loss but now reports all their signals passing at the existing
1% transient gate. OFF OP remains an honest loss outside this slice.
The resistively grounded gate OP also exposes different ngspice OFF results;
it is not presented as a verified bistable circuit.


## XSPICE open-collector/emitter buffers (#1682)

The inline `openDeck` netlists in
`packages/core/src/devices/xspice/d-open.test.ts` are self-authored under the
project MIT licence, not copied from a third-party circuit. Their opt-in live
ngspice-47 oracle uses identical input bytes, checks exact digital event times
and strengths, and compares DAC voltages at every ngspice timepoint.
Model semantics come from the Public Domain ngspice-47 sources
[`d_open_c/cfunc.mod`](https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/d_open_c/cfunc.mod)
(lines 95-110, 163-222),
[`d_open_e/cfunc.mod`](https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/d_open_e/cfunc.mod)
(lines 95-110, 165-223), and their `ifspec.ifs` parameter tables.
Run with `NGSPICE_OPEN_REFERENCE=1 spice-heavy pnpm -C packages/core exec vitest run src/devices/xspice/d-open.test.ts`.
These decks use ADC stimuli; file-driven `d_source` is not implemented by this slice.

## WASM MOS1 transient (#1622)

| Fixture | Source | Licence | Oracle |
| --- | --- | --- | --- |
| `wasm-mos1-tran/inverter.cir` | Original project-authored CMOS inverter, https://github.com/spicets/spice-ts/issues/1622 | Repository MIT | ngspice-47, identical deck bytes, default options |

`wasm-mos1-tran/ngspice.json` contains the generated ngspice time grid and all
node/source signals, tied to the deck SHA-256. Regenerate and compare with
`spice-heavy pnpm exec tsx benchmarks/wasm-mos1-tran/compare.ts --update-oracle`
after `pnpm build`. The WASM MOS1 transient test consumes this oracle. Comparison
linearly interpolates ngspice at engine times and reports per-signal max/RMS
absolute and relative errors (relative denominator floor 1e-12 in signal units).
Before this change WASM rejected the deck; afterward it completes 230 points.
Measured output-voltage max/RMS error is 1.38727e-3 / 1.78573e-4 V, not strict
ngspice parity. Core/WASM point counts agree, but default-options time grids
differ by up to 1.64113e-21 s. Exact-grid acceptance remains unresolved.

## LTRA small-signal AC (#1604)

`benchmarks/ltra/ac/{rlc,rc,lc}.cir` are original project-authored MIT test
netlists based on the minimal issue reproduction at
https://github.com/spicets/spice-ts/issues/1604. Both simulators consume the
identical committed decks, with `.ac dec 10 1k 1g` and no circuit-specific tuning.
The adjacent JSON fixtures contain ngspice-47 binary raw-file frequency and
complex `v(3)` values (61 points each). Regenerate using
`spice-heavy python3 benchmarks/ltra/ac/generate.py`; run the comparison with
`pnpm -C packages/core exec vitest run src/devices/lossy-transmission-line-ac.test.ts`.
The frequency-dependent stamp follows ngspice-47's Berkeley-licensed
[`ltraacld.c`](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/ltra/ltraacld.c).
Before this change all three decks were rejected (RC at model validation,
RLC/LC at the AC guard), so no numeric baseline error exists. Acceptance uses
maximum relative magnitude error <= 1e-6 and wrapped phase error <= 1e-4 degrees
at every frequency. RC transient and all LTRA noise analyses remain unsupported.
This is bounded AC parity evidence, not a transient or performance claim.

## Corpus-f isolated companion resolution (#1548 / #1545)

The unchanged `examples/rf/sp/file.cir` fixture comes from the ngspice examples
at revision `3ef069fb1f04177a153f342a32d941fc20ff047e`:
https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/rf/sp/file.cir
Redistribution follows the corpus-f manifest's BSD-3-Clause provenance and retained
third-party notices. SHA-256:
`2cc8b6d32c958f320a1f6b3b47995ef654a46559bb224d16de61a7f198779402`.
No companion file is added. Both engines run identical fixture bytes in fresh
directories, with `137MHz_BPF.s2p` absent. The ngspice-47 control-export wrapper
provides the reference; no rewritten fixture, tolerance change or per-deck resolver.
The single-fixture metric and seven-fixture restricted before/after classification
check are documented in `corpus/corpus-f/README.md`; no aggregate rerun is claimed.

## Bounded WASM MOS1 operating points (#1552)

`packages/wasm/src/test-support/mos1-fixtures.ts` contains 12 original
project-authored MIT netlists; no third-party circuit material is copied.
`benchmarks/wasm-mos1-op/compare.ts` feeds identical bytes to both spice-ts
backends and ngspice-47, recording input hashes, node voltages, source branch
currents, uniform tolerances and cold one-shot runtimes in `report.json`.
Reproduce with `pnpm build` then
`spice-heavy pnpm exec tsx benchmarks/wasm-mos1-op/compare.ts`.
The committed receipt is consumed and hash-checked by the WASM MOS1 tests.
This is bounded MOS1 OP evidence, not a general parity or speed claim.


## Diode junction temperature laws (#1533)

`benchmarks/diode-temperature/generate.py` generates original project-authored
MIT probe decks and the consumed test fixture
`packages/core/src/devices/fixtures/diode-temperature-1533.json`. No third-party
netlists are copied. Equations follow ngspice-47's BSD-3-Clause
[`diotemp.c:52-55,82-112,248-251`](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/dio/diotemp.c).
Run `spice-heavy python benchmarks/diode-temperature/generate.py` from the repo
root with ngspice-47 on PATH. The generator recovers adjusted capacitance,
potential and grading from `@d1[cd]` at ideal junction voltages 0, -1 and -2 V,
and transit time from `cd/gd` with depletion capacitances disabled. It does not
substitute the ported temperature equations for the external oracle. Tests
require relative error below 1e-9 for all six resolved model quantities.
Both engines use the same circuit/model/options directives for the 100 MHz
reverse-biased RC AC test; the established diode-depletion thresholds remain
1e-4 relative magnitude and 1e-4 radians phase. Coverage includes each
coefficient at -20/100 C, combined coefficients, inactive linear coefficients
with TLEVC=0, and TNOM=50 C (including TEMP=TNOM). This is correctness evidence,
not a runtime benchmark or a speed claim.

## Lossless transmission-line REL/ABS controls (#1504)

`benchmarks/transmission-line-controls/step.cir` and the parameter variants in
`compare.ts` are project-authored MIT regression circuits for
https://github.com/spicets/spice-ts/issues/1504. No third-party netlist is copied.
The external oracle is ngspice-47, specifically `trasetup.c`, `traacct.c` and
`tratrunc.c` in https://github.com/imr/ngspice/tree/ngspice-47/src/spicelib/devices/tra.
Run `pnpm build && pnpm exec tsx benchmarks/transmission-line-controls/compare.ts`.
Each oracle batch is wrapped in `spice-heavy`; both engines receive identical
netlists. Coverage includes omitted controls, explicit defaults, REL=0.5,
REL=0.5 ABS=1g and suppressed slope triggers. The unchanged corpus 1% gate
uses peak-normalized maximum error and the standard voltage floor. The script
reports point counts, maximum/RMS absolute error, normalized error and runtime
(oracle wall time explicitly includes semaphore queueing). Raw output is
temporary, not committed. No performance superiority is claimed.

## Three-dimensional control-loop outputs (#1491)

`corpus/corpus-f/three-dimensional-output.ts` runs the byte-identical upstream
`examples/various/3d_loop.sp` fixture against ngspice-47. Source URL, revision,
BSD-3-Clause licence and checksum are recorded in `corpus/corpus-f/SOURCES.md`
and its manifest. No netlist is copied or changed. After building, run
`spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/three-dimensional-output.ts`.
All three constructed output files, including their scale vectors, are scored
with the corpus-f normalized-error rule and uniform 1% threshold. The harness
requires 15 DC runs and 66 signal comparisons. ASCII raw output is selected
through an isolated ngspice initialization file. Temporary outputs are removed.



## Static BJT quasi-saturation (#1499)

`packages/core/src/devices/fixtures/bjt-quasisat-1499.json` contains original
project-authored MIT decks and ngspice-47 reference values. No upstream decks
are redistributed. Equations and defaults follow ngspice-47's BSD-3-Clause
[`bjtload.c` and `bjttemp.c`](https://github.com/imr/ngspice/tree/ngspice-47/src/spicelib/devices/bjt).
The paired unit test documents the `spice-heavy ngspice -b` control/export
commands; both engines receive identical circuit/model/analysis directives.
It checks source current and intrinsic collector voltage at every point for
NPN at two base voltages, PNP, OP, series resistance, AREA/M, and temperature.
This is a static correctness test, not a speed claim or AC/transient support.


## BJT quasi-saturation AC (#1605)

`packages/core/src/devices/fixtures/bjt-quasisat-ac-1605.json` contains eight
original project-authored MIT decks and 248 ngspice-47 reference points.
No third-party netlists are redistributed. The oracle equations are ngspice-47's
BSD-3-Clause [`bjtload.c` and `bjtacld.c`](https://github.com/imr/ngspice/tree/ngspice-47/src/spicelib/devices/bjt).
The paired test documents the `spice-heavy ngspice -b` export commands and
compares identical circuit/model/analysis directives for QCO=0/nonzero in
forward-active/quasi-saturation, NPN and PNP (the latter with AREA=2, M=3).
Acceptance is maximum relative magnitude error <=1e-5 and phase error <=1e-3
degrees across every frequency. Transient epi-charge integration is not supported.

## Lossless transmission-line IC with UIC (#1497)

`benchmarks/transmission-line-ic/step.cir` and the variants generated by
`compare.ts` are project-authored MIT regression circuits, sourced from
https://github.com/spicets/spice-ts/issues/1497 (no third-party netlist copied).
The oracle is ngspice-47's lossless T-element (`traload.c`, MODEINITTRAN /
MODEUIC); ngspice is invoked as an external executable, not redistributed.
Run `pnpm build && pnpm exec tsx benchmarks/transmission-line-ic/compare.ts`.
The script passes identical netlists to both engines, wraps each batch oracle
run in `spice-heavy`, and uses the standard transient `alignAndMeasure`
comparison. It reports maximum absolute error and error normalized by the
reference peak (standard 100 microvolt floor) for both port voltages, with the
uniform corpus 1% gate (`MATCH_THRESHOLD`, not a circuit-specific tolerance).
Coverage includes symmetric/asymmetric port states and a nonzero operating
point with/without IC and without UIC. Raw files are temporary, not committed.


## Public Gear MAXORD=3 (#1406)

`benchmarks/gear3-enable/compare.ts` runs the byte-identical corpus-f
`examples/p-to-n-examples/switch-oscillators.cir` against ngspice-47.
Its pinned upstream source, BSD-3-Clause licence and hash remain recorded in
`corpus/corpus-f/SOURCES.md` and its manifest. The four zero-UIC RC refinement
decks generated by the script are project-authored MIT probes. Both engines
receive identical deck bytes; native ASCII raw export is configured through
`.spiceinit`, not by editing the fixture. Errors are measured at native times
using linear interpolation of spice-ts, over the shared time interval. All
plotted oscillator signals and all three RC electrical signals are reported.
The JSON output includes runtime (native process startup included, TS simulation
only), row counts, source hashes and failures. No tolerance tuning or parity
threshold changes; this measures the known native order-policy discrepancy.

## XSPICE memristor (#1404)

`benchmarks/memristor-1404/compare.ts` sources the unchanged corpus-f
`examples/memristor/memristor_x.sp` in ngspice-47 and spice-ts. Its pinned
revision `3ef069fb1f04177a153f342a32d941fc20ff047e`, BSD-3-Clause licence and
SHA-256 are recorded in `corpus/corpus-f/SOURCES.md`. The model follows
[ngspice's memristor cfunc.mod and ifspec.ifs](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/src/xspice/icm/xtradev/memristor/)
(Copyright 2012, ngspice team, BSD-3-Clause). New unit probes are project-authored MIT.
The wrapper exports native electrical vectors only, avoiding `write all` padding
from the fixture's cross-plot calculated resistance vectors. No fixture bytes,
solver tolerances or MATCH_THRESHOLD are changed. Run with `spice-heavy pnpm exec
tsx benchmarks/memristor-1404/compare.ts` after `pnpm build`; errors above 1% remain
visible in its JSON output, not relabelled as matches.

## Vector parameter consumer (#1405)

`vector-param-compare.ts` sources the byte-identical corpus-f
`examples/numparam/vector_param.cir` fixture in both engines. Existing
provenance and BSD-3-Clause licence remain in `corpus/corpus-f/SOURCES.md`.
The reference driver only exports results after sourcing the unchanged deck.
The `d_genlut` behavior follows the Public Domain ngspice-47
[`cfunc.mod` and `ifspec.ifs`](https://sourceforge.net/p/ngspice/ngspice/ci/ngspice-47/tree/src/xspice/icm/digital/d_genlut/).
New unit-test circuits and the comparison runner are project-authored (MIT).
Run `spice-heavy pnpm exec tsx benchmarks/vector-param-compare.ts` from the
repository root. It reports sine max/RMS absolute and peak-normalized errors
after linear interpolation at reference times, and node3 state/strength and
event-time errors. Process startup is included only in the ngspice timing;
these single cold runs are not a speed benchmark. No fixture or tolerance changes.

## XSPICE real event nodes (#1382)

The existing corpus-f `examples/xspice/original-examples/io_types.deck` and
`user_defined_nodes.deck` are unchanged ngspice revision
`3ef069fb1f04177a153f342a32d941fc20ff047e` fixtures (BSD-3-Clause).
Their provenance, hashes and licence remain in `corpus/corpus-f/SOURCES.md`
and the manifest. No fixtures or comparison tolerances change.
Semantics follow that revision's
[`src/xspice/icm/xtraevt`](https://github.com/imr/ngspice/tree/3ef069fb1f04177a153f342a32d941fc20ff047e/src/xspice/icm/xtraevt)
`{d_to_real,real_gain,real_delay,real_to_v}/{cfunc.mod,ifspec.ifs}` and
`real/udnfunc.c` (ngspice XSPICE code-model sources, Public Domain).
The new unit-test circuits are project-authored (MIT).
Scoped rerun evidence is in `corpus/corpus-f/README.md`, section #1382.

## VDMOS noise parity and self-heating boundary (#1348)

`benchmarks/vdmos-noise/{unsupported,flicker,pchan,self-heating,self-heating-inverse-n,self-heating-inverse-p}.cir` are original
MIT-licensed spice-ts regression decks, consumed by `noise-vdmos-1348.test.ts`.
The inverse N/P decks connect the intrinsic source through RS to the output,
not AC ground. RTHJC=20 K/W makes thermal feedback observable at the unchanged
1e-4 relative-error gate; both AC transfer and noise spectra fail before the
inverse thermal source-row sign fix. Existing decks and tolerances are unchanged.
The legacy `unsupported.cir` filename is retained as the original reproducer;
it now has noise parity. The comparison runs identical bytes on both engines.
Regenerate the ngspice-47 reference vectors with
`spice-heavy pnpm exec tsx benchmarks/vdmos-noise/compare.ts --update`;
check live parity with the same command without `--update`.
At 100, 200 and 300 Hz the original deck produces output noise density
`6.237243e-10 V/sqrt(Hz)` and input noise density `2.810918e-10 V/sqrt(Hz)`.
Before the original guard, spice-ts returned approximately `3.914781e-10` and
`1.764261e-10`, respectively; immediately before this port it rejected all VDMOS.
The new flicker and pchan (M=2) decks include RD/RS and nonzero KF/AF over
1 Hz–1 MHz. `reference.json` stores ngspice `noise1` print-all source spectra;
tests isolate RD, RS, channel and flicker noise without changing the DC/AC stamp.

Algorithm reference: [ngspice-47 vdmosnoi.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/vdmos/vdmosnoi.c),
under ngspice's UC Berkeley permissive licence (see its COPYING and source
header). That routine includes RD/RS thermal, channel thermal, KF/AF flicker
and a self-heating temperature ratio, but no RG/RB/body-diode noise source.
No implementation is copied. RD/RS/channel thermal and KF/AF flicker sources
are ported, with an explicit gm/gds/id/conductance/model/temperature noise seam.
Self-heated noise now uses the AC-only thermal stamps from
[ngspice-47 vdmosacld.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/vdmos/vdmosacld.c),
under the same UC Berkeley permissive licence. The DC power Jacobian is not
the AC thermal row: the AC row uses channel-only derivatives with different
signs and omits series-resistor/body-diode thermal couplings. The existing
noise temperature ratio already matches vdmosnoi.c and is unchanged.
Before #1354, unguarded maximum output/input noise errors were 1.13%/3.32%;
the measured complex AC error at 1 Hz was 2.12384%. After the port the live
seven-point 1 Hz–1 MHz maxima are 4.52e-8 relative noise and 5.20e-13 complex
AC. The comparison script derives an AC deck from the same electrical cards
(replacing only analysis/control cards), runs identical bytes on both engines,
and stores real/imaginary output arrays in `reference.json`. Existing corpus
decks and DC/transient equations are unchanged.

## BJT base-resistance noise (#1347)

`packages/core/src/analysis/bjt-gx-noise-reference.json` contains original
MIT-licensed spice-ts regression decks and test-consumed ngspice-47 spectra
and integrated totals. The identical decks cover RBM=RB with IRB, RBM<RB
with and without IRB, split XCJC with RB>0, and PNP. The JSON records the
`spice-heavy ngspice -b case.cir` command and control commands to regenerate
each reference (append the control block to the stored deck).
Algorithm references: [ngspice-47 bjtnoise.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/bjt/bjtnoise.c)
(RB THERMNOISE uses operating-point gx between base/base-prime) and
[bjtload.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/bjt/bjtload.c)
(RBM/IRB gx law), under ngspice's UC Berkeley permissive licence; see its
COPYING and source headers. No ngspice implementation code is copied here.
These are bounded device-noise comparisons, not full-amplifier parity claims.

## Control Fourier command (#1334)

`benchmarks/control-fourier/harmonics.cir` is an original MIT-licensed probe
by spice-ts contributors. The identical six-period deck runs on both engines.
The test consumes `ngspice-47.txt`, captured with
`spice-heavy ngspice -b benchmarks/control-fourier/harmonics.cir > benchmarks/control-fourier/ngspice-47.txt 2>&1`.
The original MIT-licensed `expressions.cir` adds spaced arithmetic and mixed
expression/vector operands. Its test-consumed reference is regenerated with
`spice-heavy ngspice -b benchmarks/control-fourier/expressions.cir > benchmarks/control-fourier/expressions-ngspice-47.txt 2>&1`.
Algorithm reference: [ngspice-47 frontend/fourier.c](https://github.com/imr/ngspice/blob/ngspice-47/src/frontend/fourier.c),
lines 69-152 (defaults and grid), 158-195 (table), 292-362 (sine-reference
coefficients, normalization, THD), and `maths/poly/interpolate.c:74-188`
(polynomial-window selection). These ngspice frontend sources are BSD-3-Clause,
copyright Regents of the University of California; see ngspice's COPYING.
Higher-degree fits use Newton divided differences rather than absolute-time
Vandermonde elimination to avoid ill-conditioning. The test covers degrees
1/2 against ngspice and degree 3 against an exact cubic resampling oracle.
This is post-processing coverage, not a transient performance claim.

## BSIM4 IGBMOD=1 gate-to-body tunneling (#1321)

`benchmarks/bsim4-igb/{n,p}-{acc,inv}.cir` are self-authored MIT fixtures.
Both engines receive identical netlists, with 31 points per NMOS/PMOS
accumulation/inversion sweep, TOXREF/NTOX dependence and NF/M scaling.
Regenerate the hash-guarded `ngspice-47.json` with
`spice-heavy python3 benchmarks/bsim4-igb/generate.py`.
`gate-body-current.test.ts` checks I(Vg), I(Vb) and normalized device IGB
at every point against one shared 1e-6 relative OR 1e-15 A absolute bound.
No native logs/raw files are committed. The generic equations and analytic
derivatives are ported from ECL-2.0 ngspice-47 `b4ld.c:2803-2921`, revision
`a80f6e3e95d51534905b1f23410a951802666656`, using the existing BSIM4
licence/notices and temperature/binning path. See `bsim4/LOAD.md`.

## BSIM4 IGCMOD=1 gate tunneling (#1304)

`benchmarks/bsim4-igc/{n,p}-{forward,reverse}.cir` are self-authored MIT
fixtures. They sweep VGS at fixed VDS with thin oxide, asymmetric gate
overlaps, NF/M scaling, both polarities and both drain orientations.
Reverse cases also cover given PIGCD, poly depletion and nonnominal temperature.
The unchanged decks run through both engines. `generate.py` requires ngspice-47
and writes `ngspice-47.json`, which is consumed by `gate-current.test.ts`.
Regenerate with `spice-heavy python3 benchmarks/bsim4-igc/generate.py`;
no native raw files or logs are committed. Deck hashes guard oracle identity.
The test uses the existing BSIM4 bias-grid bound (1e-8, native-zero floor
1e-18 A), without per-fixture tolerance changes. Source equations are the
ECL-2.0 BSIM4 4.8 family at pinned ngspice revision
`a80f6e3e95d51534905b1f23410a951802666656`; see the licence and notices in
`packages/core/src/devices/bsim4/` and the line mapping in `LOAD.md`.

## VBIC open parasitic base resistor RBP=0 (#1302)

`benchmarks/vbic-rbp/rbp.cir` is an original project-authored MIT probe.
Both engines receive identical bytes for a five-point DC sweep and 2 ns
transient. Regenerate the test-consumed `ngspice-47.json` with
`spice-heavy pnpm exec tsx benchmarks/vbic-rbp/reference.ts` from the repo root.
The test checks the deck SHA-256 and full transient coverage, then linearly
interpolates spice-ts onto all 217 ngspice timepoints. Normalization is by the
reference peak of each signal, not instantaneous voltage.

Measured on Darwin arm64 with ngspice-47, collector/base DC max absolute errors
are 5.3171707703469906e-8 / 1.3212808624984973e-10 V, peak-normalized
2.6601642625602793e-8 / 1.8876202548223627e-10. Transient max absolute errors
are 2.513516651709846e-4 / 6.009391854133739e-6 V, peak-normalized
1.2582220050063982e-4 / 8.837508609840859e-6. Before support the same deck
rejects RBP=0, so there is no before waveform or speed claim.

Equations follow BSD-3-Clause ngspice revision
`a80f6e3e95d51534905b1f23410a951802666656`,
[`vbicload.c`](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vbic/vbicload.c)
and `vbicsetup.c`. The p[10]>0 gate enables Irbp; otherwise its current and
all derivatives are exactly zero, without collapsing baseBP. RBP<0 remains
outside the bounded domain. RCI/RBI gating is unchanged. The existing VTF
default DC/AC/transient stamp fingerprint remains exactly
`bd942ae769ac72c14e81f01dc017fcc2eb2405613f1d1865dbccf12d42c06eea`.
Both VTF and RBP ngspice references regenerate byte-identically.

The unmodified upstream DFF fixture is covered by the corpus-F source/license
record below. Run the full 10 ns comparison without rewriting its deck with
`spice-heavy pnpm exec tsx benchmarks/vbic-rbp/dff.ts`. This reports wall time,
row counts and V(Q), V(D), V(CLK) max absolute/peak-normalized errors, or the
next named simulator failure. No deck or tolerance tuning is applied.


## VBIC VTF forward transit-time Vbc dependence (#1300)

`benchmarks/vbic-vtf/vtf.cir` is an original project-authored MIT probe.
Both engines receive identical bytes: five complex AC points (100 MHz–10 GHz)
and a 5 ns PWL transient. Regenerate the test-consumed `ngspice-47.json` from
the repo root with `spice-heavy pnpm exec tsx benchmarks/vbic-vtf/reference.ts`.
Set TMPDIR to an appropriate scratch directory. The generator checks ngspice-47;
`vbic-vtf.test.ts` checks the netlist SHA-256, frequencies and transient coverage,
then linearly interpolates spice-ts onto all 1,020 ngspice transient times.
Error is max absolute complex distance (AC) or voltage difference (TRAN),
normalized by the reference peak of each signal, not by instantaneous voltage.

Darwin arm64, ngspice-47: collector/base AC max absolute errors are
7.646392723943314e-12 / 1.3919430203557881e-12 V, peak-normalized
3.5034358547731467e-12 / 1.3950203583134843e-12. Transient errors are
2.1070071874795815e-5 / 5.081838456710841e-6 V, peak-normalized
1.0841715193878487e-5 / 7.059307849897501e-6. Before support this deck
rejects VTF: no fabricated before waveform or speed comparison is claimed.

Equations follow BSD-3-Clause ngspice revision
`a80f6e3e95d51534905b1f23410a951802666656`,
[`vbicload.c:2223-2227,3859-3888`](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vbic/vbicload.c#L3859),
`vbicsetup.c:218-219` and `vbictemp.c:127`. Finite VTF <= 0 disables the
exponent; positive VTF uses exp(Vbci/(1.44*VTF)), with the generated
Jacobian's rounded 0.6944444/VTF slope. VTF is not temperature mapped.
Independent charge/derivative tests cover ITF=0/nonzero, reverse/zero/forward
BE bias, reverse/forward BC bias, NPN/PNP, and scale 3. The shared derivatives
feed AC and transient stamps. Omitted/zero/negative VTF preserve the pre-change
DC/AC/transient fingerprint in the committed test exactly.

At the VTF-only implementation, byte-identical corpus DFF_Y_ECL.sp rejected the independent RBP=0
bounded-domain restriction (`Invalid bounded VBIC DC model parameter: 'RBP'`).
The RBP slice above removes that restriction; DFF parity is measured separately.

## VBIC parasitic base-emitter currents IBEIP/IBENP (#1297)

`benchmarks/vbic-ibeip/ibeip.cir` is an original project-authored MIT probe.
The byte-identical ngspice-47 deck runs OP, a three-point DC sweep and AC at
75 C with deliberately distinct NCI/NCN and NEI/NEN. Regenerate with
`SPICE_ASCIIRAWFILE=1 spice-heavy ngspice -b -r ibeip.raw benchmarks/vbic-ibeip/ibeip.cir`.
`packages/core/src/devices/vbic-ibeip.test.ts` freezes collector/base source
currents; the substrate source carries only approximately 1e-13 A gmin here
and is not used for the relative-error metric. Maximum OP/DC/AC absolute error
is 1.3921102717849923e-9 A and maximum per-signal peak-normalized error is
4.5346834831227904e-6 (Darwin arm64, ngspice-47). Before support this deck
rejects IBEIP, so no before waveform or speed comparison is claimed.

Equations follow BSD-3-Clause ngspice revision
`a80f6e3e95d51534905b1f23410a951802666656`,
[`vbicload.c:3566-3598`](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vbic/vbicload.c#L3566)
and `vbictemp.c:245-258`. Ibep runs from BX to BP, using Vbep and NCI/NCN,
with EAIC/EANC and XII/XIN temperature scaling. AREA*M scales current and
conductance, not the subsequently added circuit gmin. The shared current
linearization covers DC, AC and transient; Ibep adds no charge. Noise uses
the same physical peripheral base current. Independent hand tests cover
both polarities, ideal/nonideal/both currents, 0/27/75 C and instance scale 3.
`vbicmpar.c:240-247` assigns both parameters without range validation;
spice-ts deliberately accepts only finite nonnegative saturation currents.
Omitted and explicit-zero parameters retain the pre-existing DC/AC/transient
stamp SHA-256 exactly. At #1297 the unchanged DFF_Y_ECL.sp remained unsupported
at VTF (advanced to RBP=0 by #1300 above); this is not a DFF waveform parity claim.

## VBIC substrate-parasitic weighting WSP (#1294)

`benchmarks/vbic-wsp/wsp.cir` is an original project-authored MIT probe.
`packages/core/src/devices/vbic-wsp.test.ts` reads the byte-identical deck and
freezes ngspice-47 OP (1 row), DC (3 rows) and complex AC (3 rows) currents.
Regenerate with `SPICE_ASCIIRAWFILE=1 spice-heavy ngspice -b -r wsp.raw benchmarks/vbic-wsp/wsp.cir`.
Equations follow the BSD-3-Clause
[`vbicload.c`](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vbic/vbicload.c)
at revision `a80f6e3e95d51534905b1f23410a951802666656`, lines 3221-3285 and
3913-3922. WSP mixes exponentials of Vbep and Vbci in Ifp, not voltages;
Vbcp still controls the unmixed reverse Irp. Ifp also drives qbp, the RBP
conductance and TR diffusion charge Qbep. Dual derivatives carry both inputs
through DC, AC and transient stamps. `vbicmpar.c:232-235` assigns WSP without
range validation; spice-ts deliberately restricts it to finite [0, 1].

Measured on Darwin arm64 with ngspice-47, the maximum peak-normalized
OP/DC/complex-AC current error is 2.460021212794704e-6 (threshold 0.001),
and the maximum absolute current error is 1.252334108369803e-10 A.
Independent hand-reference transport error over WSP=0/0.3/1 and NPN/PNP is
at most 1.1580528575742387e-23 A; analytic derivatives, AC diffusion charge
and Euler-integrated diffusion charge are also checked. Before this change
the same probe rejects typed unsupported WSP, so no pre-change numeric
parity or speed comparison is available.

The unchanged corpus-f `examples/vbic/DFF_Y_ECL.sp` retains BSD-3-Clause
provenance in `corpus/corpus-f/SOURCES.md` and `LICENSE.txt`, and SHA-256
`d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6`.
ngspice-47 completes 40,545 transient rows; spice-ts now advances from typed
unsupported WSP to typed unsupported IBEIP. This remains a coverage loss,
not DFF waveform parity. No corpus bytes or simulator tolerances changed.

## VBIC base-emitter partition WBE (#1291)

`benchmarks/vbic-wbe/wbe.cir` is an original project-authored MIT probe.
The regression in `packages/core/src/devices/vbic-wbe.test.ts` reads this exact
deck and freezes ngspice-47 OP (1 row), DC (3 rows) and AC (3 rows) values.
Regenerate with `SPICE_ASCIIRAWFILE=1 spice-heavy ngspice -b -r wbe.raw benchmarks/vbic-wbe/wbe.cir`.
Equations follow ngspice's BSD-3-Clause
[`vbicload.c`](https://github.com/ngspice/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vbic/vbicload.c)
at pinned revision `a80f6e3e95d51534905b1f23410a951802666656`, lines 3297-3535
(intrinsic/extrinsic diode currents) and 3874-3896 (depletion partition with
unpartitioned intrinsic forward diffusion). `vbicmpar.c:188-191` assigns WBE
without validation; spice-ts deliberately bounds finite WBE to [0, 1].
The maximum peak-normalized OP/DC/complex-AC error measured on this probe is
3.886063221917387e-6, against the unchanged 0.1% probe threshold.
The unchanged corpus-f `examples/vbic/DFF_Y_ECL.sp` retains its original
BSD-3-Clause provenance in `corpus/corpus-f/SOURCES.md` and `LICENSE.txt`.
Its SHA-256 remains `d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6`.
ngspice-47 completes 40,545 transient rows. spice-ts advances from typed
unsupported WBE to typed unsupported WSP; no DFF waveform parity is claimed.

## Diode self-heating (#1261)

`benchmarks/diode-self-heating/compare.ts` sources the unchanged corpus-f
`examples/soa/diode-soa-sh.cir` from ngspice-47 (BSD-3-Clause; provenance and
licence in `corpus/corpus-f/SOURCES.md` and `corpus/corpus-f/LICENSE.txt`).
SHA-256: `24c5c8568ebe8c15d8d8b603e84db3d98e8914767e1de1f4f266f242828f066f`.
It runs the original deck through the public API, including saved `@d1[id]`
and SOA postprocessing, and compares temperature, source current and saved diode
current at all 100 DC points. All waveforms use the uniform 1%-of-peak threshold.
The project-authored MIT saved-current unit deck freezes ngspice-47 DC currents
and thermal state with tight solver options and a 1e-6 relative threshold.
Timings measure different
execution boundaries and are diagnostic only, not a speed comparison.
Thermal semantics follow ngspice-47 `src/spicelib/devices/dio/dioparam.c:47-49`
(flag), `dioload.c:80,318-322,749-759,790-822` (activation, temperature,
power/Jacobian), and `diosetup.c:274-278` (thermal defaults). Project-authored
MIT unit decks freeze ngspice-47 OP values and check thermal RC integration.
Thermal junction charge and AC/noise remain typed unsupported errors.

## BSIM3 AC non-quasi-static common-source amplifier (#1249)

`benchmarks/bsim3-acnqs-1249/common-source.cir` and the reverse, resistive-gate,
PMOS and temperature/multiplier variants in `decks.ts` are original project-authored
MIT probes. Each deck is passed byte-identically to ngspice-47 and spice-ts;
the test-consumed `ngspice-47.json` records SHA-256 hashes and 61 complex
v(out) samples from 1 MHz to 1 THz for both ACNQSMOD=0 and 1. Regenerate with
`spice-heavy pnpm exec tsx benchmarks/bsim3-acnqs-1249/reference.ts`.
`packages/core/src/devices/bsim3-acnqs.test.ts` checks complex and magnitude
error against the unchanged 1%-of-peak threshold, plus wrapped phase error.
The port follows ngspice-47
[`b3acld.c:50-100,367-423`](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/bsim3/b3acld.c)
and [`b3ld.c:2478-2494`](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/bsim3/b3ld.c)
(ngspice BSIM3 distribution, UC Berkeley permissive licence). The AC delay
reuses the transient NQS relaxation rate. NQSMOD=1 AC (including combined
selectors) and ACNQSMOD=1 noise remain explicitly unsupported with typed
errors; ACNQSMOD is defined only on BSIM3 3.3.0.



## VBIC flicker and total noise (#1197)

`benchmarks/vbic-noise/compare.ts` runs the byte-identical corpus-f
`tests/vbic/noise_scale_test.cir` through both engines. Source: ngspice
[`tests/vbic/noise_scale_test.cir`](https://github.com/imr/ngspice/blob/3ef069fb1f04177a153f342a32d941fc20ff047e/tests/vbic/noise_scale_test.cir),
revision `3ef069fb1f04177a153f342a32d941fc20ff047e`, BSD-3-Clause;
SHA-256 `2877ccad8bcb440258e65a8a817edfd8536029ae192b3049cb62f248a8a81286`.
The licence and original manifest entry remain in `corpus/corpus-f/SOURCES.md`
and `corpus/corpus-f/LICENSE.txt`. No deck modifications or tolerance changes.
Equations follow the same revision's `src/spicelib/devices/vbic/vbicnoise.c`
and `vbicload.c` (BSD-3-Clause), including gmin, M/AREA scaling, and the
upstream distinction: RS/ICCP contribute to integrated totals, not spectra.
The regression test freezes ngspice-47 binary-raw samples; its additional
scaling/exponent probes are project-authored MIT tests. Run the comparison
with `pnpm exec tsx benchmarks/vbic-noise/compare.ts`. Numerical residuals
and single-run timings are printed, not committed as generated receipts.
This does not claim support for VBIC parameters outside the bounded model,
self-heating, or differential semiconductor-noise outputs.

## XSPICE zener and square (#1188)

`packages/core/src/devices/xspice/xspice-zener-square.test.ts` uses original
project-authored MIT probes and analytic checks. The model equations and
interface tables follow ngspice `src/xspice/icm/xtradev/zener/{cfunc.mod,ifspec.ifs}`
and `src/xspice/icm/analog/square/{cfunc.mod,ifspec.ifs}` (Georgia Tech XSPICE,
ngspice BSD-3-Clause distribution). Upstream source:
https://github.com/ngspice/ngspice/tree/master/src/xspice/icm.
The four byte-identical `analog_models4_{ac,dc,swept_dc,transient}.deck` fixtures
retain their pinned ngspice revision, URLs, hashes and BSD-3-Clause provenance
in `benchmarks/corpus/corpus-f/SOURCES.md`. Comparisons use ngspice-47 and the
existing `triage-detail.ts` harness without per-deck tolerance changes.

## Uniform distributed RC line (#1191)

`packages/core/src/urc.test.ts` contains an original project-authored MIT probe
with frozen ngspice-47 DC and transient samples. The comment-free test deck is
passed unchanged to both engines (ngspice additionally needs its title and `.end`).
References use `SPICE_ASCIIRAWFILE=1 ngspice -n -b -r probe.raw probe.cir` and
linear interpolation at the listed sample times. Expansion follows ngspice-47
[`urcsetup.c`](https://github.com/imr/ngspice/blob/3ef069fb1f04177a153f342a32d941fc20ff047e/src/spicelib/devices/urc/urcsetup.c)
(BSD-3-Clause, existing corpus-f licence). The existing byte-identical corpus-f
`examples/TransmissionLines/URC-TM-SUB.cir` retains its manifest provenance.
Its `.control` vectors are compared using the existing `control-vectors.ts`
wrapper, not the batch `-r` path which exports no vectors for this deck.

## MCP scalar RC measurements (#1162)

`packages/mcp/src/measure.test.ts` contains two original project-authored MIT
RC netlists (repository `LICENSE`), not third-party extracts. Both engines receive
the identical `rcTran`/`rcAc` strings, including the comment title and `.end`.
References were exported with ngspice-47 using
`SPICE_ASCIIRAWFILE=1 ngspice -b -r probe.raw probe.cir`.
The transient scalar is the first linear-axis crossing of `v(out)` at `1-exp(-1)`;
the AC scalar is the first linear-Hz crossing of `20*log10(abs(v(out)))` at
`-10*log10(2)`. Native scalars are retained in the runnable test, alongside the
independent analytic RC checks. No external source or simulator tolerance changed.

## TEMPER model/instance sweep regression (#1151)

`packages/core/src/analysis/temper-model-1151.test.ts` contains an original
MIT-licensed two-diode probe. Its ten current references were measured with
ngspice-47 on the identical deck, using `SPICE_ASCIIRAWFILE=1 ngspice -n -b -r probe.raw probe.cir`,
without tolerance changes. The upstream self-check decks are the unchanged
BSD-3-Clause corpus-f fixtures at ngspice revision
`3ef069fb1f04177a153f342a32d941fc20ff047e`, with per-file provenance in
`benchmarks/corpus/corpus-f/SOURCES.md`:
https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/regression/temper/temper-2.cir.
The refreshed corpus row is `not-compared`, not a numerical match: its control
block exits successfully, but ngspice's batch raw export contains no vectors.

## Behavioral capacitor explicit multiplier compatibility (#1122)

`packages/core/src/parser/behavioral-capacitor-m-1122.test.ts` contains an
original MIT-licensed PWL ramp reproducer authored in
https://github.com/mfiumara/spice-ts/issues/1122, not an imported corpus deck.
Its numerical current references were measured with ngspice-47 on identical
netlist bytes. The behavioral reference is ngspice revision
`a80f6e3e95d51534905b1f23410a951802666656`, BSD-3-Clause:
https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/frontend/inpcom.c#L6070-L6106
and lines 6970-6971. No upstream C code is copied.
Compatibility deliberately includes its double-exponent preprocessing defect:
explicit numeric `m=2` becomes gain `2.00000000e+00e9`, interpreted as 2,
whereas absent `m` gives gain 1e9. This is not physically corrected multiplier
semantics or an accuracy claim. Braced/quoted multiplier expressions remain
structured errors; ngspice-47 rejects the tested forms too. Ordinary constant
capacitor multiplicity is unchanged.

## Published numerical reference baseline (#1113)

`benchmarks/corpus/vendor-published/` contains 20 normalized reconstructions and
270 extracted numerical observations from Tony R. Kuphaldt, *Lessons in Electric
Circuits*, openly published at https://www.ibiblio.org/kuphaldt/electricCircuits/.
The seven cited chapter footers link to [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
via the [licence appendix](https://www.ibiblio.org/kuphaldt/electricCircuits/Ref/REF_A3.html).
Attribution and normalization changes are retained; the author does not endorse
this comparison. Per-case URLs, retrieval dates,
HTML SHA-256, example titles, zero-based PRE locations, assumptions and retained
printed digits are in `manifest.json`; `fetch-references.py` reproduces numerical
extraction without storing chapter HTML, PDFs or figures. Original topology and
component values are retained; legacy output/syntax normalization is documented.
These are historical SPICE2g6 simulation tables, not vendor measurements. The
requested directory name is an umbrella for the issue's permitted textbook
examples. One prose/netlist conflict is excluded from totals but still run and
reported. Identical reconstructed bytes are passed to both modern engines;
there is no calibration, restricted model, commercial install or account.
Published simulated and measured reference fields are separate (measured: none).
See [VENDOR_PUBLISHED.md](VENDOR_PUBLISHED.md) for all points, uncertainty policy,
losses and the coverage boundary. Source attribution is retained; newly authored
runner/tests are MIT project work, not re-licensed source chapters.

## VDMOS comparison/export boundary (#1106)

`benchmarks/vdmos-1106/` captures derived engine exports from the eight unchanged
corpus-n ngspice VDMOS examples (n-6 through n-13). Source revision
`a80f6e3e95d51534905b1f23410a951802666656`, BSD-3-Clause, upstream directory
https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos.
The original decks, individual URLs, licenses and input hashes remain in
`benchmarks/corpus/corpus-n/manifest.json`; no deck is edited or copied here.
Captured waveforms and full plot/vector inventories are reproducible with the
guarded runner. Runner, regression tests and report checker are original MIT
project work. Common-vector metrics, missing-vector inventories and the n-12
unmatched-plot loss are all published; no aggregate refresh or tolerance change.

## MOS1 per-iteration history trace (#1080)

[mos1-invert1-1080/HISTORY.md](mos1-invert1-1080/HISTORY.md) traces the
unchanged, already-pinned GPL-3.0-or-later Xyce `invert1.cir` fixture on
both engines. Original MIT observation/parser scripts and generated numeric
receipts are provided. `native-history.patch` adds observation statements
to ngspice-47 (https://github.com/imr/ngspice/tree/ngspice-47); its small
upstream context remains subject to ngspice's modified BSD/Berkeley notices
and COPYING. No complete native source or adapted fixture is redistributed.
The original 0.249 mismatch and all other corpus-m losses remain published.

## Diode hidden state and source-step factorization (#917)

[native-state-917](native-state-917/README.md) contains an original MIT
series-diode/capacitor reduction and observation/replay scripts. Rounded
parameters are self-written, not copied vendor model text. The unchanged
ticket-795 base/variant and seven includes remain fetch-only under the
existing policy below. Their historical hashes are checked before and after
execution; no vendor netlist/model expressions or native source are shipped.
The referenced native source is ngspice-47 revision
`a80f6e3e95d51534905b1f23410a951802666656`, modified BSD, at
https://git.code.sf.net/p/ngspice/ngspice. The script adds original numeric
observation statements to a local ignored checkout. Receipt data retains the
diode's numeric state and three rows, not complete expanded vendor material.
Both vendor losses remain; before/after max/RMS are null, not zero.


## Floating diode OP recovery experiments (#917)

[floating-island-recovery-917](floating-island-recovery-917/README.md) reuses the
self-written MIT reduction and unchanged fetch-only vendor decks pinned in
[ticket795-singular-917](ticket795-singular-917/README.md). Vendor attachment
https://sourceforge.net/p/ngspice/bugs/795/, `project.7z`, SHA256
`4f553ecaa57d330c9db7ad9c581988252858451aad0c59a589b3953693fae924`.
No vendor bytes are redistributed. New test, runner and experimental patches
are original MIT project work. Ngspice-47 `a80f6e3e95d51534905b1f23410a951802666656`
is a cited behavioral reference under its modified BSD licence; no C code is copied.
Candidate losses are retained; no production algorithm or corpus score changes.

## BJT pre-charge residual boundary experiment (#1037)

`benchmarks/bjt-precharge-1037/` reuses the original MIT-licensed rest and
nanosecond-control strings in `transient-centered-1037.fixtures.ts`, plus an
original MIT PWL-source control derived only by replacing the voltage source.
No vendor deck, library or source code is redistributed. Identical deck bytes
and SHA-256 pins, full native saved-junction rows and all TS charge-stamp terms
are in its receipt. The instance-local prototype is not a production fix.
The ngspice-47 load-order comparison uses the read-only upstream reference
https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/bjt/bjtload.c
(source SHA-256 and line references in the experiment README).


## BJT post-assembly centered Newton diagnosis (#1037)

The rest reduction and nanosecond-grid control in
`packages/core/src/analysis/transient-centered-1037.fixtures.ts` are original
MIT-licensed spice-ts work, rounded-parameter extensions of the self-written
`transient-bjt-rest-1037.test.ts` reduction. No vendor material is copied.
Both engines receive identical bytes, including observational `.save` cards.
The runner, hashes, first accepted native points, full TypeScript iteration
trace and rejected-candidate receipt are in `benchmarks/bjt-centered-1037/`.
This is not a fix or a complete vendor-deck waveform oracle.

## MOS9 op-amp AC diagnosis (#1079)

[bsim3-opamp-1079](bsim3-opamp-1079/README.md) diagnoses the unchanged
corpus-m m-3 `Netlists/ACtests/bsim3/op-amp.cir` from Xyce_Regression
`7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, GPL-3.0-or-later.
Its pinned source and retained licence grant are in corpus-m/SOURCES.md;
the fixture SHA-256 is `003a743c4b7e1194f03a7f182ad3708f59e83b6138d0dee76b3d07c94d7c1bb2`.
The source URL is https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/bsim3/op-amp.cir.
The one-transistor `minimal.cir`, diagnostic script and tests are self-written
MIT project work. Native comparison values are generated measurements.
ngspice-47 source inspection uses commit
`a80f6e3e95d51534905b1f23410a951802666656` from
https://sourceforge.net/p/ngspice/ngspice/ci/a80f6e3e95d51534905b1f23410a951802666656/tree/.
ngspice's Berkeley/BSIM copyright notices and COPYING apply to the inspected
sources; no native source is copied here. The report links parser, MOS9 and
BSIM3v32 source and records their hashes. Both engines select MOS9 for
LEVEL=9, despite the upstream BSIM3 name. Same-bias controls are explicitly
diagnostic only. Public before/after uses identical original fixture bytes,
publishes all losses and keeps m-3 at 0.637; no corpus scores or tolerances change.


## corpus-m AC, diode and MOS device batch (#1045)

24 unchanged decks from Xyce_Regression at
`7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, GPL-3.0-or-later under the
retained repository README grant. Per-deck pinned upstream URLs, SHA-256,
licences, rejected candidates and selection policy are in
[corpus-m/SOURCES.md](corpus/corpus-m/SOURCES.md); licence texts are retained
under `corpus/corpus-m/licenses/xyce/`. All other corpus directories were
hash-deduplicated, including terminal-newline variants. Selection uses only
source families, static checks and unchanged ngspice-47 probe success, never
spice-ts outcomes. All results and losses are in corpus-m/outcomes.json and
README.md. No fixture adaptations, threshold tuning, core edits or aggregate refresh.

## MOS3 temperature admission (#1057)

The twelve probes in [reference.ts](results/issue-1057/reference.ts) are original
MIT-licensed spice-ts project work. Both engines receive identical bytes at
TEMP=100/-40 C, TNOM=50 C, both polarities and no/direct/sheet series resistance.
The jge and rich3 reruns read unchanged GPL-3.0-or-later Xyce_Regression bytes and provenance
from corpus-l commit `66d67caff2f10e4d6a36d2e59898cc52d661b98d`, whose
`benchmarks/corpus/corpus-l/SOURCES.md` pins upstream revision
`7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`. It does not copy or alter fixtures.
Commands, source links and before/after evidence are in
[issue-1057](results/issue-1057/README.md). No corpus tolerances or outcomes change.

## MOS3 transient diagnosis (#1059)

[issue-1059](results/issue-1059/report.md) reruns unchanged corpus-l MOS3
gm17, gm19, gm2, mike2 and contrast gm1/gm3/todd3 from Xyce_Regression
`7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, `Netlists/CircuitSim90/MOS3/`.
Source URL is https://github.com/Xyce/Xyce_Regression/tree/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3.
Original bytes come from corpus-l PR #1050 commit
`66d67caff2f10e4d6a36d2e59898cc52d661b98d`. Licence is GPL-3.0-or-later;
upstream README grant and full GPL text are retained under
`results/issue-1059/licenses/xyce/`. The two reduced gm2 decks are derived
from those model cards and retain GPL-3.0-or-later. Diagnostic scripts are
original project work. Every paired run uses identical input bytes. Separate
OP/fine-step/control variants are labelled, not used to change corpus scores.
No fixture, harness, tolerance or aggregate is changed; losses remain losses.

The [gm17 startup receipt](results/issue-1059-gm17/report.md) adds the unchanged
gm17 original and four labelled reductions from the same GPL-3.0-or-later
source and model cards. The licence notices above apply to these reductions.
It also reruns unchanged gm19/gm2/mike2/gm1/gm3/todd3/arom. Scripts are original
project work. The diagnostic ngspice patch uses ngspice-47 source revision
`a80f6e3e95d51534905b1f23410a951802666656`; its BSD-3-Clause notice is retained
in `results/issue-1059-gm17/ngspice-COPYING`. A native-only diagonal-shunt
control is explicitly not the corpus oracle and changes no production score.

[Follow-up state trace and rejected candidate](results/issue-1059-fix/report.md)
reuse these same GPL-3.0-or-later decks and additionally classify unchanged
corpus-l `arom.cir` from the same pinned source. Fine variants alter only
TMAX identically for both engines. The ngspice-47 trace is from revision
`a80f6e3e95d51534905b1f23410a951802666656`,
[CKTterr](https://sourceforge.net/p/ngspice/ngspice/ci/a80f6e3e95d51534905b1f23410a951802666656/tree/src/spicelib/analysis/cktterr.c)
and MOS3trunc/MOS3load under ngspice's Berkeley/BSD grant. The retained
instrumentation diff adds project-authored logging only; no whole ngspice
source is copied. Traces, numerical receipts and opt-in experiments are
diagnostic evidence, not a shipped device change or an accuracy claim.

## #812 ngbehavior option and #828 negative sqrt

The self-decks generated by `results/issue-812-ngbehavior/verify.ts` are original
spice-ts project work under the repository MIT licence. Context:
https://github.com/mfiumara/spice-ts/issues/812. Both engines receive identical
bytes through the existing comparison harness. The retained 695/828 receipts
use unchanged hash-pinned decks under the existing ngspice-bugs provenance below.
ngspice-47 source is cited, not redistributed. The report preserves the 695
savecurrents gap and 828 domain rejections; neither is scored as numerical parity.


## #1049 weak-node OP root cause

The one-source `results/issue-1049/shunt-control.cir` and generic two-diode
`weak-diode.cir` are original MIT-licensed spice-ts project work, not copied
vendor models. Source context: https://github.com/mfiumara/spice-ts/issues/1049.
The numeric/hash-only rootcause receipt uses the unchanged fetch-only #737
archive and deck pins under the existing ngspice-bugs provenance below.
No vendor bytes are redistributed. The official ngspice-47 source archive
(https://downloads.sourceforge.net/project/ngspice/ng-spice-rework/47/ngspice-47.tar.gz,
SHA256 `894e649651f1838a14095e5a5439e7d3aa63e87ede14d283173fda4fcdef675f`)
is inspected and cited, not copied into the repository. See
[ROOTCAUSE.md](results/issue-1049/ROOTCAUSE.md) for identical-byte comparisons,
the native option-narrowing evidence and the unchanged original benchmark loss.

## Explicit junction GMIN regression (#1068)

The diode/BJT/MOS1/MOS6/JFET/HFET1 probes in [results/issue-1068](results/issue-1068/README.md)
are original spice-ts project work under the repository MIT licence, not vendor
models. Source context: https://github.com/mfiumara/spice-ts/issues/1068.
Both simulators receive identical bytes. The scoped comparison also reruns the
unchanged CC0 convergence fixtures and existing GPL-3.0-or-later Xyce corpus-g /
xyce fixtures under their provenance below. It retains native failures and
per-signal regressions. No benchmark input, tolerance, outcome or pin is edited.


## SINE after DC/AC expressions (#994)

The minimal V/I source probes in `reference/xyce.test.ts` and
[sine-expressions-994.md](reference/investigations/974/sine-expressions-994.md)
are original spice-ts project work under the repository MIT licence, not
third-party decks. Source: https://github.com/mfiumara/spice-ts/issues/994.
ngspice-47 and Xyce 7.10 receive identical source values; only the native
SINE/SIN alias and output cards differ. Native-grid extrema are reported,
including the pre-fix flat-output loss. No corpus tolerance is changed.

## MAXORD order-cap regression (#983)

[maxord-983](reference/maxord-983/README.md) reruns unchanged corpus-k k-13
`Netlists/CircuitSim90/MOS2/pump.cir` at Xyce_Regression revision
`7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2` (GPL-3.0-or-later, existing
corpus-k licence/provenance below). The four RC method/order probes in
`reference/maxord-983/run.ts` are original MIT-licensed spice-ts project work.
Both engines receive identical bytes per case. This scoped receipt publishes
the residual pump mismatch; no fixture, corpus outcome or tolerance is changed.

## Repeated dot-card semantics (#1009)

[repeated-dot-1009](repeated-dot-1009/README.md) reruns five unchanged corpus-e /
corpus-e-spice3 Gnucap regression decks with their existing GPL-3.0-or-later
provenance below. The synthetic interleaved order and native execution probes
are original MIT-licensed spice-ts project work. This is an evidence-only
investigation, not a corpus or comparison-tolerance change.

## MOS2 temperature admission (#995)

The 18 synthetic NMOS/PMOS temperature probes in [reference.ts](results/issue-995/reference.ts)
are original spice-ts project work, MIT-licensed, not copied vendor decks. Recorded OP and
short-transient references use ngspice-47 on identical decks at TEMP=27/50/125 C with model
TNOM=50 C, no/direct/sheet series resistance and junction capacitances.
The unchanged gm6 input uses the corpus-k k-8 source and GPL-3.0-or-later licence below.
Its scoped before/after results and raw temperature probe are in [issue-995](results/issue-995/README.md).
No fixture, comparison tolerance, corpus outcome or aggregate was changed.

## corpus-k CMOS/textbook/oscillator batch (#980)

20 novel original Xyce_Regression decks at `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, SPDX `GPL-3.0-or-later`. Redistribution basis is the repository README GPLv3-or-later grant. Notice and full GPL text are retained in corpus-k/licenses/xyce. All selected files have no separate copyright/licence notice and no external dependencies. Per-file bytes/hashes/include closures are in [manifest.json](corpus/corpus-k/manifest.json), selection and exclusions in [SOURCES.md](corpus/corpus-k/SOURCES.md). No fixture adaptation or engine-success filter. 19 ngspice-47 successes; 5 matches, 14 spice-ts losses, 1 both-engine failure. All results are in [README.md](corpus/corpus-k/README.md) and outcomes.json; gaps #982 and #983. No aggregate refresh.

Fresh ngspice SourceForge survey at `36fb6f51ff125f19ea8b36bda6ebe47dcc87a263` contributes zero decks: all 509 candidates are duplicate/static exclusions. Analog Devices, Symmetry Design and David Zan notices are not assumed covered by repository BSD. Xyce survey has 4,133 candidates, 20 selected, 4,113 duplicate/static/batch-deferred exclusions. Deferred candidates are not engine failures or licence rejections.

Every row below is GPL-3.0-or-later, under the same retained Xyce README grant. URLs resolve relative to the [pinned source tree](https://github.com/Xyce/Xyce_Regression/tree/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2); exact per-file source URLs are in the manifest.

| ID | Original upstream path | Licence / redistribution basis |
|---|---|---|
| k-1 | Netlists/ACtests/mos/opamp-ol.cir | GPL-3.0-or-later; Xyce README grant |
| k-2 | Netlists/CircuitSim90/MOS2/ab_ac.cir | GPL-3.0-or-later; Xyce README grant |
| k-3 | Netlists/CircuitSim90/MOS2/ab_integ.cir | GPL-3.0-or-later; Xyce README grant |
| k-4 | Netlists/CircuitSim90/MOS2/ab_opamp.cir | GPL-3.0-or-later; Xyce README grant |
| k-5 | Netlists/CircuitSim90/MOS2/cram.cir | GPL-3.0-or-later; Xyce README grant |
| k-6 | Netlists/CircuitSim90/MOS2/e1480.cir | GPL-3.0-or-later; Xyce README grant |
| k-7 | Netlists/CircuitSim90/MOS2/g1310.cir | GPL-3.0-or-later; Xyce README grant |
| k-8 | Netlists/CircuitSim90/MOS2/gm6.cir | GPL-3.0-or-later; Xyce README grant |
| k-9 | Netlists/CircuitSim90/MOS2/hussamp.cir | GPL-3.0-or-later; Xyce README grant |
| k-10 | Netlists/CircuitSim90/MOS2/mosrect.cir | GPL-3.0-or-later; Xyce README grant |
| k-11 | Netlists/CircuitSim90/MOS2/mux8.cir | GPL-3.0-or-later; Xyce README grant |
| k-12 | Netlists/CircuitSim90/MOS2/nand.cir | GPL-3.0-or-later; Xyce README grant |
| k-13 | Netlists/CircuitSim90/MOS2/pump.cir | GPL-3.0-or-later; Xyce README grant |
| k-14 | Netlists/CircuitSim90/MOS2/reg0.cir | GPL-3.0-or-later; Xyce README grant |
| k-15 | Netlists/CircuitSim90/MOS2/ring.cir | GPL-3.0-or-later; Xyce README grant |
| k-16 | Netlists/CircuitSim90/MOS2/schmitfast.cir | GPL-3.0-or-later; Xyce README grant |
| k-17 | Netlists/CircuitSim90/MOS2/schmitslow.cir | GPL-3.0-or-later; Xyce README grant |
| k-18 | Netlists/CircuitSim90/MOS2/slowlatch.cir | GPL-3.0-or-later; Xyce README grant |
| k-19 | Netlists/CircuitSim90/MOS2/toronto.cir | GPL-3.0-or-later; Xyce README grant |
| k-20 | Netlists/WAMPDE/HARTLEY/hartley.cir | GPL-3.0-or-later; Xyce README grant |

This file records the provenance and redistribution decision for benchmark fixtures.
The machine-readable catalogue is `benchmarks/corpus/ngspice/manifest.json`.

## EKV 2.6 static DC implementation evidence (#4)

- Equation reference: EPFL, *The EPFL-EKV MOSFET Model Equations for Simulation*,
  model version 2.6, revisions I/II and March 1999 corrections:
  https://ngspice.sourceforge.io/external-documents/models/ekv_v262.pdf.
  The report is cited, not redistributed. The MIT TypeScript implementation is
  independently written from equations; no GPL device source is copied into it.
- Behavioral reference: Xyce 7.10.0 at
  `a592a42ae7472151d1c8e3bca0ca62d27476f2f3`. The generated C++ device/registration
  `src/DeviceModelPKG/ADMS/N_DEV_ADMSekv_va.C` has GPL-3.0-or-later headers.
  Its original `utils/ADMS/examples/EKV/ekv-2.6/ekv26_SDext_Verilog-A.va`
  carries ECL-2.0 and a legacy restrictive notice; no redistribution of that
  source is attempted. These are behavioral references, not copied code:
  https://github.com/Xyce/Xyce/tree/a592a42ae7472151d1c8e3bca0ca62d27476f2f3/utils/ADMS/examples/EKV/ekv-2.6.
  Used to check defaults, revision-III smoothing and LEVEL=260 (no aliases).
  Source is not redistributed in this change.
- Fixtures reuse the three existing GPL-3.0-or-later hash-pinned upstream decks
  recorded below plus the corpus-g EKV inverter (same source bytes, explicitly
  a repeated fixture rather than a fourth novel circuit). No new third-party
  deck or licence claim. Both spice-ts and Xyce receive identical output-adapted
  deck bytes in `benchmarks/reference/ekv-static/compare.ts`; original source
  hashes and all output adaptations are retained. ngspice uses the terminated
  source deck and is labelled `ngspice-lacks-model (MOS1 fallback)`.
- `before-identical.json.gz` and `after-identical.json.gz` retain waveforms,
  native tool output, warnings, hashes and all outcomes. `metrics.md` includes
  all signals, six ascending/descending DC sweeps each and transient residuals.
  No per-circuit tuning, no full EKV/AC/transient parity or speed claim.

## BSIM4 implementation source (#3), static OP/DC subset

The #1367 quasi-static capMod=2 extension uses the same pinned ECL-2.0 source
below: b4ld.c:3339-3913 (intrinsic CTM), 4149-4177 (overlap/fringe),
3947-4128 (junction charge), and the corresponding b4temp.c charge preprocessing.
The original inverter in `bsim4/charge.test.ts` is project-authored (repository
licence); `inverter-reference.json` is actual ngspice-47 output consumed by that
test, not an upstream circuit. The corpus-g FD fixture is unchanged and retains
its existing source/licence/hash provenance. Dynamic residuals are reported in #1367.

The RGATEMOD=3 OP/DC/AC common-source decks in
`packages/core/src/devices/bsim4/__fixtures__/rgatemod3/` are original
project-authored MIT probes, not copied third-party circuits. The committed
`generate.py` runs identical decks with ngspice-47, adding output controls only,
and records netlist SHA-256 hashes plus OP/DC/complex AC samples in `ngspice-47.json`.

The four `rgatemod3/transient-{nmos,pmos}-{forward,reverse}.cir` decks (#1707)
are likewise original project-authored MIT probes. `generate-transient.py`, run
through `spice-heavy`, executes identical committed deck bytes with ngspice-47
and records SHA-256 hashes, native point counts and 201 interpolated samples of
v(out)/i(vdd) per deck. Hashes are additionally frozen in
`gate-resistance3-transient.test.ts`. There are no solver/tolerance overrides.
The test's 1%-of-peak bounds compare matched default trapezoidal waveforms;
LOAD.md reports max/RMS errors and the unsuccessful optional cross-method
BE/Gear-2 comparison rather than claiming parity for that experiment.
Model equations/topology follow ngspice BSIM4 `b4ld.c`, `b4acld.c`, `b4set.c`, `b4temp.c`
(https://github.com/ngspice/ngspice/tree/master/src/spicelib/devices/bsim4),
with the existing ECL-2.0 port notices retained. No per-circuit tolerance tuning.
Transient remains explicitly unsupported for mode 3.

The RGATEMOD=2 OP/DC/AC common-source decks in
`packages/core/src/devices/bsim4/__fixtures__/rgatemod2/` are project-authored
under the repository MIT licence. Their committed `generate.py` runs identical
decks with ngspice-47 (only output controls added), recording SHA-256 hashes and
native OP/DC/complex AC samples in `ngspice-47.json`. The gcrg equations are
ported from b4ld.c:2191-2225 at the pinned ngspice revision below, under the
same ECL-2.0 licence and retained notices. No per-circuit tolerance tuning.

The RGATEMOD=2 `transient.cir` common-source deck in the same directory is
project-authored under the repository MIT licence. `generate-transient.py`
runs its identical bytes with ngspice-47 (`SPICE_ASCIIRAWFILE=1`, `-b -r`),
without adding control commands or changing solver options. It records the
deck SHA-256, native point count and 201 shared-grid v(out)/i(vdd) samples in
`transient-ngspice-47.json`, consumed by `gate-resistance2-transient.test.ts`
with the standard 1%-of-peak bound. This is a single-fixture parity check,
not corpus-wide parity or speed evidence.

The RBODYMOD=1, capMod=2 common-source transient deck at
`packages/core/src/devices/bsim4/__fixtures__/rbodymod1/transient.cir` is
project-authored under the repository MIT licence. `generate-transient.py`
runs identical bytes with ngspice-47 (`SPICE_ASCIIRAWFILE=1`, `-b -r`),
without solver-option changes. Its hash-pinned `transient-ngspice-47.json`
stores 201 shared-grid v(out)/i(vdd) samples from 223 native points, consumed
by `body-resistance-transient.test.ts` at the issue's 1e-3 peak-normalized
maximum-error bound. The adapter follows the same pinned ECL-2.0 b4ld.c
body-junction charge separation/integration/stamping and b4trunc.c qbd/qbs
LTE handling. This is one fixture, not corpus-wide parity or speed evidence.

The RGATEMOD=1 gate-RC transient deck at
`packages/core/src/devices/bsim4/__fixtures__/rgatemod1/transient.cir` is
project-authored under the repository MIT licence, not copied from upstream.
Its source is this repository's fixture; `generate-transient.py` runs the identical
deck with ngspice-47 (only output-control commands are added) and records its
SHA-256 and native samples in `transient-ngspice-47.json`, consumed by
`gate-resistance-transient.test.ts`. No per-circuit solver or tolerance tuning.

| Port destination / upstream subset | Pinned upstream revision | Licence / notices |
| --- | --- | --- |
| `packages/core/src/devices/bsim4/` and `bsim4-junction.ts`: full ordered model defaults/instance setup from `src/spicelib/devices/bsim4/b4set.c`, baseline silicon size/binning/TEMPMOD=0 preprocessing from `b4temp.c`, GEOMOD=0 junction geometry from `b4geo.c:28-88`, relevant DC fatal checks and rejection of unported PARAMCHK correction domains from `b4check.c`, DIOMOD=1 junction currents and channel Ids/gm/gds/gmbs including substrate current from `b4ld.c:1004-2189,5413-5431`. Registered LEVEL=14/54 static subset, not full BSIM4 or dynamic support. Detailed inventories in SETUP.md, TEMPERATURE.md and LOAD.md. | [ngspice-47 bsim4/](https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4), SHA `a80f6e3e95d51534905b1f23410a951802666656` | ECL-2.0, Copyright (c) 2025 University of California. Original per-file notices retained in generated ports and `NOTICE-BSIM4.txt`, with a TypeScript modification notice. Full licence in `packages/core/src/devices/bsim4/LICENSE-ECL-2.0`, obtained from [SPDX licence text](https://github.com/spdx/license-list-data/blob/main/text/ECL-2.0.txt). The per-file ECL notice overrides ngspice's project-level BSD default for these files. |

The channel kernel embeds the full ECL-2.0 licence and upstream notice contents
in a bundler-preserved legal comment. Package licence metadata and npm publication
remain owner-gated and unchanged. Targeted oracle tests are not corpus-wide
parity or speed evidence. This extends the existing single provenance row;
it does not relabel these files BSD-3-Clause or add a duplicate source entry.

PR999 PARAMCHK correction-domain regression probes in
`benchmarks/bsim4-validation-3/paramchk-native.py` are original MIT project-authored
netlists, reproducing the review at
https://github.com/mfiumara/spice-ts/pull/999#pullrequestreview-5512569635.
No new third-party source is copied. Both engines receive identical recorded
deck bytes. Scalar references and before/after errors retain the unsupported
correction domains and the supported-domain global-gmin current residual;
these probes are not corpus expansion or speed evidence. Native semantics are
the same pinned ECL-2.0 `b4check.c:797-806` source recorded above.

## Title-continuation regression probes (#957 / PR #976)

- Source: original project-authored minimal netlists in `benchmarks/title-directive/continuations.ts`, MIT (repository `LICENSE`), reproducing https://github.com/mfiumara/spice-ts/pull/976#pullrequestreview-5511583515. No third-party fixture or source code is redistributed.
- Both engines receive identical bytes. `continuations-before.json` and `continuations-after.json` retain input SHA-256, native ngspice-47 output/exit codes and spice-ts results, including the previous input loss and hidden parameter error. These are semantic regression probes, not novel public-corpus fixtures or speed evidence.
- Reference semantics: https://github.com/imr/ngspice/blob/ngspice-47/src/frontend/inpcom.c lines 1442-1456 turn `.title` into a comment before continuation stitching at 1958; lines 694-702 preserve the preceding card across comments.
- `benchmarks/title-directive/x-continuations.ts` adds original MIT numeric/bare/braced/quoted X RHS probes at top-level and nested scope. `x-continuations-{before,after}.json` retain same-byte hashes and raw ngspice-47 output (R=2000 ohms, i(v1)=-5e-4 A). Before is the uncommitted PR955/main merge; after includes the metadata-skip scanner fix. No corpus or speed claim.

## Controlled E/G TABLE probes (#917)

- `packages/core/src/parser/controlled-table-1737.cir` is an original project-authored MIT fixture (repository `LICENSE`), public source https://github.com/spicets/spice-ts/blob/main/packages/core/src/parser/controlled-table-1737.cir. It exercises both E/G sources in OP, 161-point DC, AC and ramp transient on identical bytes against ngspice-47. The test `controlled-table-1737.test.ts` checks quadratic smoothing and clamped endpoints; the implementation PR linked from issue #1737 publishes direct reference errors (including transient interpolation loss). No third-party deck is redistributed.

- `benchmarks/controlled-table-917/{e,g-subckt,ac}.cir` are original project-authored MIT netlists (repository `LICENSE`), not vendor extracts. Issue https://github.com/mfiumara/spice-ts/issues/917. Both engines receive identical bytes, with ngspice-47 `ngbehavior=ltps`; all 81 DC rows retain endpoint clamping and smoothed corners, and the one-row AC probe verifies the smoothed derivative. Receipts publish native values and max/RMS errors where available, and unsupported/failed outcomes with null metrics otherwise.
- `vendor.py` reuses the fetch-only pinned attachment/hash/path-relocation policy of `benchmarks/vendor-expanded-node-917/run.py` for https://sourceforge.net/p/ngspice/bugs/784/. No vendor deck, model, expanded expression or raw log is redistributed. New before/after scalar receipts preserve identical relocated bytes and include hashes; both native runs remain non-completing while ngspice completes 141 AC rows per original. Existing #939 receipts are unchanged.


## X-call RHS continuation remediation (#797 / PR955)

- `benchmarks/comma-numparam-fix-797/rhs-continuation/*.cir` are original project-authored OP probes, MIT (repository `LICENSE`), for https://github.com/mfiumara/spice-ts/issues/797 and https://github.com/mfiumara/spice-ts/pull/955. No third-party decks are copied.
- `run.py before` / `run.py after`, under `spice-heavy`, retain same-byte SHA-256 hashes, ngspice-47 raw OP data, native values/errors and fixed shared-node error metrics. The after phase also reruns all 20 unchanged legacy inputs with their existing provenance. Earlier receipts are immutable; no speed claim or per-circuit settings.


## Xyce second-reference bootstrap (#948)

- `benchmarks/reference/ekv/fixtures/*.cir` are byte-identical copies of the three
  `Netlists/EKV26` decks at Xyce_Regression revision
  `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`.
  Source: https://github.com/Xyce/Xyce_Regression/tree/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/EKV26.
- Licence: GPL-3.0-or-later. Upstream notice and full licence are retained in
  `benchmarks/corpus/xyce/LICENSE-NOTICE.md` and `benchmarks/corpus/xyce/COPYING.txt`.
  Hashes and the redistribution decision are recorded in
  `benchmarks/reference/ekv/manifest.json` and `benchmarks/REFERENCES.md`.
- Runtime-only adaptations are corpus-wide and recorded per fixture: missing
  `.end` is appended for both engines; Xyce output cards are replaced by CSV
  probes. Circuit/model values, including LEVEL=260, are never downgraded.
  Engine input bytes therefore differ at output cards, explicitly disclosed in
  reports. The 100-fixture cross-check uses the existing five aggregate corpora
  unchanged, retains every failure and does not refresh the aggregate ledger.
- LEVEL=260 is EKV 2.6 in this upstream suite. spice-ts/ngspice MOS1 fallback
  results are losses against EKV, not EKV parity. No simulator superiority claim.

## Xyce bare BJT assignment syntax (#990)

The Xyce-only reference adapter now rewrites bare numeric `name value` pairs
on NPN/PNP `.model` cards to explicit assignments, with ngspice BJT aliases
canonicalised (for example `va 50` becomes `VAF=50`). Values and numeric suffixes
are retained, not evaluated or tuned. Explicit assignments, non-BJT models,
and ngspice-47 headline inputs remain unchanged. Bare expression/symbol values
are reported as unsupported rather than guessed. Every rewrite is recorded in
the adapter's changes list. This supersedes the output-only rule above for new
Xyce BJT runs, not for the preserved historical #948 receipts.

`benchmarks/reference/investigations/990/` contains a separate RCA3040 AC
before/after reference receipt and runner. The source is the existing licensed
classic RCA3040 fixture (same source/licence as the classic corpus entry below).
No new upstream deck or model is imported. Project-authored runner/test/report
code is MIT; the generated Xyce deck retains the original fixture's licence.
The historical #948 decks, outputs, losses and source hashes remain unchanged;
their tests pin the historical adapter hash instead of asserting it is today's
adapter. See the [reference report](reference/investigations/990/README.md) for
commands, original input hashes and the remaining ngspice/Xyce model residual.
No aggregate refresh, solver tolerance change, perfect-parity or speed claim.

## corpus-j partial novel source survey (#940)

Continuation: the catalogue now contains 20 fixtures; the 11-row historical receipt below remains unchanged. Nine further verbatim source/input hashes, five with ngspice-47 raw output, are registered in [corpus-j/SOURCES.md Part 2](corpus/corpus-j/SOURCES.md#part-2-nine-further-original-inputs), [manifest.json](corpus/corpus-j/manifest.json), and [PART2.md](corpus/corpus-j/PART2.md). Exact pinned paths/licences/empty include closures:

| Original paths | Repository / revision | SPDX | Include closure |
|---|---|---|---|
| `examples/measure/rc-meas-ac-control.sp`; `examples/p-to-n-examples/aswitch-pswitch.cir`; `examples/mos/nmos_pmos_BSIM330.sp`; `examples/xspice/original-examples/xspice.deck` | https://sourceforge.net/p/ngspice/ngspice at `a80f6e3e95d51534905b1f23410a951802666656` | BSD-3-Clause | empty per fixture |
| `examples/testfiles/test_kicad_nets.cir`; `examples/testfiles/ac_rawtest.net`; `examples/testfiles/ngsteps.net`; `examples/testfiles/sens_ngspice_rawtest.net`; `examples/testfiles/tran_rawtest.net` | https://github.com/nunobrum/spicelib at `d8f8ecceeb361741f1f660f03b03ac49697f8700` | GPL-3.0-only | empty per fixture |

The current ngspice COPYING explicitly covers examples/tests outside listed exceptions; all selected paths qualify. Complete original notices retained in corpus-j `licenses/ngspice-current/COPYING` (document CC-BY-SA-4.0) and `licenses/spicelib/LICENSE`. No vendor libraries, golden output variants or byte adaptation. Exact and terminal-newline-stripped input hashes are deduped against all corpus fixture directories. Existing source topologies are not counted as new topology families. Both engines receive original bytes; control vectors use unchanged corpus-f source/write collection (first plot/type only, deferred exit), fixed shared metrics, serial <=20s engine groups and <=900s cumulative wall including the historical ledger. Published new outcomes: 3 matched, 2 spice-ts-only losses ([#956](https://github.com/mfiumara/spice-ts/issues/956), [#957](https://github.com/mfiumara/spice-ts/issues/957)), 4 both-failed. No speed claim or daytime aggregate refresh; nightly #855 owns incorporation.

- 11 novel verbatim SpiceSharpParser inputs, not the requested 20: https://github.com/SpiceSharp/SpiceSharpParser at `8fc01560fe303eeebaeb5cbf5edfe77bf635e1c7`, SPDX `MIT`. Original paths, revision URLs, byte hashes and empty include closures are recorded per fixture in [corpus-j/SOURCES.md](corpus/corpus-j/SOURCES.md) and [manifest.json](corpus/corpus-j/manifest.json). Original MIT copyright/licence retained byte-identically under `licenses/spicesharpparser/LICENSE`.
- Original paths at that revision: `circuits/a-devices/{clock-divider,controlled-clamp-varistor,edge-capture-dff,fm-modulator,non-ground-common-latch,ota-current-limiter,phase-detector,sample-and-hold-sensor}.cir`; `circuits/cookbook/custom-components/simple-pll/simple-pll.cir`; `src/SpiceSharpParser.IntegrationTests/Examples/Circuits/{band-pass_1,band-pass_2}.cir`. Every fixture is standalone (include closure empty), no vendor model redistribution. These are existing original upstream decks, never generated derivatives.
- eSim survey only: https://github.com/FOSSEE/eSim at `1a25a46ce15e0ccc35296dd513f40249c089a5a7`, `GPL-3.0-only`; licence retained in corpus-j. All 65 explicitly surveyed paths were duplicate/no-analysis/include-dependent; no eSim deck, PDK or vendor companion is committed. PWL-file sources are also excluded. Exact inspected exclusions and input hashes are retained in the manifest.
- Both engines receive unchanged bytes through existing corpus-f runners, with a scoped serial 19 s execution deadline/20 s owned process-group bound and <=900 s persisted cumulative child-wall budget. No source-success filtering or per-circuit tolerance tuning. Published losses: all 11 both-failed; ngspice 8 failed/3 unsupported, spice-ts 11 unsupported. Nine cross-dialect LTspice A-device inputs and two `mc()` filters have no ngspice reference. Empty/null waveform metrics are unavailable, never zero errors. This is a partial survey receipt, not expanded measured parity or a speed win. No daytime aggregate refresh; nightly #855 owns incorporation.


## B-source finite-Jacobian overflow probes (#899)

- Source: original project-authored netlists in `benchmarks/bsource-overflow-899/compare.ts`, MIT (repository `LICENSE`); https://github.com/mfiumara/spice-ts/issues/899. No third-party circuit or source code is redistributed.
- Both engines receive identical deck bytes without parameter or tolerance tuning. `before.json` / `after.json` retain SHA-256, statuses, signed infinite outputs, finite outputs and single-run timings. Generated decks and raw ngspice logs can be reproduced with `spice-heavy pnpm exec tsx benchmarks/bsource-overflow-899/compare.ts`.
- Scope is five small OP probes, not a corpus-wide performance or accuracy claim. Infinite outputs are compared by sign; RMS/relative errors involving infinity are undefined. The conflicting-source probe remains a failure in both engines.

## Subcircuit model-expression probes (#882)

- `benchmarks/subckt-model-expressions-882/{784,738}.cir` are self-written minimal diode/parameter probes, MIT (repository LICENSE), reducing the syntax reported in https://github.com/mfiumara/spice-ts/issues/882. They are not vendor model copies and are not replacements for corpus fixtures.
- `compare.ts` sends identical bytes to spice-ts and ngspice-47 and records input hashes, runtime and max/RMS errors. No circuit-specific tolerance or solver settings. The residual diode OP voltage difference is published rather than hidden by an accuracy gate.
- `vendor.mts` reruns the unchanged attachments of https://sourceforge.net/p/ngspice/bugs/784/ and https://sourceforge.net/p/ngspice/bugs/738/, fetched/hash-verified by `benchmarks/corpus/ngspice-bugs/fetch.ts`; the only deck edit is Windows include-path relocation. Existing attachment licence/redistribution restrictions remain in the ticket READMEs and manifest. Vendor libraries are not committed. Receipts explicitly retain downstream unsupported outcomes and null waveform metrics.


## Rust sparse LU spike (#802)

- Source: matrices generated at run time by `benchmarks/rust-lu-spike/dump-matrices.ts` from the project-authored M2 scaling decks (`benchmarks/performance/scaling-m2-fixture.mjs`, MIT). Generated `.mtx` files are gitignored, not redistributed.
- The Rust crate under `rust/` is an original port of spice-ts' own solver (MIT). No KLU/SuiteSparse code is used. SciPy (BSD) is an optional local reference for `fill-reference.py` only.
- ngspice-47 receives the identical OP decks; commands, versions and raw samples are in `benchmarks/rust-lu-spike/results/*.json`.

## Global-node semantic probes (#502)

- Source: original resistor-divider netlists authored in `benchmarks/global-nodes/compare.ts` in this repository (MIT, see `LICENSE`). No third-party fixture is copied or adapted.
- Coverage: nested global supplies, global/formal-port collisions (including an unused actual port), mixed-case references, and global declarations in reachable versus unused subcircuit definitions.
- Both engines receive identical bytes. `pnpm build && pnpm exec tsx benchmarks/global-nodes/compare.ts` writes every input, its SHA-256, both engines' OP vectors, timings and all signal errors to `benchmarks/global-nodes/report.json`. A uniform 1e-12 absolute-error check applies to these linear OP probes; it does not change any corpus threshold.
- The four unchanged corpus-f measurement decks retain their existing BSD-3-Clause provenance in `benchmarks/corpus/corpus-f/SOURCES.md`. Their before/after failures are not replaced by these smaller probes or counted as parity wins.

## Control-language regression probes (#488 / #584)

- `benchmarks/control-language-488/{probes,invalid-probes,idempotence}.cir` are original spice-ts regression decks, distributed under the repository MIT licence.
- Semantics are measured against ngspice-47 with byte-identical input. Commands, raw output and SHA-256 hashes are in the adjacent `before.json` and `after.json`; `compare.ts` reproduces the measurements.
- The three corpus-f fixtures rerun by that script are unchanged upstream ngspice decks (BSD-3-Clause), with pinned URLs, hashes and licence evidence in `benchmarks/corpus/corpus-f/SOURCES.md`. No new third-party fixtures are copied.

## ngspice-47 option probes (#494)

`benchmarks/options-494/{ramptime,bypass}.cir` are project-authored MIT fixtures for
[issue #494](https://github.com/mfiumara/spice-ts/issues/494). They test the release-build
RAMPTIME breakpoint with ordinary V/I sources and a held transient initial condition,
and a nonlinear diode sweep with BYPASS requested. Both engines receive identical
bytes; no per-circuit tolerance overrides. `benchmarks/options-494/compare.ts` records
SHA-256, versions, machine, max/RMS errors and single-run timings in `report.json`.
`corpus-f-rerun-outcomes.json` is a run receipt over the unchanged corpus-f fixtures,
kept as evidence only; the committed corpus-f outcomes are not regenerated by this patch.
The affected corpus-f decks retain their existing upstream BSD-3-Clause provenance
and are not edited. No ngspice source is redistributed by this option patch.

## BSIM3 reverse-mode and SRAM diagnostics (#582)

- Sources: project-authored `benchmarks/circuits/analog-blocks.ts` (the unchanged `sramCellTransient()` deck and its model cards), `benchmarks/circuits/bsim3-validation.ts` (unchanged PMOS Id-Vgs and NMOS Id-Vds generators), and minimal orientation/off-state probes in `benchmarks/bsim3-reverse/compare.ts`.
- Canonical repository: https://github.com/mfiumara/spice-ts; SRAM reproduction: https://github.com/mfiumara/spice-ts/issues/582.
- Licence: MIT, the repository licence. These are synthetic project fixtures, not foundry or vendor model cards; redistribution is allowed.
- Both engines receive identical netlist bytes. Receipts include input SHA-256, tool versions, environment, runtime, and matched-point absolute/relative errors. No circuit-specific tolerance or parameter tuning is applied. Known losses remain, documented in `benchmarks/bsim3-reverse/README.md` and issue #589.

## ngspice public corpus A

- Repository: https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/
- Pinned revision: `3ef069fb1f04177a153f342a32d941fc20ff047e`
- Licence: Modified BSD (`BSD-3-Clause`); upstream `COPYING` explicitly applies it to test and example files except listed exception paths.
- Licence source: https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/COPYING
- Redistribution decision: allowed for these paths; none is from an exception path.
- Adaptation: only the terminal newline is omitted during ingestion. Circuit content and internal line endings remain unchanged; no values or tolerances are changed.

| ID | Category | Canonical source | Revision | Licence | Redistribution | Local path | Adaptation |
|---|---|---|---|---|---|---|---|
| `vbic-fo` | op-dc | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/vbic/FO.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/vbic/FO.cir` | terminal newline omitted |
| `vbic-temperature` | op-dc | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/vbic/temp.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/vbic/temp.cir` | terminal newline omitted |
| `mos6-inverter-transient` | tran | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/mos6/mos6inv.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/mos6/mos6inv.cir` | terminal newline omitted |
| `jfet-vds-vgs` | op-dc | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/jfet/jfet_vds-vgs.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/jfet/jfet_vds-vgs.cir` | terminal newline omitted |
| `rc-lowpass-ac` | ac | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/filters/lowpass.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/filters/lowpass.cir` | terminal newline omitted |
| `ac-zero-frequency` | ac | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/regression/misc/ac-zero.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/regression/misc/ac-zero.cir` | terminal newline omitted |
| `vbic-common-emitter-ac` | ac | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/vbic/CEamp.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/vbic/CEamp.cir` | terminal newline omitted |
| `probe-ac` | ac | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/probe/ac-test.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/examples/probe/ac-test.cir` | terminal newline omitted |
| `rc-transient` | tran | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/general/rc.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/general/rc.cir` | terminal newline omitted |
| `mos-amplifier-transient` | tran | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/general/mosamp.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/general/mosamp.cir` | terminal newline omitted |
| `mos6-simple-inverter-transient` | tran | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/mos6/simpleinv.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/mos6/simpleinv.cir` | terminal newline omitted |
| `ltra-line-transient` | tran | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/transmission/ltra1_1_line.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/transmission/ltra1_1_line.cir` | terminal newline omitted |
| `hfet-inverter` | nonlinear | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/hfet/inverter.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/hfet/inverter.cir` | terminal newline omitted |
| `mesa-oscillator` | nonlinear | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/mesa/mesosc.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/mesa/mesosc.cir` | terminal newline omitted |
| `jimi-fuzz` | nonlinear | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/wave/jimi_fuzz.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/examples/wave/jimi_fuzz.cir` | terminal newline omitted |
| `schmitt-trigger` | nonlinear | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/general/schmitt.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/tests/general/schmitt.cir` | terminal newline omitted |
| `inductive-positive-definite-2x2` | convergence | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/inductive-systems/positive-definite-1.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/examples/inductive-systems/positive-definite-1.cir` | terminal newline omitted |
| `inductive-positive-definite-3x3` | convergence | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/inductive-systems/positive-definite-2.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/examples/inductive-systems/positive-definite-2.cir` | terminal newline omitted |
| `inductive-positive-definite-4x4` | convergence | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/inductive-systems/positive-definite-3.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/examples/inductive-systems/positive-definite-3.cir` | terminal newline omitted |
| `inductive-positive-definite-ac` | convergence | [upstream](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/inductive-systems/positive-definite-4.cir) | `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause | committed | `benchmarks/corpus/ngspice/fixtures/examples/inductive-systems/positive-definite-4.cir` | terminal newline omitted |

Validate provenance, hashes, ngspice execution, and spice-ts parsing with:

    pnpm build
    node benchmarks/corpus/ngspice/validate.mjs

The validator prints every currently unsupported or failing circuit; unsupported cases are not omitted from the corpus.

## Berkeley SPICE3f5 classic corpus B

- Repository mirror: https://github.com/obernin/spice
- Pinned revision: `3d9360bef370b432e473edb0c4333707d545a55f`
- Authoritative distribution: https://ptolemy.berkeley.edu/projects/embedded/pubs/downloads/spice/spice3f5.tar.gz
- Authoritative release: Berkeley SPICE3f5; archive SHA-256 `cac11fe2a761241e6b6c9eaa31b938c7ffa76aeaecac09809609d3a4125cd269`.
- Licence and notice: Berkeley's [`spice3f5/COPYRIGHT`](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/COPYRIGHT) grants permission to use, copy, modify, and distribute SPICE and requires its Regents copyright notice and two warranty paragraphs in all copies. The byte-identical notice is retained at `benchmarks/corpus/classic/COPYRIGHT.txt` (SHA-256 `6dbad063070d502230501ddb05aced2e896eb636939c09b626d11c3e00b9aed4`). That hash matches both `spice3f5/COPYRIGHT` in the authoritative archive and `COPYRIGHT` at the pinned mirror revision.
- Mirror notice: the mirror maintainer's separate 2018 BSD-3-Clause notice is retained verbatim at `benchmarks/corpus/classic/LICENSE.txt`; it is not represented as the provenance or redistribution basis for the Berkeley-authored fixtures.
- Redistribution decision: allowed by the Berkeley SPICE grant, with its required notice retained alongside the fixtures.
- Adaptation: none. All 20 `.cir` files are committed byte-for-byte from the pinned mirror. The validator runs the identical files in both engines; `-r output.raw` only asks ngspice to export its result and does not alter a netlist.

| ID | Category | Canonical source | Revision | Licence | Redistribution | Local path | Adaptation |
|---|---|---|---|---|---|---|---|
| `bjt-noise` | noise | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/bjtnoise.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/bjtnoise.cir` | none |
| `bsim1-device-sweep` | device-characterization | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/bsim1tst.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/bsim1tst.cir` | none |
| `bsim2-device-sweep` | device-characterization | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/bsim2tst.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/bsim2tst.cir` | none |
| `bjt-differential-pair` | amplifier | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/diffpair.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/diffpair.cir` | none |
| `diode-distortion` | distortion | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/diodisto.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/diodisto.cir` | none |
| `lossy-line-24-inch` | transmission-line | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/ltra_1.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/ltra_1.cir` | none |
| `lossy-line-aluminium` | transmission-line | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/ltra_2.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/ltra_2.cir` | none |
| `coupled-lossy-lines` | transmission-line | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/ltra_3.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/ltra_3.cir` | none |
| `bjt-mixer-distortion` | distortion | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/mixdisto.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/mixdisto.cir` | none |
| `mos6-inverter-chain` | digital | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/mos6inv.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/mos6inv.cir` | none |
| `mos-amplifier` | amplifier | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/mosamp2.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/mosamp2.cir` | none |
| `mos-memory-cell` | digital | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/mosmem.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/mosmem.cir` | none |
| `pole-zero-four-stage` | filter-network | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/pz2.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/pz2.cir` | none |
| `pole-zero-three-stage` | filter-network | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/pzt.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/pzt.cir` | none |
| `rc-transient` | passive | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/rc.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/rc.cir` | none |
| `rca3040-wideband-amplifier` | amplifier | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/rca3040.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/rca3040.cir` | none |
| `resistor-noise` | noise | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/resnoise.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/resnoise.cir` | none |
| `rtl-inverter-chain` | digital | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/rtlinv.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/rtlinv.cir` | none |
| `ecl-schmitt-trigger` | digital | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/schmitt.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/schmitt.cir` | none |
| `high-pass-pole-zero` | filter-network | [upstream](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/simplepz.cir) | `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant | committed | `benchmarks/corpus/classic/fixtures/spice3f5/simplepz.cir` | none |

Validate provenance fields, pinned URLs, fixture hashes, declared analyses, ngspice execution, and spice-ts parsing with:

    pnpm build
    node benchmarks/corpus/classic/validate.mjs

At ingestion on ngspice-47, 19 circuits produce raw analysis data. `bjt-mixer-distortion` is retained as a visible source-suite failure: both of its upstream `.disto` commands are commented out, so ngspice exits successfully without producing raw data. All 20 byte-identical fixtures currently fail spice-ts parsing. The validator prints each failure and checks it against the manifest instead of hiding or rewriting unsupported inputs.

## Bounded passive RC transient WASM fixture

| Circuit | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| Passive RC pulse-step transient | ngspice public corpus A [`tests/general/rc.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/general/rc.cir), pinned revision `3ef069fb1f04177a153f342a32d941fc20ff047e` | BSD-3-Clause under the pinned ngspice [`COPYING`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/COPYING); retained at `benchmarks/corpus/ngspice/LICENSE.txt` | Redistribution is allowed. `rc-step.cir` keeps the public one-source, one-resistor, one-capacitor step-response topology. It scales R/C and stop time, names the output node, makes pulse rise/fall/width/period explicit, and removes output-only `.plot` and `.options` cards. The committed bytes are supplied unchanged to both engines. No tolerance differs by engine. SHA-256 is recorded by the focused report. | `benchmarks/wasm-rc-transient/rc-step.cir`; compare with `pnpm exec tsx benchmarks/wasm-rc-transient/compare.ts` using native ngspice and the explicit `spice-ts-wasm` backend. |

## Bounded linear CCCS OP WASM fixtures

- Source: project-authored reference circuits for [issue #309](https://github.com/mfiumara/spice-ts/issues/309), issue revision as of 2026-10-10.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: none. The comparison runner reads each committed fixture once and supplies those exact bytes to the explicit `spice-ts-wasm` backend and ngspice-47. No engine-specific values, tolerances, or rewrites are used. `single-ended.cir` deliberately references the declared `VCTRL` branch as `vctrl` to verify SPICE-case-insensitive controller resolution in both engines.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/wasm-cccs-op/differential.cir` | `5462c18de8ebc84a8566638bfd6c004523f7ab8a8c301f7de219687ce55592d8` | Differential CCCS output with negative source bias and gain. |
| `benchmarks/wasm-cccs-op/mixed-source.cir` | `16c5dfc66b2d9a637104898a6228ac1def0120baed62df17d20c5a599aaad5b0` | Controller branch between an independent bias source and sense node. |
| `benchmarks/wasm-cccs-op/single-ended.cir` | `66defab84846b8d5664fa5fc471e6d56c2060f3c647a824c8f3da141eab2e923` | Mixed-case controller lookup and single-ended output. |

Reproduce with `pnpm --filter @spice-ts/wasm bench:cccs-op`. The JSON receipt records ngspice version, machine, fixture hashes, byte-identical inputs, convergence, scalar errors, runtimes, fixed-memory and artifact-size evidence, exclusions, and every retained loss.

## Bounded linear VCVS OP WASM fixtures

- Source: project-authored reference circuits for [issue #355](https://github.com/mfiumara/spice-ts/issues/355), issue revision as of 2026-10-10.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: none. The comparison runner reads each committed fixture once and supplies those exact bytes to the explicit `spice-ts-wasm` backend and ngspice-47. No engine-specific values, tolerances, or rewrites are used.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-355/differential.cir` | `4fb27d12127586283fe8a2ea67ce3d95fdfd1b2bfa0878ea2d6bacec3d055356` | Differential VCVS control and output polarity with negative gain. |
| `benchmarks/results/issue-355/mixed-source.cir` | `c6b56aa6e0233cd19ef5ae9394ae334919979f7c0bab310ce38ac0b51e37a863` | Control ordering, non-ground output reference, and VCVS branch ordering after independent source branches. |
| `benchmarks/results/issue-355/single-ended.cir` | `ce33f5e116c8a171b2cade5ec3d449028026cc05e7728255d10d1118dfa4dfe4` | Positive single-ended gain and VCVS output current. |

Reproduce with `pnpm --filter @spice-ts/wasm bench:vcvs-op`. The JSON receipt records ngspice-47, machine, fixture hashes, byte-identical inputs, convergence, scalar errors, fresh-process boundaries and runtimes, artifact-size changes, exclusions, and every retained loss.

## Bounded passive RLC transient WASM fixtures

- Source: project-authored reference circuits for [issue #368](https://github.com/mfiumara/spice-ts/issues/368), issue revision as of 2026-10-10.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: none. The comparison runner reads each committed fixture and supplies those exact bytes to the explicit `spice-ts-wasm` backend, the `spice-ts-js` TypeScript backend, and ngspice-47. No engine-specific values, tolerances, or rewrites are used.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-368/series-rlc.cir` | `fc16cee3ada369cf068e771e31ca5e251295b1a371ba89176fc022debd45cbd8` | Underdamped series RLC voltage step: inductor branch current, source current, and capacitor voltage. |
| `benchmarks/results/issue-368/parallel-rlc.cir` | `3bcb68c13fa56d9f36718406d3788ab25da25b3871e4ed2b7bac721d5cdf26dc` | Lightly damped parallel RLC current step: tank voltage and inductor branch current. |
| `benchmarks/results/issue-368/unsupported/coupled-k.cir` | `57301acf6df0c233ae32a47bf18fa6023cf2a4198fa32ffc69088c1ecf0ad75d` | Coupled inductors; WASM rejects, recorded as a loss. |
| `benchmarks/results/issue-368/unsupported/inductor-ic.cir` | `18508eb9a7982da0e451a4370cebb7187e234867a378d822a2dbc7cbcd1df31c` | Inductor `IC=`; WASM rejects, recorded as a loss. |
| `benchmarks/results/issue-368/unsupported/inductor-multiplier.cir` | `fa91c487d342c09a5a06502a4ffb53a6043edbbbcbfd29a97c45a6726f640695` | Inductor `m=` instance parameter; WASM rejects, recorded as a loss. |

Reproduce with `pnpm --filter @spice-ts/wasm bench:rlc-tran`. The JSON receipt records ngspice-47, machine, fixture hashes, byte-identical inputs, convergence, point counts, matched-timepoint max/RMS absolute and relative errors for WASM vs ngspice, TypeScript vs ngspice and WASM vs TypeScript, unsupported-form outcomes for all three engines, fresh-process runtimes, artifact-size changes, and every retained loss.

## MOS1 bulk-junction fixtures

- Source: project-authored reference circuits for [issue #393](https://github.com/mfiumara/spice-ts/issues/393), issue revision as of 2026-10-11.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: none. `benchmarks/results/issue-393/compare.ts` supplies the exact committed bytes to spice-ts and ngspice-47 with no engine-specific values, tolerances, or rewrites.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-393/fixtures/cutoff-leakage.cir` | `115e3adeaef71dec0c4048548c43c0d1b13e751e90e19363ab44da474bc8d895` | Cutoff bulk-drain leakage IS + GMIN*VBD through a source resistor (OP). |
| `benchmarks/results/issue-393/fixtures/js-area.cir` | `afc8dd4543d8d68d489e0565ad230bbf8ca1b6cfdb8e2301af7d554f975ddddd` | JS*AD / JS*AS saturation-current scaling (OP). |
| `benchmarks/results/issue-393/fixtures/nmos-forward-bulk.cir` | `665a4c2d483d35d0575e9e7b34c325423770486d6fe1290de532f20e817a3b19` | NMOS bulk junctions from reverse to forward bias (DC sweep) and their AC linearisation. |
| `benchmarks/results/issue-393/fixtures/pmos-forward-bulk.cir` | `153742314916166194cee919a9fc6cc81e90bf8e038231752e2750b6bd75f89f` | PMOS polarity of the bulk junctions (DC sweep). |
| `benchmarks/results/issue-393/fixtures/bulk-transient.cir` | `0305d225672ab9f17e337a64a6241177128a997efe2d955e4dada64386dfde62` | Bulk junction forward/reverse ramp in transient with the channel on. |
| `benchmarks/results/issue-393/fixtures/body-diode-high-current.cir` | `4e03394eda229e4cf2d64e09d2c5f9c8db7b03c2a26345d2c226385263224b26` | Body diode at up to ~3.3 A forward current (DC sweep), exercising junction limiting. |

Reproduce with `pnpm -C packages/core build && pnpm exec tsx benchmarks/results/issue-393/compare.ts --label after`, then `pnpm exec tsx benchmarks/results/issue-393/summarize.ts`. The receipts record ngspice-47, the measured revision, fixture hashes, engine status, and per-signal max/RMS absolute and relative errors for these fixtures and for every corpus fixture that runs through the level-1 MOSFET class.

## MOS1 body-effect, signed-VTO and LD fixtures

- Source: project-authored reference circuits for [issue #530](https://github.com/mfiumara/spice-ts/issues/530), issue revision as of 2026-10-11.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: none. `benchmarks/results/issue-530/compare.ts` supplies the exact committed bytes to spice-ts and ngspice-47 with no engine-specific values, tolerances, or rewrites.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-530/fixtures/nmos-body-effect-vbs-sweep.cir` | `7a38c5b1b676c8ffc931f7595747f324c0d944e2e4dd8be9891622ed68cb45fe` | NMOS GAMMA/PHI body effect swept over vbs from -4 V to +0.3 V (DC sweep), including the forward-vbs branch. |
| `benchmarks/results/issue-530/fixtures/nmos-body-effect-vgs-sweep.cir` | `bcb58b1c35442cd1f607f0bbc8fe7521860e7d030d0a937aaf786f59810e5a36` | NMOS gate sweep at vbs = -2 V in the linear and saturation regions (DC sweep). |
| `benchmarks/results/issue-530/fixtures/nmos-depletion-signed-vto.cir` | `984895980a3e59a83df39c83fe98c69feed8eb650e957cf31ae5c1157695f55b` | NMOS depletion device, VTO = -1 V (DC sweep). |
| `benchmarks/results/issue-530/fixtures/pmos-signed-vto-body.cir` | `07defa7af60f632fc1f706b228fc609ad5df0a072529322e61024e8f61d6224f` | PMOS enhancement with body effect (bulk at the supply and source above ground) and PMOS depletion, VTO = +0.6 V (DC sweep). |
| `benchmarks/results/issue-530/fixtures/nmos-lateral-diffusion.cir` | `ac3bc2ef4d05eaee1452b2f78bcd201850853a2a7f3e3072ce415e3b77ff8de8` | Lateral diffusion LD: Leff = L - 2*LD (DC sweep). |
| `benchmarks/results/issue-530/fixtures/nmos-nsub-derived-gamma.cir` | `410e3d3f06f15c8966863045da78b0e031901163b0967fc0faedfdfa14e38ea2` | GAMMA/PHI/VTO/KP derived from TOX, NSUB, UO; source follower with grounded bulk (OP, DC sweep, transient). |

Reproduce with `pnpm -C packages/core build && pnpm exec tsx benchmarks/results/issue-530/compare.ts --label after`, then `pnpm exec tsx benchmarks/results/issue-530/summarize.ts`. The receipts record ngspice-47, the measured revision, fixture hashes, engine status, and per-signal max/RMS absolute and relative errors for these fixtures and for every corpus fixture that the base revision ran through the level-1 MOSFET class.

## NHFET level-5 inverse-operation fixture

- Source: project-authored reference circuit for [issue #448](https://github.com/mfiumara/spice-ts/issues/448), issue revision as of 2026-10-11. The model card values are copied from the ngspice `tests/hfet/inverter.cir` fixture already listed in the ngspice corpus.
- Licence: MIT, under the repository [licence](../LICENSE).
- Adaptation: none. `benchmarks/results/issue-448/verify.ts` supplies the exact committed bytes to spice-ts and ngspice-47 with no engine-specific values, tolerances, or rewrites.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-448/hfet-reverse-iv.cir` | `38d9bc0d182253cb483e26d1883b0c64ae8285443f910ada2132457d647c5f9a` | Single NHFET level-5 device, nested DC sweep of VDS through inverse operation (VDS < 0) at three gate biases. |

Reproduce with `pnpm -C packages/core build && pnpm exec tsx benchmarks/results/issue-448/verify.ts --check`. The receipt also records a diagnostic, electrically identical reordering of the unchanged ngspice `hfet-inverter` fixture; it is never substituted for the identical-netlist comparison (see `benchmarks/results/issue-448/README.md`).

## Nonlinear charge-integration fixtures

- Source: project-authored reference circuits for [issue #456](https://github.com/mfiumara/spice-ts/issues/456), issue revision as of 2026-10-11. `hfet-inverter-converged.cir` is the ngspice `tests/hfet/inverter.cir` fixture already listed in the ngspice corpus, with the two Z cards inside `.subckt inv` listed driver first (electrically identical, see issue #448) and tightened accuracy settings (`reltol=1e-6 trtol=1`, TMAX 0.1 ps) so both engines run to a converged waveform. `jfet-gate-charge.cir` and `jfet-gate-forward.cir` are new.
- Licence: MIT, under the repository [licence](../LICENSE).
- Adaptation: none. `benchmarks/results/issue-456/verify.ts` supplies the exact committed bytes to spice-ts and ngspice-47 with no engine-specific values, tolerances, or rewrites.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-456/ngspice/jfet-gate-charge.cir` | `8d4a6fa85295e71cb674ceba2f51ec9299a6a44face3441cb6bf2e5e24d6b212` | NJF gate depletion charge (CGS, CGD, FC) driven through forward bias and back by a pulse. |
| `benchmarks/results/issue-456/ngspice/hfet-inverter-converged.cir` | `9583e47aeb903a9225badaab3335260429e224c9ecc436395761d9d1ef09195d` | NHFET level-5 two-inverter chain at converged accuracy settings (gate charges qgs/qgd). |
| `benchmarks/results/issue-456/ngspice/jfet-gate-forward.cir` | `6a35aab3d1229620172ed172bfb0db29681ab245ef0c62e5d2c1142f8e200ab0` | The same NJF deck driven to 1.5 V with IS=1e-18, so v(g) reaches 0.88 V, past the FC·PB = 0.4 V corner (linear-capacitance continuation). Reference for `nonlinear-charge-history.test.ts`; not part of `verify.ts`. |

Reproduce with `pnpm -C packages/core build && pnpm exec tsx benchmarks/results/issue-456/verify.ts --output <file>` (see `benchmarks/results/issue-456/README.md`).

## MOS1 inverter-chain `.op` scaling decks (issue #462)

- Source: project-authored, generated reference circuits for [issue #428](https://github.com/mfiumara/spice-ts/issues/428) and [issue #462](https://github.com/mfiumara/spice-ts/issues/462): an N-stage level-1 CMOS inverter chain with a 10 fF load per stage. The `issue-428` variant (lambda=0.02, W_p=2u) is the #426 scaling-fixture deck with `.op`; the `true-gmin` variant (lambda=0.005, W_p=1u) at 6000 stages is a CI-sized deck on which ngspice-47 also falls back to true gmin stepping (at 5000 stages its dynamic gmin stepping still completes).
- Licence: MIT, under the repository [licence](../LICENSE).
- Adaptation: none. `benchmarks/results/issue-462/measure.mjs` and `packages/core/src/mos1-inverter-chain-op.test.ts` generate the same deck text; the script writes it once and supplies those bytes to both ngspice-47 and spice-ts. Each receipt records the deck SHA-256.

Reproduce with `pnpm -C packages/core build && node benchmarks/results/issue-462/measure.mjs --stages 40000` (see `benchmarks/results/issue-462/README.md`).

## MOS6 charge-integration fixture

- Source: project-authored reference circuit for [issue #468](https://github.com/mfiumara/spice-ts/issues/468), issue revision as of 2026-10-11. The model card reuses the `N10L5` level-6 parameters of the ngspice `tests/mos6/simpleinv.cir` fixture, adding `IS=1e-18` and instance junction areas/perimeters.
- Licence: MIT, under the repository [licence](../LICENSE).
- Adaptation: none. The committed bytes are run unchanged by ngspice-47 and spice-ts.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-468/ngspice/mos6-bulk-junction.cir` | `fa2a0dee6b790db2ac4deef8c77184f3bd84406cd1f91a59eb7632a4d4fabd53` | NMOS level-6 bulk driven through 100k to 0.71 V, past FC·PB = 0.5 V, with bottom and sidewall junction caps (MOS6 qbs/qbd charges including the f2/f3/f4 continuation). Reference for `mos6.test.ts`. |

The corpus comparisons for #468 are reproduced with `pnpm -C packages/core build && pnpm exec tsx benchmarks/results/issue-468/verify.ts --output <file>` (see `benchmarks/results/issue-468/README.md`).

## VBIC `.OPTIONS TEMP` reference values

- Source: the ngspice corpus A fixture `vbic-temperature` (`tests/vbic/temp.cir`, BSD-3-Clause, listed above) for [issue #459](https://github.com/mfiumara/spice-ts/issues/459).
- Unchanged-fixture comparison: the aggregate report runs the committed bytes through both engines. `packages/core/src/options-temp.test.ts` also pins seven ngspice-47 `.print` points of the same bytes (SHA-256 `5dfd5fb1e620eac69af1eed64463aac62efd23dee169f2a3773d1091088f31e7`).
- Adaptation, unit test only: a second case adds `TNOM=150` to the fixture's `.MODEL` card in memory to check the TNOM-relative mapping, and pins two ngspice-47 points of that deck. ngspice-47 values were written with `set filetype=ascii` and `write` from a `.control` block appended to a scratch copy; the committed fixture is never modified and the adapted deck is never used in the aggregate.

## Bounded pole-zero parity fixtures

The MCP fixture `packages/mcp/fixtures/pz-rlc.cir` is an original project-authored
MIT-licensed analytic RLC probe for issue #1449, under the repository LICENSE.
It is read by `packages/mcp/src/pz-metrics.test.ts`. Its identical, unmodified
bytes are valid for both ngspice-47 batch mode and titleless MCP input. The
analytic transfer poles are -500 +/- j*sqrt(750000) rad/s (wn=1000 rad/s,
zeta=0.5, Q=1); no external netlist was copied or adapted.

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| Passive RLC and active four-stage `.pz` | Berkeley SPICE3f5 [`simplepz.cir`](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/simplepz.cir) and [`pz2.cir`](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/pz2.cir), pinned mirror revision `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant retained at `benchmarks/corpus/classic/COPYRIGHT.txt`; redistribution is allowed with that notice | `passive-rlc.cir` preserves `simplepz.cir` and adds one 1 uH shunt inductor so the bounded fixture exercises R, L, and C dynamics. `active-four-stage.cir` changes only the source card from ngspice's implicit `iin 1 0 ac` zero bias to explicit `iin 1 0 dc 0`; its topology, values, and `.pz` command are unchanged. The committed local bytes are supplied identically to both engines. | `benchmarks/pole-zero/{passive-rlc,active-four-stage}.cir`; compare with `pnpm exec tsx benchmarks/pole-zero/compare.ts` using ngspice-47. |

## `.pz` eigenvalue root-finder stress netlists

- Source: project-authored reference circuits for [issue #451](https://github.com/mfiumara/spice-ts/issues/451), issue revision as of 2026-10-11. `four_pz.cir` and `three_pz.cir` keep the topology and values of the Berkeley SPICE3f5 `pz2.cir`/`pzt.cir` examples already listed under the classic corpus (notice retained at `benchmarks/corpus/classic/COPYRIGHT.txt`), with `cur pol` changed to `cur pz`.
- Licence: MIT, under the repository [licence](../LICENSE), apart from the SPICE3f5-derived values above, which stay under the Berkeley SPICE grant.
- Adaptation: none. `benchmarks/results/issue-451/stress.ts` supplies the exact committed bytes to spice-ts and ngspice-47 with no engine-specific values, tolerances, or rewrites.

| Fixture | SHA-256 | Coverage |
|---|---|---|
| `benchmarks/results/issue-451/stress/bandpass.cir` | `1a421435e73d4c1c78d840c8deef3c2cd547023115c9ef12f6164e53cb96b672` | Series LC bandpass; one zero at DC. |
| `benchmarks/results/issue-451/stress/feedback.cir` | `e85252f5ee8022ef32614d43d42024a66f9e1d24e14211398c8c62fe9244a576` | VCVS (gain 1e5) inverting amplifier with feedback capacitor. |
| `benchmarks/results/issue-451/stress/floatcap.cir` | `e339a5e127fbb42b4504d186f78c15546aa6a5f9aa5cf769ab1312baa673e6f0` | Capacitor loop through three nodes. |
| `benchmarks/results/issue-451/stress/four_pz.cir` | `06e0956b0d5fc49bc3af0816a1e952d56a7f38e7ef61969d34741cc42b196af5` | SPICE3f5 `pz2.cir` four-stage gm cascade with `.pz ... cur pz` (four zeros at DC). |
| `benchmarks/results/issue-451/stress/mixed.cir` | `94cbd594261fbf546e0dea1a9b2c78abb64fb6167860fdb504de1827663189b9` | 1 H inductor next to 1-10 pF capacitors (mixed-unit storage matrix). |
| `benchmarks/results/issue-451/stress/opamp2.cir` | `e9428906371fedad96c491ecb8d3cef3cebc6bfed1a9fe609022b7c03b1280dd` | Two-stage gm amplifier with Miller capacitor in closed loop (right-half-plane poles). |
| `benchmarks/results/issue-451/stress/osc.cir` | `ed6a3ff7e11e67ae41787a71a94f91c100917bd1603bb80fe8cbe8bde71a0c13` | Two lightly damped LC sections (two complex pole pairs, ngspice ordering). |
| `benchmarks/results/issue-451/stress/rcladder.cir` | `060dacb9f87d0e36ed70df20f65687a06da58f2c271a6495f54918558f1ef45f` | Four-section RC ladder across six decades, relative degree 4 (no finite zeros). |
| `benchmarks/results/issue-451/stress/rd3.cir` | `f9973ce588e56459f83cc8e77306147bdd9aea2eddc8042fdee5b0754e800b12` | RLC network with finite complex right-half-plane zeros and a 1 fF bridging capacitor. |
| `benchmarks/results/issue-451/stress/reldeg2.cir` | `6c253346d52db775d5b6ef3a70497eb75ae7e818f1d467c239342df824141499` | RLC lowpass, relative degree 2. |
| `benchmarks/results/issue-451/stress/spread.cir` | `cfaf6effaf8d3deefe995c09561f951ad2a5f94429cdab9cb601c4877a967649` | RC ladder with time constants from 1 s to 1e-18 s (published loss). |
| `benchmarks/results/issue-451/stress/three_pz.cir` | `06150402769e65e62c5b7a057b89bf20a2a3a9559a70c4c87bd8e67c984e0cf5` | SPICE3f5 `pzt.cir` three-stage cascade with `.pz ... cur pz` (triple pole). |
| `benchmarks/results/issue-451/stress/vloop.cir` | `0d5ba09f3c90db6f0cbd71e6c7453464c23ea4d34e3dbed03f47f6467ec64f1d` | Capacitor across a voltage source next to an RC network (non-dynamic storage mode). |

Reproduce with `pnpm exec tsx benchmarks/results/issue-451/stress.ts` and `pnpm exec tsx benchmarks/results/issue-451/measure.ts` (the latter after `pnpm -C packages/core build`). See `benchmarks/results/issue-451/README.md` for the before/after receipts, including losses.

## Bounded sensitivity parity fixtures

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| Passive RLC DC and DEC AC `.sens` | Berkeley SPICE3f5 [`simplepz.cir`](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/simplepz.cir), pinned mirror revision `3d9360bef370b432e473edb0c4333707d545a55f` | Berkeley SPICE grant retained at `benchmarks/corpus/classic/COPYRIGHT.txt`; redistribution is allowed with that notice | The two fixtures retain the public two-resistor/capacitor filter basis, add an independent voltage source and series inductor, and replace `.pz` with bounded DC or DEC AC `.sens`. Values and topology are then frozen; each committed file is supplied byte-identically to both engines. | `benchmarks/sensitivity/passive-rlc-{dc,ac}.cir` |
| Active VCVS DEC AC `.sens` | Gnucap [`tests/d_vcvs.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_vcvs.1.ckt), pinned revision `5acb027125d6ea7c546badd03e026d8781c6a400` | GPL-3.0-or-later; pinned notice and complete licence retained at `benchmarks/corpus/corpus-e/LICENSE-NOTICE.md` and `benchmarks/corpus/corpus-e/COPYING.txt` | Retains the source, divider, gain-4 VCVS, and output load; removes Gnucap-only output cards and the unrelated VCCS branch, sets the source DC bias explicitly to zero, and replaces repeated `.op`/`.ac` cards with one bounded DEC AC `.sens`. The resulting committed file is supplied byte-identically to both engines. | `benchmarks/sensitivity/active-vcvs-ac.cir` |
| Two-source DEC AC `.sens` rejection regressions | [spice-ts PR #178 review cases](https://github.com/mfiumara/spice-ts/pull/178), authored by project owner Mattia Fiumara | Original spice-ts project fixtures, distributed under the repository MIT licence | The two-active and zero-first review netlists are retained exactly apart from their descriptive title lines. Each committed file is supplied byte-identically to both engines; ngspice reference vectors and spice-ts's explicit unsupported-topology errors are verified by the comparison command. | `benchmarks/sensitivity/multi-source-ac.cir`, `benchmarks/sensitivity/zero-first-multi-source-ac.cir` |

Run `pnpm exec tsx benchmarks/sensitivity/compare.ts` with ngspice-47. The JSON receipt reports the engine version, machine, identical paths, deterministic native order, matched-point maximum/RMS absolute and relative errors, every non-zero residual as a retained loss, convergence failures, and the explicit unsupported matrix.

## Bounded ideal-linear distortion parity fixtures

- MCP diode metric regression: original MIT-licensed analytic diode/R/C deck embedded in `packages/mcp/src/disto-metrics.test.ts` (no third-party source). ngspice-47 values in `packages/mcp/fixtures/disto-ngspice47.json` are consumed by the test and were generated from the identical literal bytes using the recorded command. Covers all 11 frequencies of `.disto dec 5 1k 100k` for HD2/HD3; uses the existing core complex relative tolerance 0.005. No fixture rewrites or core numeric changes.

- Canonical public source: ngspice public corpus A [`tests/filters/lowpass.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/filters/lowpass.cir), pinned revision `3ef069fb1f04177a153f342a32d941fc20ff047e`.
- Licence: BSD-3-Clause under the pinned ngspice [`COPYING`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/COPYING); the retained notice is `benchmarks/corpus/ngspice/LICENSE.txt`.
- Redistribution decision: allowed. The adapted source-form fixture remains under BSD-3-Clause.
- Adaptation: `benchmarks/distortion/linear-lowpass.cir` comments the unsupported `.OPTIONS` card, replaces `.AC DEC 10 1k 1Meg` with `.DISTO DEC 10 1k 1Meg`, and changes only `DISTOF1 0` to `DISTOF1 1`. `benchmarks/distortion/two-tone-linear-lowpass.cir` makes the same changes, adds `f2overf1=0.9`, and changes `DISTOF2 0` to `DISTOF2 0.25 30`. Each title describes its bounded run. Topology, component values, remaining source clauses, and sweep bounds are unchanged. Each committed file is supplied byte-identically to spice-ts and ngspice-47.
- Scope: one DEC single-tone and one DEC two-tone ideal-linear RC case. The single-tone result covers second- and third-harmonic complex outputs. The two-tone result covers ngspice's separate `f1+f2`, `f1-f2`, and `2f1-f2` plots. All represented values are mathematically zero. Semiconductor nonlinear, stepped, LIN/OCT, controlled-source, coupled, transmission-line, arbitrary multi-excitation, protocol-v1, streaming, and external-backend distortion remain explicitly unsupported.
- Reproduce with `pnpm bench:disto`. The JSON receipt reports ngspice-47 and runtime versions, machine, fixture hashes, byte-identical inputs, convergence, runtimes, stable frequency/vector/product order, matched-point maximum/RMS absolute and relative errors, every loss, and all unsupported forms.

## RF port source and `.sp` S-parameter parity fixtures

- Fixtures: `benchmarks/rf-port-sp/sp1-power-ports.cir` (SHA-256 `024ddde0dffa1b1058376dc1f8ecad87774affe22c89d9117079d3b66fa6905b`), `sp1-power-ports-temp80.cir` (`4b597600328eda07ed9b8e630ee20a9e71099d080594cacada805d886735ab10`), `sp2-lc-voltage-ports.cir` (`bc6ad10295cc75c3d4c1f571414528196401cc9d3631edc7d84af0c8efc09501`), `sp4-three-ports.cir` (`1ca31050c073af961a37a00288f3be696da196ff7cb6eed0b2957e80f9a57394`), `tschebyschef-lp.cir` (`889b1f4cfb4ede62fbbf046631b90ff2dd0bc1944e9dabd0261afdeb999ee4bf`) and `port-op-ac.cir` (`2b613c9ccacb88a8daaf4d80efd45493bd747721902c25349163462e0a43f0cb`).
- Canonical public sources: ngspice [`examples/rf/sp/sp1.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/rf/sp/sp1.cir), [`sp2.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/rf/sp/sp2.cir), [`sp4.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/rf/sp/sp4.cir) and [`Tschebyschef-LP.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/rf/sp/Tschebyschef-LP.cir) at pinned revision `3ef069fb1f04177a153f342a32d941fc20ff047e`; `port-op-ac.cir` is project-authored for [issue #499](https://github.com/mfiumara/spice-ts/issues/499) and `sp1-power-ports-temp80.cir` is a project derivative of `sp1.cir`.
- Licence: the five ngspice-derived decks (the four upstream adaptations and the temp-80 derivative) are BSD-3-Clause under the pinned ngspice [`COPYING`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/COPYING) (retained notice `benchmarks/corpus/ngspice/LICENSE.txt`); `port-op-ac.cir` is MIT under the repository [licence](../LICENSE). Redistribution is allowed under both.
- Adaptation: only the `.control` … `.endc` block (plotting, `run`, `quit`) is removed so that `ngspice -b -r` writes the SP plot, and CRLF line endings become LF. Titles, comments, sources, port parameters, element values and the `.sp` cards are unchanged. The byte-identical upstream decks are also in corpus-f (#484), where the `.control` block prevents ngspice from exporting vectors. `sp1-power-ports-temp80.cir` additionally changes the title, adds `.options temp=80` and narrows the sweep to `.sp lin 5 1e8 1e9 1`, so the two-port noise normalization by 4kT is checked at a non-default circuit temperature. Each committed file is supplied byte-identically to spice-ts and ngspice-47.
- Scope: two- and three-port S/Y/Z matrices, the `donoise` resistor-thermal noise correlation matrix `Cy` and two-port `NF`/`SOpt`/`NFmin`/`Rn`, LIN and DEC sweeps, and RF port DC/AC behaviour. Semiconductor SP noise, current-source AC excitation in `.sp`, and the `sp` control command remain explicitly unsupported.
- Reproduce with `pnpm bench:rf-port-sp`. The JSON receipt (`benchmarks/rf-port-sp/report.json`) records ngspice-47, machine, fixture hashes, byte-identical inputs, convergence, runtimes with the process-boundary caveat, exact frequency-grid identity, per-vector max/RMS errors normalized to the vector and to its whole matrix, exclusions and every retained loss.

## Bounded stepped transfer-function parity fixture

- Fixture: `benchmarks/stepped-transfer-function/stepped-divider.cir` (SHA-256 `dfb418673a8064df89b93eaa3524580523aaf5db9f5dbdf93345827afd8e684c`).
- Source: project-authored public reference circuit for [issue #208](https://github.com/mfiumara/spice-ts/issues/208).
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: the committed four-point `R2` LIST grid is executed directly by spice-ts. ngspice-47 reports `unimplemented dot command '.step'`, so the comparison harness records that loss and expands the grid deterministically. At each matched value, the same expanded netlist bytes are supplied to both engines. The direct spice-ts result is also checked against its expanded single-point runs. No circuit value, tolerance, or engine-specific deck is used to hide an error.
- Reproduce with `pnpm bench:stepped-tf`. The JSON receipt reports convergence at every step, deterministic order, max/RMS absolute and relative errors for transfer, input resistance, and output resistance, runtimes with process-boundary caveats, unsupported forms, and all retained losses.

## Bounded TEMP LIST resistor-coefficient parity fixture

- Fixture: `benchmarks/temp-step-resistor/temp-divider.cir`.
- Source: project-authored public reference circuit for [issue #318](https://github.com/mfiumara/spice-ts/issues/318).
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: the committed `.step TEMP LIST -55 25 72` bytes are executed directly by spice-ts. ngspice-47 reports `unimplemented dot command '.step'`, so that loss is retained. For matched points, the harness evaluates the documented `R(T) = Rnom * (1 + TC1 * (T - TNOM))` relation and supplies one byte-identical expanded netlist to both engines at each temperature. Direct and expanded spice-ts results are compared with every residual retained. No engine-specific tolerance or circuit value is used.
- Scope: a single case-insensitive LIST-only circuit-temperature target and linear resistor `TC1` behavior. `.temp`, nested steps, non-LIST TEMP sweeps, diode temperature/breakdown, and broad all-device temperature semantics remain unsupported or out of scope.
- Reproduce with `pnpm bench:temp-step`. The JSON receipt records fixture and expanded hashes, versions, machine, step order, convergence, matched-point maximum/RMS absolute and relative error, runtimes, the direct ngspice loss, and expansion caveats.

## Bounded diode breakdown-temperature DC-equivalent parity fixture

- Fixture: `benchmarks/diode-breakdown-temperature/dc-equivalent.cir` (SHA-256 `02551eb619592aa1065cd549dbabd65e0916c3d223c2cbef7ecd6de72d4c8b65`).
- Source: project-authored public reference circuit for [issue #319](https://github.com/mfiumara/spice-ts/issues/319), issue acceptance-contract revision as of 2026-10-10; the immutable fixture revision is identified by the SHA-256 above.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- DC equivalence: the three parallel branches encode the issue's documented `BV(T) = 7.255 * (1 + 0.00013 * (T - 27) - 5e-8 * (T - 27)^2)` values at -55, 25, and 72 C. Unit tests and the unchanged Xyce fixture exercise native `TBV1`/`TBV2`; this fixture isolates reverse-breakdown parity at those same effective BV points without relying on ngspice-incompatible `.step TEMP` or Xyce's zero TSTEP.
- Adaptation: none between engines. The verifier reads the committed fixture once and supplies those exact bytes to spice-ts and ngspice-47. No engine-specific values, tolerances, or rewrites are used.
- Reproduce with `pnpm -C packages/core build && pnpm exec tsx benchmarks/results/issue-319/verify.ts --output benchmarks/results/issue-319/report.json`. The receipt records ngspice-47, exact commands, the 17-point `.dc VSWEEP 8 12 0.25` grid, `V(cold)`, `V(nominal)`, `V(hot)`, and `I(VSWEEP)`, convergence, runtimes, and matched-point maximum/RMS absolute and relative errors.

## VBIC emission coefficient parity fixture (#1156)

- Fixture: `benchmarks/vbic-emission/emission.cir`; project-authored for [issue #1156](https://github.com/mfiumara/spice-ts/issues/1156), MIT under the repository licence. No third-party netlist is copied.
- The exact same deck bytes are used by both engines; the temperature card alone is varied identically to 0, 27 and 75 C. Forward/reverse transport and forward-biased parasitic substrate diodes exercise NF, NR, NEI, NEN, NCI, NCN, NFP, NCIP and NCNP in OP, DC sweep and AC.
- Equation sources: ngspice-47 `src/spicelib/devices/vbic/{vbicload,vbictemp,vbicsetup}.c`, available in the [pinned ngspice source tree](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/src/spicelib/devices/vbic/), BSD-3-Clause (see the ngspice corpus provenance above). All temperature exponents outside the bounded subset retain their ngspice defaults, including TNF=0.
- Reference: `ngspice-47.json`, read by the regression test, contains ngspice-47 ASCII raw plot values (not rounded print tables). Generate raw plots with `SPICE_ASCIIRAWFILE=1 ngspice -b -r <output.raw> <deck>` for each temperature. The test runs with `pnpm -C packages/core exec vitest run src/devices/vbic-emission.test.ts`; it applies the uniform corpus 1%-of-peak rule and quantity floors, without per-circuit tolerance changes.
- Scope: bounded isothermal NPN LEVEL=4 only; this does not enable VBIC transient/noise or arbitrary model parameters. The three unchanged corpus-f VBIC example decks still reject FC after the emission-coefficient gap is removed.

## Bounded VBIC non-ground substrate parity fixtures

- Fixtures: `benchmarks/vbic-substrate/dc.cir` (SHA-256 `3229c4f71f6e450c0da6f5b1b371d8f8c3e7fd3ad845ae04859e7c3aacb1a32c`), `benchmarks/vbic-substrate/ac.cir` (SHA-256 `897e30fd367d4ad14ad4fc355bf1cc7f76e0afdae12671e6a6a3e83fcf40ed66`), and `benchmarks/vbic-substrate/dc-latchup.cir` (SHA-256 `53259667c7b0fe7f2e20b5591b9273c4beca5c51e9b5027a74b06d04c964173d`).
- Source: project-authored reference circuits for [issue #453](https://github.com/mfiumara/spice-ts/issues/453). The `N1` VBIC model card and the `ac.cir` common-emitter topology are copied from ngspice [`tests/vbic/CEamp.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/vbic/CEamp.cir) at revision `3ef069fb1f04177a153f342a32d941fc20ff047e`.
- Licence: the circuits are MIT under the repository [licence](../LICENSE); the copied model card and topology are BSD-3-Clause (ngspice public corpus A above). Redistribution is allowed under both.
- Adaptation: the substrate is node 4 (DC, swept by `VSUB`) or node 5 (AC, biased through `RSUB` from `VSUB`) instead of ground. `dc.cir` sets `.options reltol=1e-6` for both engines so each sweep point converges below the comparison tolerance. `dc-latchup.cir` is `dc.cir` with the sweep extended to 3 V and the default reltol, which forward-biases the substrate junction into NPN + parasitic-PNP latch-up; spice-ts does not converge there, and that loss is retained. Both engines receive each committed netlist byte-for-byte; no engine-specific tolerance or circuit rewrite is used.
- Reproduce with `pnpm -C packages/core build && npx tsx benchmarks/results/issue-453/verify.ts --output benchmarks/results/issue-453/report.json`. The receipt records ngspice-47, both engines' status, and the aggregate's matched-point error metrics for the three fixtures and the `vbic-fo` and `vbic-common-emitter-ac` aggregate rows.

## Bounded Gummel-Poon forward-active parity fixtures

- Public source: John P. Doty's CA3080 ngspice model, [`ca3080.mod`](https://github.com/xxv/gedasymbols/blob/49eda5e627e167fcb6346ef9805535ca92e43b0c/www/user/john_doty/models/opamp/ca3080.mod), pinned `gedasymbols` revision `49eda5e627e167fcb6346ef9805535ca92e43b0c`.
- Licence: GPL-2.0-or-later, stated in the source file by its copyright holder; the complete GPLv2 text is already retained at `benchmarks/corpus/corpus-d/COPYING.txt`.
- Redistribution decision: allowed under GPL-2.0-or-later. The upstream file is not copied. The checked-in test decks identify the source and use only the bounded numeric subset of its `VERTNPN` model card: `LEVEL`, `IS`, `VAF`, `BF`, `ISE`, `NE`, `IKF`, and `BR`.
- Adaptation: the original CA3080 subcircuit is replaced by a project-authored, deterministic common-emitter characterization grid. Unsupported temperature, resistance, capacitance, transit-time, reverse high-current, and substrate parameters are omitted rather than silently accepted. The resulting local deck bytes are supplied identically to spice-ts and ngspice-47 at VBE 0.55–0.70 V and VCE 1, 5, and 9 V.
- Local paths: `benchmarks/gummel-poon/{vce-1,vce-5,vce-9}.cir`; compare with `pnpm exec tsx benchmarks/gummel-poon/compare.ts`.

## Bounded lossless transmission-line parity fixtures

- Canonical public source: ngspice User's Manual version 47, [lossless T-card syntax and `Z0=50 TD=10NS` example](https://nmg.gitlab.io/ngspice-manual/transmissionlines/losslesstransmissionlines.html) plus the public [transmission-line inverter step-response example](https://nmg.gitlab.io/ngspice-manual/examplecircuits/transmission-lineinverter.html).
- Revision: ngspice release/manual version 47 (downloaded from the [versioned documentation page](https://ngspice.sourceforge.io/docs.html)).
- Licence: CC-BY-SA-4.0; the manual's [documentation licence notice](https://nmg.gitlab.io/ngspice-manual/copyrightsandlicenses/documentationlicense.html) applies.
- Redistribution decision: allowed with attribution and ShareAlike. The two small source-form fixtures are adaptations and this fixture section is offered under CC-BY-SA-4.0; simulator code remains MIT.
- Adaptation: the documented one-line `Z0`/`TD` form and pulse-step topology are reduced to one grounded 50-ohm, 5 ns line. `matched.cir` uses 50-ohm source/load terminations. `mismatched.cir` changes only those terminations to 25/100 ohms so source and load reflections are observable. Both engines receive each committed netlist byte-for-byte; no engine-specific tolerance or circuit rewrite is used.

| Fixture | SHA-256 | Expected behavior | Command |
|---|---|---|---|
| `benchmarks/lossless-tline/matched.cir` | `84333a39888bc3dc72b8c492c749d493230fb705f39ce02fb689d76ad9fd9fbb` | 0.5 V launch and 5 ns one-way propagation; no round-trip reflection | `pnpm exec tsx benchmarks/lossless-tline/compare.ts` (internally runs ngspice-47 in batch mode) |
| `benchmarks/lossless-tline/mismatched.cir` | `5da221908fe4c0a2f522026d3c1a25746b345adedf870442e14af67308ab22c1` | 2/3 V launch, 8/9 V first load step, 22/27 V source return, 64/81 V second load step | same |

## Bounded MOSFET level-1 noise parity fixture

- Fixture: `benchmarks/mos1-noise/mos1-noise.cir` (SHA-256 `cd8f360eb0db90b1f4796df474bc6b2b435ad77a39d16ee8cbd4bc79197acb5b`).
- Source: project-authored public reference circuit for [issue #189](https://github.com/mfiumara/spice-ts/issues/189), pinned by the fixture SHA-256 above.
- Licence: MIT, under the repository [licence](../LICENSE); redistribution is allowed. No third-party netlist was copied.
- Adaptation: none. The committed bytes are supplied identically to spice-ts and ngspice-47. The fixture exercises MOS1 channel thermal noise and default `NLEV=2` KF/AF flicker noise over a DEC sweep.
- Reproduce with `pnpm exec tsx benchmarks/mos1-noise/compare.ts`; the command records source/hash, versions, machine, convergence, runtimes, matched-point max/RMS absolute and relative errors, integrated totals, and remaining unsupported losses.

## Bounded BJT level-1 noise parity fixture

- Fixture: `benchmarks/bjt-noise/bjt-noise.cir` (SHA-256 `4e005d6433ee14cd41c8d6d793e661077e99d5802a91e93419ab1e5b4c4f93d3`).
- Source: project-authored public reference circuit for [issue #199](https://github.com/mfiumara/spice-ts/issues/199), pinned by the fixture SHA-256 above.
- Licence: MIT, under the repository [licence](../LICENSE); redistribution is allowed. No third-party netlist was copied.
- Adaptation: none. The committed bytes are supplied identically to spice-ts and ngspice-47. The forward-active fixture exercises BJT level-1 collector and base shot noise together with external base/load resistance thermal noise over a DEC sweep.
- Reproduce with `pnpm exec tsx benchmarks/bjt-noise/compare.ts`; the command records source/hash, versions, machine, convergence, runtimes, matched-point max/RMS absolute and relative errors, integrated totals, and all remaining unsupported losses.

## Bounded differential resistor-noise parity fixture

- Fixture: `benchmarks/differential-noise/differential-divider.cir` (SHA-256 `4a00d295e139c32f175870a5227df610ff4f23ff797616bdab5c675fc3b10040`).
- Source: project-authored public reference circuit for [issue #255](https://github.com/mfiumara/spice-ts/issues/255), pinned by the fixture hash above.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; no third-party circuit material was copied.
- Adaptation: none. The committed bytes are supplied identically to spice-ts and ngspice-47. The fixture measures `V(outp,outn)` across two unequal resistor-divider outputs over a DEC sweep.
- Scope: differential voltage output for resistor thermal noise only. Current output, current-source referral, stepped noise, temperature cards, and differential semiconductor or broader noisy-device forms remain explicitly unsupported.
- Reproduce with `pnpm bench:differential-noise -- --output benchmarks/differential-noise/results.json`. The JSON receipt records source, revision, licence, hash, versions, machine, convergence, runtimes, matched-point and integrated max/RMS absolute and relative errors, explicit exclusions, and every retained loss.

## Bounded BJT level-1 internal-resistance noise parity fixture

- Fixture: `benchmarks/bjt-internal-resistance-noise/bjt-internal-resistance-noise.cir` (SHA-256 `f3166a899574399ae7351f48569c898a7c4353ed8d11951148eede4f6c8eeff4`).
- Source: project-authored public reference circuit for [issue #243](https://github.com/mfiumara/spice-ts/issues/243), pinned by the fixture SHA-256 above.
- Licence: MIT, under the repository [licence](../LICENSE); redistribution is allowed. No third-party netlist was copied.
- Adaptation: none. The committed bytes are supplied identically to spice-ts and ngspice-47. The fixture adds fixed level-1 `RB=100`, `RC=10`, and `RE=10` to the existing forward-active topology and exercises their thermal noise together with collector/base shot noise and external resistance noise over a DEC sweep.
- Reproduce with `pnpm exec tsx benchmarks/bjt-internal-resistance-noise/compare.ts`; the command records source/hash, versions, machine, convergence, runtimes, matched-point max/RMS absolute and relative errors, integrated totals, explicit exclusions, and every retained loss. The `/poteto-mode` design receipt is `benchmarks/bjt-internal-resistance-noise/POTETO.md`.

## Bounded BJT level-1 flicker-noise parity fixture

- Fixture: `benchmarks/bjt-flicker-noise/bjt-flicker-noise.cir` (SHA-256 `d9001973f05126c8590e28818d83655eb0ff315b3a3eecc69ee76c28296daa4a`).
- Source: project-authored public reference circuit for [issue #248](https://github.com/mfiumara/spice-ts/issues/248), pinned by the immutable fixture hash above.
- Licence: MIT, under the repository [licence](../LICENSE); redistribution is allowed. No third-party netlist was copied.
- Reference equation: ngspice [`bjtnoise.c`](https://github.com/ngspice/ngspice/blob/032b1c32/src/spicelib/devices/bjt/bjtnoise.c#L126-L149), pinned revision `032b1c32`, BSD-3-Clause under ngspice's [`COPYING`](https://github.com/ngspice/ngspice/blob/032b1c32/COPYING).
- Adaptation: none. The committed bytes are supplied identically to spice-ts and ngspice-47. The fixture exercises level-1 `KF=1e-9`, `AF=1.2` base-current flicker noise while retaining collector/base shot noise and `RB`/`RC`/`RE` plus external-resistance thermal noise over a DEC sweep. No per-engine tolerance or value changes are made.
- Reproduce with `pnpm exec tsx benchmarks/bjt-flicker-noise/compare.ts -- --output benchmarks/bjt-flicker-noise/results.json`; the receipt reports source revision/licence/hash, versions, machine, identical inputs, matched-point max/RMS absolute and relative errors, integrated errors, runtimes, unsupported forms, and every retained loss. The `/poteto-mode` design receipt is `benchmarks/bjt-flicker-noise/POTETO.md`.

## Xyce Regression Suite corpus C

- Repository: https://github.com/Xyce/Xyce_Regression
- Pinned revision: `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`
- Licence: GPL-3.0-or-later. The pinned repository [copyright and licence notice](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/README.md#copyright-and-license) grants redistribution and modification under GPL version 3 or later.
- Licence retention: the byte-identical upstream README is retained as `benchmarks/corpus/xyce/LICENSE-NOTICE.md` (SHA-256 `82ff6df7bddcdf639483d261949a02a5f43da85d579f1242b05c3aa0c430f7cb`), and the complete GPLv3 text from https://www.gnu.org/licenses/gpl-3.0.txt is retained as `benchmarks/corpus/xyce/COPYING.txt` (SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`).
- Redistribution decision: allowed under GPL-3.0-or-later with the copyright/licence notice and complete licence text retained alongside the fixtures.
- Adaptation: none. All 20 `.cir` files are committed byte-for-byte from the pinned revision. The validator fetches every pinned source, checks its hash and bytes, and supplies the same local bytes to native ngspice and spice-ts without tolerance changes.

| ID | Category | Canonical source | SHA-256 | Local path |
|---|---|---|---|---|
| `capacitor-rc-transient` | capacitor | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/capacitor.cir) | `38b0d8271d4cef0f783be9a5ba0bc391c6d164fbe0dba9027e93927f0656e90b` | `benchmarks/corpus/xyce/fixtures/CAPACITOR/capacitor.cir` |
| `capacitor-rc-transient-newlte` | capacitor | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/capacitor3.cir) | `628f4953ca83a0e8840e100ea4671c778afe47bdcad0f52c09f5053c023c5194` | `benchmarks/corpus/xyce/fixtures/CAPACITOR/capacitor3.cir` |
| `capacitor-rc-oscillator` | capacitor | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/rc_osc.cir) | `add8ca9d2654398a4c394bc9232809677b479fe35172c66bbb8e2ad9bf9410a4` | `benchmarks/corpus/xyce/fixtures/CAPACITOR/rc_osc.cir` |
| `diode-level2-temperature-breakdown` | diode | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE/Level2_Temp_Dep_Breakdown.cir) | `9c52a577a2f0b0a7419160b6cd340894ed41ebc403023a3b3f1d809d171bee0e` | `benchmarks/corpus/xyce/fixtures/DIODE/Level2_Temp_Dep_Breakdown.cir` |
| `diode-zener-5229` | diode | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE/Zener_5229.cir) | `aefc2180e4bb6a5b39e3f4105546f3c5ba22af3b74f003d2d4d3c55f45938e9e` | `benchmarks/corpus/xyce/fixtures/DIODE/Zener_5229.cir` |
| `diode-transient` | diode | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE/diode.cir) | `334e2dde43335851dc96f76ba5e78ef3e0b1de142cca073b3c70f83937637d8c` | `benchmarks/corpus/xyce/fixtures/DIODE/diode.cir` |
| `diode-sidewall-dc` | diode | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE/diode_with_sidewall.cir) | `fb7d40fe14305d830afa0c4477e68b2da541f428883cec677f4c8cb13906d658` | `benchmarks/corpus/xyce/fixtures/DIODE/diode_with_sidewall.cir` |
| `inductor-transient` | inductor | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/INDUCTOR/inductor.cir) | `a0a869d9fe3b04d3bbdc8abf9e8a89a9302a54ac5be9c97f446f06834a248b35` | `benchmarks/corpus/xyce/fixtures/INDUCTOR/inductor.cir` |
| `njfet-2109-dc` | jfet | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NJFET_DC/njfet-2109.cir) | `d25578ed59ddc0f94e3a2f9281f1200982f82c682ec63d5256bf0399f34ecd46` | `benchmarks/corpus/xyce/fixtures/NJFET_DC/njfet-2109.cir` |
| `njfet-stepped-dc` | jfet | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NJFET_DC/njfet.cir) | `295e3d4208ea2d839acf4724473b921ef1706976b254912b6e8455508c65b412` | `benchmarks/corpus/xyce/fixtures/NJFET_DC/njfet.cir` |
| `nmos-level1-dc` | mosfet | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NMOS1_DC/nmos1.cir) | `3ab24382b4fb966d2111ba8b2aa0590b989fc09b367c09eb41cc7ac475e0e255` | `benchmarks/corpus/xyce/fixtures/NMOS1_DC/nmos1.cir` |
| `npn-dc` | bjt | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NPN_DC/npn1.cir) | `8775a88a3f9c032ee047d770781a5a0cbcf21a2e28b7b6352e63636a7c9f1ce0` | `benchmarks/corpus/xyce/fixtures/NPN_DC/npn1.cir` |
| `pmos-level1-dc` | mosfet | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/PMOS1_DC/pmos1.cir) | `767c989ba6c4ad761d2211ae39c9c82536895e76f6288e77276ad9468b2b2093` | `benchmarks/corpus/xyce/fixtures/PMOS1_DC/pmos1.cir` |
| `pnp-dc` | bjt | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/PNP_DC/pnp1.cir) | `95796ac998eb051a535fcb498c259e715c1e8edd237e1e07add401fc6a1601df` | `benchmarks/corpus/xyce/fixtures/PNP_DC/pnp1.cir` |
| `resistor-dc` | resistor | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/RESISTOR/resistor.cir) | `c0def3533cd6c07bf3cc6ee06f806c50d0b491d4d70d8296cc286ad8fc6066ba` | `benchmarks/corpus/xyce/fixtures/RESISTOR/resistor.cir` |
| `resistor-level3-zero` | resistor | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/RESISTOR/resistor_lv3.cir) | `ab40c80d1175ad3079155b07bfed914b7085a6d9396f16a577446deb7693eb81` | `benchmarks/corpus/xyce/fixtures/RESISTOR/resistor_lv3.cir` |
| `resistor-negative` | resistor | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/RESISTOR/resistor_neg.cir) | `7576379306251dd8c2baf89b4dbbe25527c399edb1fd701e7e5d38e83851614b` | `benchmarks/corpus/xyce/fixtures/RESISTOR/resistor_neg.cir` |
| `rlc-transient` | rlc | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/RLC/rlc.cir) | `4d52f9df5eb4fe814fdd137e3f66cd4b4ec6c988174e0fe1c7a19e6eddf21763` | `benchmarks/corpus/xyce/fixtures/RLC/rlc.cir` |
| `vccs-dc` | controlled-source | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/VCCS/vccs.cir) | `963d8d506600a2ac7f43812156739c8f49d332c50701f64268041ecd51b0306d` | `benchmarks/corpus/xyce/fixtures/VCCS/vccs.cir` |
| `vcvs-dc` | controlled-source | [upstream](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/VCVS/vcvs.cir) | `62541466b4010245a24d2c37b35c3debfc675b86f1bd3b2523fb91a01b4bbd5c` | `benchmarks/corpus/xyce/fixtures/VCVS/vcvs.cir` |

Validate all pinned fetches, fixture hashes, byte-identical engine inputs, declared analyses, and expected outcomes with:

    pnpm build
    node benchmarks/corpus/xyce/validate.mjs

At ingestion on ngspice-47, 13 circuits produce raw analysis data and 7 fail on explicitly reported Xyce/PSpice syntax or features. All 20 currently fail in spice-ts: 9 parse failures, 7 unsupported-feature failures, and 4 execution failures; no convergence failure is hidden or omitted. The validator emits every circuit and checks these outcomes rather than adapting inputs or changing tolerances.

## Project-authored parity fixtures

| Circuit | Source | Licence / redistribution basis | Local use |
| --- | --- | --- | --- |
| Showcase boost converter (5 V input, 100 kHz, 50% duty) | [spice-ts issue #43](https://github.com/mfiumara/spice-ts/issues/43) and `examples/showcase/main.tsx` | Authored in the spice-ts project by Mattia Fiumara; distributed under the repository [MIT licence](../LICENSE) | Identical netlist is exercised by `packages/core/src/analysis/transient-driver-integration.test.ts` and compared with ngspice-47 reference samples. |

## Independent current-source polarity parity fixtures

- Source: [spice-ts issue #196](https://github.com/mfiumara/spice-ts/issues/196) and the TDD reproduction introduced at revision [`61e05afe8c8bd7e6fd644410439dfbec0be97c19`](https://github.com/mfiumara/spice-ts/commit/61e05afe8c8bd7e6fd644410439dfbec0be97c19).
- Licence: MIT, under the repository [licence](../LICENSE).
- Redistribution decision: allowed. These three minimal netlists were authored in this project for issue #196 and contain no third-party circuit material.
- Adaptation: none between engines. `compare.ts` reads each committed file once and supplies those bytes to spice-ts and ngspice-47. No per-engine values, tolerances, or rewrites are used.
- Coverage: `op.cir`, `dc.cir`, and `tran.cir` exercise the shared positive-to-negative independent current-source stamp. An AC-form source's DC bias uses that stamp and has a core regression test. Nonzero independent current-source AC excitation uses a separate excitation path and is not claimed by this bounded comparison.
- Command: `pnpm bench:current-source-polarity`. The JSON report records commands, versions, machine data, convergence status, and max/RMS absolute and relative errors for `V(out)`.

## Independent current-source AC parity fixtures

- Source: [spice-ts issue #198](https://github.com/mfiumara/spice-ts/issues/198) and its TDD reproduction at revision [`61bef6f4a1a69420ef306e52de27bb0686379cac`](https://github.com/mfiumara/spice-ts/commit/61bef6f4a1a69420ef306e52de27bb0686379cac).
- Licence: MIT, under the repository [licence](../LICENSE).
- Redistribution decision: allowed. The three minimal netlists were authored in this project for issue #198 and contain no third-party circuit material.
- Adaptation: none. `compare.ts` reads each committed file once and supplies those exact bytes to spice-ts and ngspice-47. No engine-specific values, tolerances, or circuit rewrites are used.
- Coverage: grounded positive-to-ground orientation (`grounded.cir`, SHA-256 `0eb133dbf34d18fdf231a0d35d361d5040fd0d599a5b83a9de909c27e0a9c120`), phased non-ground node-pair orientation (`floating.cir`, SHA-256 `c3817778c2d5757caae8f2ad67771c3f58ee799e29c7974a5f0eb2a00a6e019f`), and deterministic mixed voltage/two-current-source complex superposition (`mixed.cir`, SHA-256 `50419ff61998734392e2c626ef5a2494eadd682de7d4da5e9c7962ed07467bfa`).
- Command: `pnpm bench:current-source-ac -- --output benchmarks/current-source-ac/results.json`. The JSON receipt records ngspice version, machine, commands, convergence, runtimes, and matched-frequency max/RMS absolute and relative errors. Every residual is retained as a loss; no superiority claim is made.

## Bounded diode-noise parity fixtures

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| Forward-biased diode shot and flicker noise, LIN/DEC/OCT | Original spice-ts benchmark specified by [issue #179](https://github.com/mfiumara/spice-ts/issues/179), issue revision as of 2026-10-10. Reference equations and behavior are pinned to ngspice source revision [`032b1c32`](https://github.com/ngspice/ngspice/blob/032b1c32/src/spicelib/devices/dio/dionoise.c). | Fixtures dedicated [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/); ngspice reference source is BSD-3-Clause under its pinned `COPYING`. | The three original fixture decks differ only in the `.noise` LIN/DEC/OCT card and are committed for unrestricted redistribution. No values or tolerances are adapted between engines; the runner adds only temporary ngspice output-control commands. | `benchmarks/diode-noise/diode-noise-{lin,dec,oct}.cir`; compare against ngspice-47 with `pnpm exec tsx benchmarks/diode-noise/compare.ts`. |

## Independent-source waveform syntax, issue #492

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| 14 minimal decks, one per parenthesised/extended source form | Source cards copied verbatim from ngspice examples at [`3ef069fb`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/): `cider/diode/{diode,diotran,pd1,pindiode}.cir`, `cider/mos/bootinv.cir`, `cider/serial/recovery.cir`, `cider/surfmob/Tbicmpd1.cir`, `xspice/original-examples/{arbitrary_phase,digital_models1,hybrid_models1_transient}.deck` (corpus-f batch 1, #484). One NP-truncation deck is project-authored. | ngspice examples are BSD-3-Clause; the project-authored deck and the added RC loads are MIT, as is this repository. | Each deck is the verbatim source card plus a linear RC load and the analysis line, so both engines can run it without CIDER/XSPICE devices. Both engines read the same text. ngspice also receives a `.control` block that only runs the deck and writes the vectors. | `benchmarks/source-waveform-syntax/compare.ts` writes `report.json`; the README there records every residual. |

## Resistor card forms, issue #498

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| `res_array.cir`, `res_partition.cir` (byte-identical) and 8 card-level decks from `loops/loop-model.cir`, `noise/resdiv.cir`, `noise/bipolar-noise.cir`, `regression/model/instance-defaults.cir`, `regression/pz/ac-resistance.cir`, `regression/temper/temper-res-1.cir` | ngspice tree [`3ef069fb`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/) `examples/` and `tests/` (corpus-f batch 1, #484). | BSD-3-Clause (ngspice); the added analysis cards are MIT, as is this repository. | `fixtures/res_array.cir` and `fixtures/res_partition.cir` are committed unmodified (SHA-256 in `report.json`). The other decks copy the resistor, source and model cards verbatim and replace the fixture's `.control` analysis with equivalent dot analysis cards; both engines read the same text except `temper-res-1` (`.dc temp` in ngspice, `.step TEMP` in spice-ts) and `ac-resistance-pz` (input source removed for both). | `pnpm exec tsx benchmarks/resistor-forms/compare.ts` writes `benchmarks/resistor-forms/report.json`; the README there records every residual and loss. |

## S/W switches, issue #507

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| `switches-manual-p92.cir` (byte-identical, CRLF) and 6 project-authored decks: `hysteresis.cir`, `ac-closed.cir`, `ac-window.cir`, `ac-csw.cir`, `noise-sw.cir`, `noise-csw.cir` | ngspice [`examples/probe/switches-manual-p92.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/probe/switches-manual-p92.cir) at `3ef069fb` (corpus-f batch 1, #484). The other decks are project-authored. | ngspice examples are BSD-3-Clause; the project-authored decks are MIT, as is this repository. | `fixtures/switches-manual-p92.cir` is committed unmodified (SHA-256 `93417fb9…44270`, also in `report.json`). Both engines read the deck with its `.control` block removed; ngspice also receives a `.control` block that only runs the deck and writes the vectors. | `pnpm exec tsx benchmarks/switches-507/compare.ts` writes `benchmarks/switches-507/report.json`; the README there records every residual and loss. |

## Seeded numparam statistics, issue #1594

The unchanged corpus-f `examples/Monte_Carlo/rand_numb_test.cir` comes from
[ngspice 3ef069fb](https://github.com/imr/ngspice/blob/3ef069fb1f04177a153f342a32d941fc20ff047e/examples/Monte_Carlo/rand_numb_test.cir)
(BSD-3-Clause; SHA-256 `15d5479502d67875e25bdc6608ec22639ee5952575b979dc3a86064e2464c759`).
`packages/core/src/parser/statistical-functions.ts` ports `src/frontend/numparam/xpressn.c:45-86`
and `src/maths/misc/randnumb.c:220-230` from that revision (BSD-3-Clause), reusing the
existing Tausworthe/LCG port and BSD/macOS libc seed initialization documented below.
Seeded values match ngspice-47 on macOS, not a cross-libc RNG guarantee.
The regression records `HOME=<scratch home containing .spiceinit with set numdgt=15> ngspice -b
benchmarks/corpus/corpus-f/fixtures/examples/Monte_Carlo/rand_numb_test.cir`:
`v(1) = 1.124431320988279e+00`. No deck cards are changed. The corpus runner reports
success but `not-compared` because ngspice's control block exports no raw vectors;
the dedicated regression compares the oracle voltage to relative error below 1e-9.
Native two-argument random `limit` is supported; the existing three-argument clamp
is intentionally retained, unlike native ngspice's silent third-argument discard.

## TRNOISE / TRRANDOM sources, issue #501

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| `benchmarks/trnoise-501/fixtures/seeded-vsrc.cir` (SHA-256 `932c40b4…ac75b1`), `seeded-isrc.cir` (`a0f2ec05…bc30a43`) and `pink-amplitude.cir` (`4c8c5df8…c24e199`); the corpus-f decks `examples/transient-noise/{rts-1,simple-noise,noise_vnoi}.cir` and `examples/various/mtimeavg_test.cir` | The two seeded decks are project-authored. The four corpus-f decks are ngspice examples at `3ef069fb` (corpus-f batch 1, #484), read from `benchmarks/corpus/corpus-f/fixtures`. RNG golden values in `packages/core/src/devices/transient-noise.test.ts` come from compiling ngspice-47 `src/maths/misc/randnumb.c` and `src/frontend/trannoise/wallace.c` unmodified (except `getpid()` fixed to 1) on macOS. The f_alpha golden values come from `benchmarks/trnoise-501/f-alpha-ref.c`, which carries ngspice-47 `src/frontend/trannoise/1-f-code.c` f_alpha (FFTW branch, © Holger Vogt 2008) verbatim except that the `GaussWa` draws are read from stdin, built against Homebrew libfftw3 3.3.11. | Project-authored decks are MIT, as is this repository; ngspice examples and sources (including the f_alpha body in `f-alpha-ref.c`) are BSD-3-Clause; FFTW (GPL-2.0-or-later) is only linked by the local reference build and is not redistributed. | No fixture is copied or edited. Both engines read each deck with its `.control` block removed (mtimeavg_test.cir also gets its `tran 0.5n 500n` as a `.tran` card); ngspice also receives a `.control` block that runs the deck, linearizes onto the TS grid (statistics only) and writes the vectors with `wrdata`. | `pnpm exec tsx benchmarks/trnoise-501/compare.ts` writes `benchmarks/trnoise-501/report.json`; the README there records every difference and loss. |

## XSPICE analog code models, issue #487

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| Unit-test cards in `packages/core/src/devices/xspice/xspice.test.ts` | The `analog_models1_dc` cards are copied from ngspice [`examples/xspice/original-examples/analog_models1_dc.deck`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/xspice/original-examples/analog_models1_dc.deck) at `3ef069fb` (corpus-f batch 1, #484). The limit, port-type, swept-DC, AC and transient cards are project-authored. | ngspice examples are BSD-3-Clause; the project-authored cards are MIT, as is this repository. | The copied cards keep their values. The `.op` line and resistor loads are unchanged; only the title and comment lines are dropped. Reference values come from ngspice-47 running the same cards with a `.control` print/meas block. | `pnpm --filter @spice-ts/core exec vitest run src/devices/xspice/xspice.test.ts`. The corpus-f deck outcomes and every loss are in `benchmarks/xspice/README.md`. No corpus fixture is added by this change: the decks come from #529. |

## XSPICE analog code models slice 2, issue #553

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| `benchmarks/xspice-553/fixtures/{op,dc-sweep-down,ac,tran,gd-ports}.cir` and the same cards in `packages/core/src/devices/xspice/xspice-analog2.test.ts` | The `hyst1`, `ilimit1`, `climit1`, `cmeter1` and `lmeter1` model cards in `op.cir` are copied from ngspice [`examples/xspice/original-examples/analog_models3_dc.deck`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/xspice/original-examples/analog_models3_dc.deck) at `3ef069fb` (corpus-f batch 1, #484). Every other card is project-authored. | ngspice examples are BSD-3-Clause; the project-authored cards are MIT, as is this repository. | The copied model cards keep their values, except `cmeter1`, which uses `gain=2.0` instead of 1.0. The added instances, sources, loads and `.control` blocks are project-authored. Reference values come from ngspice-47 running the fixture decks. spice-ts runs the same cards with the `.control` block replaced by the analysis line. | `pnpm --filter @spice-ts/core exec vitest run src/devices/xspice/` and `pnpm exec tsx benchmarks/xspice-553/compare-tran.ts`. The corpus-f `analog_models3`/`analog_models4` outcomes and every loss are in `benchmarks/xspice-553/README.md`. No corpus fixture is added or edited. |

## Bounded XSPICE s_xfer, issue #553 / PR #931

- Scoped registry and evidence at immutable implementation revision `1384bda7c87b7a3d177ee9124290b0019c3eac75`: [SOURCES.md](https://github.com/mfiumara/spice-ts/blob/1384bda7c87b7a3d177ee9124290b0019c3eac75/benchmarks/xspice-s-xfer-20261013/SOURCES.md), [receipt.json](https://github.com/mfiumara/spice-ts/blob/1384bda7c87b7a3d177ee9124290b0019c3eac75/benchmarks/xspice-s-xfer-20261013/receipt.json), and [README.md](https://github.com/mfiumara/spice-ts/blob/1384bda7c87b7a3d177ee9124290b0019c3eac75/benchmarks/xspice-s-xfer-20261013/README.md). These links remain valid before and after that implementation merges.
- Reference source revision `3ef069fb1f04177a153f342a32d941fc20ff047e` (ngspice-47): [`src/xspice/icm/analog/s_xfer/cfunc.mod`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/src/xspice/icm/analog/s_xfer/cfunc.mod) and [`ifspec.ifs`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/src/xspice/icm/analog/s_xfer/ifspec.ifs) explicitly declare Public Domain, Georgia Tech Research Corporation. Their unmodified copies in the scoped `source/` directory have SHA-256 `85b2c0a254268b9b2ff9a01b0a37074956c64fef9339c3feb99c64b9e6d6a30f` and `afc17c3ed3a6dc3292650c1d68c6cb78ac09044da4527b468e0fd7f683ec0ac4`, respectively. Redistribution is allowed.
- The eight project-authored reductions `benchmarks/xspice-s-xfer-20261013/{op-ic,dc-zero,ac-lowpass,ac-bandpass,tran-first,tran-second,tran-gear,tran-ic}.cir` and harness are MIT under the repository [licence](../LICENSE), not copies of the original ngspice decks. Both engines receive identical input bytes; all input and uncompressed reference-output hashes are retained in the receipt. The bounded contract covers strictly proper denominator-order-1/2 models only. Transient residuals remain published, not full parity wins.
- The five unchanged originals are existing corpus-f selections at the same full upstream revision: [`examples/xspice/original-examples/analog_models2_ac.deck`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/xspice/original-examples/analog_models2_ac.deck), [`analog_models2_dc.deck`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/xspice/original-examples/analog_models2_dc.deck), [`analog_models2_swept_dc.deck`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/xspice/original-examples/analog_models2_swept_dc.deck), [`analog_models2_transient.deck`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/xspice/original-examples/analog_models2_transient.deck), and [`examples/xspice/various/x_fer.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/examples/xspice/various/x_fer.cir). They remain BSD-3-Clause under the pinned [COPYING](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/COPYING), with redistribution notices, paths and hashes in `benchmarks/corpus/corpus-f/{SOURCES.md,LICENSE.txt,manifest.json}` and each original's receipt record. No original fixture bytes are duplicated or edited.
- All five originals remain parity losses. The four `analog_models2` decks stop on unsupported `core` (`lcouple` is also outside the slice). `x_fer.cir` completes natively, but fresh ngspice exports no raw vectors for its control deck, so its error metrics remain null. This registration adds no corpus fixtures or parity successes and does not change manifests, outcomes or aggregate receipts.
- Adding this central entry changes the source-registry hash used by nightly #855. Reconcile that pin in the authorized nightly lane; this registration does not repin or rerun the aggregate.

## BSIM1/BSIM2 MOSFETs, issue #657

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| 6 project-authored decks in `benchmarks/bsim12-657/fixtures/`: `bsim1-output-inverse.cir`, `bsim2-pmos-output.cir`, `bsim1-rload-tran.cir`, `bsim2-inverter-tran.cir`, `bsim1-cs-ac.cir`, `bsim2-cs-ac.cir` | The circuits are project-authored. Their `.model` cards are copied unchanged from the SPICE3F5 [`examples/bsim1tst.cir`](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/bsim1tst.cir) and [`examples/bsim2tst.cir`](https://github.com/obernin/spice/blob/3d9360bef370b432e473edb0c4333707d545a55f/examples/bsim2tst.cir) at `3d9360be` (already committed as corpus classic/bsim1-device-sweep and classic/bsim2-device-sweep); two decks also declare the same parameter set as a PMOS card. | Circuits: MIT, as is this repository. Model cards: Berkeley SPICE grant (see the classic corpus entry above). | Committed; the Berkeley notice is retained byte-identical at `benchmarks/bsim12-657/COPYRIGHT.txt`. SHA-256 of every deck is in `benchmarks/bsim12-657/report.json`. | `pnpm exec tsx benchmarks/bsim12-657/compare.ts` runs the decks and the two classic fixtures through ngspice-47 and spice-ts and writes `report.json`; the README there records every residual and loss. |

## Chua & Lin circuit, issue #48

- Fixture: `benchmarks/circuits/chua-issue-48.cir`
- Source: [spice-ts issue #48](https://github.com/mfiumara/spice-ts/issues/48), opened by Mattia Fiumara on 2026-05-05, including an LTspice schematic labelled “Chua & Lin, 8-7 page 343”.
- Reconstruction: transcribed from that issue screenshot. The issue text explicitly confirms `C12 ic=2 V` and `C3 ic=5 V`; the screenshot additionally shows `L8 ic=2 A`, the three coupling coefficients, component values, source parameters, and `.tran 0 200 0 0.2 uic`.
- Licence: the fixture is an original plain-text reconstruction contributed to this MIT-licensed repository. The source screenshot is linked for provenance but is not redistributed.
- Reference simulator: ngspice-47. Because ngspice rejects LTspice’s zero print-step extension, the reference run changes only the first `.tran` operand from `0` to `0.2`; `tstop`, `tstart`, `tmax`, topology, values, and initial conditions remain identical.
- Reference command: `pnpm exec tsx benchmarks/chua-ngspice.ts`. The script applies the documented `.tran` adaptation, runs ngspice in batch mode, and prints the waveform metrics as JSON.
- ngspice-47 reference (56,663 accepted points): after 20 s, `V(y)` spans 0.454439238–1.03693966 V and crosses its post-20 s mean five times. These envelope/crossing metrics are used instead of pointwise chaotic-waveform equality.
- spice-ts diagnosis after adding bounded K-element/UIC support: because semantic `.options` directives remain explicitly unsupported, the native run removes only `.options reltol=1e-12` and supplies the identical `reltol` through `SimulationOptions`. After reconciling the issue #43 boost-convergence fix, it still ends with `TimestepTooSmallError`, now at `t=0.2000001935667476 s` (`dt=1.7759231585312563e-16 s`) with the normal transient iteration budget. Two reconciliation runs reproduced the same failure coordinates and took 3.28 s and 2.77 s on the development machine, versus 45.664 s at the pre-reconciliation head. This is reported as a remaining transient-convergence gap, not parity.

## MESFET/HFET Z-card levels, issue #500

| Circuit(s) | Canonical source / revision | Licence | Redistribution / adaptation | Local use |
|---|---|---|---|---|
| 7 byte-identical ngspice decks: `hfet-id_vgs.cir`, `mes-subth.cir`, `mesa-mesa13.cir`, `mesa-mesa15.cir`, `mesa-mesa21.cir`, `mesa-mesgout.cir`, `mesa-mesinv.cir`; 8 project-authored decks `authored-*.cir` | ngspice [`tests/hfet/id_vgs.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/hfet/id_vgs.cir), [`tests/mes/subth.cir`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/mes/subth.cir) and [`tests/mesa/`](https://sourceforge.net/p/ngspice/ngspice/ci/3ef069fb1f04177a153f342a32d941fc20ff047e/tree/tests/mesa/) `mesa13.cir`, `mesa15.cir`, `mesa21.cir`, `mesgout.cir`, `mesinv.cir` at `3ef069fb` (the corpus-f batch 1 copies, #484). The `authored-*` decks are project-authored. | ngspice tests are BSD-3-Clause (upstream `COPYING`, copy at `benchmarks/corpus/corpus-f/LICENSE.txt`); the project-authored decks are MIT, as is this repository. | The ngspice decks are committed unmodified under a flattened name (`<dir>-<file>`); their SHA-256 equals the corpus-f manifest and is recorded per fixture in `report.json`. Both engines read each deck with `.end` removed; ngspice also receives a `.control` block that only runs the deck and writes the compared vectors. | `pnpm exec tsx benchmarks/mesfet-hfet-500/compare.ts` writes `benchmarks/mesfet-hfet-500/report.json`; `packages/core/src/mesfet-hfet-500.test.ts` pins sampled ngspice-47 values. Every residual and loss is in `benchmarks/mesfet-hfet-500/README.md`. |

## Convergence audit fixtures

All benchmark material must identify its origin and redistribution terms. The
comparison harness runs the checked-in netlist unchanged in spice-ts and
ngspice; runner-added `.control` commands only export results and resource
statistics.

| Fixture(s) | Origin | Licence | Source / rationale |
|---|---|---|---|
| Generated DC scaling resistor ladder (`benchmarks/performance/scaling-fixture.mjs`) | Original spice-ts fixture | MIT (repository licence) | Deterministically generated; the same byte-for-byte netlist is supplied to spice-ts and ngspice. No third-party circuit material is included. |
| `convergence/circuits/gmin-reverse-diode.cir` | Original spice-ts fixture | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Authored for issue #56 to stress a nearly floating, reverse-biased nonlinear DC node. No third-party netlist was copied. |
| `convergence/circuits/source-step-bjt.cir` | Original spice-ts fixture | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Authored for issue #56 to stress the nonlinear DC solve with a high-beta, low-emitter-resistance BJT. No third-party netlist was copied. |
| `convergence/circuits/timestep-diode-rectifier.cir` | Original spice-ts fixture | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Authored for issue #56 to stress transient rejection at 1 ns diode-commutation edges. No third-party netlist was copied. |

Strategy references used by the audit, not copied into the fixtures:

- ngspice manual, convergence options and transient analysis: https://ngspice.sourceforge.io/docs/ngspice-html-manual/manual.xhtml
- ngspice `CKTop` operating-point fallback implementation (`src/spicelib/analysis/cktop.c`), GPL-2.0-or-later: https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/src/spicelib/analysis/cktop.c
- ngspice transient retry/timestep implementation (`src/spicelib/analysis/dctran.c`), GPL-2.0-or-later: https://sourceforge.net/p/ngspice/ngspice/ci/master/tree/src/spicelib/analysis/dctran.c

## M2 generated scaling decks, issue #426

- Generator: `benchmarks/performance/scaling-m2-fixture.mjs`, added in [`34e85e9`](https://github.com/mfiumara/spice-ts/commit/34e85e9ef6e87219ff39a8ca2ef1a6892caf711c) (PR #476). Harness: `benchmarks/performance/scaling-m2.ts`; methodology and published results, losses included: `benchmarks/PERFORMANCE_BASELINE.md`.
- Origin: original material generated for this repository. No third-party circuit, model card or netlist is used. The MOS1 cards (`vto=±0.5`, `kp=120u/60u`, `lambda=0.02`) are generic hand-picked level-1 values, not vendor models.
- Licence: MIT, under the repository [licence](../LICENSE). Redistribution is allowed; the decks are regenerated deterministically and are not committed as files.
- Adaptation: none. Each circuit/size yields one byte-identical deck that is given unchanged to spice-ts and ngspice. The ngspice linear solver (KLU or Sparse 1.3) is chosen outside the deck by a per-run `.spiceinit`, so the deck hash is the same for every engine cell.
- Reference simulator: ngspice-47 (Homebrew build, KLU compiled in), as recorded in `versions.ngspice` of the receipt `benchmarks/performance/results/scaling-m2.json`.
- Deck SHA-256 values below equal the `netlistSha256` of every row in that receipt. The mesh rounds up to a square, so emitted nodes can exceed the requested size.

| Circuit | Requested nodes | Emitted nodes | Deck SHA-256 |
|---|---|---|---|
| `rc-ladder-tran` | 1000 | 1000 | `0944ed6b76f64f56c8e04b48919f1e12b9de19df4e5a08708c4be314fa7a91b7` |
| `rc-ladder-tran` | 10000 | 10000 | `eb21933fd99fcbc32276816a4f389ba216dcdddc29683551a67f606f352dfca7` |
| `rc-ladder-tran` | 50000 | 50000 | `2fd0c2090d17dddf80980eb3391440a3e4f99e1a77d1158360ffedc4246a7ada` |
| `resistor-mesh-op` | 1000 | 1024 | `6c6d5adb109cdde9ac844c3346135f4e7ffc352626b2f3c430598c0ebd9d8d40` |
| `resistor-mesh-op` | 10000 | 10000 | `c88e6076daf2523437e3da014d7a3c329f679a7405f789530c5c805f447ed0dc` |
| `resistor-mesh-op` | 50000 | 50176 | `f81ed198f7ba67068138846b12fe93b9ec957e6bb3a89300d2c7c50e30d47329` |
| `cmos-inverter-chain-tran` | 1000 | 1000 | `1a9866593c778a9fa26e23c1916c7b00b1bdb1adc2e7a246d9e3f4aa4f1ca1e1` |
| `cmos-inverter-chain-tran` | 10000 | 10000 | `2ce663326238609299d8628016b1211632f1474e9d40b6c39747fff964999a18` |
| `cmos-inverter-chain-tran` | 50000 | 50000 | `d680f1054eb14002980a7a65eb68a5dddae8063a871050fde025e8f5080bc543` |

- CI gate: `benchmarks/performance/scaling-m2.test.ts` runs in CI (`build` job) and in `pnpm test`. It takes about a second and needs no ngspice. It checks determinism, node counts, deck directives, the ngspice output parser, and that the generator, the receipt and this table agree on all nine hashes. The timing matrix itself (`pnpm bench:scaling:m2`, about 56 minutes, machine-dependent) is excluded from CI and run by hand; its JSON receipt is the evidence of record.

## AC generated scaling decks, issue #740

- Generator: `benchmarks/performance/results/issue-740/scripts/ac-fixture.mjs` (`rc-ladder-ac`, `rc-mesh-ac`, `vcvs-ladder-ac`). Harness, methodology and published results, losses included: `benchmarks/performance/results/issue-740/README.md` and the #740 section of `benchmarks/PERFORMANCE_BASELINE.md`.
- Origin: original material generated for this repository. `rc-ladder-ac` and `rc-mesh-ac` are the #426 RC ladder and resistor mesh with an AC source (and 1 pF per mesh node); `vcvs-ladder-ac` is rebuilt from the deck description in issue #740 / #732 (the original deck was not committed). No third-party circuit or model card is used.
- Licence: MIT, under the repository [licence](../LICENSE). The decks are regenerated deterministically and are not committed as files.
- Adaptation: none. Each circuit/size yields one byte-identical deck given unchanged to spice-ts and ngspice-47; the ngspice solver (`option klu` / `option sparse`) and print precision (`set numdgt=15`) are set outside the deck by a per-run `.spiceinit`.

| Circuit | Requested size | Emitted nodes | AC points | Deck SHA-256 |
|---|---|---|---|---|
| `rc-ladder-ac` | 1000 | 1000 | 71 | `e37ab2a1c1f197c3d872bb293cf0e01b2a2acacf7947839839b669365fe50bef` |
| `rc-ladder-ac` | 10000 | 10000 | 71 | `90be29fac51cf5f87cca6e9fc4ffaebd50ad10a7e2c443ceb2be06c4a641f0eb` |
| `rc-ladder-ac` | 50000 | 50000 | 71 | `2b94f30a25ac5772ec89d103d5bbb246899cd74a9826d03f826fd194b64c989e` |
| `rc-mesh-ac` | 1000 | 1024 | 13 | `b91fae5efb87b9f111c8f068978931b16ec9227d640a01cdbee3f256142ef028` |
| `rc-mesh-ac` | 10000 | 10000 | 13 | `48df2c984867fdf9611cd5d3ba1d96ec6951ff4073b12cff5bbc5d058b52774b` |
| `rc-mesh-ac` | 50000 | 50176 | 13 | `2bdba0e73cd47299d6ba5914bfc67733895f98c88f27ec135da10188a80a961f` |
| `vcvs-ladder-ac` | 2000 stages | 2121 | 451 | `6d50413f0510255e0eabab2dd3c68c4d70b7c0d692a199dbfadbfef73913e327` |

## Gnucap public corpus E

- Repository: https://github.com/gnucap/gnucap
- Pinned revision: `5acb027125d6ea7c546badd03e026d8781c6a400`
- Licence: GNU General Public License v3.0 or later (`GPL-3.0-or-later`).
- Licence sources: pinned [`tests/MakeList`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/MakeList) notice and pinned complete [`COPYING`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/COPYING) text.
- Redistribution decision: allowed under GPL-3.0-or-later; the selected source-form tests are committed verbatim with the upstream test-suite notice and complete GPLv3 text.
- Adaptation: none. Fixture bytes and analysis/tolerance directives are unchanged from the pinned source.
- Category accounting: OP/DC 4, AC 4, TRAN 4, nonlinear 4, convergence-hard 4.

| ID | Category | Canonical source | Licence | Redistribution | Local path |
|---|---|---|---|---|---|
| `cccs-mixed-analysis` | op-dc | [`tests/d_cccs.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_cccs.1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_cccs.1.ckt` |
| `vcvs-operating-point` | op-dc | [`tests/d_vcvs.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_vcvs.1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_vcvs.1.ckt` |
| `diode-bias-sweep` | op-dc | [`tests/d_diode.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_diode.1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_diode.1.ckt` |
| `mos1-inverter-sweep` | op-dc | [`tests/d_mos1.inv1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_mos1.inv1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_mos1.inv1.ckt` |
| `transmission-line-ac` | ac | [`tests/d_trln.ac.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_trln.ac.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_trln.ac.ckt` |
| `mutual-inductance-ac` | ac | [`tests/d_coil.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_coil.1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_coil.1.ckt` |
| `bjt-diffpair-ac` | ac | [`tests/d_bjt-diffpair-tf.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_bjt-diffpair-tf.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_bjt-diffpair-tf.ckt` |
| `opamp-open-loop-ac` | ac | [`tests/opamp-ol.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/opamp-ol.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/opamp-ol.ckt` |
| `capacitor-step-transient` | tran | [`tests/d_cap.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_cap.1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_cap.1.ckt` |
| `capacitor-initial-condition` | tran | [`tests/d_cap.ic1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_cap.ic1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_cap.ic1.ckt` |
| `lc-oscillator-transient` | tran | [`tests/oscillator.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/oscillator.1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/oscillator.1.ckt` |
| `bjt-diffpair-transient` | tran | [`tests/d_bjt-diffpair-tran.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_bjt-diffpair-tran.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_bjt-diffpair-tran.ckt` |
| `bjt-schmitt-trigger` | nonlinear | [`tests/d_bjt-schmitt-nobypass.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_bjt-schmitt-nobypass.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_bjt-schmitt-nobypass.ckt` |
| `diode-temperature-sweep` | nonlinear | [`tests/d_diode.6.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_diode.6.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_diode.6.ckt` |
| `mos1-nand-transient` | nonlinear | [`tests/d_mos1.nand1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_mos1.nand1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_mos1.nand1.ckt` |
| `bjt-rtl-inverter-chain` | nonlinear | [`tests/d_bjt-rtlinv.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_bjt-rtlinv.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_bjt-rtlinv.ckt` |
| `dual-lc-uic-rejection` | convergence | [`tests/oscillator.7.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/oscillator.7.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/oscillator.7.ckt` |
| `opamp-voltage-follower` | convergence | [`tests/opamp-vf.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/opamp-vf.1.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/opamp-vf.1.ckt` |
| `mos7-nand-no-bypass` | convergence | [`tests/d_mos7.nand1.nobypass.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_mos7.nand1.nobypass.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_mos7.nand1.nobypass.ckt` |
| `bjt-diffpair-current-source` | convergence | [`tests/d_bjt-diffpair-ccs.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_bjt-diffpair-ccs.ckt) | GPL-3.0-or-later | committed verbatim | `benchmarks/corpus/corpus-e/fixtures/tests/d_bjt-diffpair-ccs.ckt` |

Validate pinned provenance, unique hashes, byte-identical engine inputs, category accounting, and every visible engine result with:

    pnpm build
    node benchmarks/corpus/corpus-e/validate.mjs

The pinned validation receipt is `a2acada11be950a85fdafebb6f346880ea0acaf0051261a796d2125694a65924`: ngspice-47 passes 5/20 and reports 15 unchanged-dialect failures; spice-ts passes 0/20 and reports 20 parse, unsupported, or convergence failures. These losses are retained rather than adapted or omitted.

## Gnucap corpus E translated to SPICE3 (corpus-e-spice3, issue #524 lane 2)

- Repository: https://github.com/gnucap/gnucap
- Pinned revision: `5acb027125d6ea7c546badd03e026d8781c6a400` (same pin as corpus E).
- Licence: GNU General Public License v3.0 or later (`GPL-3.0-or-later`), for both the translated decks and the Gnucap reference outputs.
- Licence retention: byte-identical pinned [`tests/MakeList`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/MakeList) notice as `benchmarks/corpus/corpus-e-spice3/LICENSE-NOTICE.MakeList` (SHA-256 `c601be3b6a490b37c25e23e6a3b5ac5b34eedf07555a5b0ae01349b6cea474eb`) and byte-identical pinned [`COPYING`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/COPYING) as `benchmarks/corpus/corpus-e-spice3/COPYING.txt` (SHA-256 `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`).
- Redistribution decision: Allowed under GPL-3.0-or-later. Translated decks are modified versions of the Gnucap tests, redistributed under the same licence with the tests/MakeList notice and the full GPLv3 text; every modified deck states that it was modified, by what, and when (2026-10-11) in its header. Gnucap reference outputs (tests/==out) are redistributed verbatim.
- Deck provenance: `fixtures/*.cir` are modified versions of the byte-identical corpus E originals in `benchmarks/corpus/corpus-e/fixtures/tests/*.ckt`. They are generated by the project-authored translator `benchmarks/translate/gnucap-to-spice3.ts` (deterministic; `--check` verifies committed output) on 2026-10-11. The translation is syntax-only and never changes topology, element values, models or analyses; each deck header and `manifest.json` (`translation.changes`) list every change, and `translations.json` records the per-fixture translation status, hashes and change list. Fixtures needing anything beyond the documented syntax rules are recorded as `unsupported-translation` with reasons and no deck is committed.
- Reference provenance: `reference/gnucap-out/*.ckt.out` are Gnucap's own upstream regression outputs from `tests/==out/` at the pinned revision, copied byte for byte (no adaptation). Gnucap produced them from the ORIGINAL decks, at its own strobe points and probe set, so they are a descriptive third column, not a byte-matched engine comparison.
- Project-authored support files (MIT, this repository): `README.md`, `manifest.json`, `translations.json`, `run-engines.ts`, and `benchmarks/translate/gnucap-to-spice3.ts` with its test.
- Coverage: 12 translated decks and 15 Gnucap reference outputs (3 for unsupported translations).

| ID | Category | Upstream deck | Translation | Local deck (SHA-256 prefix) | Upstream reference | Local reference (SHA-256 prefix) |
|---|---|---|---|---|---|---|
| `cccs-mixed-analysis` | op-dc | [`tests/d_cccs.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_cccs.1.ckt) | translated (6 syntax changes, listed in the deck header and manifest) | `fixtures/d_cccs.1.cir` (`65800d08f5ae`) | [`tests/==out/d_cccs.1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_cccs.1.ckt.out) | `reference/gnucap-out/d_cccs.1.ckt.out` (`302d7b8d52b3`) |
| `vcvs-operating-point` | op-dc | [`tests/d_vcvs.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_vcvs.1.ckt) | translated (10 syntax changes, listed in the deck header and manifest) | `fixtures/d_vcvs.1.cir` (`00d220af322f`) | [`tests/==out/d_vcvs.1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_vcvs.1.ckt.out) | `reference/gnucap-out/d_vcvs.1.ckt.out` (`cc32fd9d2117`) |
| `mutual-inductance-ac` | ac | [`tests/d_coil.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_coil.1.ckt) | translated (5 syntax changes, listed in the deck header and manifest) | `fixtures/d_coil.1.cir` (`1f7c99b465df`) | [`tests/==out/d_coil.1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_coil.1.ckt.out) | `reference/gnucap-out/d_coil.1.ckt.out` (`496e9232068f`) |
| `bjt-diffpair-ac` | ac | [`tests/d_bjt-diffpair-tf.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_bjt-diffpair-tf.ckt) | translated (5 syntax changes, listed in the deck header and manifest) | `fixtures/d_bjt-diffpair-tf.cir` (`4d4ec35915c2`) | [`tests/==out/d_bjt-diffpair-tf.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_bjt-diffpair-tf.ckt.out) | `reference/gnucap-out/d_bjt-diffpair-tf.ckt.out` (`023823372cd0`) |
| `capacitor-step-transient` | tran | [`tests/d_cap.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_cap.1.ckt) | translated (3 syntax changes, listed in the deck header and manifest) | `fixtures/d_cap.1.cir` (`cca6e79eb0b8`) | [`tests/==out/d_cap.1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_cap.1.ckt.out) | `reference/gnucap-out/d_cap.1.ckt.out` (`bbc177787c4d`) |
| `capacitor-initial-condition` | tran | [`tests/d_cap.ic1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_cap.ic1.ckt) | translated (1 syntax change, listed in the deck header and manifest) | `fixtures/d_cap.ic1.cir` (`e4ff0bbe53f4`) | [`tests/==out/d_cap.ic1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_cap.ic1.ckt.out) | `reference/gnucap-out/d_cap.ic1.ckt.out` (`2d5d14d49798`) |
| `lc-oscillator-transient` | tran | [`tests/oscillator.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/oscillator.1.ckt) | translated (4 syntax changes, listed in the deck header and manifest) | `fixtures/oscillator.1.cir` (`2926b46a55e9`) | [`tests/==out/oscillator.1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/oscillator.1.ckt.out) | `reference/gnucap-out/oscillator.1.ckt.out` (`4994e28de979`) |
| `bjt-schmitt-trigger` | nonlinear | [`tests/d_bjt-schmitt-nobypass.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_bjt-schmitt-nobypass.ckt) | translated (2 syntax changes, listed in the deck header and manifest) | `fixtures/d_bjt-schmitt-nobypass.cir` (`6974ee6972fe`) | [`tests/==out/d_bjt-schmitt-nobypass.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_bjt-schmitt-nobypass.ckt.out) | `reference/gnucap-out/d_bjt-schmitt-nobypass.ckt.out` (`5b4fbe1d374c`) |
| `diode-temperature-sweep` | nonlinear | [`tests/d_diode.6.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_diode.6.ckt) | translated (5 syntax changes, listed in the deck header and manifest) | `fixtures/d_diode.6.cir` (`208068d25733`) | [`tests/==out/d_diode.6.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_diode.6.ckt.out) | `reference/gnucap-out/d_diode.6.ckt.out` (`dd58e46202e9`) |
| `mos1-nand-transient` | nonlinear | [`tests/d_mos1.nand1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_mos1.nand1.ckt) | translated (9 syntax changes, listed in the deck header and manifest) | `fixtures/d_mos1.nand1.cir` (`57de959ed069`) | [`tests/==out/d_mos1.nand1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_mos1.nand1.ckt.out) | `reference/gnucap-out/d_mos1.nand1.ckt.out` (`a1b4e2fb63bf`) |
| `dual-lc-uic-rejection` | convergence | [`tests/oscillator.7.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/oscillator.7.ckt) | translated (6 syntax changes, listed in the deck header and manifest) | `fixtures/oscillator.7.cir` (`0d9459725ec0`) | [`tests/==out/oscillator.7.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/oscillator.7.ckt.out) | `reference/gnucap-out/oscillator.7.ckt.out` (`3f55221ce7ba`) |
| `opamp-voltage-follower` | convergence | [`tests/opamp-vf.1.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/opamp-vf.1.ckt) | translated (9 syntax changes, listed in the deck header and manifest) | `fixtures/opamp-vf.1.cir` (`6143822b2505`) | [`tests/==out/opamp-vf.1.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/opamp-vf.1.ckt.out) | `reference/gnucap-out/opamp-vf.1.ckt.out` (`d41afa4cd582`) |
| `transmission-line-ac` | ac | [`tests/d_trln.ac.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_trln.ac.ckt) | unsupported-translation (no deck committed; reasons in manifest) | - | [`tests/==out/d_trln.ac.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_trln.ac.ckt.out) | `reference/gnucap-out/d_trln.ac.ckt.out` (`ee03920f9cd3`) |
| `opamp-open-loop-ac` | ac | [`tests/opamp-ol.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/opamp-ol.ckt) | unsupported-translation (no deck committed; reasons in manifest) | - | [`tests/==out/opamp-ol.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/opamp-ol.ckt.out) | `reference/gnucap-out/opamp-ol.ckt.out` (`59e300d8d416`) |
| `mos7-nand-no-bypass` | convergence | [`tests/d_mos7.nand1.nobypass.ckt`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/d_mos7.nand1.nobypass.ckt) | unsupported-translation (no deck committed; reasons in manifest) | - | [`tests/==out/d_mos7.nand1.nobypass.ckt.out`](https://github.com/gnucap/gnucap/blob/5acb027125d6ea7c546badd03e026d8781c6a400/tests/==out/d_mos7.nand1.nobypass.ckt.out) | `reference/gnucap-out/d_mos7.nand1.nobypass.ckt.out` (`72556ecf692e`) |

Local paths are relative to `benchmarks/corpus/corpus-e-spice3/`; full SHA-256 values are in `manifest.json`. Verify hashes, licence files and that the committed decks equal the translator output with:

    pnpm exec tsx --test benchmarks/translate/gnucap-to-spice3.test.ts

## ahkab test-suite corpus D

- Repository: https://github.com/ahkab/ahkab
- Pinned revision: `1e8939194b689909b8184ce7eba478b485ff9e3a`
- Licence: GPL-2.0-only. The pinned repository README identifies the project as GPLv2, and the pinned [`COPYING`](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/COPYING) contains the complete GNU GPL version 2 terms.
- Licence retention: the byte-identical upstream README is retained as `benchmarks/corpus/corpus-d/LICENSE-NOTICE.md` (SHA-256 `064b6a2dd3536d1699e32ffec05e3f960bd8eccda8e300109878bf2569915b2f`), and the byte-identical GPLv2 text is retained as `benchmarks/corpus/corpus-d/COPYING.txt` (SHA-256 `ee8a06e8bf69c8b547477f2a6652d330f4a4bc7d8a29d0b8b573b19abfc06e71`).
- Redistribution decision: allowed under GPL-2.0-only. These source-form test circuits are redistributed verbatim with the upstream project notice and full licence text.
- Adaptation: none. All 20 `.ckt` files are committed byte-for-byte from the pinned revision. The validator fetches each pinned source, checks exact bytes and hashes, and supplies the same local bytes to native ngspice and spice-ts without tolerance or circuit changes.

| ID | Category | Canonical source | SHA-256 | Local path |
|---|---|---|---|---|
| `ohms-law-op` | op-dc | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/ohms_law/ohms_law.ckt) | `be2e9901695aab2a53c140f845bb0fe41d3c43eecd41cddca3ce6c4946b5bbd2` | `benchmarks/corpus/corpus-d/fixtures/tests/ohms_law/ohms_law.ckt` |
| `diode-operating-point` | op-dc | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/diode_op/diode_op.ckt) | `1c7dbbf5941ce07f6806803f1c22df8165acde82d5dd66f9a9076da009e19b8e` | `benchmarks/corpus/corpus-d/fixtures/tests/diode_op/diode_op.ckt` |
| `ekv-bias-sweep` | op-dc | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/ekv1/ekv1.ckt) | `2d680251e499b4b857ea78280d8e8c0e2114eb0977d2b1b4f69ba234a08f0271` | `benchmarks/corpus/corpus-d/fixtures/tests/ekv1/ekv1.ckt` |
| `downscaling-current-mirror` | op-dc | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/downscaling_cm/downscaling_cm.ckt) | `09fa542dd664647c2deaef15f2d8bf07f7f3e30b40e7e6a9242673b62d28da1f` | `benchmarks/corpus/corpus-d/fixtures/tests/downscaling_cm/downscaling_cm.ckt` |
| `transresistance-ac` | ac | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/hvsource/hvsource.ckt) | `e9c675ae1029b278422be65104ef1c10925d3506b7432274c9dce4c8c49d0765` | `benchmarks/corpus/corpus-d/fixtures/tests/hvsource/hvsource.ckt` |
| `passive-pole-zero-ac` | ac | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/pz1/pz1.ckt) | `3a597bfe073b0d0219444b15559e6390a2aabe9ca8f1b9246db626efd8dda94c` | `benchmarks/corpus/corpus-d/fixtures/tests/pz1/pz1.ckt` |
| `resistor-voltage-ac` | ac | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/rvtest2/rvtest2.ckt) | `a632b37a296d71114ea1bb8185029e041c28f86defdc4e6e671dfbe55de3a6ed` | `benchmarks/corpus/corpus-d/fixtures/tests/rvtest2/rvtest2.ckt` |
| `series-resonance-ac` | ac | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/series_resonance/series_resonance.ckt) | `6b687bc2f3cd7415af561f26e80669ce8df3e08be977958dbc6db1446f5f22d0` | `benchmarks/corpus/corpus-d/fixtures/tests/series_resonance/series_resonance.ckt` |
| `am-source-transient` | tran | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/amckt/amckt.ckt) | `e5027b8f925e83ac09ef477b77b7219b215dcb74e0e172c8369c3c777a7e5632` | `benchmarks/corpus/corpus-d/fixtures/tests/amckt/amckt.ckt` |
| `fft-source-transient` | tran | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/fft_ckt/fft_ckt.ckt) | `04d2554f966d5ffd8cfd00f665575e02d11045790cf201bb596b610c0e2ff59b` | `benchmarks/corpus/corpus-d/fixtures/tests/fft_ckt/fft_ckt.ckt` |
| `coupled-transformer-transient` | tran | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/transformer/transformer.ckt) | `df9bf42844508fc38edffdc685e935ac90e10bde5fab0ee957ce68f5da6ba4a5` | `benchmarks/corpus/corpus-d/fixtures/tests/transformer/transformer.ckt` |
| `rlc-trapezoidal-transient` | tran | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/tran_trap/tran_trap.ckt) | `8932d8cc9e536d8ad910c67d199536f39750dea7a0ff282d9ee81bc861145cc8` | `benchmarks/corpus/corpus-d/fixtures/tests/tran_trap/tran_trap.ckt` |
| `diode-voltage-doubler` | nonlinear | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/diode_mult/diode_mult.ckt) | `de110e81dd425b8117efd6acd32d7d4311b854bf1236715f3233b1e12419da50` | `benchmarks/corpus/corpus-d/fixtures/tests/diode_mult/diode_mult.ckt` |
| `ekv-ring-oscillator` | nonlinear | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/ring3/ring3.ckt) | `300a3d7c7441224ce67bbed31f9ecd334e8dd79cf4bfbeca9e49dc673a09f9ef` | `benchmarks/corpus/corpus-d/fixtures/tests/ring3/ring3.ckt` |
| `cockcroft-walton-x8` | nonlinear | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/diodecw8/diodecw8.ckt) | `050a38d7396b25410446e79dd8106578825bcce223f4c2cb0bb6889fdb18727b` | `benchmarks/corpus/corpus-d/fixtures/tests/diodecw8/diodecw8.ckt` |
| `pwm-switch` | nonlinear | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/switch1/switch1.ckt) | `e3d1544f41fef2361132c89b6a85776f3e2f32c7ec95b1321144c82cd6799ff5` | `benchmarks/corpus/corpus-d/fixtures/tests/switch1/switch1.ckt` |
| `rlc-gear3` | convergence | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/tran_gear3/tran_gear3.ckt) | `98fd4fd298a27da8d9286ec29a1af412b7fa7d9098809b8f0635dc42e9062219` | `benchmarks/corpus/corpus-d/fixtures/tests/tran_gear3/tran_gear3.ckt` |
| `rlc-gear5` | convergence | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/tran_gear5/tran_gear5.ckt) | `ac0ae49a5c9868c6d783449b84514d69e9dc171354782d53785b1b2300a064a4` | `benchmarks/corpus/corpus-d/fixtures/tests/tran_gear5/tran_gear5.ckt` |
| `rlc-gear6` | convergence | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/tran_gear6/tran_gear6.ckt) | `1974b92f58344b953e481e579f63a374d722ca3a90bff1d3b305d2c35fb3d5d6` | `benchmarks/corpus/corpus-d/fixtures/tests/tran_gear6/tran_gear6.ckt` |
| `colpitts-oscillator` | convergence | [upstream](https://github.com/ahkab/ahkab/blob/1e8939194b689909b8184ce7eba478b485ff9e3a/tests/colpitts/colpitts.ckt) | `02bc0b17610975b80bb01bf5b73e5a334ef39412d3c14cc39ba6f8e236f67d8c` | `benchmarks/corpus/corpus-d/fixtures/tests/colpitts/colpitts.ckt` |

Validate all pinned fetches, fixture hashes, byte-identical engine inputs, declared analyses, expected outcomes, and the deterministic receipt with:

    pnpm build
    node benchmarks/corpus/corpus-d/validate.mjs

At ingestion on ngspice-47, all 20 fixtures fail on ahkab-specific source, analysis, model, or named-subcircuit syntax. All 20 also fail in spice-ts: 19 parse failures (including one existing malformed-device error path) and one explicitly unsupported parse. No circuit is adapted or omitted to improve either total; the validator prints and checks every loss.

## Xyce Regression Suite corpus C translated to SPICE3 (xyce-spice3, issue #524 lane 3)

- Repository: https://github.com/Xyce/Xyce_Regression
- Pinned revision: `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2` (same pin as corpus C).
- Licence: GNU General Public License v3.0 or later (`GPL-3.0-or-later`), for both the translated decks and the Xyce reference files. The pinned repository [copyright and licence notice](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/README.md#copyright-and-license) grants redistribution and modification under GPL version 3 or later.
- Licence retention: the byte-identical upstream README is retained as `benchmarks/corpus/xyce-spice3/LICENSE-NOTICE.md` (SHA-256 `82ff6df7bddcdf639483d261949a02a5f43da85d579f1242b05c3aa0c430f7cb`), and the complete GPLv3 text from https://www.gnu.org/licenses/gpl-3.0.txt is retained as `benchmarks/corpus/xyce-spice3/COPYING.txt` (SHA-256 `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`); both are identical to the corpus C copies.
- Redistribution decision: Allowed under GPL-3.0-or-later. Translated decks are modified versions of the Xyce_Regression netlists, redistributed under the same licence with the upstream notice and the full GPLv3 text; every modified deck states the upstream file, its SHA-256, the modifications and their date (2026-10-11) in its header. Xyce reference files are redistributed verbatim.
- Deck provenance: `fixtures/**/*.cir` are modified versions of the byte-identical corpus C originals in `benchmarks/corpus/xyce/fixtures/`, which stay unchanged. They are generated by the project-authored translator `benchmarks/translate/xyce-to-spice3.ts` (deterministic; `--check` verifies the committed decks and manifest) on 2026-10-11. The translation is syntax-only and never changes topology, element values, models or analyses; every changed original line is kept as a comment in the deck, and `manifest.json` (`translation.rules`, `translation.changes`, `source.mechanicalAdaptation`) lists every rule and change. Fixtures with a construct that has no exact SPICE3 equivalent are recorded as `unsupported-translation` with reasons and no deck is committed.
- Reference provenance: `reference/` holds Xyce_Regression's own references from the pinned revision, copied byte for byte (no adaptation; SHA-256 pinned in `compare.ts` and re-verified against the pinned raw upstream files on 2026-10-11): the Xyce gold outputs `OutputData/DIODE/diode.cir.prn` and `OutputData/NJFET_DC/njfet.cir.prn`, and the analytic gold-standard Perl scripts `Netlists/CAPACITOR/capacitor.cir.prn.gs.pl` and `Netlists/CAPACITOR/rc_osc.cir.prn.gs.pl`, whose formulas `compare.ts` transcribes with the upstream constants. Xyce produced the gold outputs from the ORIGINAL decks, so they are a descriptive third column, not a byte-matched engine comparison.
- Project-authored support files (MIT, this repository): `README.md`, `manifest.json`, `compare.ts`, `report.json`, and `benchmarks/translate/xyce-to-spice3.ts` with its test.
- Coverage: the 7 corpus C fixtures that ngspice rejects for Xyce/PSpice dialect: 4 translated decks with 4 Xyce reference files, and 3 unsupported translations (no deck, no reference).

| ID | Category | Upstream deck | Translation | Local deck (SHA-256 prefix) | Upstream reference | Local reference (SHA-256 prefix) |
|---|---|---|---|---|---|---|
| `capacitor-rc-transient` | capacitor | [`Netlists/CAPACITOR/capacitor.cir`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/capacitor.cir) | translated (3 syntax changes: `tran-zero-tstep`, `timeint-tolerances-removed`, `capacitor-ic-to-dot-ic`; listed in the deck header and manifest) | `fixtures/CAPACITOR/capacitor.cir` (`a3a53887ee21`) | [`Netlists/CAPACITOR/capacitor.cir.prn.gs.pl`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/capacitor.cir.prn.gs.pl) (analytic gold-standard script) | `reference/CAPACITOR/capacitor.cir.prn.gs.pl` (`b56529ea01c8`) |
| `capacitor-rc-transient-newlte` | capacitor | [`Netlists/CAPACITOR/capacitor3.cir`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/capacitor3.cir) | unsupported-translation (no deck committed; reasons in manifest) | - | - | - |
| `capacitor-rc-oscillator` | capacitor | [`Netlists/CAPACITOR/rc_osc.cir`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/rc_osc.cir) | translated (3 syntax changes: `tran-zero-tstep`, `timeint-tolerances-removed`, `print-brace-expressions`; listed in the deck header and manifest) | `fixtures/CAPACITOR/rc_osc.cir` (`e2f9235d08ed`) | [`Netlists/CAPACITOR/rc_osc.cir.prn.gs.pl`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CAPACITOR/rc_osc.cir.prn.gs.pl) (analytic gold-standard script) | `reference/CAPACITOR/rc_osc.cir.prn.gs.pl` (`64f1dfe54606`) |
| `diode-level2-temperature-breakdown` | diode | [`Netlists/DIODE/Level2_Temp_Dep_Breakdown.cir`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE/Level2_Temp_Dep_Breakdown.cir) | unsupported-translation (no deck committed; reasons in manifest) | - | - | - |
| `diode-zener-5229` | diode | [`Netlists/DIODE/Zener_5229.cir`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE/Zener_5229.cir) | unsupported-translation (no deck committed; reasons in manifest) | - | - | - |
| `diode-transient` | diode | [`Netlists/DIODE/diode.cir`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE/diode.cir) | translated (3 syntax changes: `tran-zero-tstep`, `timeint-tolerances-removed`, `print-brace-expressions`; listed in the deck header and manifest) | `fixtures/DIODE/diode.cir` (`f6c02a9ba844`) | [`OutputData/DIODE/diode.cir.prn`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/OutputData/DIODE/diode.cir.prn) (gold output) | `reference/DIODE/diode.cir.prn` (`5ae09676eac3`) |
| `njfet-stepped-dc` | jfet | [`Netlists/NJFET_DC/njfet.cir`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NJFET_DC/njfet.cir) | translated (2 syntax changes: `step-source-to-nested-dc`; listed in the deck header and manifest) | `fixtures/NJFET_DC/njfet.cir` (`22bf4233f938`) | [`OutputData/NJFET_DC/njfet.cir.prn`](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/OutputData/NJFET_DC/njfet.cir.prn) (gold output) | `reference/NJFET_DC/njfet.cir.prn` (`c80315b56288`) |

Local paths are relative to `benchmarks/corpus/xyce-spice3/`; full SHA-256 values are in `manifest.json` (decks) and `compare.ts` (references). Verify hashes, licence files and that the committed decks equal the translator output with:

    pnpm exec tsx benchmarks/translate/xyce-to-spice3.ts --check
    pnpm exec tsx --test benchmarks/translate/xyce-to-spice3.test.ts

## bsim3-charge-626 (#626, #582)

- `benchmarks/bsim3-charge-626/`: project-authored BSIM3v3.3.0 charge-model cards and decks (MIT, this repository), plus the #589 cards from `benchmarks/bsim3-dc-589/cards.ts` (which read corpus-f cards at run time; provenance and licence in `benchmarks/corpus/corpus-f/SOURCES.md`). The NAND deck reuses the subcircuit and default model cards of corpus-f `examples/snapshot/adder_mos_circ.cir` (ngspice examples, see that SOURCES.md). References are generated with ngspice-47 by `reference.ts` and `transient-reference.ts`.

## bsim3v32-594 (#594)

- `benchmarks/bsim3v32-594/`: the #589 and #626 BSIM3 cards (`benchmarks/bsim3-dc-589/cards.ts`, `benchmarks/bsim3-charge-626/cards.ts`; MIT, this repository) with VERSION= set to a 3.2.x revision, plus the TSMC 0.25u `Nmod`/`Pmod` VERSION = 3.2.2 cards and MNA0/MPA0 geometry, copied at run time from corpus-f `examples/tclspice/tcl-testbench4/example.cir` (ngspice `3ef069fb`, BSD-3-Clause; provenance in `benchmarks/corpus/corpus-f/SOURCES.md`). The three-stage inverter-chain deck is project-authored (MIT) and uses those unchanged cards. The parity decks add `NRD=0 NRS=0` to the TSMC instances, which removes the RSH series resistance (not modelled when #594 landed, ported by #691). References are generated with ngspice-47 by `reference.ts`.

## bsim3-rsh-691 (#691)

- `benchmarks/bsim3-rsh-691/`: the TSMC 0.25u `Nmod`/`Pmod` VERSION = 3.2.2 cards (RSH = 4.5), copied at run time from corpus-f `examples/tclspice/tcl-testbench4/example.cir` (ngspice `3ef069fb`, BSD-3-Clause; provenance in `benchmarks/corpus/corpus-f/SOURCES.md`), in project-authored (MIT) one-transistor `.op` probes with varied NRD/NRS/M and VERSION=3.3.0/3.2.4. `probe.ts` runs the identical decks through ngspice-47 and spice-ts.

## bsim3v32-700 (#700)

- `benchmarks/bsim3v32-700/`: the TSMC 0.25u `Nmod`/`Pmod` VERSION = 3.2.2 cards (binned VTH0/U0), copied at run time from corpus-f `examples/tclspice/tcl-testbench4/example.cir` (ngspice `3ef069fb`, BSD-3-Clause; provenance in `benchmarks/corpus/corpus-f/SOURCES.md`), with VERSION= rewritten to 3.2, 3.2.4 or 3.3.0 for some cases, in project-authored (MIT) multi-instance `.op` decks with alternating L/W. `probe.ts` runs the identical decks through ngspice-47 and spice-ts. The unit test `packages/core/src/devices/bsim3v32-size-reuse.test.ts` uses a project-authored (MIT) binned card with ngspice-47 references.

## Xyce Regression Suite corpus G (corpus-g, issue #711)

- Repository: https://github.com/Xyce/Xyce_Regression, pinned revision `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2` (the corpus C revision).
- Licence: GPL-3.0-or-later, per the pinned [README copyright and licence notice](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/README.md#copyright-and-license). The byte-identical README is retained as `benchmarks/corpus/corpus-g/LICENSE-NOTICE.md` and the complete GPLv3 text as `benchmarks/corpus/corpus-g/COPYING.txt` (SHA-256 values in `benchmarks/corpus/corpus-g/manifest.json`).
- Redistribution decision: allowed under GPL-3.0-or-later on the same basis as corpus C: verbatim benchmark data files with the notice and licence text alongside, not linked into any MIT-licensed package. Decks that carry their own copyright or licence notice are excluded (24 decks) and not committed.
- Adaptation: none. 128 decks are committed byte-for-byte; both engines read the same bytes.
- Selection (spice-ts-blind): 4133 candidate netlists; content-hash and path dedupe against every existing corpus fixture (22 already in a corpus, 352 duplicates); corpus-f static rules (544 not self-contained, 155 without analysis); an ngspice-47 reference probe on the identical bytes (2073 without a reference, receipt `benchmarks/corpus/corpus-g/ngspice-probe.json`); then one deck per suite directory in path order (835 capped decks listed for later batches). Per-file URL, revision, SHA-256 and licence, every exclusion, and the sources considered and skipped (KiCad demos, ISCAS, textbook circuits, vendor app notes) are in [`benchmarks/corpus/corpus-g/SOURCES.md`](corpus/corpus-g/SOURCES.md).
- Outcome receipt: `benchmarks/corpus/corpus-g/outcomes.json` and [`README.md`](corpus/corpus-g/README.md), generated by `pnpm build && spice-heavy pnpm exec tsx benchmarks/corpus/corpus-g/parity.ts` with the corpus-f runner and uniform 1% metric. At commit time on ngspice-47 / spice-ts 0.3.0: ngspice 128/128 success; spice-ts matched 48, mismatch 14, spice-ts-loss 66. Every loss is listed; gap buckets are filed as #713-#718 and the mismatches as #719.

## Public non-Xyce SPICE decks corpus H (corpus-h, issue #785)

- Sources (pinned revisions, per-source licence): ahkab `1e8939194b68` (GPL-2.0-only), KiCad QA data `240efadec4b4` (GPL-3.0-or-later; `demos/` CC BY-SA is not used), PySpice `fe08718d5a1a` (GPL-3.0-or-later), spicelib `d8f8ecceeb36` (GPL-3.0-only), SpiceSharpParser `8fc01560fe30` (MIT), XicTools/WRspice `c1244c23a991` (Apache-2.0), xschem `ca3e6c9a3e43` (GPL-2.0-or-later). Full revisions, licence basis and the byte-identical licence files retained under `benchmarks/corpus/corpus-h/licenses/<source>/` (with SHA-256) are in [`benchmarks/corpus/corpus-h/SOURCES.md`](corpus/corpus-h/SOURCES.md) and `manifest.json`.
- Redistribution decision: allowed per source under its repository-wide licence: verbatim benchmark data files with each source's licence text alongside, not linked into any MIT-licensed package. Decks that carry their own copyright or licence notice are excluded (5 decks) and not committed.
- Adaptation: none. 52 decks are committed byte-for-byte (per-file licence: MIT 24, Apache-2.0 13, GPL-3.0-or-later 13, GPL-3.0-only 2); both engines read the same bytes.
- Selection (spice-ts-blind): 446 candidate netlists; spicelib `unittests/golden/` skipped as machine-edited copies (32); content-hash dedupe against every existing corpus fixture (21 already in a corpus) and across sources (54 duplicates); corpus-f static rules (7 not UTF-8, 119 not self-contained, 29 without analysis); an ngspice-47 reference probe on the identical bytes (127 without a reference, receipt `benchmarks/corpus/corpus-h/ngspice-probe.json`); a 16-per-directory cap (none capped). Every exclusion and the sources considered and skipped (KiCad demos, ISCAS, ngspice companion-file decks, textbook/vendor circuits) are listed in the corpus SOURCES.md.
- Outcome receipt: `benchmarks/corpus/corpus-h/outcomes.json` and [`README.md`](corpus/corpus-h/README.md), generated by `pnpm build && spice-heavy pnpm exec tsx benchmarks/corpus/corpus-h/parity.ts` with the corpus-f runner and uniform 1% metric. At commit time on ngspice-47 / spice-ts 0.3.0: ngspice 52/52 success; spice-ts matched 20, mismatch 3, spice-ts-loss 29. Every loss is listed; gap buckets are filed as #787-#790 (the convergence bucket is #772, KiCad `GND` ground alias) and the mismatches as #791.

## Public SPICE decks corpus I (corpus-i, issue #834)

- Sources (pinned revisions, per-source licence): FOSSEE eSim `Examples/` `1a25a46ce15e` (GPL-3.0-only), KiCad simulation demos `demos/simulation/` `240efadec4b4` (CC-BY-SA-4.0), ngspice-cmos `9f470c6d2558` (MIT), danielrioslinares/ngspice-examples `a8f956378acf` (GPL-3.0-only), VACASK `fb8cc2055a4f` (AGPL-3.0-only, https://codeberg.org/arpadbuermen/VACASK). Full revisions, licence basis and the byte-identical licence files retained under `benchmarks/corpus/corpus-i/licenses/<source>/` (with SHA-256) are in [`benchmarks/corpus/corpus-i/SOURCES.md`](corpus/corpus-i/SOURCES.md) and `manifest.json`.
- Redistribution decision: allowed per source under its repository-wide licence: verbatim benchmark data files with each source's licence text alongside, not linked into any MIT-licensed package. Decks that carry their own copyright or licence notice are excluded (1 deck, an IHP PDK cell library) and not committed. Rejected sources (symbench/spice-datasets: scraped third-party and LTspice material; labtroll/KiCad-Simulations: no licence) are listed with the reason in the corpus SOURCES.md.
- Adaptation: none. 25 decks are committed byte-for-byte (per-file licence: GPL-3.0-only 13, AGPL-3.0-only 12); both engines read the same bytes.
- Selection (spice-ts-blind, corpus-h rules unchanged plus the `.sim` and `.cir.out` extensions): 467 candidate netlists; content-hash dedupe against every existing corpus fixture (0 already in a corpus) and across sources (31 duplicates); corpus-f static rules (1 licence notice, 8 host commands, 195 not self-contained, 190 without analysis); an ngspice-47 reference probe on the identical bytes (17 without a reference, receipt `benchmarks/corpus/corpus-i/ngspice-probe.json`); a 16-per-directory cap (none capped). The KiCad demo netlist and the VACASK transistor-level ISCAS c6288 decks load companion files and are listed as `not-self-contained`.
- Outcome receipt: `benchmarks/corpus/corpus-i/outcomes.json` and [`README.md`](corpus/corpus-i/README.md), generated by `pnpm build && spice-heavy pnpm exec tsx benchmarks/corpus/corpus-i/parity.ts` with the corpus-f runner and uniform 1% metric. At commit time on ngspice-47 / spice-ts 0.3.0: ngspice 25/25 success; spice-ts matched 17, mismatch 1, spice-ts-loss 7. Every loss is listed; gap buckets link #553 (XSPICE code models), #837 (bare `.param` names as R/C/L values), #838 (`.ac` with event-driven digital instances) and #839 (harness heap on a 1e6-point transient); the mismatch is #840.

## Mutually accepted ngspice / Xyce cross-check (#948)

`benchmarks/reference/mutual-948/` is a separate reference-only artifact, not
aggregate scoring. The original aggregate A..E fixtures are followed by the
already-licensed original F..J manifests in manifest order (hash tie-breaker).
No new external material or already-translated `-spice3` variants are ingested.
Per-file URLs, revisions and original licences remain in the existing corpus
manifests and `SOURCES.md` files; canonical/projected derivatives retain those
licences, not the MIT licence of the reporting code. Original/canonical hashes,
analysis types, every exclusion and observed reference disagreement are in
the subset manifest and [report](reference/mutual-948/README.md). Both references
see the same canonical circuit and ordinal analysis projection; only export
directives differ. Selection never uses spice-ts results. Every native warning
and execution/export/parse failure is retained; export failure is not evidence
of nonconvergence. Runs require `spice-heavy`; no model-equivalence claim is made.

## MOS2 pump residual investigation (#1019)

- Original k-13 pump input is the unmodified corpus-k Xyce_Regression GPL-3.0-or-later fixture. Its manifest source, licence and SHA-256 remain authoritative; no derived netlist is added.
- Observation-only native tracing uses [ngspice ngspice-47](https://github.com/ngspice/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656), commit `a80f6e3e95d51534905b1f23410a951802666656`, under its upstream mixed BSD-style licences. Source/build/executable are not redistributed. `evidence/1019/instrument-native.py` records the instrumentation; its output waveform is verified identical to the installed ngspice-47 reference on all 868 points and four common signals.
- `evidence/1019/` contains project-authored MIT scripts and measured diagnostics. The regenerated maxord-983 report retains the unresolved current loss (0.063 normalized, formerly 0.0585); no tolerance, deck, scoring or production change is claimed as a fix.

## Known ngspice bugs corpus (issue #803)

Solver-selection follow-up (#812): `benchmarks/solver-selection/` reuses the
existing manifest hashes and licence restrictions for tickets 645, 690, 691,
718, 720, 725 and 852. `prepare.py` retrieves 718 from
https://sourceforge.net/rest/p/ngspice/bugs/718 and 720 from
https://raw.githubusercontent.com/ngspice/ngspice/master/examples/tclspice/tcl/diffpair.cir,
reconstructs only the previously documented solver variants, and requires the
existing SHA-256 pins before writing ignored fetched inputs. No complete third-party
deck/model library is redistributed here; native diagnostics retain small error excerpts. The RC regression in
`packages/core/src/parser/solver-selection.test.ts` is self-written under the
repository MIT licence. The report retains singular-network, sensitivity,
missing-plot and native-reference failures, not just completed comparisons.

- Source: the open ngspice bug tickets (status `open` or `open-accepted`, 134 tickets on 2026-10-12) at https://sourceforge.net/p/ngspice/bugs/, harvested read-only through the SourceForge REST API (`https://sourceforge.net/rest/p/ngspice/bugs/search?q=status:open+OR+status:open-accepted`). Every deck records its ticket URL, attachment URL and SHA-256 in `benchmarks/corpus/ngspice-bugs/manifest.json`.
- Licence: decks were posted publicly on the tracker by their authors without an explicit licence. Redistribution decision: only small (at most 3 KB) user-authored decks are committed, quoted to reproduce the bug reports, plus dot-card variants derived from them; #877/#878 decks were written by the spice-ts owner. Vendor model libraries, PDK files, archives and large attachments are not committed; `benchmarks/corpus/ngspice-bugs/fetch.ts` downloads them from the tracker into the git-ignored `fetched/` directory and verifies their hashes.
- Adaptation: dot-card variants of `.control`-only decks and rewritten absolute Windows include paths, each recorded per ticket in the manifest. Method, engines and outcomes: [`benchmarks/corpus/ngspice-bugs/README.md`](corpus/ngspice-bugs/README.md) and [`benchmarks/NGSPICE_BUGS.md`](NGSPICE_BUGS.md).

## Xyce Linux reference container (#948 source-build verification)

| Source | Pin | Licence / redistribution | Local recipe and evidence |
| --- | --- | --- | --- |
| [Docker Official Ubuntu image](https://hub.docker.com/_/ubuntu), Ubuntu 24.04.4, Linux arm64 | OCI index `sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54`; arm64 manifest `sha256:ea0b2b8607a61f981b2461f21edc27c0b37ddd53d23d4d350936480adf5de28c` | Per-package Ubuntu licences ([copyright policy](https://www.ubuntu.com/legal/intellectual-property-policy)); image and installed packages fetched, no image or executable redistributed in this repository | `benchmarks/reference/Dockerfile.xyce` pins GCC 13.3.0, CMake 3.28.3 and direct prerequisites; `benchmarks/reference/linux-build/` records build and cross-check evidence; Xyce/SuiteSparse/Trilinos source provenance remains in the existing Xyce section |

## MOS2 series-resistance evidence (#982)

- Unit probes in `packages/core/src/devices/mos2-series-resistance-982.test.ts` and `evidence/982/reference-probes.py` are original spice-ts test circuits (repository MIT licence). ngspice-47 OP/AC/transient reference numbers are measured on identical probe bytes; no vendor model library is used.
- Public corpus inputs are read without alteration from corpus-k at accepted commit `e05f5f1748bb7aaada478e9c3378ec4dfb45e17c`, not copied into this implementation branch. Canonical source is [Xyce_Regression](https://github.com/Xyce/Xyce_Regression/tree/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2), revision `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, GPL-3.0-or-later. The pinned corpus-k manifest and licence receipts retain the upstream notices and per-deck hashes.
- `evidence/982/parity.ts` runs the 13 reference-successful MOS2 resistance-gap fixtures plus e1480 (both-engine failure) through unchanged corpus-f runners and corpus-j metrics. Before results come from the accepted corpus-k receipt; after results use the implementation build. Original-byte hashes are checked, uniform 1% thresholds are unchanged, and all outcomes remain in `evidence/982/parity.json`. No aggregate refresh or speed-superiority claim.


## corpus-l original MOS3, gain-stage and Sandler batch (#1045)

Twenty novel unchanged decks from https://github.com/Xyce/Xyce_Regression at pinned revision `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, SPDX `GPL-3.0-or-later`. The repository README Copyright and license grants GPL version 3 or later; selected files have no separate notice or external dependencies. Byte-identical README and full GPL text are retained under corpus-l/licenses/xyce. Hash dedupe covers all previous corpora, including d-k, and terminal-newline variants. No fixture adaptation, engine-success filter or per-circuit tolerance tuning. Every result, including losses, is published in corpus-l/README.md and outcomes.json. No aggregate refresh.

Selection is fixed before engine execution: ten CircuitSim90/MOS3 decks, four ACtests/mos gain stages, four ACtests/SANDLER decks, and the first two ACtests/diffpair_spiceMan decks. Survey covers these families only; other families are batch-deferred, not engine failures or licence rejections. MOS2_LARGE is deferred to a separately budgeted large-circuit batch. No vendor/app-note licences or KiCad schematic exports are inferred.

Every row uses the pinned revision above and GPL-3.0-or-later under the retained Xyce README grant.

| ID | Pinned source URL | SHA-256 | SPDX licence |
|---|---|---|---|
| l-1 | [Netlists/ACtests/SANDLER16/sandler16.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/SANDLER16/sandler16.cir) | 4559c5a5df102c1f471dab8b5b77d6d0856cc78c632586b1c4b46305f223344a | GPL-3.0-or-later |
| l-2 | [Netlists/ACtests/SANDLER7/sandler7.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/SANDLER7/sandler7.cir) | 9ca67ca3b7eef3c1322936b9e4c6794f200237f781b714ec161dab1c35ab42f6 | GPL-3.0-or-later |
| l-3 | [Netlists/ACtests/SANDLER8/sandler8.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/SANDLER8/sandler8.cir) | 4bb0a1cea94ce0b097771edb78c5bd47234606ffad529b1aef2254cc0f864a7e | GPL-3.0-or-later |
| l-4 | [Netlists/ACtests/SANDLER9/sandler9.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/SANDLER9/sandler9.cir) | 149ddd0a2d8b17106f791647236db84732d45bda01145284b8d0c85974171817 | GPL-3.0-or-later |
| l-5 | [Netlists/ACtests/diffpair_spiceMan.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/diffpair_spiceMan.cir) | 0780e3374389beeb6754c3423f43fa609c46f3d35537b7206e7e2014301038c1 | GPL-3.0-or-later |
| l-6 | [Netlists/ACtests/diffpair_spiceManLIN.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/diffpair_spiceManLIN.cir) | 70af53508eda159fac01125533814f6dab74ceacb885be6a9d42ed0b776c045f | GPL-3.0-or-later |
| l-7 | [Netlists/ACtests/mos/gain-stage1.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/mos/gain-stage1.cir) | e184d407df6a9fb6bb8992fb050aa7e7f28ce0d5717c4ee6cd36db59105a5203 | GPL-3.0-or-later |
| l-8 | [Netlists/ACtests/mos/gain-stage2.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/mos/gain-stage2.cir) | 5a5f3da6d8f18bb865059acbc34b1fc464c52deda5f5e0d5eb039da8973b4deb | GPL-3.0-or-later |
| l-9 | [Netlists/ACtests/mos/gain-stage3.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/mos/gain-stage3.cir) | 9294b82b1e587d14937b75e89067454f57c056a1a54ebaed666117a884b7f0ae | GPL-3.0-or-later |
| l-10 | [Netlists/ACtests/mos/gain-stage6.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACtests/mos/gain-stage6.cir) | 1a8f881f5687036ab790a47ea24e56a8a1afc6dd42c1966eab92a4a36d657b3d | GPL-3.0-or-later |
| l-11 | [Netlists/CircuitSim90/MOS3/arom.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/arom.cir) | 4db593d3133a5929e7efdcb26921d3fce15e6c6c17e8bcef2fa2a08c4f7d062c | GPL-3.0-or-later |
| l-12 | [Netlists/CircuitSim90/MOS3/gm1.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/gm1.cir) | 417d4fe8629398295bb317ad236781f36b34eebb58e74c7b63757263f55c338c | GPL-3.0-or-later |
| l-13 | [Netlists/CircuitSim90/MOS3/gm17.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/gm17.cir) | 43fc842bd3c7bfbbe285a5d83b4eb08fa6acc1a3c8a5da9ae62c605bd32324a9 | GPL-3.0-or-later |
| l-14 | [Netlists/CircuitSim90/MOS3/gm19.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/gm19.cir) | 0b94a01a96dd0ae19e93fe78b5fc7397411815d350ee13ee118c49548bb62c08 | GPL-3.0-or-later |
| l-15 | [Netlists/CircuitSim90/MOS3/gm2.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/gm2.cir) | ad4261e8c85a1f0376b24c0bad6f42fa4046a0fa669b84853236ef558fa417fc | GPL-3.0-or-later |
| l-16 | [Netlists/CircuitSim90/MOS3/gm3.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/gm3.cir) | 90ee65bd24818d09d008de93e92f5a398f3422ae2a4a663e5889834e2c1fe071 | GPL-3.0-or-later |
| l-17 | [Netlists/CircuitSim90/MOS3/jge.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/jge.cir) | c0da4a46792a27496530ea1a57b1253dd980d17380db58ffd6e6434f0156babf | GPL-3.0-or-later |
| l-18 | [Netlists/CircuitSim90/MOS3/mike2.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/mike2.cir) | 99cf3671f37b401548a991f679ceaeb6ab502c97ac7c98de81b5adbddb4df013 | GPL-3.0-or-later |
| l-19 | [Netlists/CircuitSim90/MOS3/rich3.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/rich3.cir) | 5cf5ebcafb990907419d4844249ed6c8a53e47be8faf06f8e16fd08a5ef353ae | GPL-3.0-or-later |
| l-20 | [Netlists/CircuitSim90/MOS3/todd3.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3/todd3.cir) | adecd1aec7ea465065ee828bea3db6a4f675a9e8abf0e8931137593bb338b57f | GPL-3.0-or-later |

### MOS2 residual remeasurement and pump reduction (#1001 / #1019)

`benchmarks/results/issue-1001/` replays existing corpus-k / #996 inputs; it is
not a new corpus or aggregate refresh. `pump-reduced.cir` derives from
[Xyce_Regression pump.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2/pump.cir),
revision `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, GPL-3.0-or-later under
the existing corpus-k README grant and retained full licence. It removes the
unused PMOS model, comments/output requests and the final five cycles; active
NMOS model, geometry, source edge times, capacitors, MAXORD and tolerances are
unchanged. Original SHA-256:
`142a0df7fc79780e9eb85491b0307224a5e0fa745e15dffb3c27bb6f38bb668f`;
reduction SHA-256:
`41da2258c5e4b729aa0ad6032bedd1f43ef362cab393d5adff697ed39fc838df`.
Every OP/fine diagnostic's complete bytes/hash are in the generated captures.
The checker deduplicates hashes; duplicate mosrect controls are not new coverage.
ngspice-47 source citations use pinned object
`a80f6e3e95d51534905b1f23410a951802666656` with fetched URLs/hashes in
`source-receipt.json`; its mixed BSD-style licences remain recorded in corpus-k.
No upstream native source or binary is redistributed. Scripts/tests are
project-authored MIT; captures are generated simulation evidence containing
the licensed input text. Losses and passing controls are both retained.

## Public corpus-n application/regression decks (#1045)

24 byte-identical standalone decks, 13 BSD-3-Clause ngspice examples/tests and
11 GPL-3.0-or-later Xyce regression inputs. Both engines receive the original
bytes. No core, harness, tolerance or aggregate-report change. Licences,
selection/exclusion receipts and every outcome are retained under
`benchmarks/corpus/corpus-n/`. GPL inputs are separate from MIT package code.
The supervisor explicitly approved GPL inputs under CHARTER's redistribution
policy. The ngspice COPYING document itself is CC-BY-SA-4.0, retained unchanged
with attribution to its pinned source. Notices are retained in
`corpus-n/licenses/ngspice/COPYING` and `corpus-n/licenses/xyce/{README.md,GPL-3.0.txt}`.

Pinned repositories and grants:
- ngspice `a80f6e3e95d51534905b1f23410a951802666656`:
  [COPYING](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/COPYING)
  explicitly grants Modified BSD for test/example files; selected paths are not exceptions.
- Xyce `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`:
  [README grant](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/README.md#copyright-and-license).

| ID | Pinned upstream URL | SHA-256 | Licence |
|---|---|---|---|
| n-1 | [examples/pss/vdp_osc_pss.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/examples/pss/vdp_osc_pss.cir) | 501888a16ddd9741b851953c010e7de6c8b11ea70071909db9a5b192d0571511 | BSD-3-Clause |
| n-2 | [paranoia_parallel/examples/Monte_Carlo/OpWien_s.sp](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/Monte_Carlo/OpWien_s.sp) | 4c74766c70cff535f141edb749dab6300bcbafd8db65243f1eef3061ed01b860 | BSD-3-Clause |
| n-3 | [paranoia_parallel/examples/transient-noise/noise_vnoi_test.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/transient-noise/noise_vnoi_test.cir) | 296b5af65bedcd8793498d732411f36191217f94b89a7eb37275f9f4c7392ef8 | BSD-3-Clause |
| n-4 | [paranoia_parallel/examples/transient-noise/simple-noise.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/transient-noise/simple-noise.cir) | 5cb8c9d9856777689b944076fc07bd77ae92e70ce6731cd0db0fc04d23adeb44 | BSD-3-Clause |
| n-5 | [paranoia_parallel/examples/various/adder_mos.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/various/adder_mos.cir) | 837642247b44a0c70ac952e4d24a6fa52a4132ed50c1f5c6a4cbd35bd1747f7e | BSD-3-Clause |
| n-6 | [paranoia_parallel/examples/vdmos/inv_vdmos_dc.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/inv_vdmos_dc.cir) | b20eb59e3de6e8ac27f44097b7b19f2ebd1f821425c69b731f9b1c8a11a862e1 | BSD-3-Clause |
| n-7 | [paranoia_parallel/examples/vdmos/inv_vdmos.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/inv_vdmos.cir) | 7ba5f6c24e3c6c5c1b22595173e635c0106e734232c170b8ea110d4f3480f737 | BSD-3-Clause |
| n-8 | [paranoia_parallel/examples/vdmos/VDMOS-DIO-AC.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/VDMOS-DIO-AC.cir) | 5353769bf39031ee971d955dd92bdaae8ef827d99fdb0242d635ef4fc56b3d99 | BSD-3-Clause |
| n-9 | [paranoia_parallel/examples/vdmos/VDMOS-DIO.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/VDMOS-DIO.cir) | 3e571540caef808b4acd9346962846cf0c974f9e95046f1b1cae7b9940b5687c | BSD-3-Clause |
| n-10 | [paranoia_parallel/examples/vdmos/vdmos-out_ir_mtr.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/vdmos-out_ir_mtr.cir) | 63b7483ca8406aef8f80b44443be204b367a5dc81f86697d15c4138f07455303 | BSD-3-Clause |
| n-11 | [paranoia_parallel/examples/vdmos/vdmos-out_ir.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/vdmos-out_ir.cir) | e991fe10546a7b7b0dc0a60d597782b35d9a5087682f5724b02e145fb5a27b1b | BSD-3-Clause |
| n-12 | [paranoia_parallel/examples/vdmos/vdmosp-out-mtr.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/vdmosp-out-mtr.cir) | 64176908ef6c543b9bfbc15195e75aaebd446c6c89bed69bca01eb6a647909fe | BSD-3-Clause |
| n-13 | [paranoia_parallel/examples/vdmos/vdmosp-out.cir](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/paranoia_parallel/examples/vdmos/vdmosp-out.cir) | 8c0ed92645e2876fe915703215dd208a8fdf93c9e365c5ec561760bbc3ce0e5c | BSD-3-Clause |
| n-14 | [Netlists/ACSENS/bsim3/op-amp_expr_fd.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACSENS/bsim3/op-amp_expr_fd.cir) | 1667c34c9cd58942432fb21c93943b6f12b0138a1460f576acaaaaad82d61519 | GPL-3.0-or-later |
| n-15 | [Netlists/ACSENS/bsim3/op-amp_unique_fd.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/ACSENS/bsim3/op-amp_unique_fd.cir) | 31770a8ccf83d8d1e4d84d32a80c5cb035d53c72b887cccf0a92409a598523ef | GPL-3.0-or-later |
| n-16 | [Netlists/Output/TRAN/tran-prn-filter.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/Output/TRAN/tran-prn-filter.cir) | e2c25889d90fd5aa9f86793c969bd36a448e516637af2f1b741822170bdf369e | GPL-3.0-or-later |
| n-17 | [Netlists/BJT_IC/bjt_ic.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/BJT_IC/bjt_ic.cir) | b2f414dea73a0fb66b61335fe83320fecac2b7bbf1f12e0438b6893c363c5534 | GPL-3.0-or-later |
| n-18 | [Netlists/CircuitSim90/MOS2_LARGE/add20.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2_LARGE/add20.cir) | 197b34fcac1376f5351f3c3c8508b30cec83f0ba45540c233aac8b9856340bc1 | GPL-3.0-or-later |
| n-19 | [Netlists/CircuitSim90/MOS2_LARGE/add32.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2_LARGE/add32.cir) | 120cbd0023c06993224b862be199f095226ce4a0efa587dc8c46cebd21181138 | GPL-3.0-or-later |
| n-20 | [Netlists/CircuitSim90/MOS2_LARGE/dac.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2_LARGE/dac.cir) | daff3bedde91fafd24d5a4123738d7845cd2f067d1c918f73dc07f8d9c3ab637 | GPL-3.0-or-later |
| n-21 | [Netlists/CircuitSim90/MOS2_LARGE/fadd32.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2_LARGE/fadd32.cir) | e0056c1c0e9f7c9c1fd917affec058d32001c6172251359068506b165dc5a12d | GPL-3.0-or-later |
| n-22 | [Netlists/CircuitSim90/MOS2_LARGE/pchip.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2_LARGE/pchip.cir) | 6abe8ffc3bb0e664b465bbb0ebc9d202265df9eb39608140bc976f28202bcb21 | GPL-3.0-or-later |
| n-23 | [Netlists/CircuitSim90/MOS2_LARGE/sqrt.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2_LARGE/sqrt.cir) | efec05bb614eedd46c39b85f3e8430e3c0955230909ab2adb2542667306ee791 | GPL-3.0-or-later |
| n-24 | [Netlists/CircuitSim90/MOS2_LARGE/sram.cir](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS2_LARGE/sram.cir) | f7199d0ba58e8b3563f9910511b7a1954f86ea647e276bb517eb49acdcf1fdd4 | GPL-3.0-or-later |

Reproduce parity with `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-n/parity.ts`;
offline guards with `pnpm exec tsx --test benchmarks/corpus/corpus-n/corpus-n.test.ts`.
All 87 non-reference BSD probes, every Xyce probe failure, static exclusions
and deferred candidates are retained in the batch's survey/probe receipts.

## MOS3 native load-state evidence (Refs #1059)

`benchmarks/results/issue-1059-loadstate/` reuses unchanged corpus-l gm19/arom
and `benchmarks/results/issue-1059/pair.cir`, the existing gm2-derived pair.
Canonical inputs are [Xyce_Regression CircuitSim90/MOS3](https://github.com/Xyce/Xyce_Regression/tree/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/CircuitSim90/MOS3),
pin `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, GPL-3.0-or-later under the
retained corpus-l README grant and full licence. No new circuit adaptation.
Generated captures include the licensed input bytes and verified SHA-256;
both engines receive those identical bytes. No tolerances/floors change.

The observation-only native patch targets [ngspice-47](https://github.com/ngspice/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656),
pin `a80f6e3e95d51534905b1f23410a951802666656`, under its upstream mixed
BSD-style licences (mos3load.c and dctran.c retain UC Regents notices).
Only the diagnostic patch is retained, not the native source tree or binary.
Project-authored diagnostic scripts/tests are MIT. `report.md` records
native source references, trace format, material-divergence definition,
unresolved causal classification and reproduction commands. `verification.json`
checks observation-only traces against uninstrumented output on every native
and TypeScript signal/timepoint. This is evidence, not new corpus coverage,
an aggregate refresh, or a production fix.

## BJT excess phase regression (#1142)

`packages/core/src/devices/fixtures/bjt-ptf-1142.cir` is an original,
self-authored common-emitter AC/transient probe under the repository MIT
licence. The adjacent test consumes it and pins its SHA-256 and ngspice-47
reference values. No third-party netlist was added. The unchanged corpus-g
`GMIN_STEPPING/gstep_cont3a.cir` retains its existing corpus-g provenance.
The equations follow ngspice BJT `bjttemp.c`, `bjtacld.c` and `bjtload.c`
(https://github.com/ngspice/ngspice/tree/master/src/spicelib/devices/bjt);
PTF is degrees, and the transient delay uses Weil's backward-Euler approximation.

## XSPICE flip-flop coverage (#1179)

### Toggle and synchronous SR flip-flops (#1254)

`benchmarks/xspice-tff-srff-1254/{d_tff,d_srff}.cir` are original spice-ts
fixtures, MIT (repository LICENSE). Both engines consume the identical deck.
The `.ngspice.tsv` files contain ngspice-47 `eprint q nq` output, consumed by
`packages/core/src/devices/xspice/xspice-tff-srff.test.ts`. The test checks every
state and every Q/NQ edge within 1 ps, including SR conflict (UNKNOWN).
No circuit-specific tolerances or solver adjustments are used.

Semantics and interface source (Public Domain, as stated in the source headers):
https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/digital
(`d_tff` and `d_srff`, `cfunc.mod` and `ifspec.ifs`).

Reproduce the reference from the repository root, replacing `d_tff` with
`d_srff` for the other model. The wrapper only sources the unchanged deck and
prints digital events; it adds no circuit elements or analysis directives.

```sh
printf 'reference\n.control\nsource benchmarks/xspice-tff-srff-1254/d_tff.cir\nrun\neprint q nq\nquit\n.endc\n.end\n' | ngspice -b
pnpm -C packages/core exec vitest run src/devices/xspice/xspice-tff-srff.test.ts
```

Before implementation both models were rejected as unsupported. Afterward,
all 18 Q/NQ transitions match ngspice-47 states; maximum absolute timing error
is 1.324e-23 s on these fixtures (macOS arm64, ngspice-47 KLU). This is a
coverage/timing comparison, not a speed or general waveform-parity claim.

`benchmarks/xspice-flipflop-1179/compare.ts` reuses the unchanged corpus-i
eSim `JK_Flipflop` and `4_bit_JK_ff` fixtures (GPL-3.0-only, pinned revision
`1a25a46ce15e`; see corpus-i/SOURCES.md), and corpus-f's ngspice
`examples/xspice/original-examples/mixed_mode.deck` (existing licence and
revision in corpus-f/SOURCES.md). Only GUI control blocks are removed, equally
for both engines. No circuit cards, transient directives or tolerances change.
The model semantics follow the Public Domain ngspice-47 source
https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/digital
(`d_jkff` and `d_dff`, `cfunc.mod` and `ifspec.ifs`).

## XSPICE magnetic models (#1217)

`benchmarks/xspice-magnetic/compare.ts` runs the existing corpus-i eSim
`Examples/Transformer/Transformer.cir.out` (GPL-3.0-only) and corpus-f
`examples/xspice/original-examples/analog_models2_{ac,dc,swept_dc,transient}.deck`
(BSD-3-Clause). Pinned upstream revisions, original licences and SHA-256 receipts
remain in `corpus-i/SOURCES.md`, `corpus-f/SOURCES.md` and their manifests.
Both engines read identical original bytes, including control blocks; no fixture
or tolerance changes. The script compares this selected bucket, not whole corpora.
Model semantics follow the Public Domain ngspice-47
[`xtradev` source](https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/xtradev):
`lcouple/cfunc.mod:182-249` and `core/cfunc.mod:246-365`, with ports/defaults
from the respective `ifspec.ifs`. Core hysteresis mode is explicitly rejected.

## Numparam strings (#1259)

`benchmarks/numparam-strings/compare.ts` sources the unchanged corpus-f
`examples/numparam/strings.cir` (BSD-3-Clause; provenance in corpus-f/SOURCES.md)
in ngspice-47 and passes identical bytes to spice-ts. An external observer
exports analog samples and digital event histories without editing the fixture.
Analog errors use the uniform 1%-of-peak threshold; digital state sequences and
event-time errors are reported separately. No circuit-specific tuning is applied.
Semantics follow ngspice-47 revision a80f6e3e95d51534905b1f23410a951802666656:
[`numparam/xpressn.c:1140-1210`](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/frontend/numparam/xpressn.c#L1140)
for adjacent quoted/identifier string atoms, and the Public Domain
[`digital/d_lut/cfunc.mod:168-223`](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/digital/d_lut/cfunc.mod#L168)
for table indexing, unknown entries and output delays (lines 227-259).

## BSIM3 transient NQS (#692)

`bsim3-nqs-692/reference.ts` reuses `bsim3v32-594/cards.ts`'s inverter chain
and existing corpus-f TSMC cards (provenance/licences above and in
`corpus/corpus-f/SOURCES.md`). It sets NQSMOD=0/1 on every transistor and
exercises the supported VERSION selectors with identical decks in both engines.
The generated `ngspice-47.json` is consumed by `bsim3-nqs.test.ts`.
No new third-party circuit material is introduced.
Model equations follow the UC Berkeley-copyrighted, permissively licensed
ngspice-47 source (the notice in each source file), pinned at
https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim3
(`b3ld.c:2478-2491,2593-2675,2803-2848,3109-3120`, `b3temp.c:785,803-804`)
and the sibling `bsim3v32` (`b3v32ld.c:2793-2806,2906-2988,3106-3163,3425-3436`,
`b3v32temp.c:853,873-874`). The transient implementation locally eliminates
the charge-node equation, retaining qcheq/qcdump integration histories.

## XSPICE gain declarative noise (#1278)

`benchmarks/xspice-gain-noise/compare.ts` sources the unchanged corpus-f
`examples/xspice/noise/noise_gain.cir` in ngspice-47 and passes identical bytes
to spice-ts (BSD-3-Clause; provenance in `corpus/corpus-f/SOURCES.md`). An
external batch observer exports the original control plots without editing
the fixture. The deck's summary interval of 16 exports 125 spectral points
per output; these are matched at identical frequencies within spice-ts's
1999-point sweeps. Both integrated totals cover the entire sweep.

Equations and source placement follow Public Domain ngspice-47
[`src/xspice/mif/mifnoise.c:262-321,340-364,383-411`](https://sourceforge.net/p/ngspice/ngspice/ci/a80f6e3e95d51534905b1f23410a951802666656/tree/src/xspice/mif/mifnoise.c).
Contrary to the original issue premise, `gain/cfunc.mod` has no noise law:
`noise_voltage` acts at the output voltage-source branch (not input-referred),
and `noise_current` across the input nodes. Independent white and flicker
powers are integrated separately. No thresholds or fixture bytes are tuned.

## corpus-o: Xyce analog/device regression inputs (#1045)

Pinned Xyce_Regression revision: `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`. 23 original, unadapted decks; both engines receive identical bytes. Repository README grants GPL version 3 or later; standalone decks with separate notices excluded by unchanged staticVerdict. Independent benchmark data, not package code.

Licence grant: https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/README.md (SHA-256 `82ff6df7bddcdf639483d261949a02a5f43da85d579f1242b05c3aa0c430f7cb`); retained unchanged in `benchmarks/corpus/corpus-o/licenses/xyce/README.md`. Full GPL-3.0 text retained in `benchmarks/corpus/corpus-o/licenses/xyce/COPYING` (SHA-256 `12ac5047f2af0522f06798b1589ffc4599bc29c91f954d7874e0320634e777c0`), copied unchanged from corpus-n because upstream links a missing COPYING. GPL applies to these independent benchmark inputs, not simulator package code.

| Deck | Pinned source URL | SPDX licence | SHA-256 |
|---|---|---|---|
| o-1 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/commonEmitterBjt_ngspice.cir | GPL-3.0-or-later | cff4fd7c9f9edb1a78c1d985ded41df53250e8ca2886f8262acc788b0d956bfd |
| o-2 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/commonEmitterBjt.cir | GPL-3.0-or-later | 9439fdb50af115647cfc50cc6718d0b7d49a1935cb78b141b66d1c87d803ce13 |
| o-3 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/gain-stage_b3.cir | GPL-3.0-or-later | 2c174bb54d3c2b941a74e1d89463cd13699b08ab4ea033b4b1121773bbccca71 |
| o-4 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/gain-stage1.cir | GPL-3.0-or-later | 6a12a9b6172cb9785513add28988697f19c87054ca55f6554e14fe994f8dcd21 |
| o-5 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/gain-stage2.cir | GPL-3.0-or-later | 6c00479b8bccb873d392b1d98cb88c97048fed31a6e6377f6ef1513cf29f1699 |
| o-6 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/gain-stage3.cir | GPL-3.0-or-later | 216f8ae59be39170031b3a275725e613d4df502e9049ba8e5ffe27bd086f1bf0 |
| o-7 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/invalid_device.cir | GPL-3.0-or-later | f17e7d674551d40e41a106e4cc7bf5f20ff482dca077222948c0d4149f5177ef |
| o-8 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/noiseBjt1.cir | GPL-3.0-or-later | 8f1d4d782a4ab80802291808a279275eeaeadfd7869f79820e5050fafb1e2209 |
| o-9 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/noiseBjt2.cir | GPL-3.0-or-later | 2d32fef5b0f3e3929a84798a55e837547765b8535285585c9d220f257887f2f4 |
| o-10 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/res_noise_ngspice.cir | GPL-3.0-or-later | 5f90a7de42b73c0c465c2c38931beb573bc067f20f9fd3a96c11fa4a736f6bd0 |
| o-11 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/NOISE/res_noise.cir | GPL-3.0-or-later | 8f283f9f84ae85d45dfb0ad9f0dee39309f2e026ef359ddfe47aae7b180caaad |
| o-12 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/VANOISE/gain-stage1_psp.cir | GPL-3.0-or-later | f718a5f43ad0be650bd713e5551aed00add0b343b9c05f90232dc9d7c9458873 |
| o-13 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/BJT_ANALYTIC/ramp_test2.cir | GPL-3.0-or-later | 4117823840f391e2e11481991d86efd58583043bbfa1e93f20808d8d77f89ef2 |
| o-14 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/BJT_EXTNODE/npn_rb_rc_re_2.cir | GPL-3.0-or-later | e827701a14ba46d2dd287f2e7a831c284fc127bac1bbeb2961f48e27f9c9bed1 |
| o-15 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/BJT_EXTNODE/npn_rc_re_1.cir | GPL-3.0-or-later | b222125ff7ca5ba305bcf6d8c0451cd02208b61a818e9de7b39432caa335b940 |
| o-16 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/BJT_EXTNODE/npn_rc_re_2.cir | GPL-3.0-or-later | c7bd3fa322552650009684c9cd4c7229507485f251e9945b1bd568ad93fc3913 |
| o-17 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/BJT_EXTNODE/npn1.cir | GPL-3.0-or-later | faea2b9386a9cc2e351d8e69f4e2896d309926d2c9f64d5409ac6cb111752fea |
| o-18 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/BJT_EXTNODE/npn2.cir | GPL-3.0-or-later | 54089a56e1b919d6b91f7da6528bc14a235bf05079488dbf73db762dfa7df287 |
| o-19 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE_ANALYTIC/breakdown_model.cir | GPL-3.0-or-later | c428a046c15bce99cb0f75a8346327a2becc1adb4c37b175c6d07da133159249 |
| o-20 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE_ANALYTIC/forward_model.cir | GPL-3.0-or-later | f5e090a36963633e2be6dc76dee709dc51efb4b9fa97dc5d93667c25b64dca9c |
| o-21 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE_CMC/DiodeClipper_DC.cir | GPL-3.0-or-later | 574f4b63a33c5a2d735258cdb4ca04e36a5a43f34b57d618a8eace385ca9196c |
| o-22 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE_CMC/DiodeClipper_noise.cir | GPL-3.0-or-later | debcbb8af4074b23d7a6a1e7eafd433ea646e4fd8d47a9db058102180f3bdf98 |
| o-23 | https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/Netlists/DIODE_CMC/DiodeClipper.cir | GPL-3.0-or-later | 828853fea5596b82de27b603fef5b28a879cd8b8ffc71c0bb3b908fe21ba7e39 |

## XSPICE analog delay (#1335)

`spice-heavy pnpm exec tsx benchmarks/xspice-delay/compare.ts` compares the
unchanged corpus-f `examples/xspice/delay/analog-delay1.cir` with ngspice-47.
The fixture's BSD-3-Clause licence, revision and SHA-256 remain in corpus-f's
manifest and SOURCES.md. The existing control-vector wrapper sources the original
bytes and exports retained plots, without changing the netlist or tolerances.
`--update` refreshes only this fixture's outcome and the derived report totals.
Per-output maximum normalized errors are published in corpus-f's control row,
including mismatches. The default `-r` row remains honestly not-compared.

Model source is ngspice-47, BSD-3-Clause:
[analog/delay](https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/xspice/icm/analog/delay).
`cfunc.mod:107-185` defines allocation/defaults, `193-255` defines startup,
sampling, delay rounding and control clamping; `ifspec.ifs:30-75` defines ports
and parameters. Contrary to the task's interpolation premise, this implementation
uses a sampled ring buffer, not linear interpolation (upstream marks that FIXME).
spice-ts commits samples on accepted points instead of mutating history during
Newton trials; solver-grid and trial-call differences remain measured parity losses.

## Current-output sensitivity regression (#1390)

`packages/core/src/analysis/sensitivity-current-output.ngspice.json` contains two
original RC decks (repository MIT licence) and their supported per-parameter raw
vectors generated with Homebrew ngspice-47. The DC deck extends the minimal
reproducer in https://github.com/spicets/spice-ts/issues/1390 with `AC 1` on the
source; the AC deck differs only in `.sens i(vin) ac dec 2 10 1k`.
The test runs the exact stored netlists, without simulator-specific edits.
Regenerate raw output with `SPICE_ASCIIRAWFILE=1 spice-heavy ngspice -b -r output.raw deck.cir`.
Only parameters supported by the existing bounded sensitivity implementation are
compared, not ngspice's additional model, geometry or temperature vectors.
ngspice uses one-sided finite differences; the regression compares DC and complex
AC derivatives at 1e-5 relative plus 1e-12 absolute tolerance and reports both
maximum absolute error and nonzero-vector relative error.

## MCP DC sensitivity (#1457)

`packages/mcp/fixtures/sensitivity-divider.cir` is an original MIT-licensed
analytic resistive divider, source: https://github.com/spicets/spice-ts/issues/1457.
The MCP regression test and `benchmarks/mcp-sensitivity/compare.mts` read the same
stored bytes; ngspice-47 receives that file unchanged. The comparison covers the
seven parameters supported by core (R1/R2 resistance, multiplier and scale; V1 DC),
not ngspice's additional model/temperature/geometry vectors. Run
`spice-heavy pnpm exec tsx benchmarks/mcp-sensitivity/compare.mts` after core build.
It prints SHA-256, both engines' derivatives and maximum absolute/relative error.
The 1e-5 relative threshold is inherited from the existing core sensitivity suite:
ngspice's one-sided and core's symmetric finite differences are not bit-identical.
This is correctness evidence only, not a performance comparison.

## XSPICE microstrip OP/AC (#1458)

`benchmarks/xspice-mlin/compare.ts` observes the unchanged BSD-3-Clause corpus-f
`examples/xspice/transmission_lines/mlin.cir`; provenance and deck hash remain in
`corpus/corpus-f/SOURCES.md`. Both engines receive identical original bytes.
The ngspice observer exports the existing `z = v(in)/-i(v1)` vector. Run
`spice-heavy pnpm exec tsx benchmarks/xspice-mlin/compare.ts`. It checks all 200
frequencies and reports max complex absolute error divided by max reference
magnitude, failing above 1%. Runtimes have different process boundaries and are
not evidence of a speed advantage.

Formula sources (BSD-3-Clause, Copyright 2025 Vadim Kuznetsov; retained in
`packages/core/src/devices/xspice/mlin.LICENSE`):
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/tlines/msline_common.c
lines 104-136,225-248 (geometry), 267-311 (dispersion), 315-347 (loss);
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/tlines/mlin/cfunc.mod
lines 116-151 (DC/AC). Contrary to the original issue wording, reference DC is an
ideal short and disp=0 is Kirschning-Jansen, not disabled dispersion.
Transient remains unsupported, tracked in #1461.

## XSPICE ideal coupled line OP/AC (#1551)

The project-authored MIT regression deck and ngspice-47 OP/AC oracle values
are in `packages/core/src/devices/xspice/cpline.test.ts`, with the reproduction
command and observation commands. Nonzero even/odd attenuation is covered.
The original BSD-3-Clause corpus-f `examples/xspice/transmission_lines/cpline_ac.cir`
is unchanged (provenance in `corpus/corpus-f/SOURCES.md`). Run its single-fixture
refresh with `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/control-vectors.ts
--control-vector-child examples-xspice-transmission-lines-cpline-ac-cir`.
This uses the existing uniform corpus-f tolerance, not a per-circuit override.
It compares all 48 S/Y/Z signals at 100 SP frequencies; no speed claim is made.

Formula and parameter sources (BSD-3-Clause, Copyright 2025 Vadim Kuznetsov;
full notice in `packages/core/src/devices/xspice/cpline.LICENSE`):
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/tlines/cpline/cfunc.mod
lines 68–76 (parameters and attenuation conversion), 84–107 (DC shorts),
140–164 (AC impedance matrix);
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/tlines/cpline/ifspec.ifs
lines 111–183 (parameter defaults). Transient is explicitly rejected with
`UNSUPPORTED_XSPICE_CPLINE`; no transient history implementation is adapted.

## XSPICE coupled microstrip OP/AC (#1483)

`spice-heavy pnpm exec tsx benchmarks/xspice-cpmlin/compare.ts` sources the
unchanged BSD-3-Clause corpus-f `examples/xspice/transmission_lines/cpmline_ac.cir`
(provenance in `corpus/corpus-f/SOURCES.md`). Both engines receive identical
original bytes. This is an SP sweep (100 frequencies, 0.2–4.2 GHz), despite
the filename. All 48 common S/Y/Z vectors are compared with the uniform 1%
max-complex-error/reference-vector-peak rule. The reference's last-excitation
node/branch vectors have no SP-result counterpart and are listed as exclusions.
Runtimes include different process boundaries and are not speed evidence.

Formula sources (BSD-3-Clause, Copyright 2025 Vadim Kuznetsov; full notice in
`packages/core/src/devices/xspice/cpmlin.LICENSE`):
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/tlines/msline_common.c
lines 225–248 (shared Hammerstad helpers), 315–347 (loss), 350–419
(model=0 quasi-static), 485–627 (disp=0 dispersion);
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/tlines/cpmlin/cfunc.mod
lines 63–94,125–199 (propagation, DC and AC matrix);
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/tlines/tline_common.h
lines 41–52 (constants/macros). The port deliberately retains upstream's
unparenthesized `sqr(er - 1)` expansion, which evaluates to -1 rather than
the intended square. `tline_common.c:106–172` supplies transient history only;
none of it is needed or ported for this OP/AC slice. Transient and nonzero
model/disp selectors are explicitly unsupported, not silently approximated.


## MCP AC metrics (#1391)

`benchmarks/mcp-ac-metrics/two-pole.cir` is an original MIT-licensed buffered
two-pole op-amp macromodel, derived from H(s) = 10/(1+sRC)^2, R=1k, C=1u.
Source: https://github.com/spicets/spice-ts/issues/1391 (no third-party model).
The MCP unit test reads this fixture; `compare.mts` runs the identical elements
and sweep against ngspice-47 `.meas ac` UGF and phase measurements. Only the
ngspice observation/control commands differ, not the circuit or solver settings.
Run `spice-heavy pnpm exec tsx benchmarks/mcp-ac-metrics/compare.mts` after build.
The script prints both engines' values and errors and fails above 0.5% UGF or
0.5 degrees phase-margin error. Interpolation differs (linear frequency in
ngspice, log frequency in MCP). This is correctness evidence, not a speed claim.

## Diode independent sidewall resistance (#1515)

`benchmarks/diode-rsw/sidewall.cir` is an original spice-ts regression deck
(repository MIT licence), authored for https://github.com/spicets/spice-ts/issues/1515.
No third-party model is redistributed. `compare.ts` sources identical fixture
bytes in ngspice-47 and spice-ts, reports SHA-256, machine, runtimes and max/RMS
errors for OP/DC/complex AC/TRAN node voltages and source current. Transient
samples are linearly interpolated onto ngspice's adaptive timepoints; the
unchanged parity gate is 1% of each reference signal's peak. Run
`spice-heavy pnpm exec tsx benchmarks/diode-rsw/compare.ts`; add
`--write-reference` to refresh the JSON oracle consumed by the core test.
`default-ns.cir` is the identical original MIT deck with only ` NS=1.4`
removed, exercising ngspice-47's bottom-voltage-evaluated sidewall current
and sidewall-node companion conductance. Run the same command with
`--default-ns` (and optionally `--write-reference`) for its four-analysis oracle.
Self-heating with RSW remains an explicit unsupported error.

## VBIC transient thermal capacitance (#1522)

`benchmarks/vbic-thermal-transient/power-step.cir` is project-authored, MIT under
the repository licence. It steps collector power with an active RTH/CTH node.
The analytic thermal-source tests are also project-authored and MIT.
`compare.ts` runs this deck and the unchanged corpus-f
`examples/vbic/vbic99_tran.sp` through the corpus-f identical-byte harness and
prints every common signal's peak-normalized error using its uniform 1% rule.
The public deck retains its pinned corpus-f source, SHA-256 and BSD-3-Clause
licence (see `benchmarks/corpus/corpus-f/SOURCES.md` and `manifest.json`). It
still fails on nondefault resistor temperature exponents (first XRE=2), which
require DC physics outside the CTH slice. No zero-error metric is assigned to
that failure, and no edited variant is passed off as the public deck.

Equations follow ngspice-47 `src/spicelib/devices/vbic/vbicload.c`, BSD-3-Clause,
[source](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/vbic/vbicload.c).
Lines 4012-4013 define Qcth=CTH*dT, 4117-4118 apply instance SCALE,
901-904 integrate it, and 1419-1423 stamp its companion current/Jacobian.
Run `spice-heavy pnpm exec tsx benchmarks/vbic-thermal-transient/compare.ts`
after `pnpm build`. Timings include cold child launch and adapters, not just
the solver. No performance superiority is claimed.


## MOS3 instance temperature (#1512)

`benchmarks/mos3-instance-temperature/reference.ts` generates original synthetic
NMOS/PMOS bias decks under the repository MIT licence, with source and rationale
at https://github.com/spicets/spice-ts/issues/1512. No third-party netlist or model
is copied. The temperature precedence follows
[ngspice-47 mos3temp.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/mos3/mos3temp.c).
The test reads `reference.json`, including identical deck bytes, SHA-256 hashes,
ngspice-47 invocation, OP and DC TEMP samples. Cases cover TEMP=75, DTEMP=25,
ambient TEMP=50, and TEMP overriding DTEMP for both polarities, including
series resistance, body bias and junction parameters.
Regenerate with `spice-heavy pnpm exec tsx benchmarks/mos3-instance-temperature/reference.ts`.
Check with `spice-heavy pnpm exec tsx benchmarks/mos3-instance-temperature/compare.mts`.
The comparison prints maximum relative error per quantity and retains the
existing MOS3 OP tolerance (1e-12 absolute + 1e-7 relative). This is correctness
evidence, not a speed claim.

## BJT series-resistance temperature coefficients (#1514)

`benchmarks/bjt-resistor-tempco-1514/compare.ts` generates original MIT-licensed
bias decks and the oracle consumed by
`packages/core/src/devices/bjt-resistor-tempco-1514.test.ts`. No upstream circuit
is redistributed. Formula reference (BSD-3-Clause): ngspice-47 `bjttemp.c`,
https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/bjt/bjttemp.c
(RC/RE conductance and independent RB/RBM quadratic temperature laws).

Run `spice-heavy pnpm exec tsx benchmarks/bjt-resistor-tempco-1514/compare.ts`.
Add `--update` to regenerate the test oracle. Both engines receive identical
deck bytes, including uniform RELTOL=1e-8, ABSTOL=1e-14 and VNTOL=1e-10 to
reduce reference Newton residuals; comparison retains the existing temperature
suite's 2e-5 relative-error threshold. Default-solver-tolerance development runs
had residuals up to 8.07e-5, exceeding that threshold; no comparison threshold
was relaxed. The five cases cover 85 C OP, ascending/descending TEMP sweeps,
non-default TNOM, NPN/PNP, AREA*M, IRB, equal/omitted RBM and fixed RB. Compare
loaded base/collector voltages and both source currents. Other temperature
coefficients still fail closed away from TNOM. This is not speed evidence.

### VBIC resistor temperature exponents (#1526)

`benchmarks/vbic-resistor-temperature/compare.ts` authors 48 identical-byte OP
decks under the repository MIT licence. `ngspice-47.json` is its generated
oracle, consumed by the core regression test (not a benchmark receipt).
Equation source: ngspice `src/spicelib/devices/vbic/vbictemp.c`,
https://github.com/ngspice/ngspice/blob/master/src/spicelib/devices/vbic/vbictemp.c
(ngspice BSD-style licence; equations independently implemented in TypeScript).
Run `spice-heavy pnpm exec tsx benchmarks/vbic-resistor-temperature/compare.ts`;
use `--generate` to regenerate the oracle. Covers seven isolated exponents and
their combination, -20/85 C, NPN/PNP, AREA=2, substrate transport, and NPN
self-heating. Default solver tolerances, fixed 1e-6 relative current threshold.
Before: all cases rejected; after: maximum relative error 7.165004900500094e-7
over four source currents in 48 cases. This is correctness, not speed evidence.
Losses: ngspice-47 PNP self-heating at 85 C failed with NaN temperature;
PNP thermal cases are excluded explicitly, not reported as passing. The unchanged
public `examples/vbic/vbic99_tran.sp` now passes resistor-exponent validation but
still fails closed on nondefault EA/EAIE/EAIC/EANE/EANC; it is not claimed to run.

## XSPICE xfer frequency tables (#1539)

Contract sources: ngspice-47 `src/xspice/icm/analog/xfer/cfunc.mod` and
`ifspec.ifs`, https://github.com/imr/ngspice/tree/ngspice-47/src/xspice/icm/analog/xfer
(ngspice source distribution COPYING, BSD-style licence). Independently
implemented equations/parser in TypeScript; no upstream C code copied.
`benchmarks/xspice/xfer-compare.ts` contains original MIT microdecks, sends
identical netlist bytes to both engines, and reports all four cases with a fixed
1e-10 normalized complex-error threshold, without per-circuit tuning.
The corpus-f rf/sp/file.cir bytes/source/licence remain unchanged (BSD-3-Clause,
revision 3ef069fb1f04177a153f342a32d941fc20ff047e). Its remaining pre_snp gap and
unavailable comparison metric are documented in `benchmarks/xspice/README.md`.

### VBIC activation energies (#1529)

`benchmarks/vbic-activation-energies/compare.ts` authors 36 identical-byte OP
decks under the repository MIT licence. Its generated `ngspice-47.json` oracle
is consumed by `vbic-activation-energies.test.ts`. Covers each of EA, EAIE,
EAIC, EAIS, EANE, EANC, EANS and EAP separately and combined, NPN/PNP,
TEMP=27/85 C, four node voltages and four terminal/source currents.
Equation source: ngspice-47 `src/spicelib/devices/vbic/vbictemp.c`,
https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/vbic/vbictemp.c
(ngspice BSD-style licence; independently implemented equations).
Run `spice-heavy pnpm exec tsx benchmarks/vbic-activation-energies/compare.ts`;
use `--generate` to regenerate the oracle. Default solver tolerances and the
existing fixed 1e-6 relative threshold are unchanged. Before: 36 OP cases rejected
nondefault EA*. After: maximum relative error 3.3613865080273087e-7 across all
eight signals. No speed claim. Unit tests additionally cover unequal emission
coefficients, parasitic cross-mapping, GAMM, junction potentials and capacitances.
ISRR remains fixed at 1, XISR/DEAR at 0; EA must not change that ratio.

The unchanged public `examples/vbic/vbic99_tran.sp` advances past EA* but still
fails with `Invalid bounded VBIC DC model parameter: 'HRCF'` (its HRCF=0 is
outside the current bounded domain). ngspice-47 runs the unchanged deck with
2065 transient rows. No spice-ts waveform parity is claimed for that deck.

## XSPICE sidiode (#1563)

Original MIT fixtures `benchmarks/xspice/sidiode.cir` and `sidiode-ac.cir`
exercise off/forward/reverse regions, quadratic smoothing, tanh current limits
and AC conductance. Both engines receive identical bytes. Reproduce with
`spice-heavy pnpm exec tsx benchmarks/xspice/sidiode-compare.ts`.
The fixed maximum error threshold is 1e-6, normalized by each reference trace's
peak absolute current (complex magnitude for AC); transient comparison linearly
interpolates spice-ts onto all ngspice timepoints. RMS error is also reported.

Equation/parameter sources (BSD-3-Clause, copyright 2012/2018 The ngspice team;
full notice in `packages/core/src/devices/xspice/sidiode.LICENSE`):
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/xtradev/sidiode/cfunc.mod
(lines 127-184 initialization, 193-239 current/partial/AC), and
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/xtradev/sidiode/ifspec.ifs
(lines 34-104 ports, defaults and bounds).
Preserves ngspice's non-derivative tanh partials and its unlimited smoothed-knee
discontinuities. No upstream circuit deck is copied. Before implementation,
spice-ts rejected both fixtures as unsupported; no baseline waveform exists.

## Control random vectors (#1597)

`packages/core/src/parser/control/fixtures/random-1597.cir` is an original MIT
fixture. Golden values in `random-1597.test.ts` were printed by macOS ngspice-47
using `ngspice -b` on that fixture; spice-ts changes only the output commands to
capture all real and imaginary components. Semantics follow BSD-3-Clause ngspice
revision `3ef069fb`, `src/maths/cmaths/cmath2.c` (`cx_sunif`, `cx_sgauss`) and
`src/maths/misc/randnumb.c` (`drand`, `gauss0`, `gauss1`):
https://github.com/imr/ngspice/blob/3ef069fb/src/maths/cmaths/cmath2.c
The unchanged corpus-f `examples/Monte_Carlo/{montecarlo,mc_ring}.sp` decks use
the existing corpus provenance and licence. Before: both failed control parsing
or execution. After: `montecarlo.sp` completes five AC runs; `mc_ring.sp` passes
the comment line but still fails nominal transient convergence (tracked in #1600).
This is control-language coverage, not a claim of full Monte Carlo parity.

## XSPICE microstrip open end (#1621)

| Fixture | Source | Licence |
| --- | --- | --- |
| `xspice-msopen/terminated.cir` and the generated variants embedded in `xspice-msopen/ngspice-47.json` | Original spice-ts mlin/msopen OP + AC regression decks | MIT |

`xspice-msopen/compare.ts` sources identical deck bytes into ngspice-47 and
spice-ts, comparing exact OP values and per-point AC magnitude, phase and complex
relative errors. `ngspice-47.json` archives the numeric ngspice output read by the
core regression test. See `xspice-msopen/README.md` for regeneration and limits.
The implementation adapts BSD-3-Clause ngspice-47 formulas, Copyright 2025 Vadim
Kuznetsov, with the full notice in `packages/core/src/devices/xspice/msopen.LICENSE`:
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/tlines/msopen/cfunc.mod
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/tlines/msopen/ifspec.ifs
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/tlines/msline_common.c

## XSPICE multi_input_pwl min/max (#1620)

| Files | Source | Licence |
| --- | --- | --- |
| `xspice-multi-input-pwl/{dc,tran}.cir` | Original spice-ts two-input min/max regression decks, authored for #1620 | MIT (repository licence) |
| `xspice-multi-input-pwl/{dc,tran}.raw` | ngspice-47 generated output from the identical decks; regenerated and consumed by `compare.ts --refresh` | Generated data from the MIT decks |

Model semantics: [ngspice-47 cfunc.mod](https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/analog/multi_input_pwl/cfunc.mod)
and [ifspec.ifs](https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/analog/multi_input_pwl/ifspec.ifs).
Only `and`/`or` are implemented here; `nand`/`nor` fail explicitly. The
ngspice-47 model emits a diagnostic and truncates unequal x/y arrays; spice-ts
instead raises `InvalidCircuitError`. ngspice sets neither PARTIAL nor AC_GAIN;
spice-ts supplies the exact DC/transient Jacobian but preserves zero AC gain.
Ports follow ngspice's `vd`/`id` interface (ground one terminal for single-ended
signals). The ordinary `pwl` helper includes smoothing, extrapolation and an
iteration limiter, so it cannot implement this model's clamped linear table.

Reproduce: `spice-heavy pnpm exec tsx benchmarks/xspice-multi-input-pwl/compare.ts`.
The observer loads each unchanged deck in ngspice-47 and writes only the output
vectors. The script checks regenerated reference grid/data against the committed
raw files, then reports the existing aggregate harness's linear alignment,
absolute and relative max/RMS errors, deck SHA-256, versions, CPU and runtimes.
Separate process boundaries mean these runtimes are not a speed claim.

## XSPICE potentiometer (#1619)

`benchmarks/xspice/potentiometer.cir` is an original project-authored MIT
fixture; no upstream circuit is copied. Both engines receive identical bytes.
It covers the default 100 kOhm midpoint, an explicit linear taper, and a log
taper with nondefault `log_multiplier=2`, each with a loaded wiper and default
single-ended `g` ports in `r0, wiper, r1` order. A 5 V operating point, nine-point
source DC sweep, and short piecewise-linear transient exercise node voltages
and source branch current without smooth-waveform interpolation error.

Behavior and parameter references are ngspice-47's Public Domain sources
(Georgia Tech Research Corporation, Jeffrey P. Murray):
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/xtradev/potentiometer/cfunc.mod
and
https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/xtradev/potentiometer/ifspec.ifs.
The model's lower resistance is `position*r` for linear taper and
`r/10**(position*log_multiplier)` for logarithmic taper; upper resistance is
`r-lower`. The benchmark uses interior positions; endpoint clamping and warnings
belong to unit coverage, not this parity claim. Contrary to the initial issue
description, ngspice-47 has no `r_end` or `r_wiper` parameters. Out-of-range
`position` is clamped to [0,1] with a MIF warning, not rejected as a parse error.
The model then substitutes 1e-9 or 0.999999999 at the respective endpoints.

Run `pnpm exec tsx benchmarks/xspice/potentiometer-compare.ts` from the repo root
with ngspice and spice-heavy on PATH. The runner wraps every oracle batch in
`spice-heavy`, uses `HERMES_SCRATCH_DIR` (default `~/.cache/spice-ts/benchmarks`,
not system temporary storage), and compares both freshly generated and committed raw
`potentiometer-reference/{op,dc,tran}.txt` ngspice-47 wrdata tables. Missing,
nonfinite, incomplete, or mismatched samples fail closed. OP/DC use a fixed
1e-6 pointwise relative threshold; transient uses 1e-6 peak-normalized maximum
and RMS thresholds after linear interpolation at all reference times. No
aggregate tolerance is relaxed. Output records fixture SHA-256, oracle version,
platform, sample counts, metrics, and cold timings (oracle includes process
startup/semaphore queueing; TS timing covers simulation). This is bounded
resistive-network parity evidence, not a general speed claim.


## JFET instance area/m regressions (#1695)

- Original project-authored decks in `packages/core/src/devices/jfet-instance-1695.test.ts`, MIT under repository `LICENSE`. No third-party netlists were copied.
- Oracle: ngspice-47, identical `.op` and `.tran` netlists, `ngspice -b -r deck.raw deck.cir` with `SPICE_ASCIIRAWFILE=1`.
- Model semantics are pinned to [ngspice-47 a80f6e3](https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices): `jfet/jfetpar.c`, `jfet/jfetload.c`, `jfet2/jfet2par.c`, `jfet2/jfet2load.c`, and `jfet2/psmodel.c`. AREA scales current, junction charge and series conductance; M multiplies the complete stamp, including gmin. PSids uses DELTA/AREA before multiplying the device by M.
- Targeted reproduction: `pnpm -C packages/core exec vitest run src/devices/jfet-instance-1695.test.ts` checks three pinned OP results at 1e-6 relative and the transient endpoint at 1%. The full-waveform one-off comparison measured max/RMS relative V(2) error 0.0435873%/0.00887238% over 126 samples (ngspice linearly interpolated at spice-ts times). No corpus tolerance was changed. These are correctness checks, not speed evidence.
- Before: all ten area/m simulation cases were rejected. After: three OP decks match ngspice at worst 2.77e-10 relative. OFF, IC and non-nominal TEMP remain unsupported; no general JFET instance-form parity claim.

## XSPICE table2d/table3d (#1683)

- Fixtures: original project-authored generators `tableDeck` / `tableData` in
  `packages/core/src/devices/xspice/table.test.ts`, MIT under repository LICENSE.
  Each oracle writes identical deck and table bytes for spice-ts and ngspice-47.
- Reproduce: `NGSPICE_TABLE_REFERENCE=1 pnpm -C packages/core exec vitest run src/devices/xspice/table.test.ts`.
- Semantic references (GPL-2.0 upstream, consulted, not embedded):
  https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/table/table2D/cfunc.mod
  (file layout 533-595, 648-711; clamping/ENO partials/bilinear output 286-377),
  https://github.com/imr/ngspice/blob/ngspice-47/src/xspice/icm/table/table3D/cfunc.mod
  (file layout 569-660, 715-784; trilinear output/partials 355-410), and
  `table/mada/{eno,eno2,eno3}.c` for the ENO numerical contract.
- Before: both models rejected as unsupported. After: OP/DC/transient run.
  Affine fixtures: 17 matched DC points each, maximum relative output error 0;
  ngspice/spice-ts Newton iterations 56/55 for both dimensions.
- Explicit loss, retained without tolerance changes or discarded points:
  quadratic fixtures produce maximum relative error 5.800464037123877e-4 (2D)
  and 4.2345966546693053e-4 (3D), 17 matched points each; iterations 65/64.
  At x=0.5 ngspice's default-tolerance output is 2.5mV below the exact
  bilinear/trilinear interpolant. This is not general nonlinear parity at 1e-9.
  The test reports the full metric and keeps a regression for the discrepancy;
  it does not count these fixtures as passing the 1e-9 parity threshold.


## JFET instance and circuit temperature (#1695)

- Source: original project-authored decks generated in `benchmarks/jfet-temperature/compare.ts`, MIT under repository `LICENSE`. No third-party decks copied.
- URL: https://github.com/spicets/spice-ts/blob/main/benchmarks/jfet-temperature/compare.ts
- Semantic source pin: ngspice-47 `a80f6e3e95d51534905b1f23410a951802666656`, `src/spicelib/devices/jfet/jfettemp.c:JFETtemp`, `jfet2/jfet2temp.c:JFET2temp`, `jfet2/psmodel.h:NVT/VBI`, `jfet2/psmodel.c:PSinstanceinit`, and `src/spicelib/analysis/cktsopt.c:CKTsetOpt` (model TNOM default). Upstream source licences apply to consulted references; not redistributed here.
- Reproduce: `spice-heavy pnpm exec tsx benchmarks/jfet-temperature/compare.ts`. Identical deck bytes and SHA-256 per engine, ngspice-47 version check, machine, wall times, matched-point max/RMS relative errors. No performance claim.
- Before: nonnominal instance/circuit temperatures rejected with `UnsupportedTemperatureError`; circuit TNOM rejected at parse time. After: eight required NJF/PJF OP decks have maximum relative error `5.12134e-11`; two nonnominal-temperature transient decks have maximum voltage/current relative errors `1.14508e-4` / `6.81479e-5` at linearly matched points. Unchanged gates: OP `1e-6`, transient `1%`, denominator floor `1e-12`.
- Explicit losses: two additional level-2 OFF + biased-gate OP decks produce voltage/current relative errors `0.0472779` / `0.109026`. They are printed with failing signal verdicts as known initialization losses related to #1698, not counted as temperature-law passes. Existing level-2 charge-law losses in `jfet-off-ic` remain unchanged. `.step TEMP` is still explicitly rejected because JFETs have no mutable temperature hook. Nondefault circuit TNOM is bounded to JFETs and temperature-independent passives/sources; unsupported model families fail closed.

## Bounded WASM diode AC (#1637)

See also the bounded BJT AC fixtures (#1653): original project-authored NPN/PNP common-emitter, common-base and forward-biased collector-base junction decks in `packages/wasm/src/test-support/bjt-ac.ts`, MIT under the repository `LICENSE`. Source URL: https://github.com/spicets/spice-ts/blob/main/packages/wasm/src/test-support/bjt-ac.ts. After `pnpm build`, reproduce with `spice-heavy pnpm -C packages/wasm exec tsx scripts/bjt-ac-accuracy.ts`. The runner uses identical netlist bytes for JS, WASM and ngspice and records hashes, version, host, point counts, end-to-end request time (not a speed benchmark), matched complex max/RMS relative errors, and rejected/missing signals without hiding losses. No per-circuit tolerance changes.

See also bounded MOS1 AC (#1663): original project-authored NMOS/PMOS common-source, body-driven, triode and inverse-mode decks in `packages/wasm/src/test-support/mos1-ac.ts`, MIT under the repository `LICENSE`. Source URL: https://github.com/spicets/spice-ts/blob/main/packages/wasm/src/test-support/mos1-ac.ts. After `pnpm build`, reproduce with `spice-heavy pnpm -C packages/wasm exec tsx scripts/mos1-ac-accuracy.ts`. Identical netlist bytes go to JS, WASM and ngspice; the runner records hashes, version, host, timings, all rejected/missing signals and matched complex max/RMS errors for output, supply/gate current and gate voltage. Before this change all eight WASM decks return `UNSUPPORTED_FEATURE`; afterward all return 91 frequency points. Against ngspice-47, maximum output complex relative error is `1.978888909145794e-9`; WASM/JS output complex error is at most `2.3883838727636192e-15`. Losses remain in small signals: maximum gate-current WASM/JS complex relative error is `6.898475368721798e-8`, and body-driven gate-voltage error is `2.9959320801965073e-7` (`2.9960128511547326e-7` versus ngspice). The unit contract is output magnitude/phase at the unchanged BJT `1e-9` relative tolerance, not all-signal relative parity or a speed claim.

- Source: original project-authored diode+RC deck in `packages/wasm/src/test-support/diode-ac.ts`; no third-party material or adaptations.
- URL: https://github.com/spicets/spice-ts/blob/main/packages/wasm/src/test-support/diode-ac.ts
- Licence: repository MIT (`LICENSE`).
- Reproduce after `pnpm build`: `spice-heavy pnpm -C packages/wasm exec tsx scripts/diode-ac-accuracy.ts`.
- The runner supplies identical netlist bytes to WASM, JS and ngspice, recording SHA-256, ngspice version, machine and matched-frequency max/RMS complex relative errors. Default tolerances; no per-engine rewrites, no speed claim. These are two bounded diode AC fixtures, not general device parity.
- Reverse-bias regression (#1643): the second fixture changes only `DC 2` to `DC -2`. Ratio-based JS complex division reduces maximum JS/WASM magnitude/phase relative difference from `1.0673872101548122e-9` to `7.186977714583678e-12`; forward bias changes from `9.196912374487967e-15` to `2.770800274343219e-16`. Both retain the uniform `1e-9` test bound.

- Losses: at 29 matched frequencies per fixture against ngspice-47, forward-bias maximum complex relative error remains `2.8587191588933306e-5` (output voltage). Reverse-bias source-current maximum error is unchanged for WASM (`1.1135200312921988e-9`) and worsens for JS from `1.9322872245381283e-10` to `1.1059995372775657e-9`. Closer backend agreement is not improved oracle accuracy; no tolerances are relaxed.

## Five-argument PULSE / XSPICE digital_models reference (#1706)

- Unchanged input: `benchmarks/corpus/corpus-f/fixtures/examples/xspice/original-examples/digital_models.deck`, from ngspice commit `3ef069fb1f04177a153f342a32d941fc20ff047e` (BSD-3-Clause; see corpus-f `SOURCES.md` and `LICENSE.txt`). Upstream: https://github.com/imr/ngspice/blob/3ef069fb1f04177a153f342a32d941fc20ff047e/examples/xspice/original-examples/digital_models.deck.
- Test-consumed output: `packages/core/src/devices/xspice/digital-models-ngspice47.json`, generated by `spice-heavy python3 benchmarks/xspice/digital-models-reference.py` using `ngspice -b -r` on identical bytes; contains input SHA-256 and all time/v(1)/i(v1) samples. Generator and tests are project-authored (MIT).
- Semantic sources (BSD-3-Clause): [ngspice-47 vsrcload.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/vsrc/vsrcload.c#L97-L132) and [isrcload.c](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/isrc/isrcload.c): exactly five PULSE arguments select PW=0, not an infinite plateau. This is a shared source grammar fix, not digital event tuning.
- Verification: `pnpm -C packages/core exec vitest run src/devices/xspice/xspice-digital-models-current.test.ts src/parser/waveform-parser.test.ts`. The unchanged-deck current is checked in both grid directions against the uniform 1%-of-peak criterion. Corpus triage goes from 67/71 candidate/reference points and error 1.0 to 71/71 and aligned error 0 for both voltage and current. No general speed or XSPICE parity claim.

## WASM MOS1 constant RSH and NRD/NRS backend parity (#1712)

- Source: original project-authored MIT common-source decks in `packages/wasm/src/numeric-wasm-mos1-rsh.test.ts`; no third-party model cards or adaptations.
- URL: https://github.com/spicets/spice-ts/blob/main/packages/wasm/src/numeric-wasm-mos1-rsh.test.ts
- Licence: repository MIT (`LICENSE`).
- Reproduce after `pnpm build`: `pnpm -C packages/wasm exec vitest run src/numeric-wasm-mos1-rsh.test.ts`.
- Identical netlist bytes and default options compare WASM against core TypeScript for NMOS/PMOS drain/source/both sheets, RD/RS precedence, given RD=0 (open terminal per core #757, not fallback), default squares and zero squares across OP/DC/tran/AC (64 fixtures). Every node and source current uses `max(1e-12, 1e-9 * abs(reference))`; AC magnitude and phase use `1e-9` relative only. Accepted transient time grids must be identical. The test prints maximum absolute differences and point counts and checks the 64/65-unknown boundary. Before this slice all 64 parity fixtures returned structured `UNSUPPORTED_FEATURE`; this is bounded backend parity evidence, not an ngspice accuracy or speed claim.


## WASM MOS1 constant RD/RS backend parity (#1708)

- Source: original project-authored MIT common-source decks in `packages/wasm/src/numeric-wasm-mos1-series.test.ts`; no third-party model cards or adaptations.
- URL: https://github.com/spicets/spice-ts/blob/main/packages/wasm/src/numeric-wasm-mos1-series.test.ts
- Licence: repository MIT (`LICENSE`).
- Reproduce after `pnpm build`: `pnpm -C packages/wasm exec vitest run src/numeric-wasm-mos1-series.test.ts`.
- Identical netlist bytes and default options compare WASM against core TypeScript for NMOS/PMOS, RD-only, RS-only and RD+RS across OP/DC/tran/AC (24 fixtures). Every node and source current is checked at `max(1e-12, 1e-9 * abs(reference))`; AC magnitude and phase use `1e-9` relative only. Accepted transient time grids must be identical. The test prints maximum absolute differences and point counts. Before this slice all 24 fixtures returned structured `UNSUPPORTED_FEATURE`; this is bounded backend parity evidence, not an ngspice accuracy or speed claim.

## WASM parameter-free hierarchy parity (#1726)

- Source: original project-authored fixtures in `packages/wasm/src/numeric-wasm-subckt.test.ts`, MIT under repository `LICENSE`. No external decks or model cards are redistributed.
- Nine circuits cover two-instance resistor/RC networks, global and nested two-level definitions, case-insensitive lookup, diode clamps, twice-instanced BJT and CMOS inverters, local F/H sensing branches and sibling-local model shadowing. They produce 34 OP/DC/TRAN/AC parity cases (RC uses the existing TRAN/AC-only passive-device surface).
- Reproduce with `pnpm -C packages/wasm exec vitest run src/numeric-wasm-subckt.test.ts`. Both backends receive identical source bytes and default options. Every node, branch and AC component uses `max(1e-12, 1e-9 * abs(reference))`; accepted transient grids are exactly equal. Seven structured rejection cases and the flattened 64/65-unknown boundary bring the total to 43 tests.
- Before: all 43 tests fail, including all 34 valid hierarchy cases rejected as unsupported. After: all 43 pass. This is bounded WASM/core agreement, not an ngspice accuracy or speed claim. Numeric kernel and artifact are unchanged; parameterized hierarchy remains unsupported.

## WASM constant BJT base resistance (#1720)

- Source: original project-authored NPN/PNP decks in `packages/wasm/src/numeric-wasm-bjt-rb.test.ts`, MIT under repository `LICENSE`. Public source: https://github.com/spicets/spice-ts/blob/main/packages/wasm/src/numeric-wasm-bjt-rb.test.ts. No third-party netlists or model cards.
- Reproduce after `pnpm build`: `pnpm -C packages/wasm exec vitest run src/numeric-wasm-bjt-rb.test.ts`.
- Identical netlist bytes and default options compare constant `RB=5000`, alone and with `RC=10 RE=2`, across OP/DC/tran/AC (16 fixtures). Every node voltage and source current uses the existing `max(1e-12, 1e-9 * abs(reference))` bound; AC magnitude/phase use `1e-9` relative only. Accepted transient grids must be identical. Before, all 16 fixtures rejected RB; after, all pass. Maximum absolute differences by analysis are OP `2.7533531010703882e-14`, DC `7.549516567451064e-14`, transient `3.197442310920451e-14`, and AC magnitude/phase `5.684341886080801e-13`. These mixed-unit maxima are backend-parity receipts, not ngspice accuracy or speed evidence. No parity failures; IRB/RBM remain unsupported.

## BSIM4 grounded-channel transient fringe charge (#1367)

- Source: original project-authored MIT deck, not adapted fixture bytes: https://github.com/spicets/spice-ts/tree/main/packages/core/src/devices/bsim4/__fixtures__/grounded-channel. Licence: repository `LICENSE` (MIT).
- Regenerate the test-consumed, SHA-256-pinned ngspice-47 oracle: `python3 packages/core/src/devices/bsim4/__fixtures__/grounded-channel/generate-transient.py`. Only output-control commands are added; both engines use the same electrical deck and options.
- Check: `pnpm -C packages/core exec vitest run src/devices/bsim4/grounded-channel-transient.test.ts`. Gate/sense voltages and drive current use the existing corpus 1% peak-normalized criterion and voltage/current floors; no circuit-specific tolerance. Gate-current error falls from `0.0488944993069725` to `1.2928237646189238e-13`.
- Equation source: ngspice-47 `a80f6e3e95d51534905b1f23410a951802666656`, [BSIM4](https://github.com/ngspice/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4), ECL-2.0 (existing BSIM4 notices). `b4temp.c:173-175,1301-1304` supplies omitted CF to overlap capacitances; `b4ld.c:4149-4177,4422-4424,4629-4635` forms/integrates charge; `b4acld.c:248-250` is the AC counterpart.
- Unchanged corpus-g fixture `sens-bsim4-issue694-fd-cir`: all six signals pass, worst normalized error `0.0558` -> `1.41e-12`; spice-ts versus fine reference `0.0584` -> `0.00314`, equal to ngspice default-versus-fine self-consistency. Only this outcome row and derived summaries are refreshed. No full-device parity or speed claim.



## XSPICE filesource / file_source (#1758)

- Original project-authored decks, table, generator and test-consumed ngspice vectors in [xspice-file-source/](xspice-file-source/), **MIT** under repository LICENSE. No third-party netlists or data copied.
- Numerical contract consulted: [ngspice-47 file_source source](https://github.com/imr/ngspice/tree/ngspice-47/src/xspice/icm/analog/file_source), BSD-3-Clause, Thomas Sailer. Implementation is independently expressed; no source text redistributed.
- Reproduce: `node benchmarks/xspice-file-source/generate.mjs`; internally `ngspice -b oracle.cir` sources the unchanged committed deck as `input.cir` and writes all timepoints with 17-digit precision. Version, command and platform are in `reference.json`.
- Upstream calls the model **filesource**, not file_source. spice-ts supports both names. ngspice-47 rejects omitted amplitude vectors at its parameter loader, despite identity handling in cfunc; defaults/step reference decks therefore explicitly supply identity `amploffset=[0] amplscale=[1]`. spice-ts additionally allows omission. The aliases and omitted vectors are not claimed as identical-deck ngspice parity.
- Before: unsupported model. After: 88 ngspice timepoints in each of defaults, all-four-transforms, and step cases; maximum normalized absolute errors respectively `4.448008912761045e-16`, `6.467004657784513e-16`, and `0` (limit `1e-6`, normalization by max(1, peak reference magnitude)). No speed claim.
- Verification: `pnpm -C packages/core exec vitest run src/devices/xspice/file-source.test.ts`. Tests first execute identical full decks and check all spice-ts samples, then repeat the same circuit with transient stop at each oracle time to avoid interpolating across step discontinuities. Two-output/relative-time behavior and structured missing/malformed-file errors are also tested. Coverage is bounded to these fixtures, not arbitrary file contents or general ngspice parity; past EOF spice-ts safely holds the final row.

## BSIM4 DIOMOD=0/2 junction laws (#1703)

- Sources: original project-authored `benchmarks/bsim4-diomod/mode0.cir` and `mode2.cir`, MIT under repository `LICENSE`. Public source directory: https://github.com/spicets/spice-ts/tree/main/benchmarks/bsim4-diomod.
- Each deck includes NMOS and PMOS, independent source/drain junction settings, forward/reverse bias, one OP point and 45 DC points. No third-party model card is redistributed.
- Equation source: ngspice-47 commit `a80f6e3e95d51534905b1f23410a951802666656`, `src/spicelib/devices/bsim4/b4temp.c` and `b4ld.c` (https://github.com/ngspice/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4). BSIM4 ECL-2.0 notice retained in `bsim4-junction.ts` and `bsim4/LICENSE-ECL-2.0`.
- Regenerate test-consumed oracle: `spice-heavy python3 benchmarks/bsim4-diomod/generate.py`. ngspice receives the committed deck bytes unchanged; the reference records their SHA-256. Verify using `pnpm -C packages/core exec vitest run src/devices/bsim4/junction-modes.test.ts`.
- The test prints per-signal max absolute, max relative and RMS relative errors for OP/DC. It retains the existing BSIM4 gate-current criterion `abs <= 1e-15 || rel <= 1e-6`, with no tuning. Before: both decks rejected DIOMOD. After: all saved voltages and source currents pass; maximum relative error is `6.332090677047784e-15`. This is bounded static-junction evidence, not general BSIM4 parity or a speed claim.


## Self-heating diode transient charge (#1801)

- `circuits/diode-selfheat-tran-1801.cir` is an original spice-ts regression deck, MIT (repository licence). Pulsed resistive drive, CJO, TT, temperature coefficients, RTH0 and CTH0 exercise electrical and thermal storage together. Both engines receive the identical committed netlist, without model or tolerance adaptations.
- Equation reference: ngspice-47 `src/spicelib/devices/dio/dioload.c` and `diotemp.c`, https://github.com/imr/ngspice/tree/ngspice-47/src/spicelib/devices/dio (BSD-style ngspice licence). No source code copied. Charge uses junction temperature; the thermal power includes integrated junction charge current, as in dioload.c.
- Reproduce all-point peak-normalized max and RMS waveform errors with `spice-heavy pnpm exec tsx benchmarks/diode-selfheat-parity.ts`. Add `--write-reference` to regenerate the test-consumed `packages/core/src/devices/fixtures/diode-selfheat-1801.json` (every 16th ngspice adaptive point plus the endpoint, columns time, v(anode), i(V1), v(tj)). The benchmark checks every ngspice timepoint using linear interpolation of spice-ts output, with the same 1% threshold for all vectors.
- Scope: zero internal RS; a physical external resistor drives the junction. Self-heating internal RS with junction storage still requires an internal electrical node and is explicitly rejected, not approximated. This is waveform parity evidence, not a speed superiority claim. CTH0 already compiles to a thermal capacitor; this regression verifies its coupled behavior.

## C/L circuit-temperature regression decks (#1798)

- Original project-authored `packages/core/src/fixtures/cl-temperature-1798/{rc-hot,rl-cold}.cir`, MIT under repository `LICENSE`. No third-party circuit/model cards copied.
- Equation and precedence sources: ngspice-47 `src/spicelib/devices/cap/captemp.c` and `src/spicelib/devices/ind/indtemp.c`, https://github.com/ngspice/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices. Instance TC1/TC2 override each model coefficient independently; model TNOM overrides circuit TNOM; instance TEMP overrides circuit TEMP plus DTEMP.
- Identical deck bytes go to both engines. Exact `SPICE_ASCIIRAWFILE=1 ngspice -b -r ...` commands and test-consumed reference values are in `packages/core/src/cl-temperature-1798.test.ts`. RC at 100 C covers AC near -3 dB and a TRAN step at 1 ms; RL at -40 C covers AC. Both use relative tolerance 1e-6. This is bounded correctness coverage, not a speed claim or aggregate-corpus addition.

## BSIM4 RSH/NRD/NRS static series resistance (#1792)

- Original MIT single-device decks and generator in `packages/core/src/devices/bsim4/__fixtures__/series-resistance/`; no third-party model cards. Nine OP cases and 45 Vds sweep points cover both polarities, reverse mode, single-side networks, neutral controls, multiplicity and gate/body composition.
- Equation source: ngspice-47 commit `a80f6e3e95d51534905b1f23410a951802666656`, `b4set.c:2434-2515`, `b4temp.c:2041-2101` and `b4ld.c`, ECL-2.0. Pinned links and exact regeneration command are in the fixture README. Oracle JSON is consumed by `series-resistance.test.ts` and binds identical netlists by SHA-256.
- Before: positive RSH with given positive squares rejected. After: OP/DC maximum Id relative error `6.659e-13`, nonzero internal-voltage relative error `6.669e-13`. Numerical-zero currents use the existing `1e-12` absolute floor. Enabled-series AC and transient remain explicitly unsupported. No speed or general BSIM4 parity claim.



## corpus-p: new public MNA-MAT and NetlistParse sources (#1722)

- https://github.com/nik1106/MNA-MAT pinned to `a77a4eb409aba1eb7f04919aa3990a60b0233cce`, SPDX **MIT**, copyright Nikhil Chhabria. All 12 original top-level circuit examples.
- https://github.com/NyanCAD/NetlistParse.rs pinned to `94386c7fcf669ce9e930686815d94e11050307f6`, SPDX **MIT**, copyright JuliaHub, Inc. and contributors. Original `tests/corpus/{rlc,ext_devices,ext_xyce_cmds,ext_xyce_y}.sp` decks; directive-only `ext_nodeset.sp` is not a circuit.
- Original licence/permission notices retained byte-identically in `benchmarks/corpus/corpus-p/licenses/<source>/LICENSE`. Full revision URLs, **per-file original and committed SHA256**, licence hashes and the complete static selection are in [corpus-p/SOURCES.md](corpus/corpus-p/SOURCES.md) and [manifest.json](corpus/corpus-p/manifest.json). No vendor models copied; no hashes duplicate earlier corpus manifests.
- Mechanical adaptation only: title prefix for the 12 title-less MNA-MAT files; append `\n.op\n.end\n` to those and the RLC parser example. Original element/value/whitespace bytes stay unchanged inside reversible wrappers, verified by offline tests. Three extension stress decks are verbatim. Both engines receive identical committed bytes, no runtime adaptation or per-circuit tuning. This adds DC/OP coverage, not a transient/speed claim.
- [Committed receipt](corpus/corpus-p/outcomes.json): **16 fixtures, 13 matched, 0 mismatch, 0 spice-ts failed, 2 spice-ts unsupported**. The two unsupported decks fail or are unsupported in both engines; one more deck is ngspice-failed/spice-ts-success. All three exclusions remain published, never counted as matches. All 13 ngspice-success decks match, so there is no ngspice-success gap requiring an issue. Reference rejection does not validate spice-ts extension semantics.
- Reproduce: `pnpm exec tsx benchmarks/corpus/corpus-p/ingest.ts`; `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-p/parity.ts --jobs 1`; verify with `pnpm exec tsx --test benchmarks/corpus/corpus-p/corpus-p.test.ts`. Unchanged existing corpus-f/h runner and global 1% metric; no aggregate/tolerance changes. Aggregate refresh deferred to nightly.

## Self-heating diode AC (#1787)

- Source: seven original project-authored decks, MIT under the repository `LICENSE`, at `packages/core/src/devices/__fixtures__/diode-self-heating-ac/`. No third-party fixture bytes copied. Model reference: ngspice-47 `dioacld.c` / `dioload.c`, https://github.com/imr/ngspice/tree/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/dio.
- Regenerate SHA-256-pinned, test-consumed complex references with `spice-heavy python3 packages/core/src/devices/__fixtures__/diode-self-heating-ac/generate.py`. Requires ngspice-47; adds output control only, with identical electrical decks, options and `.ac dec 10 1 1e6` in both simulators.
- Each deck checks 61 frequencies for `v(tj)`, `v(anode)` and `i(vsrc)`. Includes zero, explicit positive and default CTH0, zero/positive CJO, RS/TRS1 without charge, and an explicit external thermal capacitor. Existing diode depletion tolerances: relative magnitude < `1e-4`, phase < `1e-4` radians. Before: all seven AC decks rejected. After: maximum complex absolute error `1.309074039574171e-10` (mixed V/K/A units), relative magnitude error `6.141254171865285e-11`, phase error `7.657945388928056e-10` degrees. No speed claim.
- Important reference limitation: ngspice-47 intrinsic CTH0 is absent in AC because `dioacld` reads `DIOcqth`, which `dioload` does not initialize to CTH0 in small-signal initialization. Positive/default intrinsic CTH0 references are identical to CTH0=0; spice-ts deliberately matches this behavior. An explicit `Cthermal tj 0 ...` still creates the thermal pole in both engines. Transient CTH0 remains active. This is version-specific parity, not validation of physical intrinsic thermal AC dynamics.
- Thermal noise, thermal RSW, thermal RS plus junction charge, and transient thermal junction charge remain typed unsupported paths. Run `pnpm -C packages/core exec vitest run src/devices/diode-self-heating-ac.test.ts` for parity numbers and exclusions.

## corpus-q: Xyce AC/DC measurements and transient sources (#1763)

15 verbatim decks at Xyce_Regression revision `7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2`, licensed GPL-3.0-or-later by the pinned [repository README](https://github.com/Xyce/Xyce_Regression/blob/7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2/README.md). Original grant and full GPL text are retained under `benchmarks/corpus/corpus-q/licenses/xyce/`. These are independent benchmark data, not package code; no vendor libraries.

Six AC, six DC and three transient decks selected statically with no engine-success filter; identical original bytes in both simulators. Pinned per-file source URLs, original/committed SHA256, licence hashes and selection are in [corpus-q/SOURCES.md](corpus/corpus-q/SOURCES.md) and [manifest.json](corpus/corpus-q/manifest.json). Deduplication checks all earlier corpus manifests by revision-independent URLs and original/committed/content hashes.

ngspice-47 baseline: 3 matched (one DC, two transient), 0 mismatch, 0 not-compared, 0 spice-ts-loss, 0 ngspice-failed, 12 both-failed. All AC decks fail in both engines; this is not successful AC parity evidence. Fine-step reference is compared for q-15; q-14 is unavailable under the shared million-step budget. All failures and full metrics remain in [outcomes.json](corpus/corpus-q/outcomes.json). No speed or superiority claim. No aggregate refresh.

## corpus-r: semiconductor transients, DC device sweeps and noise (#1777)

13 verbatim Xyce_Regression decks, statically selected before either engine ran. Source repository https://github.com/Xyce/Xyce_Regression, pinned commit **7bb7e98f0ed3a81a7d1cf1d10b68592107ed40b2** for every row below. Repository-wide **GPL-3.0-or-later** grant and full GPL text retained under [corpus-r/licenses/xyce](corpus/corpus-r/licenses/xyce/). Independent benchmark data, not simulator package code; no vendor libraries.

Seven transient decks, five DC device sweeps and one noise deck. Selected by device/analysis family, novelty and include closure, not engine success. Intentional invalid-input regressions and Xyce dialect rejections remain published. Both engines receive identical original bytes; no tolerance, metric or runner changes. Waveform comparisons do not certify ignored model parameters, printed operators or diagnostics. No AC/TF coverage or speed claim.

| ID | Upstream path at pinned commit above | Licence |
|---|---|---|
| r-1 | Netlists/BJT_EXTNODE/npn_rb_rc_re_3.cir | GPL-3.0-or-later |
| r-2 | Netlists/BJT_EXTNODE/npn_rc_re_3.cir | GPL-3.0-or-later |
| r-3 | Netlists/Certification_Tests/BUG_647_SON/bjt.cir | GPL-3.0-or-later |
| r-4 | Netlists/Certification_Tests/BUG_647_SON/bjt_ambient.cir | GPL-3.0-or-later |
| r-5 | Netlists/DIODE/diode_with_sidewall_temp.cir | GPL-3.0-or-later |
| r-6 | Netlists/NOISE/unsupported_analysis_mode.cir | GPL-3.0-or-later |
| r-7 | Netlists/NOISE/unsupported_device_source.cir | GPL-3.0-or-later |
| r-8 | Netlists/Certification_Tests/BUG_983_SON/jfet.cir | GPL-3.0-or-later |
| r-9 | Netlists/Certification_Tests/BUG_647_SON/mos1.cir | GPL-3.0-or-later |
| r-10 | Netlists/Certification_Tests/BUG_647_SON/mos1_modpar.cir | GPL-3.0-or-later |
| r-11 | Netlists/Certification_Tests/ISSUE_239/mos1_test1.cir | GPL-3.0-or-later |
| r-12 | Netlists/Certification_Tests/ISSUE_239/mos1_test2.cir | GPL-3.0-or-later |
| r-13 | Netlists/Certification_Tests/ISSUE_239/mos1_test3.cir | GPL-3.0-or-later |

Pinned per-file URLs, original/committed SHA256, licence hashes and static selection are in [corpus-r/SOURCES.md](corpus/corpus-r/SOURCES.md) and [manifest.json](corpus/corpus-r/manifest.json). Every outcome and full metrics are published in [README.md](corpus/corpus-r/README.md) and [outcomes.json](corpus/corpus-r/outcomes.json). The original 100-fixture aggregate is unchanged, as requested in #1777.

## BSIM1/BSIM2 circuit temperature (#1821)

- Source: original project-authored decks, generator and test-consumed oracle vectors in [fixtures/issue-1821](fixtures/issue-1821/), MIT under the repository licence. No third-party netlists copied.
- Semantic reference: ngspice-47 [BSIM1](https://github.com/imr/ngspice/tree/ngspice-47/src/spicelib/devices/bsim1) and [BSIM2](https://github.com/imr/ngspice/tree/ngspice-47/src/spicelib/devices/bsim2), BSD-style ngspice licence. `b1temp.c` and `b2temp.c` ignore the circuit temperature; `b1ld.c`/`b2ld.c` use fixed `CONSTvt0` for junctions. BSIM2 uses model-card `TEMP` for `Vtm`, not circuit `TEMP`.
- Reproduce references: `spice-heavy python3 benchmarks/fixtures/issue-1821/generate.py`; internally `ngspice -b -r <temporary-reference.raw> <id>.cir`, ASCII output. Both engines receive identical committed bytes. Compare: `pnpm exec tsx benchmarks/fixtures/issue-1821/compare.mts`.
- 24 decks cover LEVEL=4/5, NMOS/PMOS, model TEMP=27/75, circuit TEMP=27/75/-20 C, nonzero junction leakage and OP plus six-point DC gate sweeps. Every node voltage and voltage-source current requires relative error <= 1e-6 without an absolute floor. This is correctness coverage, not a performance claim.

## BSIM4 static SA/SB/SD length-of-diffusion stress (#1832)

Dynamic follow-up (#1842): original MIT `lod/ac.cir` and `lod/tran.cir` in
`packages/core/src/devices/bsim4/__fixtures__/`, with test-consumed ngspice-47
vectors and `generate-dynamic.py`. Both engines receive identical hashed
deck bytes. See the fixture README for commands, fixed tolerances and errors.

- Original MIT decks, generator and test-consumed oracle in `packages/core/src/devices/bsim4/__fixtures__/lod/`. No third-party model cards. Six OP cases and 36 VGS sweep points use identical committed deck bytes in both engines, SHA-256 checked.
- Equation source: ngspice-47 commit `a80f6e3e95d51534905b1f23410a951802666656`, [b4temp.c:1574-1702](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/bsim4/b4temp.c#L1574-L1702), ECL-2.0. The later native MULU0 overwrite is deliberately preserved. See the fixture README for scope and regeneration command.
- Before: six parity tests reject KU0. After: maximum measured relative error 3.91e-15 for saved node voltages and drain currents (limit 1e-6). Dynamic LOD is covered by #1842 above; WPE remains unsupported. No speed claim.

## Resistor instance TEMP/DTEMP at circuit temperature (#1808)

- Source: original project-authored resistor-divider decks in [fixtures/issue-1808](fixtures/issue-1808/), MIT (repository licence). No third-party netlist copied.
- Semantic reference: ngspice-47 [`restemp.c`](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/res/restemp.c). Instance TEMP overrides circuit temperature and ignores DTEMP; otherwise DTEMP adds to circuit temperature.
- Oracle: ngspice-47, generated with `spice-heavy python3 benchmarks/fixtures/issue-1808/generate.py`. The generator records OP and DC TEMP sweep vectors from `ngspice -b -r <temporary-reference.raw> <deck.cir>` in ASCII mode.
- Both engines receive the identical committed decks. Four decks cover `.options TEMP` and `.temp` at 27/50 C, each with a 27/50/73 C sweep. Each deck contains DTEMP=10, TEMP=80, TEMP=80 plus DTEMP=10, and an ambient-only control divider; TC1 and TC2 are both nonzero. Tests require relative error <= 1e-9 on every OP/sweep voltage and source current. This is correctness coverage, not a speed claim.

## MOS2 instance TEMP/DTEMP (#1853)

- Original project-authored decks, generator and test-consumed oracle in [fixtures/issue-1853](fixtures/issue-1853/), MIT under the repository licence; no third-party netlist/model copied.
- Semantic reference: ngspice-47 [`mos2temp.c`](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/mos2/mos2temp.c), BSD-style ngspice licence. Explicit instance TEMP overrides circuit TEMP and ignores DTEMP; otherwise DTEMP adds to circuit TEMP. Existing temperature laws are reused, including ngspice's use of unscaled model UO in `mos2load.c` (its preprocessed tSurfMob is unused there).
- Regenerate: `spice-heavy python3 benchmarks/fixtures/issue-1853/generate.py` (ngspice-47); internally `ngspice -b -r <temporary-reference.raw> <id>.cir`. Both simulators consume identical committed deck bytes, SHA-256 checked by tests.
- Six decks: NMOS/PMOS x TEMP=75, DTEMP=20, TEMP=75 plus DTEMP=20 at circuit TEMP=40. OP and 61-point gate sweeps compare **every** saved node voltage and source current at strict relative <=1e-6, without an absolute floor. All decks use the same tight Newton settings (RELTOL=1e-12, ABSTOL=1e-20, VNTOL=1e-16) to resolve off-state source voltages around 4e-11 V; these are solver settings, not relaxed comparison thresholds.
- Before: all six OP/DC parity tests failed with ignored instance fields. After: worst relative errors n-temp/n-both/p-temp/p-both 1.939e-7, n-dtemp 1.612e-8, p-dtemp 1.127e-8. Compare: `spice-heavy pnpm -C packages/core exec vitest run src/devices/mos2-instance-temperature-1853.test.ts`.
- Regression coverage includes repeated DC TEMP sweep restoration, invalid effective temperature with last-valid-state preservation, and AC/transient equivalence to the same effective circuit temperature with nonzero junction capacitances. No performance claim.

## XSPICE d_state (#1864)

- Source: self-authored counter/reset decks and state table in [xspice/d-state](xspice/d-state/), MIT under the repository licence. No third-party deck or code copied.
- Semantic reference: ngspice-47 [`digital/d_state`](https://github.com/imr/ngspice/tree/ngspice-47/src/xspice/icm/digital/d_state), Public Domain code model. Ordered header/continuation rows, wildcard inputs, Moore outputs with strengths, clock/reset delays and reset priority.
- Regenerate the test-consumed oracle with `spice-heavy python3 benchmarks/xspice/d-state/reference.py`; internally `ngspice -b -r <case>.raw <case>.cir`. Deck and state SHA-256 digests enforce identical bytes.
- Before: counter rejected with UnsupportedCodeModelError. After: counter (1506 points) and nonzero-state asynchronous reset (1511 points) maximum bidirectional interpolated DAC error 1.1102230246251565e-16 V. Uses existing XSPICE digital DAC tolerance (9 decimal places), not circuit-specific relaxation. No speed claim.
- Test: `pnpm -C packages/core exec vitest run src/devices/xspice/d-state.test.ts`.

## VDMOS circuit temperature (#1845)

- Source: original project-authored decks, generator and test-consumed oracle vectors in [fixtures/issue-1845](fixtures/issue-1845/), MIT under the repository licence. No third-party netlists copied.
- Semantic reference: ngspice-47 [`vdmostemp.c`](https://github.com/imr/ngspice/blob/a80f6e3e95d51534905b1f23410a951802666656/src/spicelib/devices/vdmos/vdmostemp.c), BSD-style ngspice licence. The existing VDMOS instance-temperature implementation supplies the same law for circuit temperature.
- Regenerate with `spice-heavy python3 benchmarks/fixtures/issue-1845/generate.py` (requires ngspice-47). Internally runs `ngspice -b -r <temporary-reference.raw> <id>.cir`. Both simulators receive identical committed decks, including the ASCII-output control setting.
- Nine decks cover the issue OP plus NMOS/PMOS gate sweeps at -20/75 C, model TNOM=40, TCVTH/MU, RD polynomial and TEXP0 branches, RS/RG temperature coefficients, quasi-saturation TEXP1 and body-diode IS/N/EG/XTI/RB temperature coefficients. Tests consume all OP and 488 DC points and all saved node voltages/source currents, requiring relative error <=1e-6 or absolute error <=1e-12.
- Compare with `VDMOS_PARITY_REPORT=1 pnpm -C packages/core exec vitest run src/devices/vdmos-temperature-1845.test.ts`. Additional tests cover `.temp`, `.dc TEMP` and instance TEMP/DTEMP precedence. Nondefault circuit TNOM and self-heating circuit TEMP remain explicitly rejected. This is correctness coverage, not a speed claim.
