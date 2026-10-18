# #1310 round 12: unrolled linear Dual passes

Refs #1310. Base 5db8e29000d27848bee5c3251b1accad1d371c4a. GO gate passed before PR creation. No solver, tolerance, timestep, option or fixture changes. Sources/licences remain in benchmarks/SOURCES.md.

## Profile-led fallback

Use the round-10 recipe on current main:

    spice-heavy node --cpu-prof --cpu-prof-dir=<scratch> --cpu-prof-name=r12-base.cpuprofile benchmarks/performance/dff-1310.mjs 1

Resolve function-start locations with matching dist source maps using node:module SourceMap.findEntry. Count unweighted inclusive samples once per selected frame per sample. Union scale, map and add without double counting. Inlining limits expression attribution. CPU sample counts are not wall-clock time.

Main profile: 5361 process samples, 3484 evaluate-inclusive. The selected linear map/scale + add union is 720/3484 (20.67%). Scale alone is 472, add 264, map 82 inclusive; overlap means these cannot be summed. A temporary extraction of the unchanged q1/q2/qb/itzf/itzr/transport Dual expression measured 239/3139 (7.61%) evaluate samples, below the 15% gate. It was not used as the balanced timing baseline. Counts were captured against matching extraction maps before a subsequent build removed those temporary dist files. Thus use the permitted largest remaining N-wide linear arithmetic bucket rather than converting transport.

Production only unrolls map and add derivative loops for the existing model-wide nine branches, or eleven with excess phase. Every coordinate performs exactly the previous floating-point multiplication/addition, including inactive and signed-zero coordinates. Allocation strategy is unchanged. No analytic transport, avalanche or quasi-saturation equations changed. No model constants, bias-specific dispatch or circuit-specific path added.

Head profile: 4274 process samples, 2695 evaluate-inclusive; selected union 527/2695 (19.55%). Scale 305, add 237, map 79 inclusive. Profiled simulate seconds 23.224072125 -> 18.905166458. Profile changes are descriptive, not an independent speed claim.

## Full-evaluator oracle

The test retains the exact pre-change map/add Dual expressions and substitutes both into the complete evaluator. The prior depletion oracle remains independently exercised. Each oracle compares 10,800 seeded bias points and 2,754,000 residual/charge/noise values and derivatives. Both polarities, -40/27/125 C, 9/11 dimensions, default/substrate-rich models, independent random biases, forward/reverse/zero/signed zero, depletion boundaries and 2.5 V high-injection biases are included.

Worst absolute and relative errors: zero for both oracles. Relative tolerance 1e-12, absolute floor 1e-42; both sides must be finite. This performance change has no RED correctness claim.

## All six balanced pairs

Fresh `spice-heavy node benchmarks/performance/dff-1310.mjs 1` process for each entry. Alternating AB/BA, no warmup, no discarded runs. Restore saved matching base/head core dist trees before each process. Unchanged full 10 ns deck. Node v22.23.1 on the shared Mac. Host load is uncontrolled; slow runs are retained and the magnitude needs independent replication.

| Pair | Order | Base s | Head s |
| --- | --- | ---: | ---: |
| 0 | base, head | 17.319900375 | 16.260154334 |
| 1 | head, base | 15.909531042 | 15.801471584 |
| 2 | base, head | 16.665618875 | 15.952420833 |
| 3 | head, base | 24.676463292 | 17.328863125 |
| 4 | base, head | 44.382541875 | 21.347230584 |
| 5 | head, base | 24.307345042 | 23.552517167 |
| Median | | 20.813622709 | 16.794508730 |

Median change -19.310016%, zero pairwise losses. Meets the predeclared >=3% median improvement and <=2 losses. This does not establish superiority to ngspice or eliminate the remaining gap. Do not tune or discard runs to make independent review pass.

## Identity and verification

All twelve balanced runs and all three profile runs have waveform SHA256 361251b58101652f07fbdc64abdfb3ec8c8a941f92618420b32a2abc2a9a43f7, 40545 rows, 31 DC Newton, 85851 transient Newton, 40544 accepted, zero rejected/retries. Fixture SHA256 d811ecfa0f370d281fb35729ca3177e738fe034621d9b2909765d9d70f527cc6. No changed accuracy requiring a new ngspice comparison. Existing ngspice losses remain unchanged.

- Frozen install, base/head build and lint: passed.
- `pnpm -C packages/core exec vitest run src/devices/vbic src/mna`: 333 passed, 24 files.
- Default stamp hash remains bd942ae769ac72c14e81f01dc017fcc2eb2405613f1d1865dbccf12d42c06eea.
- `spice-heavy pnpm test`: started; final status in PR/card.
- Exact-head CI and independent review remain required. Author does not merge.

Timing arrays and profile counts are in round-12-perf.json. Raw logs and CPU profiles remain in scratch, not committed.
