---
"@spice-ts/core": minor
---

Allow each transient simulation to supply a sparse solver factory for DC initialization, convergence recovery, transient steps and resets. Export the SparseSolver type for custom backends and propagate factory failures without falling back to the default solver.
