import { required } from "../required.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { modularWat } from "../wat-modules.ts";
const source = [
  "(module",
  " (type $0 (func))",
  ' (import "env" "memory" (memory 1))',
  " (func $build/target/__bq_12345678_local (nop))",
  " ;; comment with a closing parenthesis )",
  ' (data (i32.const 0) "a)(\\22")',
  " (func $build/target/run (call $build/target/__bq_12345678_local))",
  " (func $~lib/helper (; nested (; comment ;) ;) (nop))",
  ' (export "run" (func $build/target/run))',
  ")",
  "",
].join("\n");
const modules = [
  { source: "core/local.ts", file: "core/local.wat", symbolPrefix: "__bq_12345678_", exports: [] },
  { source: "main.ts", file: "main.wat", symbolPrefix: "__bq_87654321_", exports: ["run"] },
  { source: "types.ts", file: "types.wat", symbolPrefix: "__bq_00000000_", exports: [] },
];
test("preserves source ownership and reconstructs the backend module exactly", () => {
  const { files, layout } = modularWat(source, modules);
  assert.match(required(files.get("core/local.wat") ?? null, "files.get(\"core/local.wat\")"), /__bq_12345678_local/);
  assert.match(required(files.get("main.wat") ?? null, "files.get(\"main.wat\")"), /\(func \$build\/target\/run/);
  assert.match(required(files.get("runtime.wat") ?? null, "files.get(\"runtime.wat\")"), /\$~lib\/helper/);
  assert.match(required(files.get("module.wat") ?? null, "files.get(\"module.wat\")"), /\(data/);
  assert.equal(required(layout.modules[2] ?? null, "layout.modules[2]").fields, 0);
  assert.equal(layout.prefix + layout.order.map(([file, offset, length]) => required(files.get(file) ?? null, "files.get(file)").slice(offset, offset + length)).join("") + layout.suffix, source);
});
test("rejects unknown ownership, unsafe paths and malformed modules", () => {
  assert.throws(() => modularWat(source, modules.slice(1)), /Unknown compiler symbol owner/);
  assert.throws(() => modularWat(source, [{...required(modules[0] ?? null, "modules[0]"), file: "../escape.wat"}]), /Unsafe WAT module path/);
  assert.throws(() => modularWat("(module (func", modules), /Unterminated/);
});
