# AST construction

The native syntax builders construct TypeScript AST nodes from grammar templates and substitute the original typed children. This preserves absent syntax without passing untyped values to positional factory arguments. Original bindings and bodies retain their identity.

- `nativeParameter`, `nativeVariable` and `nativeProperty` construct typed frame declarations.
- `NativeCallableParts`, `nativeCallable`, `nativeFunction` and `nativeMethod` construct callable declarations.
- `annotateBinding` and `annotateCallable` retain the original source metadata when adding materialised types.
