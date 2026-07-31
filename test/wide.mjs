#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bake = path.join(root, "vendor/bake");
const fix = path.join(root, "test/fixtures/protected-core");
const src = path.join(fix, "build/baguette-bake/src/input.ts");
const wasm = path.join(fix, "dist/protected-core.wasm");
const rows = [];

function run(bin, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve()
      : reject(new Error(`${bin} exited with status ${code ?? -1}`)));
  });
}

function pass(name, detail) {
  rows.push({ name, detail });
}

function imports(mod) {
  const out = {};
  for (const item of WebAssembly.Module.imports(mod)) {
    const ns = out[item.module] ??= {};
    if (item.kind === "function") ns[item.name] = item.name === "abort"
      ? (() => { throw new Error("fixture aborted"); })
      : (() => 0);
    else if (item.kind === "memory") ns[item.name] = new WebAssembly.Memory({ initial: 1024, maximum: 32768 });
    else if (item.kind === "global") ns[item.name] = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
    else if (item.kind === "table") ns[item.name] = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  }
  return out;
}

await run("npm", ["run", "build"], bake);
await run(process.execPath, [
  path.join(root, "node_modules/typescript/bin/tsc"),
  "-p",
  path.join(bake, "tsconfig.test.json")
]);
await run(process.execPath, ["--test", path.join(bake, "dist-test/test/wide.test.js")]);
pass("Bake wide pass", "safe rejects the fixture; wide lowers guards, private fields, optional access, exceptions, for-of, destructuring and nullish logic");

await run("bun", [
  path.join(root, "src/compiler.ts"),
  "--config",
  path.join(fix, "baguette.config.json"),
  "--skip-determinism-check"
]);
pass("Baguette compile", "the synthetic wide fixture compiled to native WebAssembly");

const text = await fs.readFile(src, "utf8");
for (const [name, re] of [
  ["unknown type", /:\s*unknown\b/],
  ["type predicate", /\bis\s+Reader\b/],
  ["private identifier", /#value\b/],
  ["try statement", /\btry\b/],
  ["throw statement", /\bthrow\b/]
]) assert.doesNotMatch(text, re, `${name} survived wide lowering`);
assert.match(text, /__bake_p_/, "private-member lowering marker is missing");
assert.match(text, /__bake_err_/, "exception lowering marker is missing");
pass("Lowered source", "unsupported application syntax was removed before Baguette validation");

const bytes = await fs.readFile(wasm);
assert.equal(WebAssembly.validate(bytes), true, "wide fixture output is not valid WebAssembly");
const mod = new WebAssembly.Module(bytes);
const inst = await WebAssembly.instantiate(mod, imports(mod));
const score = inst.exports.score;
assert.equal(typeof score, "function", "score export is missing");
assert.equal(score(4), 14);
assert.equal(score(-2), 4);
pass("Wasm ABI", "score(4) = 14 and score(-2) = 4");

console.log("\nWide lowering results");
for (const row of rows) console.log(`PASS  ${row.name.padEnd(18)} ${row.detail}`);
console.log(`PASS  Wasm output        ${path.relative(root, wasm)} (${bytes.byteLength} bytes)`);
