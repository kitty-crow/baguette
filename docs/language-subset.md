# Supported TypeScript

Baguette accepts the TypeScript constructs implemented by its
validator and lowering passes. It is not a general replacement for
the TypeScript compiler.

A programme must have statically discoverable modules and types. The
compiler rejects unsupported syntax, unresolved dynamic behaviour
and host imports that are absent from `allowedHostImports`.

Type aliases used at the binary interface must have an entry in the
configuration. Exported functions are checked against the configured
ABI before the module is emitted.

Run `--validate-only` when adopting new source constructs. Validation
errors include the source location and should be fixed in the source
rather than bypassed in generated output.
