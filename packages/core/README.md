# @spice-ts/core

[![npm](https://img.shields.io/npm/v/@spice-ts/core)](https://www.npmjs.com/package/@spice-ts/core)
[![CI](https://github.com/spicets/spice-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/spicets/spice-ts/actions/workflows/ci.yml)

TypeScript-native SPICE circuit simulator. Parse netlists and run DC, transient, and AC analysis directly in Node.js or the browser with the built-in solver, or swap to an optional ngspice WASM backend.

```ts
import { simulate } from '@spice-ts/core';

const result = await simulate(`
  V1 1 0 DC 5
  R1 1 2 1k
  R2 2 0 1k
  .op
  .end
`);

console.log(result.dc?.voltage('2')); // 2.5
```

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
- **Device models** — R, C, L, V, I, Diode (Shockley), BJT (Ebers-Moll NPN/PNP), MOSFET (Level 1 Shichman-Hodges NMOS/PMOS), BSIM3v3 (LEVEL=49)
- **Passive parasitics** — capacitor ESR/ESL/leakage and inductor DCR/core-loss/winding-capacitance expansion for AC and transient analysis
- **Controlled sources** — VCVS (E), VCCS (G), CCVS (H), CCCS (F) with DC, AC, and subcircuit support
- **Sparse solver** — Gilbert-Peierls LU with symbolic/numeric split, typed-array stamping, batch MOSFET evaluation. Competitive with ngspice-WASM on DC, AC, and nonlinear circuits
- **Complex AC solver** — native complex sparse LU (no 2n×2n real expansion)
- **Subcircuits** — `.subckt`/`.ends` definitions with `X` device instantiation, nested expansion, parameterized subcircuits
- **Library support** — `.include` file resolution, `.lib`/`.endl` section selection (process corners), `.param` expressions with SI suffixes
- **Async parsing** — `parseAsync()` with platform-agnostic `IncludeResolver` callback for loading external files
- **Streaming API** — `simulateStream()` yields results as an `AsyncIterableIterator`
- **Swappable simulator backend** — use the default TypeScript solver or select optional `ngspice-wasm` via `simulate(..., { simulator })`
- **Programmatic API** — build circuits in code with `Circuit`, or parse SPICE netlists with `parse()`
- **Typed errors** — `ConvergenceError`, `SingularMatrixError`, `ParseError`, `CycleError`, and more

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

### Passive parasitics

Capacitor and inductor instances can carry model or instance parameters. The native solver expands these into equivalent primitive networks before AC and transient analysis.

```spice
.model CLOSS C(CAP=1u ESR=250m ESL=10n RLEAK=1meg)
C1 in 0 CLOSS

.model LLOSS L(IND=10u RSER=400m RPAR=2k CPAR=3p)
L1 out 0 LLOSS
```

Capacitors support `CAP`, geometry/temperature parameters, `ESR`/`RSER`/`RS`, `ESL`/`LSER`/`LS`, `RLEAK`/`RPAR`, and loss-derived `DF` or `Q` with `FREQ`. Inductors support `IND`/`L`, geometry/temperature parameters, `RSER`/`DCR`/`RDC`, `RPAR`, `CPAR`, `Q` with `FREQ`, and `SRF`-derived parallel capacitance.

### Swappable backend

The TypeScript solver is used by default. To run through ngspice compiled to WASM, install `eecircuit-engine` and pass `simulator: 'ngspice-wasm'`:

```ts
const result = await simulate(`
  V1 1 0 DC 5
  R1 1 2 1k
  R2 2 0 2k
  .op
`, { simulator: 'ngspice-wasm' });
```

Custom adapters can also be passed via `simulator` when they implement `simulate(input, options)`.

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

const freq = result.ac!.frequencies;        // Float64Array
const mag  = result.ac!.magnitude('out');   // Float64Array
const phase = result.ac!.phase('out');      // Float64Array (degrees)
```

### Includes and libraries

```ts
import { parseAsync, simulate } from '@spice-ts/core';
import { readFile } from 'fs/promises';

const ckt = await parseAsync(netlist, async (path) => readFile(path, 'utf-8'));
const result = await simulate(ckt);
```

The resolver is platform-agnostic — use `fetch()` in the browser, `readFile()` in Node, or return bundled strings for static assets.

## API

| Export | Signature |
|---|---|
| `simulate` | `(input: string \| Circuit, options?: SimulationOptions) => Promise<SimulationResult>` |
| `simulateStream` | `(input, options?) => AsyncIterableIterator<TransientStep \| ACPoint>` |
| `createTransientSim` | `(input, options?) => Promise<TransientSim>` |
| `parse` | `(netlist: string) => Circuit` |
| `parseAsync` | `(netlist: string, resolver?: IncludeResolver) => Promise<Circuit>` |
| `Circuit` | Programmatic circuit builder |

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
| `resolveInclude` | — | Async callback for `.include`/`.lib` |

All public exports have TSDoc comments for IDE hover-docs.

### Convergence telemetry

Native `simulate()` results expose an optional `convergence` object. External
simulator adapters may omit it. `TransientSim.convergence` returns an immutable
snapshot for resumable/streaming runs, and terminal `ConvergenceError` instances
carry the last snapshot when one is available.

`convergence.dc` reports total Newton iterations, accepted/rejected solves,
source-step attempts/failures, GMIN-step attempts/failures, and a terminal
failure classification. `convergence.transient` reports accepted/rejected
timesteps, total Newton iterations, NR/LTE retries, the minimum accepted
timestep, and a terminal failure classification. Counters are observational;
enabling the API does not change tolerances or convergence decisions.

## Visualizing results

Pair with [`@spice-ts/ui`](https://www.npmjs.com/package/@spice-ts/ui) for React waveform viewers, Bode plots, and schematic rendering.

## License

MIT · See the [spice-ts monorepo](https://github.com/spicets/spice-ts) for benchmarks, roadmap, and contributing guide.
