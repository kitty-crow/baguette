# Obfuscation

Baguette exposes two independent opt-in stages:

```text
Bake -> compatible source protector -> Baguette -> Wasm protector
```

Use `--obfuscate-pre[=minimal|balanced|hell]` for the source stage and `--obfuscate-post[=minimal|balanced|hell]` for the Wasm stage. Both are disabled by default. `--obfuscate-seed=<number>` makes a protected build reproducible.

The pre stage runs the configured `obfuscation.preCommand` against an isolated copy of Bake's emitted source. Placeholders are `{dir}`, `{level}` and `{seed}`. The command must preserve Baguette-compatible TypeScript. Ordinary JavaScript obfuscators are not suitable directly because they erase the type information Baguette still needs.

The post stage uses `wasm-tools mutate --preserve-semantics` and `wasm-opt` stripping. Minimal strips metadata, balanced adds four deterministic mutation rounds, and hell adds sixteen. Baguette validates the final module and rejects any transformation that changes its import or export ABI.

The final hashes are recorded in `baguette-obfuscation.json`. The ordinary Baguette manifest remains the record of the compiler output before the optional protection stage.

Configuration:

```json
{
  "bakeLowering": "wide",
  "obfuscation": {
    "pre": "balanced",
    "post": "hell",
    "seed": 20260731,
    "preCommand": ["protect-ts", "--root", "{dir}", "--level", "{level}", "--seed", "{seed}"],
    "wasmTools": "wasm-tools",
    "wasmOpt": "wasm-opt"
  }
}
```
