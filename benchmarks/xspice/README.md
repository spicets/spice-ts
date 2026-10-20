# XSPICE analog code models (issue #487, slice 1)

## xfer frequency-table model (#1539)

`xfer` accepts a frequency/magnitude/phase `table` or a Touchstone `file`,
`span`/`offset`, and `r_i`/`db`/`rad` format flags. AC interpolates real and
imaginary components linearly and clamps beyond the endpoints. DC and transient
use the first real table value times the input, with no PARTIAL (as upstream);
this is not a transient convolution model. There are no gain/in_offset parameters.
Files use the existing `resolveInclude` callback in async parsing/simulation;
the core never opens host files. Missing files warn and produce zero, matching
ngspice's uninitialized-model behavior. Invalid table/file contents fail closed.
For ngspice-47 parity, frequency values are interpreted as Hz even when the
Touchstone option line says MHz/GHz: upstream computes but never applies `mult`.

Reproduce numerical microdeck comparisons (identical bytes, default solver
tolerances, 31 frequencies per case):
`spice-heavy pnpm exec tsx benchmarks/xspice/xfer-compare.ts`.
The four cases cover dB/degrees, strided RI, linear magnitude/radians, and file
input. This is correctness evidence, not a speed comparison.

The unchanged corpus-f `examples/rf/sp/file.cir` still does not run: before this
slice it rejected `xfer`; afterwards it rejects the independent `.control
pre_snp` command at line 42. ngspice-47 reports success but the existing corpus-f
path exports no vectors: 0 compared analyses/signals, error metric null, still
`spice-ts-loss`. It also lacks the referenced `137MHz_BPF.s2p` companion.
No successful full-fixture simulation or numerical parity is claimed.
Run `spice-heavy pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts
--corpus-f-fixture-child examples-rf-sp-file-cir` after building to reproduce.

The remainder below is the historical initial slice, not the current complete
list of supported models.

spice-ts now parses XSPICE `A` cards and the `.model` cards of eight ngspice-47
analog code models: `gain`, `summer`, `mult`, `divide`, `pwl`, `limit`, `int`
and `d_dt`. Every other ngspice code model (`adc_bridge`, `d_*`, `s_xfer`,
`hyst`, `sine`, ...) is rejected while parsing its `.model` card, with the typed
`UnsupportedCodeModelError` (`code: 'UNSUPPORTED_XSPICE_CODE_MODEL'`, a
`ParseError`). Such a card is never stored, so no instance can simulate
without its code model. `A` cards inside `.subckt` bodies still raise the
existing `ParseError: Unsupported device card: 'A'`.

## What is ported from ngspice-47

- **A-card grammar.** Follows `MIF_INP2A` / `MIFget_port`. Supported: `%v`,
  `%vd`, `%i`, `%id` and `%vnam` ports, `[ ]` vector connections and `null`.
  Connections are resolved at compile time against the model's port table, so
  the `.model` card can come after the instance. `%g`, `%gd`, `%h`, `%hd`,
  `%d` and `~` raise a typed `InvalidCircuitError`.
- **`.model` values.** Follows `MIFgetMod` / `MIFgetValue` / `MIFmParam`:
  - Values are typed by the code model's parameter table: `[ ]` vectors and
    `t/true/f/false/0/1` booleans.
  - Unknown parameters are ignored with ngspice's `MIF: unrecognized parameter`
    warning.
  - Out-of-range values are clamped with a warning.
  - A parameter with no default must be given.
  - A vector parameter tied to a connection must match its port count.
- **Matrix load.** Follows `MIFload`:
  - A voltage output is an ideal voltage source (`<name>#branch_<conn>_<port>`).
    A current output is a current source.
  - A current input is a zero-volt sensing source (`<name>#ibranch_<conn>_<port>`).
  - Each `PARTIAL` is stamped as the matching VCVS/VCCS/CCVS/CCCS linearisation.
  - Between Newton iterations the inputs are limited by the default
    `conv_limit`: max(25 % of the last input, 0.1). A limited iteration cannot
    converge (`CKTnoncon`).
- **Code models.** Each `cfunc.mod` is transcribed line by line:
  - `pwl` includes its iteration limiter (`limit_x_value`, FRACTION 0.3) and its
    end-point extrapolation.
  - `divide` and `limit` include the `cm_smooth_corner` smoothing.
  - `int` uses `cm_analog_integrate`. Under TRAP this is `y(n+1) = y(n) + h·x(n+1)`
    at both orders, because ngspice's order-2 branch halves `ag[0]`. GEAR uses
    the BDF coefficients. Its `MIFtrunc` timestep bound is ported too. As in
    ngspice, its `PARTIAL` is `h` without the gain factor.
  - `d_dt` is a backward difference over the accepted input. Its
    `cm_analog_integrate` call passes a stack variable, which ngspice rejects,
    so it never limits the timestep.
- **AC.** `AC_GAIN` equals the operating-point `PARTIAL` for the static models.
  - `d_dt` adds `j·ω·gain`.
  - For `int`, the output equation is scaled by `j·ω`, giving `gain/(j·ω)`.
- **trtol.** `cktdojob.c` reduces `trtol` to 1 whenever an `A` device is
  present (unless `trtol <= 1`). spice-ts applies the same rule at compile time.
- **Typed rejections**, instead of a silently wrong result:
  - `.disto` with any `A` device.
  - `int` with `.tf`, `.pz` or `.sens`.
  - `int` with a current output in `.ac` or `.noise`.
  - `gain` with nonzero `noise_voltage` or `noise_current` in `.noise`.

## Evidence: corpus-f, identical bytes against ngspice-47

Fixtures are byte-identical ngspice decks at `3ef069fb` (BSD-3-Clause) from
corpus-f batch 1 (#484, PR #529, branch `wt/corpus-f-batch1-484` @
`5014ae0b`). They are run unchanged through the corpus-f harness:
`ngspice -b -r` against spice-ts `simulate()` in a bounded child process.
"matched" means every common signal satisfies
max|spice-ts − ngspice| ≤ 1 % of the peak |ngspice| value. No fixture was
edited and no tolerance was changed.

The set is the 65 decks in the `device: XSPICE A-element code models` bucket,
plus 2 decks from other buckets that use one of the eight models
(`examples/noise/baker-252-gain.cir` and
`examples/xspice/various/analog_models1_transient.sp`): 67 in total.
ngspice-47 runs 55 of them.

| | before (`origin/main` 2a8112c + #529 harness) | after (this branch on 2a8112c + #529 harness) |
|---|---|---|
| spice-ts success / failed / unsupported | 0 / 0 / 67 | 13 / 4 / 50 |
| matched | 0 | 11 |
| mismatch | 0 | 1 |
| not-compared | 0 | 1 |
| spice-ts-loss | 55 | 42 |
| both-failed | 12 | 12 |

Decks that now simulate (worst = largest normalised error over all signals). Measured on this branch rebased onto `origin/main` 2a8112c; the first measurement on fbbbe85 gave the same outcome for every deck, with worst errors differing only in the fourth digit.

| Fixture | ngspice | Outcome | Worst | Worst signal | spice-ts points | ngspice points |
|---|---|---|---|---|---|---|
| `examples/xspice/original-examples/analog_models1_ac.deck` | success | unsupported → matched | 2.49e-16 | ac i(v1) | ac:21 | ac:21 |
| `examples/xspice/original-examples/analog_models1_dc.deck` | success | unsupported → matched | 7.01e-15 | op v(50) | op:1 | op:1 |
| `examples/xspice/original-examples/analog_models1_swept_dc.deck` | success | unsupported → matched | 1.0e-4 | dc v(30) | dc:100 | dc:100 |
| `examples/xspice/original-examples/bad_param.deck` | success | unsupported → matched | 4.90e-4 | tran v(2) | tran:138 | tran:108 |
| `examples/xspice/original-examples/dot_model_ref.deck` | success | unsupported → matched | 4.93e-4 | tran v(1) | tran:374 | tran:108 |
| `examples/xspice/original-examples/io_ordering.deck` | success | unsupported → matched | 4.90e-4 | tran v(2) | tran:138 | tran:108 |
| `examples/xspice/original-examples/long_names.deck` | success | unsupported → matched | 1.96e-3 | tran i(v1_…_1234) | tran:266 | tran:108 |
| `examples/xspice/original-examples/mixed_case.deck` | success | unsupported → matched | 4.90e-4 | tran v(2) | tran:138 | tran:108 |
| `examples/xspice/original-examples/parsing.deck` | success | unsupported → matched | 4.90e-4 | tran v(2) | tran:138 | tran:108 |
| `examples/xspice/original-examples/polarity.deck` | success | unsupported → matched | 4.90e-4 | tran i(v1) | tran:142 | tran:108 |
| `examples/xspice/various/xspice_c2.cir` | success | unsupported → matched | 4.92e-4 | tran v(1) | tran:271 | tran:214 |
| **LOSS** `examples/xspice/original-examples/analog_models1_transient.deck` | success | unsupported → **mismatch** | **0.122** | tran v(40) | tran:232 | tran:108 |
| `examples/xspice/various/analog_models1_transient.sp` | success | unsupported → not-compared | — | — | tran:232 | — (`.control` deck, ngspice `-r` exports nothing, #528) |

### Losses and open scope

- **`analog_models1_transient.deck`, v(40): 12.2 % under the harness metric.**
  - v(40) is `divide` of 2 V by a 0–10 V ramp. With `den_lower_limit=0.1` the
    output is 20 V up to t = 0.1 s and 2/t after that.
  - Each engine's samples are exact at its own timepoints: ngspice gives 15.625
    at t = 0.128, which is 2/0.128.
  - ngspice steps from 0.064 s straight to 0.128 s. The harness interpolates
    ngspice linearly at spice-ts's 0.1 s point, giving 17.54 V against the
    exact 20 V.
  - This is an artefact of ngspice's coarse grid at the limiter corner, not a
    difference in the divide model. It is still published as a mismatch: the
    metric is not tuned per circuit.
- **Timepoint counts.** spice-ts takes 1.3–3.5× more transient points than
  ngspice on these resistive decks (for example 374 against 108 on
  `dot_model_ref.deck`). ngspice bounds these steps only by TMAX. spice-ts's
  node-voltage LTE check runs with trtol = 1 because of the XSPICE rule. This
  is a speed loss, not an accuracy loss.
- **Still unsupported: 42 decks that ngspice runs.** They need code models
  outside this slice or control-language commands. Ranked by deck count of the
  models still missing:
  - 10: `adc_bridge`
  - 7: `d_nand`
  - 5: `s_xfer`
  - 4 each:
    - `d_inverter`, `core`, `lcouple`
    - `climit`, `cmeter`, `hyst`, `ilimit`, `lmeter`
    - `aswitch`, `oneshot`, `sine`, `triangle`, `zener`
    - `dac_bridge`, `d_to_real`, `real_gain`, `real_to_v`
  - 3: `d_cosim`
  - 2 each: `d_osc`, `d_dff`, `real_delay`, `mlin`, `astate`
  - 1 each: `d_buffer`, `d_tristate`, `d_lut`, `delay`, `ota`, `square`,
    `d_and`, `d_pwm`, `seegen`, `cpline`, `pwlts`

  Separately, `resdiv_gain.cir`, `noise_gain.cir`, `baker-252-gain.cir` and
  `integrate1.cir` stop on `.control` commands (`noise`, `set`, `let`), not on
  a code model.

## Unit tests against ngspice-47

`packages/core/src/devices/xspice/xspice.test.ts` pins:

- The `analog_models1_dc` operating point, including branch currents.
- `limit` in its linear, smoothing and hard-limited regions.
- `%i`, `%vd` and `%vnam` ports.
- A 25-point swept DC of `pwl` (`limit=true`) and `limit`.
- AC gains of `int`, `d_dt`, `mult`, `divide` and a differential `int` input.
- `int`, `d_dt` and `pwl` transients at 12 `meas` points (within 0.1 %), and
  `int` under `.options method=gear` at 6 points (within 0.01 %).
- The parser and compile-time typed errors.

Every reference value was produced by ngspice-47 on the same cards (with
`.control` print/meas).

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @spice-ts/core exec vitest run src/devices/xspice/xspice.test.ts
# corpus-f rows (needs the #529 harness and fixtures, e.g. this branch merged onto wt/corpus-f-batch1-484):
pnpm exec tsx benchmarks/corpus/corpus-f/outcomes.ts --corpus-f-fixture-child examples-xspice-original-examples-analog-models1-dc-deck
```

Machine: macOS 27.0.1 arm64 (Apple M5 Pro), Node v22.23.1, ngspice-47 (Homebrew, KLU).

## Simple diode (#1563)

Run `spice-heavy pnpm exec tsx benchmarks/xspice/sidiode-compare.ts`.
The original MIT decks `sidiode.cir` and `sidiode-ac.cir` go unchanged to both
engines. Three current traces cover unlimited, smoothed-unlimited and
smoothed-limited models over a -8 to 8 V DC sweep and two sine periods.
Six AC bias points cover reverse limiting, reverse smoothing, off, forward
smoothing and forward limiting. The script prints deck SHA-256, versions,
sample counts, errors and one-shot DC/transient runtimes. It fails above 1e-6
peak-normalized error; this is a parity check, not a speed claim.

The implementation follows ngspice-47 `xtradev/sidiode/cfunc.mod:127-239`.
Its tanh partial is intentionally not the derivative of its output current.
With smoothing enabled but current limits disabled, the outer linear formulas
have current discontinuities at the quadratic boundaries, also retained here.
