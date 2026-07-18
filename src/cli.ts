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
interface WrapperProcess {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  execPath: string;
  exit(code?: number): never;
}
const processHost = (globalThis as unknown as { process: WrapperProcess }).process;
const argv = new Set(processHost.argv.slice(2));
const testCli = argv.has("--test-cli");
const testWeb = argv.has("--test-web");
const validateOnly = argv.has("--validate-only");
const alternateConfig = processHost.argv.slice(2).some(value => value === "--config" || value.startsWith("--config="));
const nativeBun = (globalThis as unknown as { Bun?: {
  spawnSync(command: string[], options: { cwd: string; env: Record<string, string | undefined>; stdout: "inherit"; stderr: "inherit" }): { exitCode: number };
  file(path: string): { exists(): Promise<boolean> };
} }).Bun;
const childProcess = await import("node:child_process" as string) as unknown as { spawnSync(executable: string, args: string[], options: { cwd: string; env: Record<string, string | undefined>; stdio: "inherit" }): { status: number | null } };
const fs = await import("node:fs/promises" as string) as unknown as { access(path: string): Promise<void> };

const run = (command: string[], label: string): void => {
  const exitCode = nativeBun
    ? nativeBun.spawnSync(command, { cwd: processHost.cwd(), env: processHost.env, stdout: "inherit", stderr: "inherit" }).exitCode
    : (childProcess.spawnSync(command[0]!, command.slice(1), { cwd: processHost.cwd(), env: processHost.env, stdio: "inherit" }).status ?? 1);
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}`);
};
const exists = async (path: string): Promise<boolean> => {
  if (nativeBun) return nativeBun.file(path).exists();
  try { await fs.access(path); return true; } catch { return false; }
};

if (testCli || testWeb) {
  console.log("Baguette: building the Thistle host and static browser assets first");
  run(["npm", "run", "build:thistle"], "Thistle host build");
}

const urlHost = await import("node:url" as string) as unknown as {
  fileURLToPath(url: URL): string;
};
const compilerPath = urlHost.fileURLToPath(new URL("./compiler.ts", import.meta.url));
const compilerCommand = nativeBun
  ? [processHost.execPath, "run", compilerPath, ...processHost.argv.slice(2)]
  : [processHost.execPath, "--experimental-strip-types", compilerPath, ...processHost.argv.slice(2)];
run(compilerCommand, "Baguette compiler");

if (validateOnly) processHost.exit(0);

const webBuildExists = await exists("dist/web/index.html");
const webPreparerExists = await exists("build/tool/teto-web.js");
if (!alternateConfig && webBuildExists && webPreparerExists) {
  run(["node", "build/tool/teto-web.js"], "Teto web preparation");
} else if (alternateConfig) {
  console.log("Baguette: alternate compiler configuration completed");
} else {
  console.log("Baguette: Teto generated; run --test-web to build and prepare the static browser test");
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
