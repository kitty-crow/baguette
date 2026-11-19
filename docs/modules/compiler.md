# compiler

The primary compiler entry point reads the configured TypeScript project after Bake lowering, validates the supported subset and exported ABI, generates AssemblyScript, compiles each WebAssembly variant and checks module imports and exports. It writes generated modules and a reproducible manifest.
