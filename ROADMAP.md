# spice-ts Roadmap

spice-ts is pursuing correctness parity with ngspice before performance, AI-native APIs, or additional device
> Older reconciliation notes and per-merge evidence: [docs/history/ROADMAP-archive-2026-10.md](docs/history/ROADMAP-archive-2026-10.md).

models. [CHARTER.md](CHARTER.md) is the source of truth for priorities and program rules; this document is the
public issue map and measurable delivery sequence.

## Frozen snapshot, 2026-10-13

Repository evidence is frozen at main [`283e0c7ecfac8ce0f51b73b8f8f42d3aee9f1de5`](https://github.com/mfiumara/spice-ts/commit/283e0c7ecfac8ce0f51b73b8f8f42d3aee9f1de5).
GitHub issues, open PRs and milestones were captured from **2026-10-13T12:35:49Z to
2026-10-13T12:35:52Z** with `gh issue list --state open --limit 1000 --json
number,title,labels,milestone,url,body`, `gh pr list --state open --limit 100 --json
number,title,headRefOid,url` and `gh api repos/mfiumara/spice-ts/milestones`, all for
`mfiumara/spice-ts`. This is an immutable reconciliation, not a live dashboard. Later merges and new
issues do not retroactively change this snapshot, except for the explicitly dated M4 reconciliation and
merge-wave overlay below. The overlay takes precedence for the specific issues it updates; all other
captured issue and PR states remain historical.
Batch the next update rather than opening another
standalone roadmap PR within six hours.

The original capture contains **33 open issues**, four canonical trackers and **29 non-tracker issues**.
The issue tables below retain the captured inventory: **19 M1, 1 M2, 0 M3** from that capture and
**11 M4** from the 2026-10-14 readback below, each mapped once. This mixed-date inventory is not a
fresh repository-wide issue count; other milestones remain frozen.
References elsewhere explain priorities or evidence, not additional inventory entries. Tracker
checkboxes can lag GitHub issue state; the captured issue inventory takes precedence over their
older checklist counts. The [spice-ts roadmap Project](https://github.com/users/mfiumara/projects/2)
is live but private, so viewing it requires repository-owner access.

| Charter milestone | Canonical tracker | Exit criteria |
|---|---|---|
| [M1 Correctness parity](https://github.com/mfiumara/spice-ts/milestone/1) | [#634](https://github.com/mfiumara/spice-ts/issues/634) | All open simulator bugs fixed; ≥100 public benchmark circuits run against ngspice in CI-able harness; published parity report; agreed error thresholds met or gaps filed |
| [M2 Performance](https://github.com/mfiumara/spice-ts/milestone/2) | [#635](https://github.com/mfiumara/spice-ts/issues/635) | Sparse/reuse solver path; scaling benchmark to ≥10k nodes; published runtime comparison vs ngspice |
| [M3 AI-native API](https://github.com/mfiumara/spice-ts/milestone/3) | [#636](https://github.com/mfiumara/spice-ts/issues/636) | MCP server package, JSON netlist schema, structured errors, docs + examples for agent use |
| [M4 Device models](https://github.com/mfiumara/spice-ts/milestone/4) | [#637](https://github.com/mfiumara/spice-ts/issues/637) | Gummel-Poon, BSIM4 (or documented subset), EKV, T-line, driven by benchmark gaps |

## M1 Correctness parity

Open work is ordered by affected fixture groups, then concrete correctness blockers and
measurement decisions. Counts in issue titles are historical triage scope, not fresh main results.

| Issue | Scope and next verifiable delivery |
|---|---|
| [#526](https://github.com/mfiumara/spice-ts/issues/526) | Q/D follow-through umbrella (22 original fixtures); CIDER, diode/VBIC thermal, noise/PNP residuals. Share CIDER scope with M4, do not count it twice. |
| [#812](https://github.com/mfiumara/spice-ts/issues/812) | OPEN after refresh [PR #1038](https://github.com/mfiumara/spice-ts/pull/1038), squash `56e870f8149337ad08fe2d040da64e8df304386f`, accepted head `535e1fd7a8feb3eba85d22230939a50221bd66ef`. Original 25-ticket manifest right 7 → 8, unsupported 18 → 15, error 0 → 2. Published ticket 745/761/763 i(V1) max relative losses 1.9e-3/2.8e-4/2.0e-3; 5 pinned variants remain provenance gaps in #803's pin-restoration lane. Later [PR #1042](https://github.com/mfiumara/spice-ts/pull/1042), squash `fcbefa08`, reduces d_pulldown 1 → 0 but gives ticket 398 only a partial native oracle for up/vss, not zero. Partial/unscored execution is not parity; see both dated denominators in the overlay. |
| [#871](https://github.com/mfiumara/spice-ts/issues/871) | CLOSED at the added readback. [PR #1048](https://github.com/mfiumara/spice-ts/pull/1048), merge `33bbd69c`, repairs only the strict analytic assertion with ngspice-47 numparam bits, not temperature implementation or upstream lexical shadowing. This updates this captured row, not the historical M1 inventory total. |
| [#597](https://github.com/mfiumara/spice-ts/issues/597) | Seven newly runnable F mismatch rows, including ddt, XSPICE, resistor-array and TXL/CPL. Root-cause remaining losses after merged child fixes. |
| [#791](https://github.com/mfiumara/spice-ts/issues/791) | H astable/relay/T-line triage. Pending PR #892 is not frozen-main delivery. |
| [#882](https://github.com/mfiumara/spice-ts/issues/882) | Scoped brace expressions on subcircuit model cards; at least three vendor decks in upstream tickets 784/738. Pending PR #900. |
| [#888](https://github.com/mfiumara/spice-ts/issues/888) | Dynamic caller-instance numparam scope and shadowing, distinct from merged lexical/model-scope fixes. |
| [#797](https://github.com/mfiumara/spice-ts/issues/797) | Comma-separated instance parameter semantics; example01 V(N1) -7.232 vs 1.097. Decide source-pinned compatibility, not per-deck rewriting. |
| [#899](https://github.com/mfiumara/spice-ts/issues/899) | Finite Jacobian solve overflow rejects ngspice-valid infinite B-source OP. Solver lane; preserve genuine singularity protections. |
| [#917](https://github.com/mfiumara/spice-ts/issues/917) | Still **OPEN** after evidence-only [PR #1091](https://github.com/mfiumara/spice-ts/pull/1091), merged at `8bf0e839`. Source-schedule bootstrap and OPtran-reuse candidates were rejected; both vendor losses remain. No production recovery fix or parity claim. This later evidence row does not change the frozen M1 inventory total. |
| [#549](https://github.com/mfiumara/spice-ts/issues/549) | TXL+CPL default-step accuracy and 65–125x runtime loss; compare general step/load fixes, retain fine-reference uncertainty. |
| [#768](https://github.com/mfiumara/spice-ts/issues/768) | PSP103-named MOS1 transient 1.02% mismatch in earlier receipt; establish current cause without loosening 1%. |
| [#782](https://github.com/mfiumara/spice-ts/issues/782) | CLOSED by [PR #1032](https://github.com/mfiumara/spice-ts/pull/1032), merge `17128122`. Numparam reading/printf ties-to-even remediation; earlier rounding rejection retained in the overlay. This updates only this captured row, not the old M1 inventory total. |
| [#655](https://github.com/mfiumara/spice-ts/issues/655) | TRNOISE/TRRANDOM independent random realisations need honest comparison semantics. |
| [#734](https://github.com/mfiumara/spice-ts/issues/734) | Unstable-equilibrium blocking oscillator; phase/round-off sensitivity, no deterministic first-pulse parity claim. |
| [#867](https://github.com/mfiumara/spice-ts/issues/867) | VSWITCH missing VON/VOFF defaults versus ngspice-47 double-free failure. Document or diagnose deliberate difference; no valid reference win. |
| [#847](https://github.com/mfiumara/spice-ts/issues/847) | CKTrhsOld output convention versus converged solve; measured documentation PR #896 pending. |
| [#855](https://github.com/mfiumara/spice-ts/issues/855) | Nightly-only aggregate provenance/transition/fine-reference refresh. Blocks current aggregate parity claims. |
| [#761](https://github.com/mfiumara/spice-ts/issues/761) | HFET upstream bug 877 explanation, batched with nightly aggregate; retain row status. |
| [#901](https://github.com/mfiumara/spice-ts/issues/901) | This bounded roadmap reconciliation and exact-head review; ROADMAP.md only. |

Recent **merged** evidence in the frozen history includes [#841](https://github.com/mfiumara/spice-ts/pull/841)
(I ingestion), [#851](https://github.com/mfiumara/spice-ts/pull/851) (fine reference),
[#865](https://github.com/mfiumara/spice-ts/pull/865) (digital AC),
[#866](https://github.com/mfiumara/spice-ts/pull/866) (model scope),
[#880](https://github.com/mfiumara/spice-ts/pull/880) (PSpice model temperature),
[#881](https://github.com/mfiumara/spice-ts/pull/881) (POLY trtol),
[#883](https://github.com/mfiumara/spice-ts/pull/883) (B-source PSpice functions),
[#884](https://github.com/mfiumara/spice-ts/pull/884) (subcircuit parameter dependency order),
[#885](https://github.com/mfiumara/spice-ts/pull/885) (literal round trips),
[#889](https://github.com/mfiumara/spice-ts/pull/889) and
[#897](https://github.com/mfiumara/spice-ts/pull/897) (B-source zero-base/initial-iterate power),
[#894](https://github.com/mfiumara/spice-ts/pull/894) (bounded test timeout), and
[#895](https://github.com/mfiumara/spice-ts/pull/895) (fourbitadder bisect receipt).
Merged fixes do not refresh the aggregate or close unrelated parent gaps.

## M2 Performance

| Issue | Scope and next verifiable delivery |
|---|---|
| [#890](https://github.com/mfiumara/spice-ts/issues/890) | Profile RC transient after merged #887; cache/stamp hot-path PR #898 remains pending at capture. Require identical-deck before/after receipts and controls. |
| [#1310](https://github.com/mfiumara/spice-ts/issues/1310) | VBIC DFF_Y_ECL.sp transient perf; compare timestep/Newton counters against ngspice on the identical deck to split per-iteration cost from step/iteration count; require identical-deck before/after receipts and output hashes. |

The [published M2 baseline](benchmarks/PERFORMANCE_BASELINE.md) and
[raw matrix](benchmarks/performance/results/scaling-m2.json) run RC ladders, resistor mesh and
CMOS chains at 1k / 10k / 50k. Mesh actually has 1024 / 10000 / 50176 nodes. The October 11
baseline used main `3490527`, Apple M5 Pro, Node v22.23.1 and ngspice-47, two warmups and ten
samples per cell on byte-identical decks. KLU selection is outside the shared deck; its banner
is checked. spice-ts times the in-process API, ngspice wall includes cold CLI startup; internal
analysis is separate. The shared host ranged from load 4.6 to 22.1, so retain raw samples/p95.

| Historical baseline workload | Nodes | spice-ts median | ngspice KLU wall median | Published wall result |
|---|---:|---:|---:|---|
| RC transient | 1000 | 90.9 ms | 23.9 ms | 3.80x slower |
| RC transient | 10000 | 1.12 s | 179 ms | 6.29x slower |
| RC transient | 50000 | 8.92 s | 1.09 s | 8.17x slower |
| Mesh OP | 1024 | 5.82 ms | 18.2 ms | 3.13x faster wall, but 2.19x slower analysis |
| Mesh OP | 10000 | 146 ms | 100 ms | 1.46x slower |
| Mesh OP | 50176 | 2.71 s | 906 ms | 3.00x slower |
| CMOS transient | 1000 | 3.15 s (load-affected) | 408 ms | 7.73x slower; retained original row |
| CMOS transient | 10000 | 18.35 s | 4.60 s | 3.99x slower |
| CMOS transient | 50000 | FAILED, singular s135 after 28.6 s | 68.39 s | ngspice succeeds; historical failure retained |

The separate 1k CMOS rerun was 1.08 s vs 151 ms KLU, **7.15x slower**. Historical accuracy
sanity was RC 1.08e-4 relative, mesh ≤1.9e-7 relative, CMOS v(s20) 0.6456 vs 0.3501 V on a steep
edge and about 1% stage-delay difference. Memory losses include RC 50k 933 vs 131 MiB, mesh
50k 445 vs 219 MiB, CMOS 10k 662 vs 102 MiB. The 50k failure is not a current-main failure
claim: later committed receipts complete it, but the original failure is never erased.

Later **merged** receipts qualify what has improved and what still loses:

- [#769 receipt](benchmarks/performance/results/issue-769/README.md) publishes AC mesh at
  2.3x / 2.2x / 2.4x slower than KLU wall at 1k / 10k / 50k after pivot reuse, plus fresh-process
  1k CPU losses of 0.81x mesh and 0.87x ladder before/after speedup. Its M2 control ratios are
  RC 1.57x / 1.31x / 1.00x, mesh 2.88x / 2.44x / 2.02x, CMOS 1.41x / 0.62x / 0.81x analysis
  versus KLU. Unpaired faster readings are not wins.
- [#830 receipt](benchmarks/performance/results/issue-830/README.md), merged PR
  [#835](https://github.com/mfiumara/spice-ts/pull/835), removes allocating MOS1 step limits.
  CMOS OP 10k 624→544 ms, 50k 12.88→9.08 s, paired 1.15x / 1.42x. Different Newton schedules
  and shared load prevent an engine-level win claim.
- [#842 receipt](benchmarks/performance/results/issue-842/README.md), merged PR
  [#859](https://github.com/mfiumara/spice-ts/pull/859), caches bit-identical MOS1 loads.
  Post-review A/B medians are CMOS 1k 162→144 ms, 10k 2382→2272 ms, 50k 22498→18397 ms;
  pair speedups 1.188x / 1.077x / 1.147x. RC 1k control reads **0.951x**, a published loss.
  The earlier 10k CMOS-OP pair median 0.923x and 50k 0.881x are unsettled losses, not hidden.
  Its native comparison used **Sparse 1.3**, not a new KLU matrix (the 50k mesh native reorder
  alone was 74.5 s). CMOS/mesh faster readings cannot replace the KLU comparison above.
- [#878 receipt](benchmarks/performance/results/issue-878/README.md), merged PR
  [#887](https://github.com/mfiumara/spice-ts/pull/887), closes the CMOS transient iteration
  gap from 599 to 466 versus ngspice's 483 on the same 214 points. The 1k/10k waveform gap
  remains about 0.628 mV. Fresh-process CMOS medians are 194→181 ms / 2130→2082 ms /
  23541→20632 ms; paired gains only 1.043x / 1.030x / 1.028x with load-sensitive ranges.
  RC controls read **0.968x / 0.945x / 0.975x**; mesh 10k/50k **0.973x / 0.984x**.
  A rejected predictor implementation lost at 0.952x / 0.880x. All remain published.

- [#1310 receipt](benchmarks/performance/results/issue-1310/README.md), merged PR
  [#1326](https://github.com/mfiumara/spice-ts/pull/1326) (squash `8e148427`), reduces the full
  unchanged `DFF_Y_ECL.sp` median from 994.508378 s to 76.027358 s (92.3553% reduction,
  13.0809x speedup; three runs each under `spice-heavy`, shared host load uncontrolled).
  All six runs have identical waveform SHA-256 and convergence counters, with 43273 rows.
  [Independent review](https://github.com/mfiumara/spice-ts/pull/1326#pullrequestreview-5557546163)
  repeated only the shortened 0.1 ns run: median 6.82→0.55 s, not a full-deck rerun.
  The loss remains: the ngspice-47 reference is 1.3–3.9 s / 40545 rows, so spice-ts is still
  roughly 20–58x slower and its row count differs (43273 versus 40545). This is not a new
  ngspice measurement or a superiority claim; the known V(Q) parity gap remains tracked by #1309.

- [#1310 round-2 receipt](benchmarks/performance/results/issue-1310/README.md#full-unchanged-deck-three-runs-per-revision),
  merged PR [#1329](https://github.com/mfiumara/spice-ts/pull/1329) (squash `afefa01b`), reduces the
  full unchanged `DFF_Y_ECL.sp` median from 51.971084 s to 37.015348 s (28.7770% reduction)
  against the implementation lane's paired fresh baseline `8e148427`; three runs each under
  `spice-heavy`, shared host load uncontrolled.
  [Independent full-deck review](https://github.com/mfiumara/spice-ts/pull/1329#pullrequestreview-5557636767)
  repeated 3+3 runs: medians 69.06→45.84 s (33.63% reduction).
  All runs have identical waveform SHA-256
  `fa930f7d1b79d8ce7f05a5de675090f44ff445b143b18a85075f530dd52b19fc` (43273 rows)
  and identical convergence counters. The loss remains: about 9.5–28.5x slower than the existing
  ngspice-47 reference of 1.3–3.9 s. No fresh ngspice timing was taken; there is no superiority claim.

These tables come from their cited artifacts, not a new measurement of the frozen head. Do not
multiply isolated speedups or call #890's older 8.2x headline a newly reproduced main result.
The next performance slice must profile its actual base and publish both KLU and control losses.

## M3 AI-native API

There are **zero open non-tracker M3 issues** in the captured inventory. The tracker still lists
the old MCP parent, but [#61](https://github.com/mfiumara/spice-ts/issues/61) closed at
2026-10-13T08:32:27Z. The old #60–#63 residual table in the archive is not today's backlog.
Continue to document supported protocol/MCP/JSON/WASM boundaries and measured costs; absence
of open issues does not make every SPICE device or analysis available through WASM.

## M4 Device models

| Issue | Scope and next verifiable delivery |
|---|---|
| [#948](https://github.com/mfiumara/spice-ts/issues/948) | Xyce second-reference simulator integration remains open despite the merged EKV static validation. |
| [#962](https://github.com/mfiumara/spice-ts/issues/962) | EKV2.6 charge-conserving dynamics, AC/NQS, noise and temperature follow-up; not completed by #964. |
| [#963](https://github.com/mfiumara/spice-ts/issues/963) | Retain and characterize EKV2.6 static-slice residual/reference loss buckets. |
| [#994](https://github.com/mfiumara/spice-ts/issues/994) | CLOSED by [PR #1030](https://github.com/mfiumara/spice-ts/pull/1030), merge `e96c3929`. Xyce SINE/DC/AC translation remediation, not resolution of Jimi startup-IC loss. This updates only this captured row, not the old M4 inventory total. |
| [#497](https://github.com/mfiumara/spice-ts/issues/497) | CIDER NUMD/NUMOS/NBJT. Largest explicit model bucket, 37 F rows in the committed receipt; original issue title's ten is not the current receipt count. |
| [#553](https://github.com/mfiumara/spice-ts/issues/553) | Remaining XSPICE models, including I's four d_jkff/lcouple/zener losses. Earlier adc_bridge/digital counts predate merged slices; audit before choosing the next group. |
| [#692](https://github.com/mfiumara/spice-ts/issues/692) | BSIM3 NQSMOD/ACNQSMOD; two F decks, explicit rejection rather than silent quasi-static simulation. |
| [#559](https://github.com/mfiumara/spice-ts/issues/559) | VDMOS thermal Tj/Tc and VP/TT soft recovery. Two original F examples, with control-language blockers distinguished. |
| [#747](https://github.com/mfiumara/spice-ts/issues/747) | B3SOI/PSP/EKV compact-model umbrella; G receipt has one B3SOI unsupported row, not the issue's original four as a fresh count. |
| [#5](https://github.com/mfiumara/spice-ts/issues/5) | Gummel-Poon parent. Many later BJT slices merged; preserve unsupported boundaries rather than reusing the archive's old forward-active-only claim. |
| [#7](https://github.com/mfiumara/spice-ts/issues/7) | Lossless T-line parent, including NL/F form and pending #892 step-control evidence; no blanket transmission-line parity claim. |

M4 issue state was reconciled at **2026-10-14T05:17:08Z** with
`gh issue list --repo mfiumara/spice-ts --milestone "M4 Device models" --state open --limit 1000 --json number,title`:
**12 open issues including tracker #637; 11 non-tracker issues**, listed above.
[#4](https://github.com/mfiumara/spice-ts/issues/4) is **done / closed**: EKV2.6 static OP/DC,
validated against **Xyce 7.10**, merged in [PR #964](https://github.com/mfiumara/spice-ts/pull/964)
as [`c1594afc`](https://github.com/mfiumara/spice-ts/commit/c1594afc420f9d61116d60fa21d14ae893315527).
This is not full dynamic, noise or temperature support; #962 and #963 retain the follow-up gaps.
[#3](https://github.com/mfiumara/spice-ts/issues/3) also closed through the documented BSIM4 static
OP/DC subset in [PR #999](https://github.com/mfiumara/spice-ts/pull/999), merge `3e493009`;
neither closed parent belongs in this refreshed open inventory. #948 and #747 remain open.

## Benchmark policy

- Record every circuit's source URL, revision, licence, redistribution decision, and adaptations in
  `benchmarks/SOURCES.md`. Do not commit material whose licence forbids redistribution; commit an executable fetch
  script instead.
- Run spice-ts and ngspice on semantically identical netlists. Record versions, machine, commands, analysis type,
  convergence status, runtime, and matched-point max/RMS absolute and relative waveform errors.
- Publish failures, unsupported features, and speed losses alongside wins. Never cherry-pick circuits, hide errors
  with per-circuit tolerance tuning, or claim category superiority without reproducible evidence.

## Publication boundary

The program may create and update GitHub issues, labels, milestones, Projects, branches, and PRs in
`mfiumara/spice-ts`. A PR may be squash-merged only when CI is green on its exact head SHA and an independent
`spice-ts-review` has accepted that same SHA.

Without Mattia's approval, the program must not publish npm packages, create tags or releases, publish changeset
versions, change production hosting (spicets.com, Cloudflare Pages), force-push `main`, delete branches or issues not created by the
program, spend money, touch secrets, edit `~/repos/spicets/web`, or post on social media.

</details>
