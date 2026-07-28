# Baguette

**BAGUETTE** means **Baguette Ahead-of-time Generates Universal Executables, Targeting Teto Efficiently**.

Baguette is an ahead-of-time compiler from TypeScript to WebAssembly. Bake is its canonical source frontend: every compilation first validates the configured programme and safely lowers compatible TypeScript into Baguette's deterministic subset. Baguette then remains the final authority for subset validation, lowering and WebAssembly generation.

```text
TypeScript
    -> Bake validation and safe source lowering
    -> Baguette-compatible TypeScript
    -> Baguette AOT compilation
    -> WebAssembly
```

## Requirements

- Bun 1.1 or later, or Node.js 22.6 or later with TypeScript stripping enabled;
- TypeScript;
- AssemblyScript and Binaryen, as pinned by `package.json`;
- a recursive Git checkout so the pinned Bake and KITTYX submodules are present.

## Use

    git submodule update --init --recursive
    npm install
    bun src/compiler.ts --config baguette.config.json

Validate without writing the final WebAssembly modules:

    bun src/compiler.ts --config baguette.config.json --validate-only

Skip the second deterministic-build pass during local development:

    bun src/compiler.ts --config baguette.config.json --skip-determinism-check

`BAGUETTE_BAKE_ENGINE` may select Bake's `auto`, `host` or `wasm` core. `auto` is the default. Baguette builds the pinned Bake CLI locally when its generated JavaScript is absent.

Copy `baguette.config.example.json` as a starting point for a target configuration.

## Documentation

- [Compiler pipeline](docs/compiler.md)
- [Configuration](docs/configuration.md)
- [Supported TypeScript](docs/language-subset.md)

## Licence

MIT. See `LICENSE`.
