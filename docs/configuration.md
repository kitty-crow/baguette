# Configuration

Baguette reads JSON from `baguette.config.json` by default. Use
`--config PATH` to select another file.

Important fields include:

- `project`: the TypeScript project file;
- `entries`: one or more entry modules;
- `generatedDir`: generated TypeScript and intermediate output;
- `outDir`: final WebAssembly and manifest output;
- `moduleBaseName`: the default module name;
- `typeAliases` and `abiTypes`: source and host ABI mappings;
- `abi.exports`: exported functions to retain;
- `memory`: initial, maximum, imported and exported memory settings;
- `variants`: output names, threading mode and optional preludes;
- `allowedHostImports`: the imports permitted in the final module;
- `asyncLowering`: the asynchronous lowering strategy.

`baguette.config.example.json` shows the complete configuration
accepted by the current release.
