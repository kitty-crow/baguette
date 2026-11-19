# Baguette

**BAGUETTE**: Baguette Ahead-of-time Generates Universal Executables,
Targeting Teto Efficiently.

Baguette compiles a statically supported TypeScript subset to WebAssembly.
It uses Bake for source validation and lowering, then applies its own subset
and ABI validation before code generation.

## Requirements

- Bun 1.1 or later;
- TypeScript, AssemblyScript and Binaryen as declared in `package.json`;
- the pinned Bake and KITTYX dependencies.

## Use

```sh
git submodule update --init --recursive
bun install
cp baguette.config.example.json baguette.config.json
bun src/compiler.ts --config baguette.config.json
```

Edit the configuration to identify the input project, entry points, memory
settings and exported ABI. The example is a starting point, not a complete
configuration for arbitrary input.

`--validate-only` checks the input without writing final WebAssembly.
`--skip-determinism-check` omits the repeated generation pass for local
iteration. Bake runs directly from its pinned TypeScript source under Bun.

## Validation

The three CI jobs validate the transpiler, generate modular WAT and reference WASM from a standalone fixture, and independently reconstruct and assemble the generated WAT. Consumer projects validate their own kernel builds.

## Documentation

[Compiler module reference](docs/index.md). Run `bun run guards` for strict source, test and documentation checks.

- [Compiler pipeline](docs/compiler.md)
- [Configuration](docs/configuration.md)
- [Supported TypeScript](docs/language-subset.md)

## Licence

[MIT](LICENSE).
