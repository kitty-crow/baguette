import processHost from "node:process";
import * as childProcess from "node:child_process";
import { pathExists } from "./host.ts";
import * as urlHost from "node:url";
import { required } from "./required.ts";
/**
 * Baguette 0.2.6
 *
 * Portable build entry point for generating native WebAssembly from the
 * authoritative Thistle TypeScript kernel source.
 *
 * Usage:
 *   bun baguette.ts
 *   node --experimental-strip-types baguette.ts
 */

export {};
const argv = new Set(processHost.argv.slice(2));
const testCli = argv.has("--test-cli");
const testWeb = argv.has("--test-web");
const validateOnly = argv.has("--validate-only");
const alternateConfig = processHost.argv.slice(2).some(value => value === "--config" || value.startsWith("--config="));
const nativeBun = Boolean(processHost.versions.bun);

const run = (command: string[], label: string): void => {
  const exitCode = childProcess.spawnSync(required(command[0], "command executable"), command.slice(1), { cwd: processHost.cwd(), env: processHost.env, stdio: "inherit" }).status ?? 1;
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}`);
};

if (testCli || testWeb) {
  console.log("Baguette: building the Thistle host and static browser assets first");
  run(["npm", "run", "build:thistle"], "Thistle host build");
}

const compilerPath = urlHost.fileURLToPath(new URL("./compiler.ts", import.meta.url));
const compilerCommand = nativeBun
  ? [processHost.execPath, "run", compilerPath, ...processHost.argv.slice(2)]
  : [processHost.execPath, "--experimental-strip-types", compilerPath, ...processHost.argv.slice(2)];
run(compilerCommand, "Baguette compiler");

if (validateOnly) processHost.exit(0);

const webBuildExists = await pathExists("dist/web/index.html");
const webPreparerExists = await pathExists("build/tool/teto-web.js");
if (!alternateConfig && webBuildExists && webPreparerExists) {
  run(["node", "build/tool/teto-web.js"], "Teto web preparation");
} else {
  console.log(alternateConfig ? "Baguette: alternate compiler configuration completed" : "Baguette: Teto generated; run --test-web to build and prepare the static browser test");
}

if (testCli) {
  console.log("Baguette: running direct-source and generated-WASM CLI parity tests");
  run(["node", "build/test/all.js"], "CLI Teto test suite");
  console.log("Baguette CLI test passed");
}

if (testWeb) {
  console.log("Open http://127.0.0.1:3131/teto-test.html");
  console.log("Press Ctrl+C to stop the static preview server");
  const serverCommand = nativeBun ? [processHost.execPath, "run", "build/main/server.js"] : [processHost.execPath, "build/main/server.js"];
  run(serverCommand, "static web preview");
}

if (!testWeb) processHost.exit(0);
