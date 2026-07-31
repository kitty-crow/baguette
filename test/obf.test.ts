import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { obfPlan, obfPost, obfPre } from "../src/obf.ts";

async function tool(root: string, name: string, body: string): Promise<string> {
  const file = path.join(root, name);
  await fs.writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}

test("parses independent pre and post levels", () => {
  const plan = obfPlan([
    "--obfuscate-pre=minimal",
    "--obfuscate-post=hell",
    "--obfuscate-seed=17"
  ], undefined);
  assert.equal(plan.pre, "minimal");
  assert.equal(plan.post, "hell");
  assert.equal(plan.seed, 17);
});

test("runs the pre adapter on an isolated source copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bq-pre-"));
  try {
    const input = path.join(root, "in");
    const output = path.join(root, "out");
    await fs.mkdir(input);
    await fs.writeFile(path.join(input, "core.ts"), "export const value: number = 7;\n");
    const adapter = await tool(root, "pre.sh", "printf '%s:%s' \"$2\" \"$3\" > \"$1/pre.marker\"");
    const plan = obfPlan([], { pre: "balanced", seed: 29, preCommand: [adapter, "{dir}", "{level}", "{seed}"] });
    const selected = await obfPre(input, output, plan);
    assert.equal(selected, output);
    assert.equal(await fs.readFile(path.join(output, "pre.marker"), "utf8"), "balanced:29");
    assert.equal(await fs.readFile(path.join(input, "core.ts"), "utf8"), "export const value: number = 7;\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("post processing preserves the Wasm ABI and records final hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bq-post-"));
  try {
    const wasmTools = await tool(root, "wasm-tools.sh", "cp \"$2\" \"$4\"");
    const wasmOpt = await tool(root, "wasm-opt.sh", "cp \"$1\" \"$3\"");
    const file = path.join(root, "core.wasm");
    await fs.writeFile(file, Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    const plan = obfPlan([], { post: "balanced", seed: 41, wasmTools, wasmOpt });
    await obfPost(root, plan);
    assert.equal(WebAssembly.validate(await fs.readFile(file)), true);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "baguette-obfuscation.json"), "utf8")) as {
      post: string;
      files: Array<{ before: string; after: string; file: string }>;
    };
    assert.equal(manifest.post, "balanced");
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0]?.file, "core.wasm");
    assert.equal(manifest.files[0]?.before, manifest.files[0]?.after);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
