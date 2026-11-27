# Differential ideal-diode noise, #2212

These original project-authored regression decks are MIT-licensed. They are not
copied from ngspice. The exact UTF-8 bytes below include the final LF. Change
only `outp,outn` to `outn,outp` or `outp,0` for the other two decks. The test
contains the same template and ngspice-47 vectors.

```spice
* MIT original differential diode noise #2212
V1 in 0 DC 1 AC 1
R1 in outp 1k
R2 outn 0 1k
D1 outp outn DMOD
.model DMOD D(IS=1e-14 N=1 KF=1e-10 AF=1)
.noise v(outp,outn) V1 dec 3 100 10k
.end
```

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `outp,outn` | 193 | `af7403a45b6e408d0af26123931e28e5d6fc78bec5848656d796ca47c11faa0d` |
| `outn,outp` | 193 | `ad45f0d3ecb6ba2fa6a2cf3bad78bdced30a3c073159d4d4a01b25ca7f15ff23` |
| `outp,0` | 190 | `d2a98062596534d60cdbcfcced8bf8b0db280aa7b648ad54b8d0fb43a7ca706c` |

Measured on Darwin arm64 with Node v22.23.4, pnpm 10.28.1, ngspice-47
(Homebrew, KLU-capable build; log selected SPARSE 1.3), and this PR's spice-ts
source. Both simulators consume the same circuit bytes. For ngspice only, the
commands below add a `.control` block to a temporary copy to print noise plots;
no circuit or analysis line changes. Seven frequencies, 100 Hz to 10 kHz, match
in each case. Before this change all three were rejected by spice-ts with
`.noise differential voltage output only supports resistor noise`; no numeric
before spectrum exists. No speed comparison was performed.

Reproduce from the repository root with ngspice-47 installed. This extracts the
literal deck from the test rather than retyping it. Temporary files stay in
`$TMPDIR`.

```sh
mkdir -p "$TMPDIR/diode2212"
python3 - <<'PY'
from pathlib import Path
import os
s = Path('packages/core/src/analysis/noise-diode-differential.test.ts').read_text()
template = s.split('const deck = (output: string) => `', 1)[1].split('`;', 1)[0]
p = Path(os.environ['TMPDIR']) / 'diode2212'
for name, output in [('diff', 'outp,outn'), ('swap', 'outn,outp'), ('ground', 'outp,0')]:
    deck = template.replace('${output}', output)
    (p / f'{name}.cir').write_text(deck)
    control = '.control\nset numdgt=15\nrun\nsetplot noise1\nprint all\nsetplot noise2\nprint all\n.endc\n.end\n'
    (p / f'{name}-ng.cir').write_text(deck.replace('.end\n', control))
PY
shasum -a 256 "$TMPDIR"/diode2212/{diff,swap,ground}.cir
spice-heavy sh -c 'for n in diff swap ground; do ngspice -b -n "$TMPDIR/diode2212/$n-ng.cir" > "$TMPDIR/diode2212/$n-ng.log" 2>&1 || exit; done'
pnpm -C packages/core exec vitest run src/analysis/noise-diode-differential.test.ts
```

`noise1` prints frequency, input and output density, `noise2` the input and
output integrated RMS. The test asserts every density and both totals against
these measured vectors. For exact spice-ts values independently of Vitest,
run once per name (`diff`, `swap`, `ground`):

```sh
DECK="$TMPDIR/diode2212/diff.cir" pnpm exec tsx -e 'import {readFileSync} from "node:fs"; import {simulate} from "./packages/core/src/index.ts"; simulate(readFileSync(process.env.DECK!,"utf8")).then(r=>console.log(JSON.stringify(r.noise)))'
```

## Errors and losses

Absolute errors are V/sqrt(Hz) for output density and input-referred units per
sqrt(Hz) for input density. Relative errors are pointwise absolute error divided
by the ngspice value. RMS means root mean square across the seven points.
Normalized is max absolute error divided by max(reference peak, 1e-12), the
shared corpus noise-signal rule. All are below the uniform 1% threshold; the
smaller nonzero errors below are losses and are not rounded to zero.

| Output | Signal | max abs | RMS abs | max rel | RMS rel | normalized |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| diff and swap | output | 4.052491141e-12 | 2.087589263e-12 | 2.326044727e-6 | 2.326037012e-6 | 2.326034330e-6 |
| diff and swap | input | 7.400586383e-11 | 3.812317045e-11 | 2.658911272e-6 | 2.658908591e-6 | 2.658911272e-6 |
| ground | output | 2.026232852e-12 | 1.043769948e-12 | 2.326007027e-6 | 2.325313208e-6 | 2.326007027e-6 |
| ground | input | 3.332266599e-12 | 1.716536907e-12 | 2.032354294e-6 | 2.031660500e-6 | 2.032354294e-6 |

Integrated RMS comparisons (scalar max and RMS errors are identical):

| Output | Signal | ngspice | spice-ts | absolute error | relative error |
| --- | --- | ---: | ---: | ---: | ---: |
| diff and swap | output | 3.738784321513111e-5 | 3.738775624964377e-5 | 8.696548734e-11 | 2.326036483e-6 |
| diff and swap | input | 5.972920660243001e-4 | 5.972936541696218e-4 | 1.588145322e-9 | 2.658909120e-6 |
| ground | output | 1.869611608321786e-5 | 1.869607260634094e-5 | 4.347687692e-11 | 2.325449667e-6 |
| ground | input | 3.518952353591076e-5 | 3.518945203794477e-5 | 7.149796599e-11 | 2.031796933e-6 |

Swapping output terminals gives exactly equal spice-ts density arrays and RMS
values. With both resistors noiseless and KF=0, the independently solved diode
shot-noise transfer predicts 9.862251702771897e-10 V/sqrt(Hz), while spice-ts
returns 9.862228476888805e-10 V/sqrt(Hz). The tests also check explicit ground versus single-ended, zero output
for equal nodes, an independently solved shot-noise transfer, and rejection of
RS > 0, current outputs and invalid input sources. Existing non-diode
semiconductor differential rejection tests remain. This receipt does not claim
parity for other circuits, device models, or source restrictions.
