# corpus-f: triage of decks over the 1% parity threshold (#511)

Hand-written companion to the generated [README.md](README.md). Machine-readable version: [triage-511.json](triage-511.json). `triage-511.test.ts` checks it against the committed `outcomes.json`, so it fails when an outcome changes and this file is not updated.

Current snapshot (#1572): full refresh on main `e7a39a5f`, ngspice-47, unchanged fixture bytes and policy. Totals: 92 matched, 20 mismatched, 115 not compared, 79 spice-ts losses, 4 ngspice-failed and 26 both-failed (336 fixtures). Five deferred mismatches now match: analog_models1_transient, analog_models3_transient, mixed_io_size, mixed_ref and vswitch-test-lin. No root-cause attribution is inferred from the refresh. Two engine-success regressions remain published: mos-test now rejects saved MOS1 vector `@mn1[id]` ([#1578](https://github.com/spicets/spice-ts/issues/1578)); 100W now exceeds the unchanged 120 s bound ([#1579](https://github.com/spicets/spice-ts/issues/1579)), so leaving the mismatch list is not a parity improvement. The shared host may contribute to timeouts. Current stochastic samples are simple-noise 3.14 and rts-1 1.29, not reproducible accuracy claims (#655). The historical discussion below retains its original provenance; `triage-511.json` current fields and deferred membership are synchronized to this refresh. The separately generated control-vector supplement was not rerun.

Scope: all ten rows of the #511 table, the two other mismatches present in the imported report, and the decks exposed by the refreshes up to main `03706cc7` (switches-manual-p92; adder_mos_circ; the two #640 transient-noise decks). The seven newly runnable mismatches found by the first refresh on `bf2e4169`, plus adder_bip and measure/func-cap from the `03706cc7` refresh, remain published losses. They are explicitly deferred to [#597](https://github.com/mfiumara/spice-ts/issues/597), not claimed as root-caused here. The #511 triage changed no fixture, tolerance, threshold or metric. Later, #593 changed the normalising-peak floor for every fixture (see "#593 metric floor" below). Current measurements (the "Now" column and `outcomes.json`) use ngspice-47 and the simulator at main `3b9c836f` (sixth refresh, below). They use the published corpus-f metric: the worst over signals of max|spice-ts - ngspice| / max(peak|ngspice|, floor), with ngspice interpolated onto spice-ts points with breakpoint alignment. The floor is 1e-4 V for v(...), 1e-10 A for i(...) and 1e-12 for anything else. Values attributed to `bf2e4169` are historical and appear only where they explain an issue. Diagnostic variants are labelled separately.

This triage covers the batch-1 `outcomes.json` table only. The "Control-vector supplement (#521)" in README.md is generated separately by `control-vectors.ts`. It was refreshed on the same tree (all 207 control decks: 34 matched, 35 mismatched (two of them the stochastic #640 noise decks, 6.68 and 1.7 in the `3b9c836f` run, #655), 1 not compared, 120 spice-ts losses, 1 ngspice-only failure, 16 both-engine failures) but is not triaged here. Its mismatches remain linked to #511 or their gap issues.

## Tool

`benchmarks/corpus/corpus-f/triage-detail.ts` runs one fixture through both engines exactly as `outcomes.ts` does. It prints the highest-error signals (use `--top 1000` for all), their published error, and two plain-linear-interpolation diagnostics: the location of the largest difference and the reverse-grid error at ngspice's own points. The locator and reverse-grid columns do not apply breakpoint alignment and need not equal the published error. Diagnostic options, never used for the published table:

- `--tmax <s>`: both engines run the deck with .tran TMAX forced. This separates step and grid effects from model differences.
- `--deck <file>`: both engines run a variant deck (for example one model parameter removed). This isolates a model term.
- `--reference-tmax <s> [--candidate ngspice]`: the reference is ngspice with TMAX forced, and the candidate is spice-ts (or ngspice) on the unchanged deck. These are candidate-grid diagnostics, not a common-grid accuracy ranking. A single fine-step run does not establish step convergence.

```sh
pnpm build
pnpm exec tsx benchmarks/corpus/corpus-f/triage-detail.ts tests-general-mosmem-cir
pnpm exec tsx benchmarks/corpus/corpus-f/triage-detail.ts tests-general-rtlinv-cir --reference-tmax 2e-11
```

## Root causes

| Root cause | Kind | Issue | Fixtures |
|---|---|---|---|
| MOS1 bulk-junction capacitance was constant CBD/CBS; CJ/CJSW/MJ/PB depletion C(V) ignored | fixed (#601) | https://github.com/mfiumara/spice-ts/issues/590 | mosmem (now matched) |
| MOS1 had no Meyer intrinsic gate capacitance from TOX | fixed (#601) | https://github.com/mfiumara/spice-ts/issues/591 | ltra2_2_line (improved; the residual is a grid effect per #627/#629 → #592) |
| BSIM3 4-bit NAND adder: supply current 10-40x ngspice before #624, timeout after #624, internal-node mismatch 1.54 since #648 | simulator, not root-caused | https://github.com/mfiumara/spice-ts/issues/626 | adder_mos_circ |
| TRNOISE/TRRANDOM decks compare independent random realisations (ngspice reseeds every run) | metric | https://github.com/mfiumara/spice-ts/issues/655 | transient-noise simple-noise, rts-1 |
| Transient metric scores ngspice's coarse default-step output as spice-ts error | metric | https://github.com/mfiumara/spice-ts/issues/592 | rca3040, switches-manual-p92 (rtlinv, mos-test, fourbitadder and ltra2_2_line match on `3b9c836f`, after #689; not bisected) |
| Zero or near-zero ngspice peaks turned fV-µV residuals into mismatches | fixed (#593 metric floor) | https://github.com/mfiumara/spice-ts/issues/593 | rca3040 AC v(2) (now 5.64e-10; the row stays a #592 mismatch) |
| fourbitadder TTL internal nodes kept 1–7 µV residuals above the 1 µV VNTOL floor | fixed by transient step control, #689 and #758 (bisected; see the #698 re-check below) | https://github.com/mfiumara/spice-ts/issues/698 | fourbitadder (sub-mV nodes within 0.15 µV at default steps, every signal within 50 nV at TMAX 10 ps on `49a4fed4`) |
| BSIM1/BSIM2 (LEVEL 4/5) not implemented; typed error from #552 until ngspice-47 BSIM1/BSIM2 landed | fixed (#667) | https://github.com/mfiumara/spice-ts/issues/565 | bsim1, bsim2 |
| VDMOS .model silently dropped | fixed (#542, #562) | https://github.com/mfiumara/spice-ts/issues/509 | vdmosp-out, ro_11_vdmos |

## Per fixture

| Fixture | #511 table | Now | Classification and evidence |
|---|---|---|---|
| examples/vdmos/vdmosp-out.sp | 5.05e+242 dc i(vs) | matched, 1.48e-8 | Fixed by the VDMOS model (#562) after #509. |
| examples/vdmos/ro_11_vdmos.sp | (not in table; 3.19 in the committed outcomes) | matched, 0.00694 | Same. 0.00348 on `b1a1ff58`. |
| tests/general/fourbitadder.cir | 8.64 | matched, 0.00313 | Worst signals are TTL NAND internal nodes with 75–125 µV peaks (abs error 6.7 µV on a 5 V circuit). At ngspice points: 0.0377. Against fine-step ngspice (TMAX 10 ps), spice-ts default is 0.0107 on its grid and ngspice default is 0.0415 on its grid. Residual 1.1 µV at t≈13 ps with both engines at 10 ps (5/270 signals at 1.02–1.07%) is not root-caused yet. With the #593 floor (1e-4 V) only the two signals with peaks under 100 µV move: v(x1.x1.x1.x7.8) 0.0677 → 0.0674 and v(x1.x1.x1.x6.8) 0.0386 → 0.0302. 12 signals stay over 1%. The residuals are 3–7 µV, above VNTOL, so the floor does not hide them → #698 (split from #593). On `3b9c836f` the unchanged deck matches at 0.00313 (worst v(x1.x2.x1.x6.8)); the published metric no longer shows the residual. The change comes from merges after `b1a1ff58` (most likely #689, ngspice CKTtrunc step control; not bisected), not from the floor. The #698 re-check on `49a4fed4` bisects the residual to #689 and #758 (transient step control); see the section below. |
| tests/transmission/ltra2_2_line.cir | 1 | matched, 0.000796 | At `bf2e4169`: i(vs) gate current 0 in spice-ts vs a 2.5 µA ngspice peak (0.974, still 1.0 at TMAX 10 ps), and removing `TOX=18000N` from both cards made it agree → #591, fixed by #601. Now 0.374 (t≈16.1 ns: −42.5 nA vs −2.4 µA). That is 0.151 at ngspice points and 0.029 with both engines at TMAX 10 ps. #627 (#629) traced the residual to discretisation of a current that is discontinuous at the pulse corners. Against ngspice at TMAX 1 ps, spice-ts default scores 0.0233 and ngspice's own default run 0.0401. The post-breakpoint step rule differs from ngspice (#608) → #592. Other signals ≤ 0.0071 at ngspice points and ≤ 0.0033 at TMAX 10 ps → #592. On `b1a1ff58` the value is 0.42. That run scored it the same under the old and new floors, so the move is simulator drift since `03706cc7`; it is not bisected. On `3b9c836f` it matches at 0.000796 (i(vs)), after merges since `b1a1ff58` (most likely #689; not bisected). The live test in `triage-511.test.ts` now asserts the match as a regression guard. |
| tests/bsim2/test.cir | 0.738 | matched, 8.17e-12 | The issue-table value came from running Level-1 equations; #552 made LEVEL=5 a typed `UnsupportedModelLevelError` (spice-ts-loss through `b3f04506`). #667 ported ngspice-47 BSIM2 and the unchanged deck now matches (worst dc i(v1)). |
| tests/general/mosmem.cir | 0.714 | matched, 0.00999 | At `bf2e4169`: i(vdd) 0.227, v(6) 0.103, i(vw) 0.0994, v(3) 0.0618, v(8) 0.0311, unchanged at TMAX 0.1 ns. Adding `mj=0` (constant CBD/CBS in ngspice) brought all 13 signals to ≤ 3.95e-4 → #590. Fixed by #601: the unchanged deck has 0/13 signals over 1% (worst v(4) 0.0025, i(vdd) 0.00205). On `3b9c836f` it still matches, but the worst is now i(vdd) 0.00999, just under the 0.01 threshold. |
| tests/bsim1/test.cir | 0.628 | matched, 9.46e-9 | LEVEL=4, as bsim2; matches after #667 (worst dc i(v4)). |
| tests/general/rtlinv.cir | 0.432 | matched, 0.00238 | At ngspice points: 0.0013. All 16 signals ≤ 8.5e-4 with both engines at TMAX 20 ps. Against the fine-step reference, spice-ts default transient error is 5.24e-4 and ngspice default is 0.0017; DC remains 8.43e-4 → #592. On `3b9c836f` it matches at 0.00238 (v(2)), after merges since `b1a1ff58` (most likely #689; not bisected). |
| tests/general/rca3040.cir | 0.148 | mismatch, 0.0118 | Tran worst is v(1), the SIN source node itself (108 ngspice points over ten 50 MHz cycles); at ngspice points 0.0021. Against the fine-step reference (TMAX 10 ps), spice-ts tran is ≤ 0.0010 on its grid and ngspice default is 0.031 on its grid → #592. What remains is AC v(2), a node held by `vcc` with no AC value: spice-ts 4.84e-14 V vs ngspice exactly 0, divided by the 1e-12 floor = 0.0484 → #593. On `03706cc7` this AC v(2) term is the worst signal at 0.0564 (changed by a merge after `b3f04506`, not bisected). With the #593 floor, AC v(2) scores 5.64e-14 V / 1e-4 V = 5.64e-10, below the threshold. The row stays a mismatch: tran v(1) is 0.0511, with 8 signals over 1%, all transient → #592. On `3b9c836f` it is still a mismatch, 0.0118 tran v(31) → #592. |
| examples/xspice/various/xspice_c1.cir | 0.0439 | matched, 2.26e-5 | Imported report was already matched at 4.93e-4. Fresh runs (`bf2e4169`, `4bdbe0c2`, `b3f04506`, `03706cc7`) include #531 initial-condition semantics. |
| examples/xspice/original-examples/spice3.deck | 0.0439 | matched, 2.26e-5 | Same circuit and transition as xspice_c1. |
| examples/probe/mos-test.cir | (not in table) | matched, 0.00811 | The inverter has no capacitance (default MOS1, no TOX/CJ, lambda 0, equal KP), so v(out) jumps vertically at vin = 2.5 V. Interpolating ngspice's 135-point grid across the jump gives 0.176. spice-ts's 3.64 V at vin = 2.33 V is the analytic value. At ngspice points: 0.0023 → #592. On `3b9c836f` it matches at 0.00811, after merges since `b1a1ff58` (most likely #689; not bisected). |
| examples/probe/switches-manual-p92.cir | (not in table) | mismatch, 0.74 | Runnable since #579 (S/W switches); `spice-ts-loss` at `bf2e4169`. Ideal switches make v(10)/v(20)/v(30)/v(40) jump between consecutive output points. ngspice's default output brackets each edge with points 2 µs apart, for example v(10) crossing 0.5 V between 1.19856 and 1.20056 ms. spice-ts puts the edge inside that interval (1.20029 ms), so interpolating ngspice's chord gives 0.865 (spice-ts 1 vs ngspice 0.135 at t = 1.2 ms). At ngspice points: 2.7e-20. With both engines at TMAX 0.1 µs, the crossing times agree within 1e-8 s, but the metric still reports 1.0 at a vertical edge → #592. The other 8 signals agree to ≤ 5.4e-16. On `3b9c836f`: still a mismatch, 0.74. |
| examples/snapshot/adder_mos_circ.cir | (not in table) | mismatch, 0.0451 | Runnable since #599 (dotted BSIM3 `version=3.3.0`); `spice-ts-loss` at `bf2e4169`. On `68b64909` it was a mismatch of 42: i(vcc) −11.6 mA vs −25 µA near 8.95 ns, 40.6 at ngspice points. On `c317324f` (#624) it exceeded the 120 s bound. On `4bdbe0c2` (#648) it completes again: 81/90 signals over 1%, worst internal NAND node v(x1.x2.x1.x8.net.1) 1.54 (2.94 V vs 0.20 V near 0.985 µs), 1.44 at ngspice points. On `03706cc7` (after #661, the ngspice-47 BSIM3v3.3 charge model for #626; not bisected against the other merges) worst is i(vin3a) 0.755. On `b1a1ff58` worst is i(vcc) 0.0451 with 7 signals over 1%. This is simulator drift since `03706cc7` and has the same value under both floors; it is not bisected. This is a real device-level loss → #626, root cause not established. |
| examples/transient-noise/simple-noise.cir, rts-1.cir | (not in table) | mismatch, 3.04 / 1.24 | Runnable since #640. Random sources: spice-ts is deterministic and ngspice-47 reseeds each run: 4.71 / 1.55 on `4bdbe0c2`, 3.75 / 1.45 on a triage-detail rerun, 2.5 / 1.36 on `b3f04506`, 5.44 / 1.14 on `03706cc7`, 7.15 / 1.37 and then 4.04 / 1.4 in two runs on `b1a1ff58`, 3.04 / 1.24 on `3b9c836f`. The sample-wise value is not reproducible and is not a parity measure → #655. It stays a published loss. |

## What this does not claim

- The #592 metric rows are not counted as matches. They remain published mismatches until the supervisor/owner decides on a metric change, which applies to every fixture.
- The #593 floor changes the metric for every fixture, with no per-circuit tuning. In the `b1a1ff58` runs it moves no fixture between outcome classes; rca3040 and fourbitadder stayed mismatches. On `3b9c836f` fourbitadder matches because of simulator merges, not the floor (see the sixth refresh).
- The fine-step diagnostics support a grid-sensitivity investigation. They do not establish convergence or rank engine accuracy: candidate-grid sampling and breakpoint alignment differ between candidates. No simulator-superiority claim follows from these numbers.

## Report refresh attribution

The imported report has 336 fixtures (the original issue predates the final ingestion exclusion), with 11 matched, 10 mismatched, 11 not compared, 274 spice-ts losses and 30 both-engine failures. Regeneration on `bf2e4169` has 26 matched, 13 mismatched, 22 not compared, 245 spice-ts losses and 30 both-engine failures. These are results of earlier merged implementations, **not fixes made by this triage PR**. Neither engine's input bytes nor the 1% rule changed.

All 35 outcome-class transitions are accounted for below. Changes within an outcome class remain in the generated JSON diff.

| Prior implementation | Class transitions | Count |
|---|---|---:|
| #495 B-source expressions | loss → mismatch (ddt-test1, ddt-test3) | 2 |
| #491 CPL/TXL | loss → not-compared (nine examples/transmissionlines decks; .control export gap #521) | 9 |
| #491 CPL/TXL | loss → mismatch (tests/transmission cpl-ibm2, txl1, txl2) | 3 |
| #506 / #562 VDMOS | mismatch → matched (ro_11_vdmos, vdmosp-out); loss → matched (vdmos-out-ir-mtr) | 3 |
| VDMOS charge/initial-state fixes, including #531 | loss → not-compared (crss-coss-ciss; ngspice .control vectors still unavailable, #521) | 1 |
| #487 XSPICE | loss → matched (11 decks) | 11 |
| #487 XSPICE | loss → mismatch (original-examples/analog-models1-transient); loss → not-compared (various/analog-models1-transient, #521) | 2 |
| #552 honest unsupported MOS levels | mismatch → spice-ts-loss (bsim1, bsim2), tracked by #565 | 2 |
| #498 resistor forms | loss → mismatch (res-array); loss → matched (res-partition) | 2 |

The seven newly runnable mismatches have a separate follow-up in #597. This table attributes which feature made a deck runnable; it does not establish the remaining mismatch's root cause. `not-compared` is not a parity win.

### Second refresh on main `4bdbe0c2`

Review of the first version of this PR found that the published report was stale against main: #579 had made switches-manual-p92 runnable as a 0.865 mismatch. `outcomes.json` and README.md were regenerated again on the merge of this branch with main `4bdbe0c2` (`spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --jobs 4`). Result: 32 matched, 16 mismatched, 53 not compared, 205 spice-ts losses and 30 both-engine failures (outcome SHA-256 `bca8f348…`). The two transient-noise rows are stochastic, so this digest is not reproducible bit-for-bit until #655 is resolved. Compared with the `bf2e4169` regeneration, all 41 outcome-class transitions are listed below. They come from merged implementations, not from this PR.

| Prior implementation | Class transitions | Count |
|---|---|---:|
| #579 S/W switches | loss → mismatch (switches-manual-p92, 0.865, published loss → #592) | 1 |
| #601 MOS1 depletion and Meyer charges | mismatch → matched (mosmem) | 1 |
| #614 .pz with sources and active elements | loss → matched (polezero filt-bridge-t, filt-multistage, filt-rc) | 3 |
| a merge between `bf2e4169` and `7c66aab9`, not bisected | loss → not-compared (transmissionlines/cpl1-4-line: spice-ts no longer fails with timestep too small, but ngspice runs it from `.control` and exports no vectors) | 1 |
| #584 .control interpreter | loss → not-compared (27 `.control` decks spice-ts now runs; ngspice `-r` exports no vectors, #528) | 27 |
| #584 .control interpreter | loss → matched (control-structs/if-batchmode, various/param-sweep) | 2 |
| #616 numparam .func/.if | loss → not-compared (regression/misc/if-elseif, parser/xpressn-3; `.control` decks, #528) | 2 |
| #603 .global | loss → not-compared (regression/subckt-processing/global-1; `.control` deck, #528) | 1 |
| #599 BSIM3 version strings (values later moved by #624/#648) | loss → mismatch (adder_mos_circ, 1.54 now, → #626) | 1 |
| #640 TRNOISE/TRRANDOM | loss → mismatch (transient-noise simple-noise, rts-1; stochastic, → #655) | 2 |

Intermediate full regenerations on main `7c66aab9` (before #584), `e58322ea` (before #616/#623), `0f255516` (before #603/#628/#629/#639) and `68b64909` (before #631/#632/#624) gave the same 14 mismatches with identical values, so the mismatch values are reproducible across five full runs. On `c317324f` the only change was adder_mos_circ: mismatch → timeout (#624). On `4bdbe0c2`, adder_mos_circ completes again (#648, mismatch 1.54) and the #640 noise decks are new stochastic mismatches. #645 and #644 changed no corpus-f outcome. #623 and #628 (LTRA step rules), #629 (test only), #639 (temperature laws), #631 (numparam minus) and #632 (MOS1 batch stamping) changed no corpus-f outcome. Changes within an outcome class: ltra2_2_line 0.974 → 0.374 and txl1_1_line 0.973 → 0.371 (#601), txl2_3_line 0.0904 → 0.0864.

### Third refresh on main `b3f04506`

Review of head `d9439881` found the report stale against main `b3f04506` (#651, #652). `outcomes.json`, README.md and the control-vector supplement were regenerated on the merge of this branch with main `b3f04506` (`spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --jobs 4`, then `control-vectors.ts --jobs 4`). Outcome totals are unchanged (32 matched, 16 mismatched, 53 not compared, 205 spice-ts losses, 30 both-engine failures; outcome SHA-256 `832172f0…`). No outcome class changed. Rows that changed (all remain published losses):

| Fixture | Change | Cause |
|---|---|---|
| examples/control_structs/foreach_bjt_ft.sp, examples/various/bjt_ac_par.sp | first error `Unsupported bounded BJT model parameter: 'VAR'` → `Unsupported BJT model parameter: 'PTF' (excess phase is not implemented)` | #652 ports VAR and rejects unported BJT parameters on every card |
| examples/noise/bipolar-noise.cir | unsupported (VAR) → failed: `.noise does not support BJT model parameter 'VAR' for 'q1'`; bucket parse → execution | #652 |
| examples/control_structs/s-param.cir | failed `Undefined variable 'Vbias_in'` → unsupported `.control alter` of a subcircuit device; bucket execution → control (#488) | #651 X-line `params:` |
| examples/memristor/memristor.sp | unsupported `Cannot parse number: '20e3/stime'` → failed `no such vector 'stime'` in `.control`; bucket parse → execution | #651 `.subckt PARAMS:` expression defaults |
| tests/regression/func/func-1.cir | `Unknown function 'v'` → `v() takes one or two node names`; bucket expression → parse | #651 v() B-source sub-expressions |
| examples/transient-noise/simple-noise.cir, rts-1.cir | 4.71 → 2.5, 1.55 (v(9)) → 1.36 (v(21)) | stochastic, #655; no simulator change to these decks |

Control-vector supplement on the same tree: totals unchanged (13/38/13/125/1/17). The same five error-text rows changed; the noise decks moved 6.37 → 4.19 and 1.79 → 1.74 (#655); TransmissionLines/cpl_ibm1.sp moved 1.52 → 2.47 (still a mismatch, linked to #511, not root-caused here).

Harness fix in this refresh: after #651/#652, examples/digital/compare/adder_bip.cir can finish inside the 120 s spice-ts bound (about 89 s alone, 106,319 points x 450 signals). The first regeneration then crashed: the fixture child ran out of its default V8 heap while deserialising one object per sample (about 1.05 GB serialised). `outcomes.ts` now transports the spice-ts child's result as packed Float64Arrays (bit-for-bit round trip, unit-tested in `corpus-f.test.ts`). No metric, bound or fixture changed. Under the regeneration's 4-way parallel load it exceeded the 120 s bound again, so the published row stays a spice-ts-loss (timeout). Run alone on the same tree it completes as a mismatch with worst 0.0242 (tran v(10)). This row is load-sensitive near the bound; it is a published loss either way and is not triaged here.

### Fourth refresh on main `03706cc7`

The supervisor merged the accepted queue (#668, #656, #674, #663, #664, #659, #665, #671, #661, #658, #647, then #673, #672, #667) while the `b3f04506` refresh was in review. `outcomes.json`, README.md and the control-vector supplement were regenerated once more on the merge of this branch with main `03706cc7`, with the same commands. Result: 43 matched, 18 mismatched, 53 not compared, 192 spice-ts losses, 30 both-engine failures (outcome SHA-256 `97a565c5…`). All 15 outcome-class transitions against the `b3f04506` table come from those merged implementations, not from this PR:

| Prior implementation | Class transitions | Count |
|---|---|---:|
| #667 ngspice-47 BSIM1/BSIM2 | loss → matched (tests/bsim1, tests/bsim2; #511 rows, root cause marked fixed) | 2 |
| #672 MES level 1, MESA level 3, Z-card parameters | loss → matched (tests/hfet/id_vgs, tests/mes/subth, tests/mesa mesa13, mesa15, mesa21, mesgout, mesinv) | 7 |
| #647 .meas/.measure | loss → matched (measure/buggy-meas-tran, measure/meas_expression) | 2 |
| #647 .meas/.measure | loss → mismatch (measure/func-cap, 0.5 tran i(vdd); deferred to #597, not root-caused) | 1 |
| a merge after `b3f04506`, not bisected (the deck now finishes inside the 120 s bound) | loss → mismatch (digital/compare/adder_bip, 0.0242 tran v(10); deferred to #597, not root-caused) | 1 |
| #647 parses .meas, so the first error moved further into the deck (attribution per row not bisected; still losses) | loss → loss with a new first error: inv-meas-tran, inv-meas-tran-auto (.options scale/autostop, #494), mos-meas-dc (unknown model 'nch'), rc-meas-ac (singular matrix), ro_17_4 (.options xmu), MonteCarlo, vdp_osc_pss_ctrl, integrate1 (other .control commands), shot_ng (B-source i()) | 0 |

Changes within the mismatch class: adder_mos_circ 1.54 → 0.755 (worst now i(vin3a); #661 BSIM3 charge model is the likely cause, not bisected, still a loss under #626); rca3040 0.0511 → 0.0564 (worst now the #593 AC v(2) term); the stochastic noise decks moved again (5.44 / 1.14, #655). Error-text-only changes on losses: the LEVEL=14/54 BSIM4 rows now list levels 1, 2, 4, 5, 6, 8, 49 (#658, #667); mos-meas-dc-control(-file) remain both-failed with new spice-ts first errors.

Control-vector supplement on the same tree: 15 matched, 39 mismatched, 13 not compared, 122 spice-ts losses, 1 ngspice-only failure, 17 both-engine failures. buggy-meas-tran and meas_expression became matches and adder_bip a 0.0242 mismatch. Notable mismatch moves: ltra5_1_line 51.1 → 0.0568 (the #622 ECL-receiver DC operating point addressed by #664) and txl4_1_line 53.5 → 0.606 (same driver family; not bisected); cpl_ibm1 2.47 → 1.04; VDMOS-DIO 8.54e9 → 2.94e10 (worst signal now ac v(kd)); smaller moves on other transmission-line, param_sweep and theta_nch rows. None of these is triaged here; they stay published losses linked to #511/#595.

adder_bip and the harness fix: the packed Float64Array transport above is what lets this regeneration score adder_bip at all. In this run it finished inside the bound under 4-way load. It remains close to the 120 s bound, so a heavily loaded rerun may publish it as a timeout again.

The separate 100-fixture aggregate is not changed by this PR. Its provenance pin and artifacts were refreshed on main by #613 (#598). An earlier version of this file wrongly said this PR did that.

### #593 metric floor and fifth refresh on main `b1a1ff58`

#593 changes the corpus-f normalisation for every fixture; nothing is tuned per circuit. Before, each signal was divided by max(peak|ngspice|, 1e-12). Now the floor depends on the quantity:

- `v(...)` node voltages: 1e-4 V = VNTOL / 0.01, where 1 µV is the ngspice-47 default `.options vntol`.
- `i(...)` branch currents: 1e-10 A = ABSTOL / 0.01, where 1 pA is the ngspice-47 default `.options abstol`.
- Everything else, including `.pz` roots and noise spectra: 1e-12, as before.

So a signal whose ngspice peak is zero or tiny matches when the absolute difference is at most VNTOL or ABSTOL, the smallest difference ngspice itself resolves. Signals with larger peaks keep plain peak normalisation. A deck's own `.options` tolerances are not consulted.

Before/after evidence: one run of both engines (`spice-heavy`, `b1a1ff58` plus this branch) scored all 101 fixtures that have a numeric worst in either table (batch 1 and the control supplement) under both floors. In the batch-1 rows, ddt-test1 was scored against the control-wrapper reference, so its batch-1 row was checked against the regenerated report instead. No fixture changes outcome class. The rows whose published worst moves because of the floor:

| Fixture | Old floor | New floor |
|---|---|---|
| tests/general/rca3040.cir | mismatch, 0.0564 ac v(2) (5.64e-14 V on a 0 V peak) | mismatch, 0.0511 tran v(1) (ac v(2) now 5.64e-10; #592 remains) |
| tests/general/fourbitadder.cir | mismatch, 0.0677 | mismatch, 0.0674 (#698) |
| tests/mesa/mesgout.cir | matched, 5.69e-6 ac v(1) | matched, 1.85e-6 ac i(vds) |
| examples/ddt/ddt-test1.cir (batch 1, `-r` export) | mismatch, 2e12 tran v(2) (2 V on a 0 V peak) | mismatch, 2e4 |
| control: examples/p-to-n-examples/MOS1_out.cir | matched, 0.00572 dc i(vb) (86 fA on a 15 pA peak) | matched, 0.00086 |
| control: examples/vdmos/soa_chk.sp | mismatch, 2.5e13 dc v(g2) (25 V on a 0 V peak) | mismatch, 2.52e10 dc i(vd2) (257 A on a 10 nA peak); v(g2) is still 2.5e5 |
| control: examples/vdmos/VDMOS-DIO.sp | mismatch, 2.94e10 ac v(kd) (29 mV on a 0 V peak) | mismatch, 294 ac v(kd) |

The floor shrinks the number of over-threshold signals on some losing rows without changing their outcome. rca3040 goes from 9 to 8; nmos_pmos_drainresistor/plotting from 12 to 11, because dc i(vbsn) 5.06 pA on a 5.1 pA peak drops from 0.992 to 0.0506; vdmosp-out-mtr from 8 to 6; soa_chk from 9 to 8. Zero-peak signals with real errors stay far over 1%. Examples are VDMOS-DIO ac v(kd), 29 mV against an exact 0, and soa_chk dc v(g2), 25 V. The floor does not hide them.

The rule needs `outcomes.json` and README.md to be regenerated, because the match-rule text is part of the report. They were regenerated on this branch on main `b1a1ff58` with `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --jobs 2`. The first run used `--jobs 4` under shared-host load. In it, adder_bip exceeded the 120 s spice-ts bound. Run alone it completes (`triage-detail.ts`, 0.0242), so `--jobs 2` was rerun and is the one published. Result: 46 matched, 19 mismatched, 53 not compared, 188 spice-ts losses, 30 both-engine failures (was 43/18/53/192/30). All class transitions come from simulator merges after `03706cc7`, not from the floor:

| Prior implementation | Class transitions | Count |
|---|---|---:|
| #670 XSPICE hyst (and other slice-2 code models) | loss → matched (original-examples/analog-models3 ac, dc, swept-dc) | 3 |
| #670 XSPICE hyst | loss → mismatch (original-examples/analog-models3-transient, 0.0181 tran v(10); deferred to #597, not root-caused) | 1 |

Changes within a class, all scored identically under both floors in the before/after run, so they are not metric effects; not bisected: adder_mos_circ 0.755 → 0.0451 (#626 still open); ltra2_2_line 0.374 → 0.42 and txl1_1_line 0.371 → 0.422 (i(vs)); txl2_3_line 0.0864 → 0.0875; mosmem 0.0025 → 0.00229; rtlinv 0.0527 → 0.0526; arbitrary-phase 0.00187 → 0.00113. The stochastic noise decks moved to 4.04 / 1.4 (#655). Error-text-only changes: tests/regression/misc/convergence.cir now parses `µ` (#685) and fails on `.options savecurrents`. ro_nand_digi now reports the `D_NAND` .model type after #684 accepted its misplaced `.endc`. The XSPICE "not supported" lists name the new #670 models. analog-models4 now first fails on `triangle` rather than `sine`.

Control-vector supplement, regenerated after that with `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/control-vectors.ts --jobs 4`: totals unchanged at 15/39/13/122/1/17. The floor-driven rows are listed in the table above. Other moves have the same value under both floors, so they are drift: ddt-test1 1 → 0.5; cpl_ibm1 1.04 → 1.47; cpl1_4_line 2.34 → 1.8; ltra1_1_line 0.322 → 0.21; ltra6_2_line 0.495 → 0.421; ltra2_2_line 0.374 → 0.42; txl1_1_line 0.371 → 0.422; crss_coss_ciss 0.00098 → 0.00127; the stochastic noise decks 6.03 / 1.78 → 5.97 / 1.68 (#655). The other changes are smaller than 3%.

The separate 100-fixture aggregate (`AGGREGATE_PARITY.md`) is not changed. It publishes absolute and relative error envelopes with zero references excluded. It has no per-signal match threshold or peak floor, and corpus-f is not one of its corpora.

### Sixth refresh: #593 merged with main `3b9c836f`

PR #705 became conflicting after main merged #699 (#528 `.control` export) and other simulator work. Branch head `a32e8cef` was merged with main `3b9c836f` (a merge commit; no rebase, no force-push). The only textual conflict was the control-vector supplement in README.md. It was resolved to main's version and then regenerated. Commands, after `pnpm build` on the merge:

- `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --jobs 2`
- `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/control-vectors.ts --jobs 3`

Batch 1: 52 matched, 14 mismatched, 56 not compared, 184 spice-ts losses, 30 both-engine failures (outcome SHA-256 `f0ca8fa8…`; was 46/19/53/188/30 on `b1a1ff58`). The 10 outcome-class transitions all come from simulator merges between `b1a1ff58` and `3b9c836f` (#686/#688, #689, #690, #691, #693, #696, #479), not from the floor. They are not bisected per row:

| Probable implementation | Class transitions | Count |
|---|---|---:|
| #689 ngspice CKTtrunc step control (most likely; not bisected) | mismatch → matched (rtlinv 0.0526 → 0.00238, mos-test 0.176 → 0.00811, fourbitadder 0.0674 → 0.00313, ltra2_2_line 0.42 → 0.000796, res-array 0.0253 → 0.000452, cpl-ibm2 0.155 → 0.00669) | 6 |
| a merge after `b1a1ff58`, not bisected (no more timestep too small / 120 s timeout) | loss → mismatch (tests/transmission/cpl3_4_line, 0.116 tran v(9); deferred to #597); loss → not-compared (transmissionlines cpl3_4_line.sp, cpl_ibm1a.sp; `.control` decks, scored in the supplement) | 3 |
| #686/#688 `set savecurrents` | loss → not-compared (regression/misc/convergence; `.control` deck, matched in the supplement) | 1 |

Changes within a class: rca3040 0.0511 → 0.0118 (worst now tran v(31); still #592); switches-manual-p92 0.865 → 0.74; adder_bip 0.0242 → 0.016; txl1_1_line 0.422 → 0.0236; txl2_3_line 0.0875 → 0.0878; mosmem 0.00229 → 0.00999 (still matched, close to the threshold); ro_11_vdmos 0.00348 → 0.00694. The stochastic noise decks moved to 3.04 / 1.24 (#655). tclspice testbench2/testbench4 now first fail on BSIM3 NQSMOD=1 (#692) instead of the BSIM3 revision (#594, fixed by #696).

Control-vector supplement, compared with main's committed section (27/39/1/123/1/16, scored with the old floor): 34 matched, 35 mismatched, 1 not compared, 120 spice-ts losses, 1 ngspice-only failure, 16 both-engine failures. Class transitions: mismatch → matched for mos-test, cpl_ibm2, ltra2_2_line, ltra3_2_line, ltra7_4_line and inv_vdmos; loss → matched for regression/misc/convergence; loss → mismatch for cpl_ibm1a (0.293) and cpl3_4_line (0.116). The rows moved by the floor are those of the fifth refresh (MOS1_out, soa_chk, VDMOS-DIO) plus temper-1 (matched, op v(1) 2.68e-6 → 2.68e-14). Other moves are simulator drift, not bisected: cpl_ibm1 1.47 → 0.293, cpl1_4_line 1.8 → 0.213, cpl2_2_line 0.996 → 0.348, ltra1_4_line 0.917 → 0.0998, txl4_1_line 0.612 → 0.0817, ltra6_2_line 0.421 → 0.58 (worse), and the stochastic noise decks 3.8 / 1.61 → 6.68 / 1.7 (#655). None of these is triaged here. The mismatches stay published losses.

### Seventh refresh on main `449ce900` (#592)

The #592 card adds a fine-step reference column to transient rows and regenerates batch 1 on main `449ce900` (the #592 branch merged with main) with `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --jobs 3` after `pnpm -C packages/core build`. The column is computed after the headline comparison and changes no outcome, worst value or signal, so every headline change below comes from simulator merges between `3b9c836f` and `449ce900`, not from #592. They are not bisected. The control-vector supplement was not regenerated.

Batch 1: 60 matched, 16 mismatched, 62 not compared, 168 spice-ts losses, 30 both-engine failures (outcome SHA-256 `bcf75a8a…`; was 52/14/56/184/30 on `3b9c836f`). Class transitions (18):

- spice-ts loss → matched (6): measure/rc-meas-ac.sp, transient-noise/noise_vnoi.cir, various/bjtnoise.cir, various/v-i-sources-am-ffm.cir, original-examples digital_invert and digital_models1.
- spice-ts loss → not compared (6): noise/bipolar-noise.cir, transient-noise/noi-sc-tr.cir, xspice/see/set1.cir, regression/lib-processing scope-1, scope-2 and scope-3.
- spice-ts loss → mismatch (4, deferred to #597 at that refresh): transient-noise/shot_ng (1.48, stochastic, #655), original-examples digital_models (1 tran i(v1)), mixed_io_size (0.208 tran v(4)), mixed_ref (0.0123 tran v(10)). digital_models is now resolved by #1706: the shared five-argument PULSE width default is zero in ngspice-47, not an infinite plateau. The unchanged deck matches at 71/71 points with aligned error 0 and leaves the deferred list.
- mismatch → matched (2): tests/transmission/txl1_1_line (0.0236 → 0.0036) and cpl3_4_line (0.116 → 2.44e-11).

Changes within a class: mos-test 0.00811 → 4.23e-5; mosmem 0.00999 → 0.000636; fourbitadder 0.00313 → 0.00143; rtlinv 0.00238 → 0.00148; rca3040 0.0118 → 0.0111 (still a mismatch); txl2_3_line 0.0878 → 0.0194; cpl_ibm2 0.00669 → 0.00306; res_array 0.000452 → 8.81e-16; ro_11_vdmos 0.00694 → 0.00324; switches-manual-p92 0.74 → 0.75; adder_bip 0.016 → 0.0163; measure/func_cap 0.5 → 1 (worse); analog_models1 transient 0.122 → 0.121; analog_models3 transient 0.0181 → 0.0178. The stochastic noise decks moved to 2.63 / 1.41 (#655). 112 other rows changed only their recorded error text.

The fine-step reference section of README.md lists, for every transient row, the headline value next to spice-ts and ngspice default runs scored against one ngspice fine-TMAX reference. For the #592 rows: rca3040 0.0111 headline, 0.0489 for both default runs against the reference (v(1), the 50 MHz source node sampled at 2 ns by both engines); analog_models1 transient 0.121 headline, spice-ts 0.00193 and ngspice default 0.109 against the reference; switches-manual-p92 0.75 headline, spice-ts 1 and ngspice default 0.68. One fine reference is not a convergence proof.

### #698 re-check on main `49a4fed4` (bisected)

`triage-detail.ts tests-general-fourbitadder-cir`, with and without `--tmax 1e-11`, against ngspice-47 on the byte-identical deck, each row on that commit's own `packages/core` build. Both variants were bisected with `git bisect run` (default variant over `b1a1ff58..3b9c836f`, TMAX variant over `3b9c836f..49a4fed4`).

| core | default: worst normalised (signals over 1%) | default: worst of the 8 sub-mV signals | TMAX 10 ps: worst normalised | TMAX 10 ps: worst absolute, all 270 signals |
|---|---|---|---|---|
| `b1a1ff58` (issue baseline) | 0.0677 (12) | 7.39 µV v(x1.x1.x2.x7.8) | 0.0107 | 11.7 µV v(x1.x1.x1.8) |
| `e2c73b29` #689 ngspice CKTtrunc step control (first good commit, default variant) | 0.00313 (0) | 0.327 µV | not measured | not measured |
| `faa48247` (parent of #758) | 0.00313 (0) | 0.327 µV v(x1.x2.x1.x6.8) | 0.00314 | 4.14 µV v(x1.x1.x1.7) |
| `9bb94573` #758 ngspice dctran first step and order control (first good commit, TMAX variant) | 0.00143 (0) | 0.148 µV v(x1.x1.x2.x7.8) | 7.23e-6 | 50 nV |
| `49a4fed4` (main) | 0.00143 (0) | 0.148 µV | 7.23e-6 | 50 nV |

The residual came from transient step control (step size, first step and integration order), not from the BJT load, gmin or the convergence test. Before #758 (`faa48247`) spice-ts produced 605 points on the TMAX 10 ps run against ngspice's 606; from #758 both produce 606 and the 8 uV-level nodes agree within 0.8 nV. #847 (ngspice prints CKTrhsOld) is therefore not the cause; any remaining effect on these nodes is below 1 nV. The 0.19 mV absolute default-step error on the 0.87 V nodes is ordinary output-grid interpolation (0.02% normalised) and is scored by the published metric.

`triage-511.test.ts` guards both results live when ngspice-47 is installed: the 8 signals with ngspice peaks under 1 mV stay within VNTOL at default steps, and every signal stays within VNTOL with both engines at TMAX 10 ps. With the current harness on older core builds the guard fails on `b1a1ff58` (7.39 µV and 11.7 µV) and on `faa48247` (TMAX variant, 4.14 µV), and passes on `9bb94573` and `49a4fed4`.

## RED and GREEN mean different things on a triage card

This PR changes no simulator code; `packages/` is identical to main `03706cc7`. Run:

```sh
CORPUS_F_REQUIRE_PARITY=1 pnpm exec tsx --test benchmarks/corpus/corpus-f/triage-511.test.ts
pnpm exec tsx --test benchmarks/corpus/corpus-f/triage-511.test.ts
```

The first command is deliberately **RED**. At `bf2e4169` it reproduced mosmem 0.227 and ltra2_2_line 0.974 against the unchanged 0.01 rule. After #601, mosmem matches and is asserted as a regression guard. Through `b1a1ff58` the command stayed RED on ltra2_2_line (metric residual, #592). On `3b9c836f` ltra2_2_line matches, so both commands are GREEN and the live test asserts the match as a regression guard. The second command checks all original issue rows, explicit follow-up coverage for every current mismatch, exact stored measurements, and live reproduction of mosmem and ltra2_2_line matching (8 tests with ngspice-47 installed, including the two #698 fourbitadder guards). Without ngspice-47 the four live tests are skipped, not presented as parity passes. This is not a claim that failing physics became passing physics by changing an assertion.

The initial documentation regression run also failed because the saved triage had stale XSPICE measurements and omitted the seven newly exposed mismatches. Updating the measurements and linking #597 resolves that documentation gap.
