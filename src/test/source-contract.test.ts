import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../contracts.ts";
import { assertCanonicalThistleSource } from "../source-contract.ts";

const sha = "f851ea0c70a6be819be70aa0112ca1f84d67d873";
const valid = parseConfig(JSON.stringify({
  canonicalSource: "Thistle",
  canonicalRevision: sha,
  productionKernel: "Thistle",
  completeKernel: true,
  entries: ["src/native/kernel.ts", "src/native/abi.ts"],
  memory: { initialPages: 8192, maximumPages: 32768 },
}));

test("canonical Thistle build accepts one authoritative kernel", () => {
  assert.doesNotThrow(() => assertCanonicalThistleSource(valid));
  assert.doesNotThrow(() => assertCanonicalThistleSource({
    ...valid, entries: ["/tmp/build/thistle-source/build/baguette-bake/src/native/kernel.ts"],
  }));
});

test("canonical Thistle build rejects an independent Teto executor", () => {
  assert.throws(() => assertCanonicalThistleSource({ ...valid, entries: ["src/teto/kernel.ts"] }),
    /src\/native\/kernel/);
  assert.throws(() => assertCanonicalThistleSource({
    ...valid, entries: ["src/native/kernel.ts", "src/teto/kernel.ts"],
  }), /must not compile/);
});

test("canonical Teto must reject the host-only Thistle adapter", () => {
  assert.throws(() => assertCanonicalThistleSource({
    ...valid, entries: ["src/core/kernel.ts"],
  }), /src\/native\/kernel/);
  assert.throws(() => assertCanonicalThistleSource({
    ...valid, entries: ["src/native/kernel.ts", "src/core/kernel.ts"],
  }), /host-only adapter/);
});

test("canonical Thistle build rejects a hidden transitive Teto kernel", () => {
  assert.throws(() => assertCanonicalThistleSource({
    ...valid,
    canonicalOriginalModules: [
      "/tmp/thistle/src/native/kernel.ts",
      "/tmp/thistle/src/native/abi.ts",
      "/tmp/thistle/src/teto/kernel.ts",
    ],
  }), /transitively imports/);
  assert.doesNotThrow(() => assertCanonicalThistleSource({
    ...valid, canonicalOriginalModules: ["/tmp/thistle/src/native/kernel.ts", "/tmp/thistle/src/fs/vfs.ts"],
  }));
});

test("canonical Thistle build refuses spoofed provenance or incomplete ABI", () => {
  assert.throws(() => assertCanonicalThistleSource({ ...valid, canonicalRevision: "" }), /immutable/);
  assert.throws(() => assertCanonicalThistleSource({ ...valid, completeKernel: false }), /partial/);
  assert.throws(() => assertCanonicalThistleSource({ ...valid, productionKernel: "Teto" }), /alternative/);
  assert.throws(() => assertCanonicalThistleSource({ ...valid, memory: { ...valid.memory, initialPages: 0, maximumPages: 32768 } }), /memory/);
});

test("other Baguette programmes are not subjected to Teto-specific rules", () => {
  assert.doesNotThrow(() => assertCanonicalThistleSource(parseConfig(JSON.stringify({ entries: ["src/another-app.ts"] }))));
});
