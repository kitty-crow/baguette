# Compiler pipeline

Baguette builds a TypeScript programme in five stages.

1. The TypeScript project and configured entry modules are loaded.
2. Reachable modules are checked against the supported language
   subset and configured ABI types.
3. Types, control flow and asynchronous functions are lowered to the
   compiler's WebAssembly model.
4. The selected prelude and memory settings are applied to each
   configured variant.
5. WebAssembly, declarations and the build manifest are written to
   the configured output directories.

Unless `--skip-determinism-check` is supplied, the compiler repeats
the generation pass and compares the result. Different bytes from
the same input are treated as a build failure.
