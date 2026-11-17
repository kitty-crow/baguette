# Compiler pipeline

Baguette builds a TypeScript programme in six stages.

1. The configured TypeScript project, entry modules and intrinsic modules are isolated into the compilation boundary.
2. The pinned Bake frontend validates that boundary and safely lowers supported wider TypeScript constructs into Baguette's deterministic subset.
3. Baguette loads Bake's emitted source tree and remains the final validator for the supported language subset and configured ABI types.
4. Types, control flow and asynchronous functions are lowered to Baguette's WebAssembly model.
5. The selected prelude and memory settings are applied to each configured variant.
6. WebAssembly, declarations and the build manifest are written to the configured output directories.

Bake is a compile-time source dependency only. It does not add a runtime, interpreter or virtual machine to generated programmes. The original output paths in `baguette.config.json` remain authoritative; Bake's intermediate source and report are written below `build/baguette-bake/`.

Unless `--skip-determinism-check` is supplied, Baguette repeats the generation pass and compares the result. Different bytes from the same input are treated as a build failure.

## Modular WAT output

`--emit-modular-wat` also emits a source tree for each variant under the generated directory. The directory structure follows the lowered input modules. Baguette uses its symbol ownership and ABI mapping to assign declarations to their original source modules. Module-wide declarations are in `module.wat`; compiler and runtime helpers without an input owner are in `runtime.wat`. `layout.json` records declaration order, allowing the consumer to assemble the exact original module. Type-only and fully inlined modules have no standalone declarations. The existing binary output remains available for compatibility and reference validation.
