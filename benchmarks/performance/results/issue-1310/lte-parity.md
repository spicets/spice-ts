# Issue #1310: classify transient rejections

Refs #1310, not a closure. Base e620ed8614da1c8afd2a8f0657a73857b58cbc98. This slice adds opt-in rejection telemetry, not a numerical correction. No tolerance, timestep, device, order or default changes. Machine-readable observations are in [lte-parity.json](lte-parity.json).

## Result

The unchanged full DFF deck reproduces **3139 voltage-predictor-only rejects**. There are no charge-only, simultaneous voltage/charge, Newton or hybrid-breakpoint rejects. This locates the rejection decision; it does not show that removing voltage LTE is safe or would preserve waveform accuracy.

| Mutually exclusive reject class | spice-ts | ngspice-47 |
| --- | ---: | ---: |
| Voltage predictor only | 3139 | 0 |
| Charge only | 0 | 0 |
| Voltage and charge together | 0 | 0 |
| Newton nonconvergence | 0 | 0 |
| Hybrid breakpoint backup | 0 | 0 |
| Total | 3139 | 0 |

ngspice classifications follow from zero total rejected timepoints, not added instrumentation. Scheduled source-breakpoint clipping is not a rejected trial in either column. In particular ngspice's XSPICE `past_breakpoint` branch does not increment STATrejected, so the breakpoint category is not generally equivalent to its aggregate counter. This all-analog deck has no hybrid event devices.

spice-ts returns 43273 rows including t=0, 43272 accepted advances and 100724 transient Newton iterations with telemetry disabled and enabled. ngspice returns 40545 accepted rows including t=0. The enabled and disabled accepted-advance waveforms have identical row-major SHA-256 74f3e10feb6e37272834242d6308bf069f107cffbc69005902356682170992a5. The hash includes the same baseline t=0 row for both; all later rows are independently simulated. Round 3 hashes columns instead and is not directly comparable.

First rejection: endpoint 3.2e-13 s, dt 1.6e-13 s, voltage ratio 8.793309405909879, charge bound 5.2409245884402585e-12 s, proposed retry dt 4.856085388943625e-14 s. Charge truncation permits a much larger step on that trial.

One wrapped baseline `simulate` call took 46.812938791 s. One callback-enabled stepping call took 54.073582166 s. Fresh ngspice transient time was 1.64356 s. The JS scopes differ in result construction; this shared-host sample is **not an overhead or speed benchmark**. No behavior changed, so the three-before/three-after behavior-change condition does not apply. Disabled observers allocate no rejection events and add only optional-call checks at existing rejection sites, not accepted-point work.

## ngspice-47 source comparison

All links pin the public ngspice-47 tag.

- [CKTtrunc lines 22–56](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/ckttrunc.c#L22-L56) uses device DEVtrunc hooks when newtrunc=0 and caps growth at 2x. The alternative [lines 78–100](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/ckttrunc.c#L78-L100) starts a voltage predictor implementation. spice-ts's fallback voltage predictor is not the same algorithm and is applied alongside charge hooks on uncovered state nodes. `transient-node-truncation.ts:21–54` explains the exemption rule. VBIC has a truncation hook but does not declare `truncationCoversCharges`; this is not permission to exempt its nodes without proving complete charge coverage.
- [VBICtrunc lines 26–38](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/devices/vbic/vbictrunc.c#L26-L38) calls CKTterr on qbe, qbex, qbc, qbcx, qbep, qbeo, qbco and qbcp. No VBIC device code is changed here. A device coverage audit belongs to the device-owning lane.
- [dctran lines 724–741](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L724-L741) counts Newton failure, divides dt by 8 and restarts at order 1. spice-ts also divides by 8 and restarts order, with additional established convergence safeguards. This DFF triggers neither path.
- [dctran lines 769–835](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L769-L835) skips truncation on the first point, accepts charge bounds strictly above 0.9x dt, and probes order 2 after order 1, raising it only above 1.05x dt. [Lines 879–889](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L879-L889) count charge rejection. spice-ts uses the corresponding order-growth policy, plus the voltage ratio decision. Its strict-less-than rejection comparison also differs at exact 0.9 equality; no physical failing parity example was established here, so that boundary is unchanged.
- [dctran lines 488–523](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L488-L523) resets order and limits the post-break step using saved delta and next-break gap. [Lines 743–761](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L743-L761) handle a temporary hybrid breakpoint inside a solved trial, and [815–817](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L815-L817) can request backup after hybrid evaluation. The callback reports spice-ts's analogous `events.prepareStep` retries, not normal clipping.
- [traninit line 36](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/traninit.c#L36) scales delmin by maxStep*1e-11. [dctran lines 160–168](https://github.com/imr/ngspice/blob/ngspice-47/src/spicelib/analysis/dctran.c#L160-L168) sets minBreak to 10*delmin for XSPICE or maxStep*5e-5 otherwise. spice-ts retains fixed MIN_TIMESTEP=1e-15 and MIN_BREAK=1e-14, plus the 100*MIN_TIMESTEP LTE floor and ten-rejection bypass. These differences are not isolated causally by this measurement.

No small ngspice-referenced failing accuracy test was established that warrants a policy change. The telemetry tests deliberately use synthetic device hooks to exercise classification, not as physical parity evidence. No LTE disabling, per-deck tuning, changeset or claimed RED/GREEN numerical correction. The existing DFF V(Q) parity loss (#1309) remains; this adds no waveform-error improvement or loss relative to the baseline accepted advances.

## Reproduce

Source/license remain recorded under corpus-f in benchmarks/SOURCES.md. Fixture SHA-256 is d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. Original deck bytes, including TRAN 0.25p 10n, are unchanged. Node v22.23.1, Darwin 27.0.0 arm64, shared Mac; ngspice-47.

After `pnpm install --frozen-lockfile && pnpm build`, save this module in scratch and run `spice-heavy node <scratch>/classify.mjs` from the repo root. Options restate the original control TRAN for the stepping API; no fixture rewriting occurs.

```js
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { createTransientSim } = await import(pathToFileURL(`${process.cwd()}/packages/core/dist/index.js`));
const deck = readFileSync('benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp', 'utf8');
const counts = {};
const sim = await createTransientSim(deck, {
  timestep: 2.5e-13, stopTime: 1e-8,
  onReject: e => { counts[e.reason] = (counts[e.reason] ?? 0) + 1; },
});
while (!sim.isDone) sim.advance();
console.log(JSON.stringify({ counts, convergence: sim.convergence }));
sim.dispose();
```

For ngspice, save the following scratch wrapper, run `spice-heavy ngspice -b <scratch>/stats.cir`, and inspect accepted/rejected timepoints. The source command executes the original control block before rusage. Plot errors in headless batch mode do not change the analysis.

```spice
Stats only
.control
source benchmarks/corpus/corpus-f/fixtures/examples/vbic/DFF_Y_ECL.sp
rusage all
quit
.endc
.end
```

Validation: frozen install, monorepo build and lint pass. Targeted command `pnpm -C packages/core exec vitest run src/analysis/transient-rejection-1310.test.ts src/analysis/transient-charge-lte.test.ts` passes 2 files / 6 tests. The wrapped root command `spice-heavy pnpm test` also passes. Exact-head GitHub CI supplies the authoritative full-suite and accuracy gates; their status is reported in the card handoff rather than frozen into this receipt.
