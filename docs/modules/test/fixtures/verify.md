# Generated fixture validation

`verify(file, threaded)` loads a native WebAssembly binary with the declared memory import and checks its exported arithmetic behaviour. Both the reference binary and the independently reassembled modular WAT binary are checked for baseline and threaded variants.
