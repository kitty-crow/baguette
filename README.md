# Baguette

**BAGUETTE**: Baguette Ahead-of-time Generates Universal Executables,
Targeting Teto Efficiently.

Baguette compiles a statically supported TypeScript subset to WebAssembly.
It uses Bake for source validation and lowering, then applies its own subset
and ABI validation before code generation.

## Requirements

- Bun 1.1 or later, or Node.js 22.6 or later with TypeScript stripping;
- TypeScript, AssemblyScript and Binaryen as declared in `package.json`;
- the pinned Bake and KITTYX dependencies.

## Use

```sh
git submodule update --init --recursive
npm install
cp baguette.config.example.json baguette.config.json
bun src/compiler.ts --config baguette.config.json
```

Edit the configuration to identify the input project, entry points, memory
settings and exported ABI. The example is a starting point, not a complete
configuration for arbitrary input.

`--validate-only` checks the input without writing final WebAssembly.
`--skip-determinism-check` omits the repeated generation pass for local
iteration. `BAGUETTE_BAKE_ENGINE=auto|host|wasm` selects Bake's policy engine.

## Documentation

- [Compiler pipeline](docs/compiler.md)
- [Configuration](docs/configuration.md)
- [Supported TypeScript](docs/language-subset.md)

## Licence

[MIT](LICENSE).
