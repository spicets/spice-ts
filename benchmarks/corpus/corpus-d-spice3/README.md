# corpus-d-spice3: SPICE3/ngspice translations of the ahkab corpus

Sibling of [`../corpus-d`](../corpus-d) (issue #524, lane 1). The 20 ahkab test-suite decks in
corpus-d stay byte-for-byte unchanged. Here they are translated to SPICE3/ngspice syntax, so
ngspice and spice-ts can run identical bytes. Only purely syntactic, circuit-preserving
translations are allowed. A construct with no exact SPICE3 equivalent is not approximated: the
fixture is marked `unsupported-translation` and the manifest gives the reasons.

| Path | Content |
| --- | --- |
| `manifest.json` | Generated. One entry for each of the 20 corpus-d fixtures, with the upstream path, the original's SHA-256, the translation status, the list of changes or the reasons it could not be translated, the translated deck's SHA-256, and any ahkab reference files. |
| `fixtures/` | Generated translated decks. Line 1 is the upstream title. A comment header names the upstream file, the GPL-2.0-only licence, the modification date and every change. |
| `references/` | ahkab's own reference results (`*-ref.op`, `*-ref.tran`) for the translated circuits, copied byte-for-byte from the pinned revision. They are the third reference column. |
| `LICENSE-NOTICE.md`, `COPYING.txt` | The upstream notice and the complete GPLv2 text, the same bytes as in corpus-d. |
| `compare.ts` | Runs ngspice and spice-ts on each translated deck and measures both engines against the ahkab references. It writes `results.json` and `RESULTS.md`. |

## Regenerate and verify

```sh
pnpm exec tsx benchmarks/translate/ahkab-to-spice3.ts           # regenerate manifest + fixtures
pnpm exec tsx benchmarks/translate/ahkab-to-spice3.ts --check   # fail if committed output is stale
pnpm exec tsx --test benchmarks/translate/ahkab-to-spice3.test.ts
pnpm -C packages/core build && pnpm exec tsx benchmarks/corpus/corpus-d-spice3/compare.ts
```

This corpus is not registered in `benchmarks/aggregate-report.ts` or `benchmarks/SOURCES.md` yet.
That registration is #524 lane 4.

The `tran_gear5` and `tran_gear6` translated decks now run in both engines. On
ngspice-47, their worst spice-ts vs ngspice transient difference is 6.8834e-15 V
at `v(2)` (586 aligned points). Against the ahkab fixed-order references the
worst differences are 0.54059 V and 0.52742 V respectively. See `RESULTS.md`
for the full report. `compare.ts` reports errors without a pass/fail tolerance.

For ngspice-47, [dctran.c:822-831](https://github.com/ngspice/ngspice/blob/a80f6e3/src/spicelib/analysis/dctran.c#L822-L831)
trials only order 1 to 2. [nicomcof.c:52-64](https://github.com/ngspice/ngspice/blob/a80f6e3/src/maths/ni/nicomcof.c#L52-L64)
provides coefficients for orders 1 through 6, and [cktterr.c:60-75](https://github.com/ngspice/ngspice/blob/a80f6e3/src/spicelib/analysis/cktterr.c#L60-L75)
indexes the error estimate by the actual order. A higher MAXORD is a cap, not
a request to run that order. These are source-derived conclusions, not an
instrumented native order trace.

## Caveats stated per deck

- `method=gearN` becomes `.options method=gear maxord=N`. SPICE3/ngspice Gear is variable-order up
  to MAXORD, while ahkab GEARn is fixed-order. The circuit and the requested analysis are the
  same, but the integration error is not ahkab's.
- `.tran` `uic=0` and `uic=2` become `UIC` only when both simulators provably start from the zero
  state.
- Decks with diodes get `.temp 26.85` and `.options tnom=26.85`, because ahkab evaluates and
  specifies devices at 300 K.
- ahkab `AM` becomes ngspice `AM(0 sa*oc sa fm fc td)`. The waveform is identical, but `AM` is an
  ngspice extension and not part of SPICE3f5.
