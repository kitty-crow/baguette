import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCanonicalThistleSource } from "../source-contract.js";

const sha = "f851ea0c70a6be819be70aa0112ca1f84d67d873";
const valid = {
  canonicalSource: "Thistle",
  canonicalRevision: sha,
  productionKernel: "Thistle",
  completeKernel: true,
  entries: ["src/core/kernel.ts", "src/teto/abi.ts"],
  memory: { initialPages: 8192, maximumPages: 32768 },
} as const;

test("canonical Thistle build accepts one authoritative kernel", () => {
  assert.doesNotThrow(() => assertCanonicalThistleSource(valid));
  assert.doesNotThrow(() => assertCanonicalThistleSource({
    ...valid, entries: ["/tmp/build/thistle-source/build/baguette-bake/src/core/kernel.ts"],
  }));
});

test("canonical Thistle build rejects an independent Teto executor", () => {
  assert.throws(() => assertCanonicalThistleSource({ ...valid, entries: ["src/teto/kernel.ts"] }),
    /src\/core\/kernel/);
  assert.throws(() => assertCanonicalThistleSource({
    ...valid, entries: ["src/core/kernel.ts", "src/teto/kernel.ts"],
  }), /must not compile/);
});

test("canonical Thistle build refuses spoofed provenance or incomplete ABI", () => {
  assert.throws(() => assertCanonicalThistleSource({ ...valid, canonicalRevision: "" }), /immutable/);
  assert.throws(() => assertCanonicalThistleSource({ ...valid, completeKernel: false }), /partial/);
  assert.throws(() => assertCanonicalThistleSource({ ...valid, productionKernel: "Teto" }), /alternative/);
  assert.throws(() => assertCanonicalThistleSource({ ...valid, memory: { initialPages: 0, maximumPages: 32768 } }), /memory/);
});

test("other Baguette programmes are not subjected to Teto-specific rules", () => {
  assert.doesNotThrow(() => assertCanonicalThistleSource({ entries: ["src/another-app.ts"] }));
});
