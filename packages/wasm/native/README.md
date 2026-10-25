# Dense numeric WebAssembly artifact

`dense-solver.wasm` is the checked-in numeric kernel used by the bounded `spice-ts-wasm` backend. Package builds copy and hash this artifact. They do not require a native compiler and do not regenerate it implicitly.

The artifact was built with Homebrew LLVM/LLD 23.1.3. Run this from `packages/wasm`; the explicit
`llvm-objcopy` step removes LLVM's non-semantic `producers` custom section so the command reproduces the
checked artifact bytes:

    PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH" \
      clang --target=wasm32 -Oz -nostdlib -fno-builtin \
      -Wl,--no-entry \
      -Wl,--export=stamp_vccs_f64 \
      -Wl,--export=stamp_cccs_f64 \
      -Wl,--export=stamp_vcvs_f64 \
      -Wl,--export=stamp_ccvs_f64 \
      -Wl,--export=solve_f64 \
      -Wl,--export=solve_dc_f64 \
      -Wl,--export=solve_complex_f64 \
      -Wl,--export=abi_version \
      -Wl,--export=max_order \
      -Wl,--export=__heap_base \
      -Wl,--export-memory \
      -Wl,--initial-memory=196608 \
      -Wl,--max-memory=196608 \
      -Wl,--strip-all \
      -o native/dense-solver.unstripped.wasm native/dense-solver.c
    PATH="/opt/homebrew/opt/llvm/bin:$PATH" \
      llvm-objcopy --remove-section=producers \
      native/dense-solver.unstripped.wasm native/dense-solver.wasm
    rm native/dense-solver.unstripped.wasm
    chmod 0644 native/dense-solver.wasm
    test "$(wc -c < native/dense-solver.wasm | tr -d ' ')" = 5034
    printf '%s  %s\n' \
      4a81c732f02085d1c7697cf50d38431b96506ba3e18961ce542bea47aa8610a6 \
      native/dense-solver.wasm | shasum -a 256 -c -

Expected artifact:

- byte length: 5034
- SHA-256: `4a81c732f02085d1c7697cf50d38431b96506ba3e18961ce542bea47aa8610a6`
- imports: none
- memory: fixed at 3 WebAssembly pages (196608 bytes)
- ABI version: 2
- maximum order: 64

ABI v2 exposes `stamp_vccs_f64(order, matrix, outP, outN, ctrlP, ctrlN, gm)` for bounded linear VCCS stamps,
`stamp_cccs_f64(order, matrix, outP, outN, controlBranchColumn, gain)` for bounded linear CCCS stamps,
`stamp_vcvs_f64(order, matrix, outP, outN, ctrlP, ctrlN, branchColumn, gain)` for bounded linear VCVS stamps,
`stamp_ccvs_f64(order, matrix, outP, outN, controlBranchColumn, branchColumn, transresistance)` for bounded linear CCVS stamps,
`solve_f64(order, matrix, rhs)` for real systems,
`solve_dc_f64(order, matrix, rhs)` for singleton-first nonlinear OP/DC systems, and
`solve_complex_f64(order, matrixReal, matrixImaginary, rhsReal, rhsImaginary)` for split-complex systems.
The entry points mutate their row-major matrices and right-hand sides in place. Status 0 means success, 1 means
singular, 2 means non-finite input/intermediate/output, and 3 means invalid arguments.

The kernels perform deterministic dense f64 Gaussian elimination with partial pivoting. The additive ABI-v2
`solve_dc_f64` entry point selects structural column singletons before partial pivoting and uses column-oriented
back substitution to preserve leakage-current precision. Nonlinear OP/DC uses this ordering regardless of
temperature or numeric tolerances. Transient and AC bias retain `solve_f64`'s original row-oriented substitution:
changing their rounding also changes adaptive transient step decisions. Neither path calls a host solver.
Equal pivot magnitudes
retain the lowest row index. The complex kernel uses scaled division and a `max(abs(real), abs(imaginary))` pivot
score. It has no WASI, filesystem, network, clock, randomness, shared memory, threads, SIMD, or memory growth.
