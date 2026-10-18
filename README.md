<p align="left">
  <img src="docs/brand/spice-ts-mark-f1.svg" width="56" alt="spice-ts" />
</p>

# spice-ts

**The SPICE simulator built for agents.**

TypeScript-native circuit simulation with an MCP server, JSON in and out, and structured errors a model can act on.
It runs in Node, in the browser or inside an agent sandbox, with no ngspice binary to ship.
Accuracy is checked against ngspice on a public, reproducible benchmark, and every outcome is published, failures included.

[![CI](https://github.com/spicets/spice-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/spicets/spice-ts/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/spicets/spice-ts/graph/badge.svg)](https://codecov.io/gh/spicets/spice-ts)
[![npm @spice-ts/core](https://img.shields.io/npm/v/@spice-ts/core?label=%40spice-ts%2Fcore)](https://www.npmjs.com/package/@spice-ts/core)
[![npm @spice-ts/ui](https://img.shields.io/npm/v/@spice-ts/ui?label=%40spice-ts%2Fui)](https://www.npmjs.com/package/@spice-ts/ui)
[![GitHub stars](https://img.shields.io/github/stars/spicets/spice-ts?style=social)](https://github.com/spicets/spice-ts/stargazers)

**[Live showcase](https://spicets.github.io/spice-ts/)** · **[Parity report](benchmarks/AGGREGATE_PARITY.md)** · **[MCP server](packages/mcp/README.md)**

---

### Give your agent a simulator

`@spice-ts/mcp` is not published to npm yet; run it from a clone of this repo.

```sh
pnpm install && pnpm --filter @spice-ts/mcp... build
```

```jsonc
{
  "mcpServers": {
    "spice": {
      "command": "node",
      "args": ["/absolute/path/to/spice-ts/packages/mcp/dist/stdio.js"]
    }
  }
}
```

The agent gets `spice_validate`, `spice_simulate`, `spice_measure` and a streaming job API.
Bad decks come back as typed diagnostics (`FLOATING_NODE`, `NO_DC_PATH_TO_GROUND`, `VOLTAGE_SOURCE_LOOP`)
with node and element ids, so the model can fix the circuit instead of guessing.

### Or call it from code

```ts
import { simulate } from '@spice-ts/core';

const result = await simulate(`
  V1 1 0 DC 5
  R1 1 2 1k
  R2 2 0 1k
  .op
`);

result.dc?.voltage('2'); // 2.5
```

### Check our work

Same netlist bytes go to spice-ts and ngspice, with no per-circuit tolerance tuning.
The [100-circuit parity report](benchmarks/AGGREGATE_PARITY.md) lists every success, failure and unsupported case,
with SHA-256 receipts so you can reproduce it.

---

## Install

```bash
npm install @spice-ts/core
```

Requires Node.js ≥ 20.

## Features

- **DC operating point** — Newton-Raphson with voltage limiting for convergence
- **DC sweep** — `.dc` transfer curves and I-V characteristics
- **Transient analysis** — backward Euler and trapezoidal integration with adaptive timestep
- **AC small-signal** — frequency sweep (dec/oct/lin) via complex LU solve
- **Device models** — R, C, L, V, I, Diode (Shockley), BJT (Ebers-Moll NPN/PNP), MOSFET (Level 1 Shichman-Hodges NMOS/PMOS), BSIM3v3 (LEVEL=49), VDMOS power MOSFET (ngspice `vdmos` nchan/pchan with body diode)
- **Passive parasitics** — capacitor ESR/ESL/leakage and inductor DCR/core-loss/winding-capacitance expansion for AC and transient analysis
- **Controlled sources** — VCVS (E), VCCS (G), CCVS (H), CCCS (F) with DC, AC, and subcircuit support
- **Sparse solver** — Gilbert-Peierls LU with symbolic/numeric split, typed-array stamping, batch MOSFET evaluation.
- **Complex AC solver** — native complex sparse LU (no 2n×2n real expansion)
- **Subcircuits** — `.subckt`/`.ends` definitions with `X` device instantiation, nested expansion, parameterized subcircuits
- **Library support** — `.include` file resolution, `.lib`/`.endl` section selection (process corners), `.param` expressions with SI suffixes
- **Async parsing** — `parseAsync()` with platform-agnostic `IncludeResolver` callback for loading external files
- **Streaming API** — `simulateStream()` yields results as an `AsyncIterableIterator`
- **Swappable simulator backend** — use the default TypeScript solver or select optional `ngspice-wasm` via `simulate(..., { simulator })`
- **Programmatic API** — build circuits in code with `Circuit`, or parse SPICE netlists with `parse()`
- **Typed errors** — `ConvergenceError`, `SingularMatrixError`, `ParseError`, `CycleError`, and more
- **Full TSDoc** — every public API export has JSDoc comments for IDE hover-docs

## Usage

### Netlist (SPICE format)

```ts
import { simulate } from '@spice-ts/core';

// RC low-pass filter — transient step response
const result = await simulate(`
  V1 in 0 PULSE(0 5 0 1n 1n 500u 1m)
  R1 in out 1k
  C1 out 0 1u
  .tran 10u 5m
  .end
`);

const { time, voltage } = result.transient!;
// time: Float64Array of timepoints
// voltage('out'): Float64Array of node voltages
```

### Programmatic (no netlist)

```ts
import { Circuit, simulate } from '@spice-ts/core';

const ckt = new Circuit();
ckt.addVoltageSource('V1', 'in', '0', { dc: 5 });
ckt.addResistor('R1', 'in', 'out', 1000);
ckt.addResistor('R2', 'out', '0', 1000);
ckt.addAnalysis('op');

const result = await simulate(ckt);
console.log(result.dc?.voltage('out')); // 2.5
```

### Passive Parasitics

Capacitor and inductor instances can carry model or instance parameters. The native solver expands these into equivalent primitive networks before AC and transient analysis.

```spice
.model CLOSS C(CAP=1u ESR=250m ESL=10n RLEAK=1meg)
C1 in 0 CLOSS

.model LLOSS L(IND=10u RSER=400m RPAR=2k CPAR=3p)
L1 out 0 LLOSS
```

Capacitors support `CAP`, geometry/temperature parameters, `ESR`/`RSER`/`RS`, `ESL`/`LSER`/`LS`, `RLEAK`/`RPAR`, and loss-derived `DF` or `Q` with `FREQ`. Inductors support `IND`/`L`, geometry/temperature parameters, `RSER`/`DCR`/`RDC`, `RPAR`, `CPAR`, `Q` with `FREQ`, and `SRF`-derived parallel capacitance.

### Swappable Backend

The TypeScript solver is used by default. To run through ngspice compiled to WASM, install `eecircuit-engine` and pass `simulator: 'ngspice-wasm'`:

```ts
import { simulate } from '@spice-ts/core';

const result = await simulate(`
  V1 1 0 DC 5
  R1 1 2 1k
  R2 2 0 2k
  .op
`, { simulator: 'ngspice-wasm' });
```

You can also pass a custom simulator adapter implementing `simulate(input, options)`.

### Streaming

```ts
import { simulateStream } from '@spice-ts/core';

for await (const step of simulateStream(netlist)) {
  if ('time' in step) {
    console.log(`t=${step.time}  V(out)=${step.voltages.get('out')}`);
  }
}
```

### AC analysis

```ts
const result = await simulate(`
  V1 in 0 AC 1
  R1 in out 1k
  C1 out 0 1u
  .ac dec 10 1 100k
  .end
`);

const freq = result.ac!.frequencies;          // Float64Array
const mag  = result.ac!.magnitude('out');     // Float64Array
const phase = result.ac!.phase('out');        // Float64Array (degrees)
```

## API

### `simulate(input, options?)`

```ts
simulate(input: string | Circuit, options?: SimulationOptions): Promise<SimulationResult>
```

Runs all analyses declared in the netlist/circuit. Returns a `SimulationResult` with `.dc`, `.transient`, and `.ac` fields (populated for each analysis present).

### `simulateStream(input, options?)`

```ts
simulateStream(input: string | Circuit, options?: SimulationOptions): AsyncIterableIterator<TransientStep | ACPoint>
```

Yields each timestep/frequency point as it is computed.

### `parse(netlist)`

```ts
parse(netlist: string): Circuit
```

Parses a SPICE netlist into a `Circuit` object without running any analysis. Throws `ParseError` if the netlist contains `.include` or `.lib` directives — use `parseAsync()` for those.

### `parseAsync(netlist, resolver?)`

```ts
parseAsync(netlist: string, resolver?: IncludeResolver): Promise<Circuit>
```

Async variant of `parse()` that runs the preprocessor first, resolving `.include`, `.lib`/`.endl`, and `.param` directives. The optional `resolver` callback loads external files:

```ts
import { parseAsync } from '@spice-ts/core';
import { readFile } from 'fs/promises';

const ckt = await parseAsync(netlist, async (path) => {
  return readFile(path, 'utf-8');
});
```

The resolver is platform-agnostic — use `fetch()` in the browser, `readFile()` in Node, or return bundled strings for static assets.

### `SimulationOptions`

| Option | Default | Description |
|---|---|---|
| `abstol` | `1e-12` | Absolute current tolerance (A) |
| `vntol` | `1e-6` | Absolute voltage tolerance (V) |
| `reltol` | `1e-3` | Relative tolerance |
| `maxIterations` | `100` | Max Newton-Raphson iterations (DC) |
| `maxTransientIterations` | `100` | Max NR iterations per timestep (ngspice-47 floor) |
| `integrationMethod` | `'trapezoidal'` | `'euler'` or `'trapezoidal'` |
| `simulator` | `'spice-ts'` | Built-in TypeScript solver, `'ngspice-wasm'`, or a custom simulator adapter |
| `resolveInclude` | — | Async callback `(path: string) => Promise<string>` for `.include`/`.lib` |

## Benchmarks

Three-way comparison: **spice-ts** (pure TypeScript) vs **eecircuit** (ngspice compiled to WASM via [EEcircuit-engine](https://github.com/eelab-dev/EEcircuit-engine)) vs **ngspice** (native C). Measured on Apple M4 Pro, Node.js v24. Run `pnpm bench:compare` to reproduce.

### DC Operating Point

spice-ts uses a sparse LU solver (Gilbert-Peierls with symbolic/numeric split) and typed-array direct stamping.

| Circuit | Size | spice-ts | eecircuit (WASM) | ngspice (native) | eecircuit ÷ spice-ts time |
|---|---|---|---|---|---|
| Resistor ladder | 10 | 0.16 ms | 0.9 ms | 0.9 ms | 5.6 |
| Resistor ladder | 100 | 1.2 ms | 1.4 ms | 0.5 ms | 1.2 |
| Resistor ladder | 500 | 2.2 ms | 4.0 ms | 0.7 ms | 1.8 |

### Transient

| Circuit | Size | spice-ts | eecircuit (WASM) | ngspice (native) | eecircuit ÷ spice-ts time |
|---|---|---|---|---|---|
| RC chain | 10 | 5.1 ms | 4.2 ms | 1.6 ms | 0.82 |
| RC chain | 50 | 14.7 ms | 17.1 ms | 4.0 ms | 1.2 |
| RC chain | 100 | 25.9 ms | 21.0 ms | 7.0 ms | 0.81 |
| LC ladder | 10 | 10.7 ms | 10.6 ms | 3.7 ms | 0.99 |
| LC ladder | 50 | 41.6 ms | 35.9 ms | 11.2 ms | 0.86 |

### AC Small-Signal

spice-ts uses a native complex sparse LU solver — no 2n×2n real expansion.

| Circuit | Size | spice-ts | eecircuit (WASM) | ngspice (native) | eecircuit ÷ spice-ts time |
|---|---|---|---|---|---|
| RC chain | 10 | 0.46 ms | 1.4 ms | 0.5 ms | 3.0 |
| RC chain | 50 | 1.7 ms | 4.1 ms | 0.7 ms | 2.4 |
| RC chain | 100 | 3.3 ms | 5.8 ms | 1.1 ms | 1.8 |

### Nonlinear (CMOS / Ring Oscillators)

Batch MOSFET evaluation bypasses polymorphic dispatch — all transistors in a model group are evaluated in one tight loop with direct array writes:

| Circuit | spice-ts | eecircuit (WASM) | ngspice (native) | eecircuit ÷ spice-ts time |
|---|---|---|---|---|
| CMOS inv chain (5 stg) | 13.2 ms | 16.9 ms | 8.5 ms | 1.3 |
| CMOS inv chain (10 stg) | 21.7 ms | 28.4 ms | 13.3 ms | 1.3 |
| Ring oscillator (3 stg) | 25.7 ms | 29.8 ms | 14.5 ms | 1.2 |
| Ring oscillator (5 stg) | 37.6 ms | 40.5 ms | 20.8 ms | 1.1 |
| Ring oscillator (11 stg) | 84.3 ms | 69.8 ms | 37.4 ms | 0.83 |

> These are historical single-machine microbenchmarks against ngspice compiled to WASM (eecircuit), not a speed claim. A ratio >1 means spice-ts took less time on that run; native ngspice took less time than spice-ts on most rows. The [aggregate parity report](benchmarks/AGGREGATE_PARITY.md) makes no runtime claim. The default solver has no native binary, no WASM startup, and no process spawn. The optional ngspice-WASM backend is available when compatibility matters more than startup cost.

### Accuracy

| Test | Metric | spice-ts | Expected | Error |
|---|---|---|---|---|
| RC step response | V(out) at t=τ | 3.151 V | 3.161 V | **0.29%** |
| BJT CE amplifier | V(base) DC bias | 2.048 V | 2.105 V | **2.7%** |
| RLC bandpass | peak frequency | 1585 Hz | 1592 Hz | **0.4%** |
| RC ladder 5-stage | f<sub>-3dB</sub> | 12.76 Hz | 12.73 Hz | **0.23%** |
| RLC resonance (transient) | oscillation frequency | 1579 Hz | 1592 Hz | 0.8%† |

†RLC transient resonance error is due to numerical damping in the trapezoidal integrator with the default timestep. Use a finer timestep or `integrationMethod: 'euler'` to reduce it.

Run `pnpm bench:accuracy` to see the full accuracy report including SPICE3 Quarles reference circuits.

## Limitations

- **Large ring oscillators:** The 11-stage ring oscillator is 1.2x slower than ngspice-WASM. This is near the fundamental TypeScript-vs-compiled-C overhead floor.
- **BSIM3v3 MOSFET:** Supported alongside Level 1 Shichman-Hodges. BSIM4, EKV not yet available.

## Development

```bash
git clone https://github.com/spicets/spice-ts
cd spice-ts
pnpm install
pnpm test              # run all tests
pnpm build             # build @spice-ts/core
pnpm bench             # vitest bench (ops/sec, mean, p99 — no external deps)
pnpm bench:accuracy    # accuracy vs analytical + ngspice diff (requires ngspice)
pnpm bench:compare     # 3-way comparison: spice-ts vs eecircuit (WASM) vs ngspice
```

The `bench` script uses [vitest bench](https://vitest.dev/guide/benchmarking) (backed by tinybench) for statistically sound ops/sec and latency metrics. The `bench:compare` script runs 16 circuits through all three engines and outputs a markdown table. Pass `--json` for machine-readable output or `--no-ngspice` to skip native ngspice.

See [ROADMAP.md](ROADMAP.md) for planned features.

## License

MIT
