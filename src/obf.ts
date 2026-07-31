import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export type ObfLevel = "minimal" | "balanced" | "hell";
type WasmBytes = Uint8Array<ArrayBuffer>;

export interface ObfConfig {
  pre?: boolean | ObfLevel;
  post?: boolean | ObfLevel;
  seed?: number | string;
  preCommand?: string[];
  wasmTools?: string;
  wasmOpt?: string;
}

export interface ObfPlan {
  readonly pre: ObfLevel | undefined;
  readonly post: ObfLevel | undefined;
  readonly seed: number;
  readonly preCommand: readonly string[] | undefined;
  readonly wasmTools: string;
  readonly wasmOpt: string;
}

interface WasmShape {
  readonly imports: readonly string[];
  readonly exports: readonly string[];
}

interface ObfFile {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly bytes: number;
}

function value(args: readonly string[], name: string): string | undefined {
  const direct = args.find(item => item.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const next = args[index + 1];
  return next && !next.startsWith("-") ? next : "balanced";
}

function level(raw: unknown, name: string): ObfLevel | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true || raw === "") return "balanced";
  if (raw === "minimal" || raw === "balanced" || raw === "hell") return raw;
  throw new Error(`${name} must be minimal, balanced or hell`);
}

function seed(raw: number | string | undefined): number {
  if (raw === undefined) return 0x42414755;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error("obfuscation seed must be a safe integer");
  return parsed >>> 0;
}

export function obfPlan(args: readonly string[], config: ObfConfig | undefined): ObfPlan {
  const preArg = value(args, "--obfuscate-pre");
  const postArg = value(args, "--obfuscate-post");
  const seedArg = value(args, "--obfuscate-seed");
  return {
    pre: level(preArg ?? config?.pre, "pre obfuscation"),
    post: level(postArg ?? config?.post, "post obfuscation"),
    seed: seed(seedArg ?? config?.seed),
    preCommand: config?.preCommand,
    wasmTools: config?.wasmTools ?? process.env.BAGUETTE_WASM_TOOLS ?? "wasm-tools",
    wasmOpt: config?.wasmOpt ?? process.env.BAGUETTE_WASM_OPT ?? "wasm-opt"
  };
}

async function run(command: readonly string[], label: string): Promise<void> {
  const executable = command[0];
  if (!executable) throw new Error(`${label} has no executable`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, command.slice(1), { stdio: "inherit", env: process.env });
    child.once("error", error => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${label} exited with status ${code ?? -1}`)));
  });
}

function expand(command: readonly string[], dir: string, plan: ObfPlan): string[] {
  return command.map(part => part
    .replaceAll("{dir}", dir)
    .replaceAll("{level}", plan.pre ?? "minimal")
    .replaceAll("{seed}", String(plan.seed)));
}

export async function obfPre(input: string, output: string, plan: ObfPlan): Promise<string> {
  if (!plan.pre) return input;
  if (!plan.preCommand?.length) {
    throw new Error("pre obfuscation needs obfuscation.preCommand; the command must preserve Baguette-compatible TypeScript");
  }
  await fs.rm(output, { recursive: true, force: true });
  await fs.cp(input, output, { recursive: true });
  await run(expand(plan.preCommand, output, plan), "pre obfuscator");
  return output;
}

async function bytes(file: string): Promise<WasmBytes> {
  const data = await fs.readFile(file);
  const output = new Uint8Array(data.byteLength);
  output.set(data);
  return output;
}

async function sha(data: WasmBytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

function shape(data: WasmBytes): WasmShape {
  const module = new WebAssembly.Module(data);
  const imports = WebAssembly.Module.imports(module).map(item => `${item.kind}:${item.module}:${item.name}`).sort();
  const exports = WebAssembly.Module.exports(module).map(item => `${item.kind}:${item.name}`).sort();
  return { imports, exports };
}

function same(left: WasmShape, right: WasmShape): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function files(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && file.endsWith(".wasm")) output.push(file);
    }
  };
  try { await walk(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return output.sort();
}

function rounds(level: ObfLevel): number {
  if (level === "minimal") return 0;
  if (level === "balanced") return 4;
  return 16;
}

async function postFile(file: string, level: ObfLevel, plan: ObfPlan, index: number): Promise<ObfFile> {
  const original = await bytes(file);
  const before = await sha(original);
  const abi = shape(original);
  let current = file;
  const temps: string[] = [];
  try {
    for (let round = 0; round < rounds(level); round++) {
      const next = `${file}.mut-${round}`;
      temps.push(next);
      await run([
        plan.wasmTools,
        "mutate",
        current,
        "-o",
        next,
        "--preserve-semantics",
        "--seed",
        String((plan.seed + index * 257 + round) >>> 0)
      ], "wasm-tools mutate");
      current = next;
    }
    const stripped = `${file}.strip`;
    temps.push(stripped);
    await run([plan.wasmOpt, current, "-o", stripped, "--strip-debug", "--strip-producers"], "wasm-opt strip");
    const final = await bytes(stripped);
    if (!WebAssembly.validate(final)) throw new Error(`${file} is invalid after post obfuscation`);
    const nextAbi = shape(final);
    if (!same(abi, nextAbi)) throw new Error(`${file} changed its public WebAssembly ABI during post obfuscation`);
    await fs.rm(file, { force: true });
    await fs.rename(stripped, file);
    return { file, before, after: await sha(final), bytes: final.byteLength };
  } finally {
    for (const temp of temps) if (temp !== file) await fs.rm(temp, { force: true });
  }
}

export async function obfPost(root: string, plan: ObfPlan): Promise<void> {
  if (!plan.post) return;
  const list = await files(root);
  if (!list.length) throw new Error(`post obfuscation found no WebAssembly modules in ${root}`);
  const output: ObfFile[] = [];
  for (let index = 0; index < list.length; index++) output.push(await postFile(list[index]!, plan.post, plan, index));
  await fs.writeFile(path.join(root, "baguette-obfuscation.json"), `${JSON.stringify({
    schema: 1,
    pre: plan.pre ?? null,
    post: plan.post,
    seed: plan.seed,
    files: output.map(item => ({ ...item, file: path.relative(root, item.file).split(path.sep).join("/") }))
  }, null, 2)}\n`);
}
