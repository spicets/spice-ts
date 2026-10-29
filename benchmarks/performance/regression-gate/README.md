# Paired performance gate

The PR workflow checks out the event base and head commits separately, builds both, and runs the same generated RC ladder decks on one runner. It alternates base/candidate order over five rounds and rotates case order. The 1,000-node case is the existing `rc-ladder-tran-1000` fixture; 10 and 100 use the same generator. The candidate's generator supplies the exact same bytes to both engines.

Each cold sample measures a fresh Node process including startup, module import, parsing, simulation, and output hashing. Each warm sample measures a second parse and simulation in a fresh process after one untimed run with the module already imported. Output hashing is outside the warm timer. This is a same-engine regression check, not an ngspice comparison or a 0.3.x performance claim.

The worker checks every transient time, voltage and current value is finite and hashes all vector names, lengths and IEEE-754 values. Every sample and both revisions must match exactly. Equal hashes mean matched-point max and RMS errors are both zero; no tolerance is applied. Metadata, sample counts, timing validity and deck hashes must also match. A median exceeding 110% of base fails. CI uploads raw samples, decks, SHA metadata, medians and errors even when the comparison fails.

Run locally after building core at each revision:

```sh
node --test benchmarks/performance/regression-gate/gate.test.mjs
spice-heavy node benchmarks/performance/regression-gate/run.mjs /path/to/base /path/to/head /path/to/output
node benchmarks/performance/regression-gate/compare.mjs /path/to/output/base.json /path/to/output/candidate.json
```

Shared runner noise can produce both wins and losses or fail an unchanged build. Investigate failed samples; never discard or selectively publish them. This workflow does not change required branch-protection checks.
