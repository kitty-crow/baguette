# Compiler pipeline

1. Resolve the configured TypeScript project, entry modules and intrinsics.
2. Invoke the pinned Bake frontend to validate and lower the source.
3. Validate the emitted source against Baguette's supported subset and ABI.
4. Lower types, control flow and supported asynchronous operations to the
   WebAssembly model.
5. Apply memory settings and variant-specific preludes.
6. Write WebAssembly, declarations and the build manifest.

Bake runs at compile time. Its intermediate source and report are written
under `build/baguette-bake/`. Final output paths follow the configuration.

By default, the compiler repeats generation and compares the resulting bytes.
`--skip-determinism-check` disables that comparison.

## Modular WAT output

`--emit-modular-wat` emits a source tree for each configured variant.
Its directory structure follows the lowered input modules.

`module.wat` contains module-wide declarations. `runtime.wat`
contains compiler helpers without an input-module owner.
`layout.json` records declaration order for assembly.

Type-only and fully inlined modules may contain no standalone
declarations. Binary output remains available for reference
validation.

## Independent validation

The CI fixture exercises both baseline and threaded output. Generated modular WAT is reconstructed, compared against the complete backend WAT and independently assembled. Both resulting binaries must implement the fixture's exported arithmetic contract.
