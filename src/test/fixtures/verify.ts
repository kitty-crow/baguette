import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Check both the reference and independently assembled fixture binaries. */
async function verify(file: string, threaded: boolean): Promise<void> {
  const bytes = Uint8Array.from(await readFile(file));
  assert.ok(WebAssembly.validate(bytes));
  const module = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048, shared: threaded });
  const instance = new WebAssembly.Instance(module, { env: { memory } });
  const add = instance.exports.add ?? null;
  if (typeof add !== "function") throw new Error("Missing fixture arithmetic export");
  // The fixture declares this numeric ABI; the export kind is checked above.
  const arithmetic = add as (left: number, right: number) => number;
  assert.equal(arithmetic(20, 22), 42);
  assert.equal(arithmetic(-3, 1.5), -1.5);
}

for (const variant of ["fixture", "fixture-threads"]) {
  const threaded = variant.endsWith("-threads");
  await verify(`build/ci-wasm/${variant}.wasm`, threaded);
  await verify(`build/ci-wasm/${variant}.linked.wasm`, threaded);
}
