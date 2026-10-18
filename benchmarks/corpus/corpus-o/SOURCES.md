# corpus-o provenance and selection

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

## Reproduction and selection

Clone https://github.com/Xyce/Xyce_Regression and set CORPUS_O_UPSTREAM to that checkout. Run `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-o/ingest.ts`, then `pnpm exec tsx benchmarks/corpus/corpus-o/provenance.ts`, then `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-o/parity.ts`. The generator appends the root source section once. Verification: `pnpm exec tsx --test benchmarks/corpus/corpus-o/corpus-o.test.ts`.

Scope/order are fixed in ingest.ts: SANDLER/TL431/MCNC BJT applications first, AC/noise second, then diode/BJT/switch families in en path order. Shared corpus-h staticVerdict excludes separate licence notices, dependencies, host commands and decks without analyses. SHA-256 dedupe covers every other benchmarks/corpus directory (including terminal-newline-normalised hashes) and earlier candidates. survey.json retains every candidate and static exclusion. probe.json retains every eligible ngspice attempt. Stop at 24 reference successes, or exhaust eligible candidates: this batch exhausts them with 23 successes. No spice-ts execution informed selection. Attempted AC and switch decks did not yield an ngspice reference and are explicitly excluded below, not adapted. No simulator code changes; this is a new baseline, not a speed improvement.

## Excluded after ngspice-47 probe

| Path | Status | Reason |
|---|---|---|
| Netlists/SANDLER24/sandler24.cir | unsupported | Error: no such function 'poly' at line 67 |
| Netlists/SANDLER28/sandler28.cir | unsupported | Error: no such function 'poly' at line 55 |
| Netlists/TL431/TL431.cir | unsupported | Error on line 10 or its substitute: |
| Netlists/ACtests/bsim3/step-op-amp.cir | unsupported | Error on line 32 or its substitute: |
| Netlists/ACtests/test1.cir | unsupported | Error: no such function 'if' at line 7 |
| Netlists/NOISE/unsupported_analysis_mode.cir | failed | Error on line 12 or its substitute: |
| Netlists/VANOISE/bsim6_acnoise1d_sw.cir | unsupported | Error on line 16 or its substitute: |
| Netlists/VANOISE/commonEmitterBjt_vbic13_3T.cir | failed | Error on line 57 or its substitute: |
| Netlists/VANOISE/commonEmitterBjt_vbic13.cir | failed | Error on line 61 or its substitute: |
| Netlists/BJT_EXTNODE/npn_rb_rc_re_3.cir | unsupported | Error on line 14 or its substitute: |
| Netlists/BJT_EXTNODE/npn_rc_re_3.cir | unsupported | Error on line 14 or its substitute: |
| Netlists/DIODE/diode_with_sidewall_temp.cir | unsupported | Error on line 7 or its substitute: |
| Netlists/GSWITCH/gswitch.cir | unsupported | Error in netlist line no. 9, new internal line no. 9: |
| Netlists/GSWITCH/gswitchHyst1.cir | unsupported | Error in netlist line no. 9, new internal line no. 10: |
| Netlists/ISWITCH/iswitch_spice.cir | failed | Error on line 8 or its substitute: |
| Netlists/ISWITCH/iswitch.cir | unsupported | Error in netlist line no. 9, new internal line no. 8: |
| Netlists/ISWITCH/iswitchHyst1.cir | unsupported | Error in netlist line no. 4, new internal line no. 4: |
| Netlists/VSWITCH/Vswitch_A1.cir | failed | Error on line 36 or its substitute: |
| Netlists/VSWITCH/Vswitch_B1.cir | failed | Error on line 4 or its substitute: |
| Netlists/VSWITCH/VswitchHyst1.cir | failed | Error on line 4 or its substitute: |

## Failure and measurement issues

- MOS2 noise (o-5): https://github.com/mfiumara/spice-ts/issues/1314
- MOS3 noise (o-6): https://github.com/mfiumara/spice-ts/issues/1315
- MOS9 noise (o-3): https://github.com/mfiumara/spice-ts/issues/1316
- Control-noise export/pairing (o-1, o-10): https://github.com/mfiumara/spice-ts/issues/1317
- Large diode-reference metric deadline: https://github.com/mfiumara/spice-ts/issues/1318

The metric itself is unchanged. Every comparison runs in a uniform 119 s owned process group; expiry preserves the real engine statuses, publishes measurementError, null metrics and not-compared. This is incomplete measurement, not evidence of parity. The initial in-parent corpus-n-style comparison stalled on the 10,000,008-point o-19 reference for over nine minutes; no circuit was dropped. A terminal transport timeout then interrupted the bounded run after o-19. The published run resumes that verified 19-row checkpoint with `--resume <original-core-tree>` (fixture-prefix hashes checked), with no core, fixture or metric changes. Resume requires an explicitly supplied original core tree; it is a local recovery feature, not automatic evidence reuse. Full regeneration without --resume is the canonical command.
