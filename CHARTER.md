# spice-ts Program Charter

Owner: Mattia Fiumara (@mfiumara). Operated by the Hermes `spice-ts-*` agent hierarchy on Kanban board `spice-ts`.
Started: 2026-10-09. Runs continuously until the owner stops it.

## Goal

Make spice-ts the default SPICE simulator for AI-native engineering companies: a TypeScript/WASM-embeddable
simulator that matches ngspice on correctness for the circuits people actually simulate, beats it on
embeddability, determinism and developer/agent ergonomics, and proves every claim with reproducible public
benchmarks.

## Priorities (owner decision 2026-10-09, do not reopen)

1. **Correctness parity** with ngspice on a public, reproducible benchmark suite (DC/OP, DC sweep, AC, TRAN,
   nonlinear devices, convergence-hard circuits). Fix every known simulator bug first (e.g. #43 boost collapse,
   #44 CS-amp AC gain, #48 Chua).
2. **Speed**: sparse LU, matrix reuse, allocation-free stamping, large-circuit scaling, WASM where it helps.
3. **AI-native API**: MCP server / tool-calling interface, JSON netlists (circuit-json interop, #35),
   LLM-actionable structured errors, deterministic results, streaming.
4. Device-model coverage follows from the benchmark gaps (Gummel-Poon #5, BSIM4 #3, EKV #4, T-lines #7, ...).

## Benchmark policy

- Collect circuits from public sources (ngspice examples/regression tests, SPICE3/CircuitSim90/ISCAS-style
  suites, textbook circuits, LTspice/eecircuit examples, vendor app notes) with recorded licence and URL in
  `benchmarks/SOURCES.md`. Do not commit material whose licence forbids redistribution; store a fetch script instead.
- Compare against ngspice (and eecircuit-engine where relevant) using the same netlists. Record versions,
  machine, command, waveform error metrics (max/RMS relative error at matched timepoints), runtime, and
  convergence failures.
- Publish losses as honestly as wins. Never cherry-pick, tune tolerances per-circuit to hide errors, or claim
  "better than ngspice" for a category without benchmark evidence. Unsupported features are reported as such.

## Team and authority

- `spice-ts-supervisor`: decomposes work into small cards, runs the parallelization checkpoint every
  reconciliation, owns GitHub roadmap/issues/milestones/project board, routes review, merges accepted PRs.
  Never writes code.
- `spice-ts-engineer`: one card, one isolated worktree, TDD, opens a PR from its branch, reports PR URL + head SHA.
- `spice-ts-review`: independent review of the exact PR head SHA; reruns build/lint/tests/benchmarks; accepts or
  rejects with evidence. Never reviews its own work.
- Up to 10 concurrent worker lanes, only when genuinely independent (separate worktrees, no shared-file conflicts).

## Publication boundary

Allowed: GitHub issues, labels, milestones, Projects board, branches, PRs on `spicets/spice-ts`; squash-merge a PR
only when (a) CI is green on the exact head SHA and (b) `spice-ts-review` accepted that same SHA.

Not allowed without Mattia: npm publish, git tags/releases, changeset version bumps that publish, production hosting (spicets.com on Cloudflare Pages)
deploy changes, force-push to main, deleting branches/issues not created by the program, spending money, touching
secrets, editing `~/repos/spicets/web` (cardamom), posting on social media.

## Engineering rules

- Feature work uses `/poteto-mode`, not GSD. Tests first for bug fixes (RED reproduction, then GREEN).
- Every PR: `pnpm build && pnpm lint && pnpm test` green; benchmark-affecting PRs attach before/after numbers.
- Keep `main` releasable. Small PRs; one concern per PR.
- Background-only on the Mac: no foreground apps, window switching or focus stealing; headless browsers only.
- Never read or print secrets.

## Milestones (GitHub milestones use these exact names)

| Milestone | Exit criteria |
|-----------|---------------|
| M1 Correctness parity | All open simulator bugs fixed; ≥100 public benchmark circuits run against ngspice in CI-able harness; published parity report; agreed error thresholds met or gaps filed |
| M2 Performance | Sparse/reuse solver path; scaling benchmark to ≥10k nodes; published runtime comparison vs ngspice |
| M3 AI-native API | MCP server package, JSON netlist schema, structured errors, docs + examples for agent use |
| M4 Device models | Gummel-Poon, BSIM4 (or documented subset), EKV, T-line, driven by benchmark gaps |
