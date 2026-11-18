# Compiler configuration contracts

`BaguetteVariant` describes one output variant. `BaguetteConfig` describes the source project, ABI, memory, variants and compiler options. `JsonValue` and `JsonObject` represent JSON data. `parseJsonObject` verifies the root; `parseConfig` validates recognised properties, including nested ABI and variant declarations, before passing them to the compiler.
