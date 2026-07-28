import ts from "typescript";

interface HostProcess {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  execPath: string;
}
interface HostFs {
  access(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}
interface HostPath {
  dirname(path: string): string;
  isAbsolute(path: string): boolean;
  join(...parts: string[]): string;
  normalize(path: string): string;
  relative(from: string, to: string): string;
  resolve(...parts: string[]): string;
  sep: string;
}
interface HostUrl { fileURLToPath(url: string): string; }
interface HostChild {
  once(event: "exit", listener: (code: number | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}
interface HostChildProcess {
  spawn(executable: string, args: string[], options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdio: "inherit";
  }): HostChild;
}
interface BaguetteVariant { name: string; threaded?: boolean; preludeFile?: string; }
interface BaguetteConfig {
  project?: string;
  entries: string[];
  generatedDir?: string;
  outDir?: string;
  preludeFile?: string;
  intrinsicModules?: string[];
  variants?: BaguetteVariant[];
  [key: string]: unknown;
}

const processHost = (globalThis as unknown as { process: HostProcess }).process;
const fs = await import("node:fs/promises" as string) as unknown as HostFs;
const pathHost = await import("node:path" as string) as unknown as HostPath;
const urlHost = await import("node:url" as string) as unknown as HostUrl;
const childProcess = await import("node:child_process" as string) as unknown as HostChildProcess;
const root = processHost.cwd();

function optionValue(name: string): string | undefined {
  const direct = processHost.argv.find(value => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = processHost.argv.indexOf(name);
  return index >= 0 ? processHost.argv[index + 1] : undefined;
}

function setConfigArg(value: string): void {
  const directIndex = processHost.argv.findIndex(item => item.startsWith("--config="));
  if (directIndex >= 0) {
    processHost.argv[directIndex] = `--config=${value}`;
    return;
  }
  const index = processHost.argv.indexOf("--config");
  if (index >= 0) {
    processHost.argv[index + 1] = value;
    return;
  }
  processHost.argv.push("--config", value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(pathHost.dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function run(command: string[], cwd: string, label: string): Promise<void> {
  const executable = command[0];
  if (!executable) throw new Error(`${label} has no executable`);
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(executable, command.slice(1), {
      cwd,
      env: processHost.env,
      stdio: "inherit",
    });
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${label} exited with status ${code ?? -1}`)));
    child.once("error", error => reject(new Error(`${label} could not start: ${error.message}`)));
  });
}

function normalise(value: string): string {
  return pathHost.normalize(pathHost.resolve(value));
}

function commonDirectory(files: readonly string[]): string {
  const firstFile = files[0];
  if (!firstFile) return root;
  const parts = files.map(file => normalise(file).split(pathHost.sep));
  const first = parts[0];
  if (!first) return pathHost.dirname(firstFile);
  const shared: string[] = [];
  for (let index = 0; ; index++) {
    const value = first[index];
    if (value === undefined || !parts.every(item => item[index] === value)) break;
    shared.push(value);
  }
  return shared.join(pathHost.sep) || pathHost.dirname(firstFile);
}

function relativeJson(from: string, to: string): string {
  const value = pathHost.relative(from, to).split(pathHost.sep).join("/");
  return value.startsWith(".") ? value : `./${value}`;
}

function parseProject(project: string): ts.Program {
  const config = ts.readConfigFile(project, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, pathHost.dirname(project), {
    noEmit: true,
    incremental: false,
    composite: false,
  }, project);
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

const originalConfigPath = pathHost.resolve(root, optionValue("--config") ?? "baguette.config.json");
const configRoot = pathHost.dirname(originalConfigPath);
const config = await readJson<BaguetteConfig>(originalConfigPath);
if (!Array.isArray(config.entries) || config.entries.length === 0) {
  throw new Error(`${originalConfigPath} must define at least one TypeScript entry module`);
}

const stageRoot = pathHost.resolve(configRoot, "build/baguette-bake");
const inputDir = pathHost.join(stageRoot, "input");
const outputRoot = pathHost.join(stageRoot, "src");
const inputProject = pathHost.join(inputDir, "tsconfig.json");
const reportFile = pathHost.join(stageRoot, "bake-report.json");
await fs.rm(stageRoot, { recursive: true, force: true });
await fs.mkdir(inputDir, { recursive: true });

const projectPath = pathHost.resolve(configRoot, config.project ?? "tsconfig.json");
const inputFiles = [...new Set([...config.entries, ...(config.intrinsicModules ?? [])]
  .map(value => pathHost.resolve(configRoot, value)))];
await writeJson(inputProject, {
  extends: relativeJson(inputDir, projectPath),
  compilerOptions: {
    noEmit: true,
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  },
  files: inputFiles.map(value => relativeJson(inputDir, value)),
  include: [],
  exclude: [],
});

const moduleDir = pathHost.dirname(urlHost.fileURLToPath(import.meta.url));
const bakeRoot = pathHost.resolve(moduleDir, "../vendor/bake");
const bakeProject = pathHost.join(bakeRoot, "tsconfig.json");
const bakeCli = pathHost.join(bakeRoot, "dist/cli.js");
if (!await exists(bakeProject)) {
  throw new Error("Baguette's Bake submodule is missing; run git submodule update --init --recursive");
}
if (!await exists(bakeCli)) {
  const resolver = (import.meta as unknown as { resolve(specifier: string): string }).resolve;
  const typescriptFile = urlHost.fileURLToPath(resolver("typescript"));
  const tscFile = pathHost.join(pathHost.dirname(typescriptFile), "tsc.js");
  await run([processHost.execPath, tscFile, "-p", bakeProject], bakeRoot, "Bake build");
}

await run([
  processHost.execPath,
  bakeCli,
  "--engine", processHost.env.BAGUETTE_BAKE_ENGINE ?? "auto",
  "--project", inputProject,
  "--out-dir", outputRoot,
  "--report", reportFile,
  "--fail-on-warnings",
], root, "Bake");

const program = parseProject(inputProject);
const sources = program.getSourceFiles().filter(source =>
  !source.isDeclarationFile && !source.fileName.includes(`${pathHost.sep}node_modules${pathHost.sep}`)
);
const commonRoot = commonDirectory(sources.map(source => pathHost.dirname(source.fileName)));
const sourceSet = new Set(sources.map(source => normalise(source.fileName)));

function bakedSource(value: string): string {
  const absolute = normalise(pathHost.resolve(configRoot, value));
  if (!sourceSet.has(absolute)) throw new Error(`Bake did not load configured source ${value}`);
  const relative = pathHost.relative(commonRoot, absolute);
  if (relative.startsWith("..") || pathHost.isAbsolute(relative)) {
    throw new Error(`Bake source ${value} is outside the emitted programme root`);
  }
  return pathHost.resolve(outputRoot, relative);
}

const finalProject = pathHost.join(outputRoot, "tsconfig.json");
await writeJson(finalProject, {
  extends: relativeJson(outputRoot, projectPath),
  compilerOptions: {
    noEmit: true,
    rootDir: ".",
    incremental: false,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  },
  files: sources.map(source => relativeJson(
    outputRoot,
    pathHost.resolve(outputRoot, pathHost.relative(commonRoot, source.fileName)),
  )),
  include: [],
  exclude: [],
});

const bakedConfig: Record<string, unknown> = {
  ...config,
  project: finalProject,
  entries: config.entries.map(bakedSource),
  intrinsicModules: (config.intrinsicModules ?? []).map(bakedSource),
};
if (config.generatedDir !== undefined) bakedConfig.generatedDir = pathHost.resolve(configRoot, config.generatedDir);
if (config.outDir !== undefined) bakedConfig.outDir = pathHost.resolve(configRoot, config.outDir);
if (config.preludeFile !== undefined) bakedConfig.preludeFile = pathHost.resolve(configRoot, config.preludeFile);
if (config.variants !== undefined) {
  bakedConfig.variants = config.variants.map(variant => variant.preludeFile === undefined ? variant : {
    ...variant,
    preludeFile: pathHost.resolve(configRoot, variant.preludeFile),
  });
}

const bakedConfigPath = pathHost.join(stageRoot, "baguette.config.json");
await writeJson(bakedConfigPath, bakedConfig);
setConfigArg(bakedConfigPath);
console.log(`Baguette: Bake prepared ${sources.length} source module(s)`);
