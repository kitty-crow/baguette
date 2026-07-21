# Baguette

**BAGUETTE** means **Baguette Ahead-of-time Generates Universal Executables, Targeting Teto Efficiently**.

Baguette is an ahead-of-time compiler from a restricted TypeScript
programme to WebAssembly.

The compiler reads a TypeScript project and one or more configured
entry modules, validates the supported language subset, lowers the
programme and emits one or more WebAssembly variants. It also writes
generated TypeScript declarations and a build manifest describing
the result.

## Requirements

- Bun 1.1 or later;
- TypeScript;
- AssemblyScript and Binaryen, as pinned by `package.json`.

## Use

    npm install
    bun src/compiler.ts --config baguette.config.json

Validate without writing the final WebAssembly modules:

    bun src/compiler.ts --config baguette.config.json --validate-only

Skip the second deterministic-build pass during local development:

    bun src/compiler.ts --config baguette.config.json --skip-determinism-check

Copy `baguette.config.example.json` as a starting point for a target
configuration.

## Documentation

- [Compiler pipeline](docs/compiler.md)
- [Configuration](docs/configuration.md)
- [Supported TypeScript](docs/language-subset.md)

## Licence

MIT. See `LICENSE`.
