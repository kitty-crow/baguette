import ts from "typescript";

/** Baguette 0.2.6: kernel-independent ahead-of-time TypeScript-to-WebAssembly compiler. */
const BAGUETTE_VERSION = "0.2.6";
const MANIFEST_SCHEMA = 3;

interface BunFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
interface BunResult { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; }
interface BunSubprocess { exited: Promise<number>; kill(signal?: number | string): void; }
interface BunApi {
  file(path: string): BunFile;
  write(path: string, data: string | Uint8Array): Promise<number>;
  spawn(command: string[], options?: { cwd?: string; env?: Record<string, string | undefined>; stdout?: "inherit"; stderr?: "inherit" }): BunSubprocess;
}
interface HostProcess { argv: string[]; cwd(): string; env: Record<string, string | undefined>; execPath: string; exit(code?: number): never; }
interface HostFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
}
interface HostPath {
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
  extname(path: string): string;
  normalize(path: string): string;
  sep: string;
}
interface BaguetteMemoryConfig {
  initialPages?: number;
  maximumPages?: number;
  import?: boolean;
  export?: boolean;
}
interface BaguetteAbiVerification {
  init?: string;
  initArgs?: Array<number | string>;
  initExpected?: number | string;
  valid?: string;
  validArgs?: Array<number | string>;
  validExpected?: number | string;
}
interface BaguetteAbiTest { function: string; args?: Array<number | string>; expected: number | string; }
interface BaguetteAbiConfig {
  exports?: "all-exported-functions" | string[];
  allowNonFunctionExports?: boolean;
  verify?: BaguetteAbiVerification;
  tests?: BaguetteAbiTest[];
}
interface BaguetteVariantConfig { name: string; threaded?: boolean; preludeFile?: string; }
interface BaguetteConfig {
  schema?: number;
  name?: string;
  project?: string;
  entries: string[];
  generatedDir?: string;
  outDir?: string;
  moduleBaseName?: string;
  preludeFile?: string;
  intrinsicModules?: string[];
  typeAliases?: Record<string, string>;
  abiTypes?: Record<string, "number" | "bigint" | "void">;
  abi?: BaguetteAbiConfig;
  memory?: BaguetteMemoryConfig;
  runtime?: "stub" | "minimal" | "incremental";
  variants?: BaguetteVariantConfig[];
  allowedHostImports?: Array<{ module: string; name: string; kind: WebAssembly.ImportExportKind }>;
  completeKernel?: boolean;
  productionKernel?: string;
  materialiseInferredTypes?: boolean;
  asyncLowering?: "state-machine" | "reject";
}
interface SourceEntry {
  readonly path: string;
  readonly absolutePath: string;
  readonly text: string;
  readonly source: ts.SourceFile;
  readonly sha256: string;
}
interface AbiParameter { readonly name: string; readonly sourceType: string; readonly hostType: "number" | "bigint" | "void"; }
interface AbiFunction {
  readonly name: string;
  readonly sourceName: string;
  readonly parameters: readonly AbiParameter[];
  readonly resultSourceType: string;
  readonly resultHostType: "number" | "bigint" | "void";
}
interface VariantResult {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly threaded: boolean;
  readonly imports: readonly WebAssembly.ModuleImportDescriptor[];
  readonly exports: readonly WebAssembly.ModuleExportDescriptor[];
  readonly functionCount: number;
}

const processHost = (globalThis as unknown as { process: HostProcess }).process;
const fs = await import("node:fs/promises" as string) as unknown as HostFs;
const pathHost = await import("node:path" as string) as unknown as HostPath;
const childProcess = await import("node:child_process" as string) as unknown as {
  spawn(executable: string, args: string[], options: { cwd?: string | undefined; env?: Record<string, string | undefined> | undefined; stdio: "inherit" }): {
    once(event: "exit", listener: (code: number | null) => void): void;
    once(event: "error", listener: () => void): void;
    kill(signal?: number | string): void;
  };
};
const nativeBun = (globalThis as unknown as { Bun?: BunApi }).Bun;
const bun: BunApi = nativeBun ?? {
  file(filePath: string): BunFile {
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        const bytes = await fs.readFile(filePath);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
      text(): Promise<string> { return fs.readFile(filePath, "utf8"); },
    };
  },
  async write(filePath: string, data: string | Uint8Array): Promise<number> {
    await fs.writeFile(filePath, data);
    return typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
  },
  spawn(command: string[], options): BunSubprocess {
    const executable = command[0];
    if (!executable) throw new Error("Baguette backend command has no executable");
    const child = childProcess.spawn(executable, command.slice(1), { cwd: options?.cwd, env: options?.env, stdio: "inherit" });
    const exited = new Promise<number>(resolve => {
      child.once("exit", code => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    return { exited, kill(signal?: number | string): void { child.kill(signal); } };
  },
};
const root = processHost.cwd();
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const optionValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  const direct = processHost.argv.find(value => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = processHost.argv.indexOf(name);
  return index >= 0 ? processHost.argv[index + 1] : undefined;
};
const hasOption = (name: string): boolean => processHost.argv.includes(name);
const validateOnly = hasOption("--validate-only");
const skipDeterminism = hasOption("--skip-determinism-check");
const skipOptimiser = hasOption("--skip-wasm-opt");
const configPath = pathHost.resolve(root, optionValue("--config") ?? "baguette.config.json");
const configRoot = pathHost.dirname(configPath);

const run = async (command: string[], label: string, attempts = 1, timeoutMs = 240_000): Promise<BunResult> => {
  if (!command[0]) throw new Error(`${label} has no executable`);
  let lastExit = -1;
  let lastTimedOut = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const child = bun.spawn(command, { cwd: root, env: processHost.env, stdout: "inherit", stderr: "inherit" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(9);
    }, timeoutMs);
    const exitCode = await child.exited;
    clearTimeout(timer);
    lastExit = exitCode;
    lastTimedOut = timedOut;
    if (exitCode === 0 && !timedOut) return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
    if (!timedOut || attempt === attempts) break;
    console.warn(`Baguette: ${label} timed out; retrying in a fresh backend process (${attempt + 1}/${attempts})`);
  }
  throw new Error(`${label} failed with ${lastTimedOut ? "timeout" : `exit code ${lastExit}`}`);
};
const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
};
const readBytes = async (path: string): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await bun.file(path).arrayBuffer());
const readText = async (path: string): Promise<string> => bun.file(path).text();
const normalise = (value: string): string => pathHost.normalize(pathHost.resolve(configRoot, value));
const relative = (value: string): string => pathHost.relative(root, value).split(pathHost.sep).join("/");
const lineAndColumn = (source: ts.SourceFile, position: number): string => {
  const place = source.getLineAndCharacterOfPosition(position);
  return `${relative(source.fileName)}:${place.line + 1}:${place.character + 1}`;
};
const diagnosticText = (diagnostic: ts.Diagnostic): string => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  return `${lineAndColumn(diagnostic.file, diagnostic.start)}: ${message}`;
};
const parseJson = async <T>(path: string): Promise<T> => {
  try { return JSON.parse(await readText(path)) as T; }
  catch (error) { throw new Error(`cannot parse ${relative(path)}: ${String(error)}`); }
};

const config = await parseJson<BaguetteConfig>(configPath);
if (!Array.isArray(config.entries) || config.entries.length === 0) throw new Error(`${relative(configPath)} must define at least one TypeScript entry module`);
const projectPath = normalise(config.project ?? "tsconfig.json");
const generated = normalise(config.generatedDir ?? "build/teto-generated");
const output = normalise(config.outDir ?? "dist/teto");
const moduleBaseName = config.moduleBaseName ?? "teto";
const variants = config.variants?.length ? config.variants : [{ name: moduleBaseName, threaded: false }, { name: `${moduleBaseName}-threads`, threaded: true }];
const intrinsicModules = new Set((config.intrinsicModules ?? []).map(normalise));

const defaultTypeAliases: Record<string, string> = {};
const typeAliases = new Map(Object.entries({ ...defaultTypeAliases, ...(config.typeAliases ?? {}) }));
const defaultAbiTypes: Record<string, "number" | "bigint" | "void"> = { number: "number", bigint: "bigint", boolean: "number", void: "void" };
const abiTypes = new Map(Object.entries({ ...defaultAbiTypes, ...(config.abiTypes ?? {}) }));

const configFile = ts.readConfigFile(projectPath, file => ts.sys.readFile(file));
if (configFile.error) throw new Error(diagnosticText(configFile.error));
const parsedProject = ts.parseJsonConfigFileContent(configFile.config, ts.sys, pathHost.dirname(projectPath), {
  noEmit: true,
  incremental: false,
  composite: false,
}, projectPath);
if (parsedProject.errors.length) throw new Error(parsedProject.errors.map(diagnosticText).join("\n"));
const entryPaths = config.entries.map(normalise);
const compilerOptions: ts.CompilerOptions = {
  ...parsedProject.options,
  noEmit: true,
  incremental: false,
  composite: false,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
};
const program = ts.createProgram({ rootNames: entryPaths, options: compilerOptions });
const semanticDiagnostics = ts.getPreEmitDiagnostics(program);
if (semanticDiagnostics.length) throw new Error(`Baguette TypeScript front-end failed:\n${semanticDiagnostics.map(diagnosticText).join("\n")}`);
const checker = program.getTypeChecker();

const sourceByAbsolute = new Map<string, ts.SourceFile>();
for (const source of program.getSourceFiles()) {
  if (source.isDeclarationFile || source.fileName.includes(`${pathHost.sep}node_modules${pathHost.sep}`)) continue;
  const absolute = pathHost.normalize(pathHost.resolve(source.fileName));
  if (absolute === configPath) continue;
  sourceByAbsolute.set(absolute, source);
}
for (const entry of entryPaths) if (!sourceByAbsolute.has(entry)) throw new Error(`Baguette could not load entry ${relative(entry)}`);

const resolveDependency = (source: ts.SourceFile, specifier: string): string | undefined => {
  const result = ts.resolveModuleName(specifier, source.fileName, compilerOptions, ts.sys).resolvedModule;
  if (!result || result.isExternalLibraryImport) return undefined;
  const resolved = pathHost.normalize(pathHost.resolve(result.resolvedFileName.replace(/\.d\.ts$/, ".ts")));
  return sourceByAbsolute.has(resolved) ? resolved : undefined;
};
const dependencies = new Map<string, string[]>();
const unresolvedRuntimeImports: string[] = [];
for (const [absolute, source] of sourceByAbsolute) {
  const items: string[] = [];
  for (const statement of source.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const dependency = resolveDependency(source, statement.moduleSpecifier.text);
      if (dependency) {
        items.push(dependency);
        continue;
      }
      const importIsTypeOnly = ts.isImportDeclaration(statement)
        ? Boolean(statement.importClause?.isTypeOnly || statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.every(item => item.isTypeOnly))
        : statement.isTypeOnly;
      if (!importIsTypeOnly) unresolvedRuntimeImports.push(`${relative(source.fileName)} imports external runtime module ${JSON.stringify(statement.moduleSpecifier.text)}`);
    }
  }
  dependencies.set(absolute, items);
}
if (unresolvedRuntimeImports.length) {
  throw new Error(`Baguette cannot silently erase external runtime modules. Link their TypeScript source into the entry graph or expose explicit Wasm host capabilities:
${unresolvedRuntimeImports.join("\n")}`);
}
const orderedPaths: string[] = [];
const visited = new Set<string>();
const active = new Set<string>();
const visitModule = (absolute: string): void => {
  if (visited.has(absolute)) return;
  if (active.has(absolute)) return; // TypeScript modules may be cyclic. Symbol identity still disambiguates them.
  active.add(absolute);
  for (const dependency of dependencies.get(absolute) ?? []) visitModule(dependency);
  active.delete(absolute);
  visited.add(absolute);
  orderedPaths.push(absolute);
};
for (const entry of entryPaths) visitModule(entry);

const sourceEntries: SourceEntry[] = [];
for (const absolutePath of orderedPaths) {
  const source = sourceByAbsolute.get(absolutePath)!;
  const text = await readText(absolutePath);
  sourceEntries.push({ path: relative(absolutePath), absolutePath, text, source, sha256: await sha256(encoder.encode(text)) });
}

const impossibleRuntimeIdentifiers = new Set(["Bun", "Function", "Proxy", "Reflect", "WeakMap", "WeakSet", "WebSocket", "document", "eval", "fetch", "navigator", "process", "require", "window"]);
const asyncLowering = config.asyncLowering ?? "state-machine";
interface BaguetteDiagnostic {
  readonly code: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly hint?: string | undefined;
}
const diagnosticLine = (source: ts.SourceFile, diagnostic: BaguetteDiagnostic): string => {
  const head = `${lineAndColumn(source, diagnostic.node.getStart(source))}: ${diagnostic.code}: ${diagnostic.message}`;
  return diagnostic.hint ? `${head}\n  hint: ${diagnostic.hint}` : head;
};
const isExplicitAny = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.AnyKeyword;
const isExplicitUnknown = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.UnknownKeyword;
const functionHasAsyncModifier = (node: ts.Node): boolean => ts.isFunctionLike(node)
  && ts.canHaveModifiers(node)
  && Boolean(ts.getModifiers(node)?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword));
const containsAwait = (node: ts.Node): boolean => {
  let found = false;
  const walk = (current: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(current) && current !== node) return;
    if (ts.isAwaitExpression(current)) { found = true; return; }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return found;
};
const validateSource = (entry: SourceEntry): void => {
  const errors: BaguetteDiagnostic[] = [];
  const fail = (node: ts.Node, code: string, message: string, hint?: string): void => { errors.push({ node, code, message, hint }); };
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      fail(node, "BQ1101", "runtime-computed imports cannot be ahead-of-time compiled", "Use a statically resolvable import or expose the operation as an explicit host capability.");
    }
    if (asyncLowering === "reject" && (ts.isAwaitExpression(node) || functionHasAsyncModifier(node))) {
      fail(node, "BQ2001", "async/await lowering is disabled by this Baguette configuration", "Set asyncLowering to \"state-machine\" or rewrite the function as an explicit scheduler state machine.");
    }
    if (ts.isYieldExpression(node) || ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && Boolean(node.asteriskToken))) {
      fail(node, "BQ2101", "generators require a resumable iterator frame that Baguette does not yet lower", "Use async/await for scheduler suspension, or write an explicit iterator state object.");
    }
    if (ts.isTryStatement(node) || ts.isThrowStatement(node)) {
      fail(node, "BQ2201", "JavaScript exception semantics are not part of the native kernel profile", "Return a typed result, errno, tagged union or explicit trap code instead.");
    }
    if (isExplicitAny(node)) {
      fail(node, "BQ1001", "`any` has no deterministic native memory shape", "Replace it with a concrete interface/class, a tagged union, or an opaque numeric handle. Baguette is an AOT compiler, not a JavaScript runtime.");
    }
    if (isExplicitUnknown(node)) {
      fail(node, "BQ1002", "`unknown` cannot be stored or passed until its native shape is known", "Narrow the value before this declaration, or use an explicit tagged union/handle whose layout Baguette can compile.");
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !node.type) {
      const inferred = checker.getTypeAtLocation(node.name);
      if (inferred.flags & ts.TypeFlags.Any) {
        fail(node.name, "BQ1001", `inferred type of ${node.name.text} is any and has no deterministic native memory shape`, "Add a concrete type annotation or replace the value with a tagged union or opaque handle.");
      } else if (inferred.flags & ts.TypeFlags.Unknown) {
        fail(node.name, "BQ1002", `inferred type of ${node.name.text} is unknown and cannot be materialised`, "Narrow the value to a concrete native type before storing it.");
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && !node.type) {
      const inferred = checker.getTypeAtLocation(node.name);
      if (inferred.flags & ts.TypeFlags.Any) {
        fail(node.name, "BQ1001", `parameter ${node.name.text} is implicitly any`, "Give the parameter an explicit native type. Baguette will not insert a dynamic JavaScript value representation.");
      } else if (inferred.flags & ts.TypeFlags.Unknown) {
        fail(node.name, "BQ1002", `parameter ${node.name.text} remains unknown at the native boundary`, "Use a concrete type, tagged union, interface/class layout or numeric handle.");
      }
    }
    if (functionHasAsyncModifier(node) && asyncLowering === "state-machine") {
      const topLevelExpression = (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
        && ts.isVariableDeclaration(node.parent)
        && ts.isIdentifier(node.parent.name)
        && ts.isVariableDeclarationList(node.parent.parent)
        && node.parent.parent.declarations.length === 1
        && ts.isVariableStatement(node.parent.parent.parent)
        && ts.isSourceFile(node.parent.parent.parent.parent);
      const classMethod = ts.isMethodDeclaration(node)
        && Boolean(node.body)
        && ts.isIdentifier(node.name)
        && ts.isClassDeclaration(node.parent)
        && Boolean(node.parent.name);
      if (!(ts.isFunctionDeclaration(node) && node.name && node.body) && !topLevelExpression && !classMethod) {
        fail(node, "BQ2003", "the current coroutine lowering supports named async functions, top-level async arrows/function expressions, and static or instance async methods", "Move local async closures into an explicit named function until their lexical capture shapes are materialised.");
      }
    }
    if (ts.isIdentifier(node) && impossibleRuntimeIdentifiers.has(node.text)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declarations = symbol?.declarations ?? [];
      const isLocal = declarations.some(declaration => !declaration.getSourceFile().isDeclarationFile);
      if (!isLocal) fail(node, "BQ1102", `${node.text} requires a JavaScript host runtime`, "Use an explicit numeric host capability or a native Wasm support routine instead.");
    }
    ts.forEachChild(node, walk);
  };
  walk(entry.source);
  if (errors.length) throw new Error(`Baguette AOT validation failed for ${entry.path}:\n${errors.map(item => diagnosticLine(entry.source, item)).join("\n")}`);
};
for (const entry of sourceEntries) if (!intrinsicModules.has(entry.absolutePath)) validateSource(entry);

const exported = (node: ts.Node): boolean => Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const rawSymbolOf = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node);
const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
  const symbol = rawSymbolOf(node);
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
};
const namespaceImportSymbol = (node: ts.Identifier): boolean => Boolean(rawSymbolOf(node)?.declarations?.some(declaration => ts.isNamespaceImport(declaration)));
const explicitAbiNames = config.abi?.exports === undefined || config.abi.exports === "all-exported-functions" ? undefined : new Set(config.abi.exports);
const abiSymbols = new Map<ts.Symbol, string>();
const abiFunctions: AbiFunction[] = [];
const explicitTypeName = (type: ts.TypeNode | undefined): string => {
  if (!type) return "";
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return type.typeName.text;
  if (type.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (type.kind === ts.SyntaxKind.BigIntKeyword) return "bigint";
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (type.kind === ts.SyntaxKind.VoidKeyword) return "void";
  return type.getText(type.getSourceFile());
};
const hostTypeFor = (type: ts.TypeNode | undefined, where: string): "number" | "bigint" | "void" => {
  const name = explicitTypeName(type);
  const mapped = abiTypes.get(name);
  if (!mapped) throw new Error(`${where}: type ${name || "<inferred>"} cannot cross the WebAssembly numeric ABI; expose a pointer or handle instead`);
  return mapped;
};
const registerAbi = (name: ts.Identifier, parameters: readonly ts.ParameterDeclaration[], result: ts.TypeNode | undefined, source: ts.SourceFile): void => {
  const symbol = symbolOf(name);
  if (!symbol) throw new Error(`${lineAndColumn(source, name.getStart(source))}: cannot resolve ABI symbol ${name.text}`);
  const exportName = name.text;
  if (abiFunctions.some(item => item.name === exportName)) throw new Error(`duplicate WebAssembly ABI export ${exportName}`);
  abiSymbols.set(symbol, exportName);
  abiFunctions.push({
    name: exportName,
    sourceName: `${relative(source.fileName)}#${name.text}`,
    parameters: parameters.map(parameter => ({
      name: ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(source),
      sourceType: explicitTypeName(parameter.type),
      hostType: hostTypeFor(parameter.type, `${relative(source.fileName)}:${name.text}`),
    })),
    resultSourceType: explicitTypeName(result),
    resultHostType: hostTypeFor(result, `${relative(source.fileName)}:${name.text} return`),
  });
};
for (const entry of sourceEntries) {
  if (intrinsicModules.has(entry.absolutePath)) continue;
  for (const statement of entry.source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && (explicitAbiNames?.has(statement.name.text) || (!explicitAbiNames && exported(statement)))) {
      registerAbi(statement.name, statement.parameters, statement.type, entry.source);
    }
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isArrowFunction(declaration.initializer)) continue;
        if (explicitAbiNames && !explicitAbiNames.has(declaration.name.text)) continue;
        registerAbi(declaration.name, declaration.initializer.parameters, declaration.initializer.type, entry.source);
      }
    }
  }
}
if (explicitAbiNames) {
  const found = new Set(abiFunctions.map(item => item.name));
  const missing = [...explicitAbiNames].filter(name => !found.has(name));
  if (missing.length) throw new Error(`configured ABI exports were not found as exported functions: ${missing.join(", ")}`);
}

const shortHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_$]/g, "_");
const renamedSymbols = new Map<ts.Symbol, string>();
const declarationNames = (statement: ts.Statement): ts.Identifier[] => {
  const result: ts.Identifier[] = [];
  const collectBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) result.push(name);
    else for (const item of name.elements) if (ts.isBindingElement(item)) collectBinding(item.name);
  };
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
    if (statement.name && ts.isIdentifier(statement.name)) result.push(statement.name);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) collectBinding(declaration.name);
  }
  return result;
};
for (const entry of sourceEntries) {
  if (intrinsicModules.has(entry.absolutePath)) continue;
  const prefix = `__bq_${shortHash(entry.path)}_`;
  for (const statement of entry.source.statements) {
    for (const name of declarationNames(statement)) {
      const symbol = symbolOf(name);
      if (!symbol || abiSymbols.has(symbol)) continue;
      renamedSymbols.set(symbol, `${prefix}${safeName(name.text)}`);
    }
  }
}

const stripExportModifiers = (modifiers: readonly ts.ModifierLike[] | undefined, keepExport: boolean): readonly ts.Modifier[] | undefined => {
  const kept = modifiers?.filter((modifier): modifier is ts.Modifier => ts.isModifier(modifier) && modifier.kind !== ts.SyntaxKind.DefaultKeyword && (keepExport || modifier.kind !== ts.SyntaxKind.ExportKeyword));
  return kept?.length ? kept : undefined;
};
const assemblyType = (type: ts.TypeNode): ts.TypeNode => {
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    if (type.typeName.text === "Promise") {
      const inner = type.typeArguments?.[0];
      if (!inner || inner.kind === ts.SyntaxKind.VoidKeyword) return ts.factory.createTypeReferenceNode("__BqTaskVoid", undefined);
      return ts.factory.createTypeReferenceNode("__BqTask", [assemblyType(inner)]);
    }
    const mapped = typeAliases.get(type.typeName.text);
    if (mapped) return ts.factory.createTypeReferenceNode(mapped, type.typeArguments?.map(assemblyType));
  }
  if (type.kind === ts.SyntaxKind.NumberKeyword) return ts.factory.createTypeReferenceNode("f64", undefined);
  if (type.kind === ts.SyntaxKind.BigIntKeyword) return ts.factory.createTypeReferenceNode("i64", undefined);
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return ts.factory.createTypeReferenceNode("bool", undefined);
  return type;
};

/**
 * Materialise TypeScript's inferred types into the flattened AssemblyScript
 * programme. This is a correctness requirement, not merely an optimisation:
 * TypeScript widens `let value = 1` to `number` (IEEE-754 f64 semantics), while
 * AssemblyScript otherwise infers i32 from the same literal.
 */
const materialiseInferredTypes = config.materialiseInferredTypes !== false;
const nativeTypeNode = (type: ts.Type, location: ts.Node, depth = 0): ts.TypeNode | undefined => {
  if (depth > 16) return undefined;
  const aliasName = type.aliasSymbol?.getName();
  if (aliasName) {
    if (aliasName === "Awaited") {
      const inner = type.aliasTypeArguments?.[0];
      if (inner) return nativeTypeNode(inner, location, depth + 1);
    }
    const mapped = typeAliases.get(aliasName);
    if (mapped) return ts.factory.createTypeReferenceNode(mapped, undefined);
  }
  const flags = type.flags;
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return undefined;
  if (flags & ts.TypeFlags.NumberLike) return ts.factory.createTypeReferenceNode("f64", undefined);
  if (flags & ts.TypeFlags.BigIntLike) return ts.factory.createTypeReferenceNode("i64", undefined);
  if (flags & ts.TypeFlags.BooleanLike) return ts.factory.createTypeReferenceNode("bool", undefined);
  if (flags & ts.TypeFlags.StringLike) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
  if (flags & ts.TypeFlags.Void) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  if (flags & ts.TypeFlags.Never) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  if (flags & ts.TypeFlags.TypeParameter) {
    const symbol = type.getSymbol();
    return symbol ? ts.factory.createTypeReferenceNode(symbol.getName(), undefined) : undefined;
  }
  if (type.isUnion()) {
    const withoutUndefined = type.types.filter(item => !(item.flags & ts.TypeFlags.Undefined));
    const hasNullish = withoutUndefined.length !== type.types.length || type.types.some(item => Boolean(item.flags & ts.TypeFlags.Null));
    const concrete = withoutUndefined.filter(item => !(item.flags & ts.TypeFlags.Null));
    if (concrete.length === 1) {
      const inner = nativeTypeNode(concrete[0]!, location, depth + 1);
      if (!inner) return undefined;
      // AssemblyScript models nullable managed references with `T | null`.
      if (hasNullish && !(concrete[0]!.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike))) {
        return ts.factory.createUnionTypeNode([inner, ts.factory.createLiteralTypeNode(ts.factory.createNull())]);
      }
      return inner;
    }
    if (concrete.every(item => Boolean(item.flags & ts.TypeFlags.NumberLike))) return ts.factory.createTypeReferenceNode("f64", undefined);
    if (concrete.every(item => Boolean(item.flags & ts.TypeFlags.BooleanLike))) return ts.factory.createTypeReferenceNode("bool", undefined);
    if (concrete.every(item => Boolean(item.flags & ts.TypeFlags.StringLike))) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    return undefined;
  }
  if (checker.isTupleType(type)) {
    const elements = checker.getTypeArguments(type as ts.TypeReference);
    if (!elements.length) return ts.factory.createTypeReferenceNode("Array", [ts.factory.createTypeReferenceNode("f64", undefined)]);
    const nodes = elements.map(item => nativeTypeNode(item, location, depth + 1));
    if (nodes.some(item => !item)) return undefined;
    const printed = nodes.map(item => ts.createPrinter().printNode(ts.EmitHint.Unspecified, item!, location.getSourceFile()));
    if (printed.every(item => item === printed[0])) return ts.factory.createTypeReferenceNode("Array", [nodes[0]!]);
    return undefined;
  }
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    const elementNode = element ? nativeTypeNode(element, location, depth + 1) : undefined;
    return elementNode ? ts.factory.createTypeReferenceNode("Array", [elementNode]) : undefined;
  }
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (signatures.length === 1) {
    const signature = signatures[0]!;
    const parameters: ts.ParameterDeclaration[] = [];
    for (const parameter of signature.getParameters()) {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? location;
      const parameterType = nativeTypeNode(checker.getTypeOfSymbolAtLocation(parameter, declaration), declaration, depth + 1);
      if (!parameterType) return undefined;
      parameters.push(ts.factory.createParameterDeclaration(undefined, undefined, parameter.getName(), undefined, parameterType, undefined));
    }
    const result = nativeTypeNode(signature.getReturnType(), location, depth + 1);
    return result ? ts.factory.createFunctionTypeNode(undefined, parameters, result) : undefined;
  }
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol) {
    if (symbol.getName() === "Awaited") {
      const arguments_ = type.aliasTypeArguments ?? (type as ts.TypeReference).typeArguments;
      const inner = arguments_?.[0];
      return inner ? nativeTypeNode(inner, location, depth + 1) : undefined;
    }
    if (symbol.getName() === "Promise") {
      const arguments_ = type.aliasTypeArguments ?? (type as ts.TypeReference).typeArguments;
      const inner = arguments_?.[0];
      if (!inner || inner.flags & ts.TypeFlags.Void) return ts.factory.createTypeReferenceNode("__BqTaskVoid", undefined);
      const innerNode = nativeTypeNode(inner, location, depth + 1);
      return innerNode ? ts.factory.createTypeReferenceNode("__BqTask", [innerNode]) : undefined;
    }
    const mapped = typeAliases.get(symbol.getName());
    if (mapped) return ts.factory.createTypeReferenceNode(mapped, undefined);
    const replacement = abiSymbols.get(symbol) ?? renamedSymbols.get(symbol) ?? symbol.getName();
    if (replacement && replacement !== "__type") {
      const arguments_ = type.aliasTypeArguments ?? (type as ts.TypeReference).typeArguments;
      const typeArguments = arguments_?.map(item => nativeTypeNode(item, location, depth + 1));
      if (typeArguments?.some(item => !item)) return undefined;
      return ts.factory.createTypeReferenceNode(replacement, typeArguments as ts.TypeNode[] | undefined);
    }
  }
  return undefined;
};
const declaredTypeOfSymbol = (symbol: ts.Symbol | undefined, seen = new Set<ts.Symbol>()): ts.TypeNode | undefined => {
  if (!symbol) return undefined;
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (seen.has(target)) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(target);
  for (const declaration of target.declarations ?? []) {
    if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) && declaration.type) {
      return assemblyType(declaration.type);
    }
    if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
      const inferred = syntacticTypeOfExpression(declaration.initializer, nextSeen);
      if (inferred) return inferred;
    }
    if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration) || ts.isGetAccessorDeclaration(declaration)) && declaration.type) {
      return assemblyType(declaration.type);
    }
  }
  return undefined;
};
const numericConstantExpression = (node: ts.Expression): boolean => {
  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return numericConstantExpression(node.expression);
  if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.TildeToken)) {
    return numericConstantExpression(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    const arithmetic = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.LessThanLessThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
    ]);
    return arithmetic.has(node.operatorToken.kind) && numericConstantExpression(node.left) && numericConstantExpression(node.right);
  }
  return false;
};
const syntacticTypeOfExpression = (expression: ts.Expression | undefined, seen = new Set<ts.Symbol>()): ts.TypeNode | undefined => {
  if (!expression) return undefined;
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return assemblyType(expression.type);
    return syntacticTypeOfExpression(expression.expression, seen);
  }
  if (ts.isIdentifier(expression)) return declaredTypeOfSymbol(checker.getSymbolAtLocation(expression), seen);
  if (ts.isPropertyAccessExpression(expression)) return declaredTypeOfSymbol(checker.getSymbolAtLocation(expression.name), seen);
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    const signature = checker.getResolvedSignature(expression);
    const declarationType = (signature?.declaration as { type?: ts.TypeNode } | undefined)?.type;
    if (declarationType && ts.isTypeNode(declarationType) && ts.isTypeReferenceNode(declarationType) && ts.isIdentifier(declarationType.typeName) && typeAliases.has(declarationType.typeName.text)) {
      return assemblyType(declarationType);
    }
    if (signature) {
      const instantiated = nativeTypeNode(signature.getReturnType(), expression);
      if (instantiated) return instantiated;
    }
    if (declarationType && ts.isTypeNode(declarationType)) return assemblyType(declarationType);
  }
  if (ts.isConditionalExpression(expression)) {
    const left = syntacticTypeOfExpression(expression.whenTrue, seen);
    const right = syntacticTypeOfExpression(expression.whenFalse, seen);
    const printer = ts.createPrinter();
    const source = expression.getSourceFile();
    if (left && right && printer.printNode(ts.EmitHint.Unspecified, left, source) === printer.printNode(ts.EmitHint.Unspecified, right, source)) return left;
    if (left && numericConstantExpression(expression.whenFalse)) return left;
    if (right && numericConstantExpression(expression.whenTrue)) return right;
    if (numericConstantExpression(expression.whenTrue) && numericConstantExpression(expression.whenFalse)) {
      if (ts.isBinaryExpression(expression.condition)) {
        const conditionOperand = syntacticTypeOfExpression(expression.condition.left, seen) ?? syntacticTypeOfExpression(expression.condition.right, seen);
        if (conditionOperand) return conditionOperand;
      }
    }
    if ((expression.whenTrue.kind === ts.SyntaxKind.TrueKeyword || expression.whenTrue.kind === ts.SyntaxKind.FalseKeyword) &&
        (expression.whenFalse.kind === ts.SyntaxKind.TrueKeyword || expression.whenFalse.kind === ts.SyntaxKind.FalseKeyword)) {
      return ts.factory.createTypeReferenceNode("bool", undefined);
    }
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    const comparisonOperators = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword,
      ts.SyntaxKind.InstanceOfKeyword,
    ]);
    if (comparisonOperators.has(operator)) return ts.factory.createTypeReferenceNode("bool", undefined);
    return syntacticTypeOfExpression(expression.left, seen) ?? syntacticTypeOfExpression(expression.right, seen);
  }
  if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) return syntacticTypeOfExpression(expression.operand, seen);
  return undefined;
};
const returnedFromTypedFunction = (node: ts.Node): ts.TypeNode | undefined => {
  if (!ts.isIdentifier(node)) return undefined;
  const symbol = symbolOf(node);
  if (!symbol) return undefined;
  let current: ts.Node | undefined = node;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  if (!current || !(ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current))) return undefined;
  if (!current.type || !ts.isTypeNode(current.type) || !current.body) return undefined;
  let returned = false;
  const walk = (candidate: ts.Node): void => {
    if (returned) return;
    if (candidate !== current && ts.isFunctionLike(candidate)) return;
    if (ts.isReturnStatement(candidate) && candidate.expression) {
      let expression: ts.Expression = candidate.expression;
      while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
      if (ts.isIdentifier(expression) && symbolOf(expression) === symbol) returned = true;
    }
    ts.forEachChild(candidate, walk);
  };
  walk(current.body);
  if (!returned) return undefined;
  if (functionHasAsyncModifier(current) && ts.isTypeReferenceNode(current.type) && ts.isIdentifier(current.type.typeName) && current.type.typeName.text === "Promise") {
    const inner = current.type.typeArguments?.[0];
    return inner ? assemblyType(inner) : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  }
  return assemblyType(current.type);
};
const inferredTypeFor = (node: ts.Node, initializer?: ts.Expression): ts.TypeNode | undefined => {
  if (!materialiseInferredTypes) return undefined;
  return syntacticTypeOfExpression(initializer) ?? returnedFromTypedFunction(node) ?? nativeTypeNode(checker.getTypeAtLocation(node), node);
};
const inferredReturnTypeFor = (node: ts.SignatureDeclaration): ts.TypeNode | undefined => {
  if (!materialiseInferredTypes) return undefined;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !ts.isBlock(node.body)) {
    const fromBody = syntacticTypeOfExpression(node.body);
    if (fromBody) return fromBody;
  }
  const signature = checker.getSignatureFromDeclaration(node);
  const declarationType = (signature?.declaration as { type?: ts.TypeNode } | undefined)?.type;
  return declarationType ? assemblyType(declarationType) : signature ? nativeTypeNode(signature.getReturnType(), node) : undefined;
};

interface AsyncUnit {
  readonly name: ts.Identifier;
  readonly declaration: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
  readonly body: ts.Block;
  readonly parameters: readonly ts.ParameterDeclaration[];
  readonly typeParameters: readonly ts.TypeParameterDeclaration[] | undefined;
  readonly frameTypeParameters: readonly ts.TypeParameterDeclaration[] | undefined;
  readonly modifiers: readonly ts.ModifierLike[] | undefined;
  readonly symbol: ts.Symbol;
  readonly receiverType?: ts.TypeNode | undefined;
  readonly method?: ts.MethodDeclaration;
}
const asyncFunctionDeclarations: AsyncUnit[] = [];
for (const entry of sourceEntries) {
  if (intrinsicModules.has(entry.absolutePath)) continue;
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && functionHasAsyncModifier(node)) {
      const symbol = symbolOf(node.name);
      if (symbol) asyncFunctionDeclarations.push({ name: node.name, declaration: node, body: node.body, parameters: node.parameters, typeParameters: node.typeParameters, frameTypeParameters: node.typeParameters, modifiers: node.modifiers, symbol });
    }
    if (ts.isMethodDeclaration(node) && node.body && ts.isIdentifier(node.name) && functionHasAsyncModifier(node)) {
      if (!ts.isClassDeclaration(node.parent) || !node.parent.name) return;
      const isStatic = Boolean(ts.getModifiers(node)?.some(item => item.kind === ts.SyntaxKind.StaticKeyword));
      const symbol = symbolOf(node.name);
      const classSymbol = symbolOf(node.parent.name);
      if (symbol && classSymbol) {
        const className = abiSymbols.get(classSymbol) ?? renamedSymbols.get(classSymbol) ?? node.parent.name.text;
        const classTypeParameters = node.parent.typeParameters ?? [];
        const classTypeArguments = classTypeParameters.map(parameter => ts.factory.createTypeReferenceNode(parameter.name.text, undefined));
        const frameTypeParameters = isStatic ? [...(node.typeParameters ?? [])] : [...classTypeParameters, ...(node.typeParameters ?? [])];
        asyncFunctionDeclarations.push({
          name: node.name,
          declaration: node,
          body: node.body,
          parameters: node.parameters,
          typeParameters: node.typeParameters,
          frameTypeParameters: frameTypeParameters.length ? frameTypeParameters : undefined,
          modifiers: node.modifiers,
          symbol,
          receiverType: isStatic ? undefined : ts.factory.createTypeReferenceNode(className, classTypeArguments.length ? classTypeArguments : undefined),
          method: node,
        });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(entry.source);
  for (const statement of entry.source.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
    const variable = statement.declarationList.declarations[0]!;
    if (!ts.isIdentifier(variable.name) || !variable.initializer
      || !(ts.isArrowFunction(variable.initializer) || ts.isFunctionExpression(variable.initializer))
      || !functionHasAsyncModifier(variable.initializer)) continue;
    const symbol = symbolOf(variable.name);
    if (!symbol) continue;
    const body = ts.isBlock(variable.initializer.body)
      ? variable.initializer.body
      : ts.factory.createBlock([ts.factory.createReturnStatement(variable.initializer.body)], true);
    asyncFunctionDeclarations.push({
      name: variable.name,
      declaration: variable.initializer,
      body,
      parameters: variable.initializer.parameters,
      typeParameters: variable.initializer.typeParameters,
      frameTypeParameters: variable.initializer.typeParameters,
      modifiers: statement.modifiers,
      symbol,
    });
  }
}
const hasAsyncFunctions = asyncLowering === "state-machine" && asyncFunctionDeclarations.length > 0;
const asyncRuntimeSource = hasAsyncFunctions ? `
// Baguette native coroutine runtime. This is compiled to Wasm and is not a Promise VM.
// Each coroutine frame is a native object with a virtual resume method.
class __BqContinuation {
  __bq_resume_frame(): void {}
}

class __BqTask<T> {
  private __bq_status: i32 = 0;
  private __bq_value!: T;
  private __bq_waiter: __BqContinuation | null = null;

  __bq_ready(): bool { return this.__bq_status != 0; }
  __bq_suspend(frame: __BqContinuation): void {
    if (this.__bq_status != 0) frame.__bq_resume_frame();
    else this.__bq_waiter = frame;
  }
  __bq_resume(): T { return this.__bq_value; }
  __bq_resolve(value: T): void {
    if (this.__bq_status != 0) return;
    this.__bq_value = value;
    this.__bq_status = 1;
    const frame = this.__bq_waiter;
    this.__bq_waiter = null;
    if (frame) frame.__bq_resume_frame();
  }
}

class __BqTaskVoid {
  private __bq_status: i32 = 0;
  private __bq_waiter: __BqContinuation | null = null;

  __bq_ready(): bool { return this.__bq_status != 0; }
  __bq_suspend(frame: __BqContinuation): void {
    if (this.__bq_status != 0) frame.__bq_resume_frame();
    else this.__bq_waiter = frame;
  }
  __bq_resume(): void {}
  __bq_resolve(): void {
    if (this.__bq_status != 0) return;
    this.__bq_status = 1;
    const frame = this.__bq_waiter;
    this.__bq_waiter = null;
    if (frame) frame.__bq_resume_frame();
  }
}
` : "";

const finalNameOf = (name: ts.Identifier): string => {
  const symbol = symbolOf(name);
  return symbol && (abiSymbols.get(symbol) ?? renamedSymbols.get(symbol)) || name.text;
};
const asyncHelpers = new Map<ts.Symbol, { frameName: string }>();
for (const unit of asyncFunctionDeclarations) {
  const symbol = unit.symbol;
  const stem = `${safeName(finalNameOf(unit.name))}_${shortHash(`${relative(unit.declaration.getSourceFile().fileName)}:${unit.declaration.getStart()}`)}`;
  asyncHelpers.set(symbol, { frameName: `__BqFrame_${stem}` });
}
const withoutAsyncModifier = (modifiers: readonly ts.ModifierLike[] | undefined, keepExport: boolean): readonly ts.Modifier[] | undefined => {
  const kept = modifiers?.filter((modifier): modifier is ts.Modifier => ts.isModifier(modifier)
    && modifier.kind !== ts.SyntaxKind.AsyncKeyword
    && modifier.kind !== ts.SyntaxKind.DefaultKeyword
    && (keepExport || modifier.kind !== ts.SyntaxKind.ExportKeyword));
  return kept?.length ? kept : undefined;
};
const promisedResultType = (node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): { source: ts.Type; native: ts.TypeNode; isVoid: boolean } => {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) throw new Error(`${lineAndColumn(node.getSourceFile(), node.getStart())}: BQ2004: cannot resolve async function signature`);
  if (node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)
    && node.type.typeName.text === "Promise" && node.type.typeArguments?.length === 1) {
    const innerNode = node.type.typeArguments[0]!;
    const sourceType = checker.getTypeFromTypeNode(innerNode);
    const isVoid = innerNode.kind === ts.SyntaxKind.VoidKeyword || Boolean(sourceType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined));
    const native = isVoid ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword) : assemblyType(innerNode);
    return { source: sourceType, native, isVoid };
  }
  const promised = checker.getAwaitedType(signature.getReturnType());
  if (!promised) throw new Error(`${lineAndColumn(node.getSourceFile(), node.getStart())}: BQ2004: async function must return Promise<T>`);
  const isVoid = Boolean(promised.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined));
  const native = isVoid ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword) : nativeTypeNode(promised, node);
  if (!native) throw new Error(`${lineAndColumn(node.getSourceFile(), node.getStart())}: BQ2004: async result type ${checker.typeToString(promised)} has no native Wasm shape`);
  return { source: promised, native, isVoid };
};
const taskTypeFor = (result: { native: ts.TypeNode; isVoid: boolean }): ts.TypeNode => result.isVoid
  ? ts.factory.createTypeReferenceNode("__BqTaskVoid", undefined)
  : ts.factory.createTypeReferenceNode("__BqTask", [result.native]);
const containsNestedAwait = (node: ts.Node): boolean => {
  let found = false;
  const scan = (current: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(current) && current !== node) return;
    if (ts.isAwaitExpression(current)) { found = true; return; }
    ts.forEachChild(current, scan);
  };
  scan(node);
  return found;
};
interface AsyncFrameBinding {
  readonly symbol: ts.Symbol;
  readonly field: string;
  readonly type: ts.TypeNode;
  readonly parameter?: ts.ParameterDeclaration | undefined;
}
type AsyncAwaitKind = "variable" | "assignment" | "expression" | "return" | "capture";
interface AsyncAwaitPoint {
  readonly await: ts.AwaitExpression;
  readonly kind: AsyncAwaitKind;
  readonly target?: ts.Expression | ts.Identifier | undefined;
  readonly captureField?: string;
  readonly resultType: ts.TypeNode;
  readonly resultVoid: boolean;
  readonly field: string;
}

const lowerSource = (entry: SourceEntry): string => {
  if (intrinsicModules.has(entry.absolutePath)) return `// intrinsic module omitted: ${entry.path}`;
  const source = entry.source;
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => {
    const asyncSupportStatements: ts.Statement[] = [];
    let visit: ts.Visitor;
    const lowerAsyncFunction = (unit: AsyncUnit): { readonly support: readonly ts.Statement[]; readonly wrapper: ts.FunctionDeclaration | ts.MethodDeclaration } => {
      const node = unit.declaration;
      const body = unit.body;
      for (const parameter of unit.parameters) {
        if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) {
          throw new Error(`${lineAndColumn(source, parameter.getStart(source))}: BQ2007: async coroutine parameters must currently be fixed named parameters`);
        }
      }

      const result = promisedResultType(node);
      const taskType = taskTypeFor(result);
      const functionSymbol = unit.symbol;
      const helper = asyncHelpers.get(functionSymbol);
      if (!helper) throw new Error(`${lineAndColumn(source, node.getStart(source))}: BQ2013: missing coroutine helper identity`);
      const { frameName } = helper;
      const frameTypeArguments = unit.frameTypeParameters?.map(parameter => ts.factory.createTypeReferenceNode(parameter.name.text, undefined));
      const frameTypeReference = ts.factory.createTypeReferenceNode(frameName, frameTypeArguments);
      const frameBindings = new Map<ts.Symbol, AsyncFrameBinding>();
      const bindings: AsyncFrameBinding[] = [];
      let bindingIndex = 0;
      const addBinding = (name: ts.Identifier, type: ts.TypeNode | undefined, parameter?: ts.ParameterDeclaration): AsyncFrameBinding => {
        const symbol = symbolOf(name);
        if (!symbol) throw new Error(`${lineAndColumn(source, name.getStart(source))}: BQ2008: cannot resolve coroutine-frame binding ${name.text}`);
        const native = type ? assemblyType(type) : inferredTypeFor(name);
        if (!native) {
          const actual = checker.typeToString(checker.getTypeAtLocation(name));
          throw new Error(`${lineAndColumn(source, name.getStart(source))}: BQ1003: ${name.text} has unresolved native shape ${actual}\n  hint: Add a concrete annotation, tagged union, class/interface layout or opaque numeric handle.`);
        }
        const binding: AsyncFrameBinding = { symbol, field: `__bq_v_${safeName(name.text)}_${bindingIndex++}`, type: native, parameter };
        frameBindings.set(symbol, binding);
        bindings.push(binding);
        return binding;
      };
      for (const parameter of unit.parameters) addBinding(parameter.name as ts.Identifier, parameter.type, parameter);
      const collectBindingIdentifiers = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
          const symbol = symbolOf(name);
          if (symbol && !frameBindings.has(symbol)) addBinding(name, undefined);
          return;
        }
        for (const element of name.elements) {
          if (ts.isOmittedExpression(element)) continue;
          collectBindingIdentifiers(element.name);
        }
      };
      const collectFrameBindings = (current: ts.Node): void => {
        if (ts.isFunctionLike(current) && current !== node) return;
        if (ts.isVariableDeclaration(current)) {
          if (ts.isIdentifier(current.name)) {
            const symbol = symbolOf(current.name);
            if (symbol && !frameBindings.has(symbol)) addBinding(current.name, current.type);
          } else collectBindingIdentifiers(current.name);
        }
        ts.forEachChild(current, collectFrameBindings);
      };
      collectFrameBindings(body);

      const awaitPoints = new Map<ts.Statement, AsyncAwaitPoint>();
      const allAwaitPoints: AsyncAwaitPoint[] = [];
      const expressionCaptureFields: Array<{ readonly field: string; readonly type: ts.TypeNode }> = [];
      let awaitIndex = 0;
      let expressionCaptureIndex = 0;
      const awaitResult = (awaitExpression: ts.AwaitExpression): { native: ts.TypeNode; isVoid: boolean } => {
        const awaited = checker.getTypeAtLocation(awaitExpression);
        const isVoid = Boolean(awaited.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined));
        const native = isVoid ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword) : nativeTypeNode(awaited, awaitExpression);
        if (!native) {
          throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2010: awaited type ${checker.typeToString(awaited)} has no native shape`);
        }
        return { native, isVoid };
      };
      const classifyAwait = (statement: ts.Statement): AsyncAwaitPoint | undefined => {
        let awaitExpression: ts.AwaitExpression | undefined;
        let kind: AsyncAwaitKind | undefined;
        let target: ts.Expression | ts.Identifier | undefined;
        if (ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)) {
          awaitExpression = statement.expression; kind = "expression";
        } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
          && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isAwaitExpression(statement.expression.right)) {
          awaitExpression = statement.expression.right; kind = "assignment"; target = statement.expression.left;
        } else if (ts.isVariableStatement(statement)) {
          const awaitedDeclarations = statement.declarationList.declarations.filter(item => Boolean(item.initializer && ts.isAwaitExpression(item.initializer)));
          if (awaitedDeclarations.length) {
            if (statement.declarationList.declarations.length !== 1 || awaitedDeclarations.length !== 1) {
              throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2014: an awaited variable declaration must be the only declaration in its statement`);
            }
            const declaration = awaitedDeclarations[0]!;
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isAwaitExpression(declaration.initializer)) return undefined;
            awaitExpression = declaration.initializer; kind = "variable"; target = declaration.name;
          }
        } else if (ts.isReturnStatement(statement) && statement.expression && ts.isAwaitExpression(statement.expression)) {
          awaitExpression = statement.expression; kind = "return";
        }
        if (!awaitExpression || !kind) return undefined;
        const awaited = awaitResult(awaitExpression);
        const point: AsyncAwaitPoint = {
          await: awaitExpression,
          kind,
          target,
          resultType: awaited.native,
          resultVoid: awaited.isVoid,
          field: `__bq_await_${awaitIndex++}`,
        };
        allAwaitPoints.push(point);
        return point;
      };
      const collectAwaitPoints = (current: ts.Node): void => {
        if (ts.isFunctionLike(current) && current !== node) return;
        if (ts.isStatement(current)) {
          const point = classifyAwait(current);
          if (point) awaitPoints.set(current, point);
        }
        ts.forEachChild(current, collectAwaitPoints);
      };
      collectAwaitPoints(body);

      const sequenceAlwaysReturns = (statements: readonly ts.Statement[]): boolean => {
        if (!statements.length) return false;
        return statementAlwaysReturns(statements[statements.length - 1]!);
      };
      const statementAlwaysReturns = (statement: ts.Statement): boolean => {
        if (ts.isReturnStatement(statement)) return true;
        if (ts.isBlock(statement)) return sequenceAlwaysReturns(statement.statements);
        if (ts.isIfStatement(statement) && statement.elseStatement) return statementAlwaysReturns(statement.thenStatement) && statementAlwaysReturns(statement.elseStatement);
        if (ts.isSwitchStatement(statement)) {
          const hasDefault = statement.caseBlock.clauses.some(ts.isDefaultClause);
          return hasDefault && statement.caseBlock.clauses.every(clause => sequenceAlwaysReturns(clause.statements));
        }
        return false;
      };
      if (!result.isVoid && !sequenceAlwaysReturns(body.statements)) {
        const end = body.pos >= 0 ? body.getEnd() - 1 : node.getEnd() - 1;
        throw new Error(`${lineAndColumn(source, end)}: BQ2005: non-void async function has a path without an explicit return`);
      }

      const frameIdentifier = ts.factory.createIdentifier("__bq_frame");
      const taskAccess = (): ts.PropertyAccessExpression => ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_task");
      const bindingAccess = (binding: AsyncFrameBinding): ts.PropertyAccessExpression => ts.factory.createPropertyAccessExpression(frameIdentifier, binding.field);
      const receiverAccess = (): ts.PropertyAccessExpression => ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_this");
      const frameReferenceVisitor: ts.Visitor = current => {
        if (ts.isFunctionLike(current)) return current;
        if (unit.receiverType && current.kind === ts.SyntaxKind.ThisKeyword) return receiverAccess();
        if (current.kind === ts.SyntaxKind.SuperKeyword) {
          throw new Error(`${lineAndColumn(source, current.getStart(source))}: BQ2033: super access across async suspension needs an explicit base-receiver ABI`);
        }
        if (ts.isPrivateIdentifier(current)) {
          throw new Error(`${lineAndColumn(source, current.getStart(source))}: BQ2034: ECMAScript private fields cannot be accessed from a native coroutine resume function\n  hint: Use a TypeScript private/protected field or explicit accessor method.`);
        }
        if (ts.isShorthandPropertyAssignment(current)) {
          const symbol = symbolOf(current.name);
          const binding = symbol && frameBindings.get(symbol);
          if (binding) return ts.factory.createPropertyAssignment(current.name.text, bindingAccess(binding));
        }
        if (ts.isIdentifier(current)) {
          const symbol = symbolOf(current);
          const binding = symbol && frameBindings.get(symbol);
          if (binding) return bindingAccess(binding);
        }
        return ts.visitEachChild(current, frameReferenceVisitor, context);
      };
      const rewrite = <T extends ts.Node>(current: T): T => {
        const framed = ts.visitNode(current, frameReferenceVisitor) as T;
        return ts.visitNode(framed, visit) as T;
      };
      const firstAwaitIn = (root: ts.Node): ts.AwaitExpression | undefined => {
        let found: ts.AwaitExpression | undefined;
        const scan = (current: ts.Node): void => {
          if (found) return;
          if (ts.isFunctionLike(current) && current !== root) return;
          if (ts.isAwaitExpression(current)) { found = current; return; }
          ts.forEachChild(current, scan);
        };
        scan(root);
        return found;
      };
      const replaceNode = <T extends ts.Node>(root: T, target: ts.Node, replacement: ts.Expression): T => {
        const replacer: ts.Visitor = current => current === target ? replacement : ts.visitEachChild(current, replacer, context);
        return ts.visitNode(root, replacer) as T;
      };
      const literalOrStaticReference = (expression: ts.Expression): boolean => {
        while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
        if (ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword || ts.isLiteralExpression(expression)) return true;
        if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return true;
        if (ts.isPropertyAccessExpression(expression)) return literalOrStaticReference(expression.expression);
        return false;
      };
      const assertAwaitEvaluationOrder = (awaitExpression: ts.AwaitExpression, root: ts.Node): void => {
        const ancestry: ts.Node[] = [];
        const findPath = (current: ts.Node): boolean => {
          if (current === awaitExpression) { ancestry.push(current); return true; }
          let found = false;
          current.forEachChild(child => {
            if (!found && findPath(child)) found = true;
          });
          if (found) ancestry.push(current);
          return found;
        };
        if (!findPath(root)) throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2020: internal coroutine expression path could not be resolved`);
        for (let index = 0; index + 1 < ancestry.length; index++) {
          const current = ancestry[index]!;
          const parent = ancestry[index + 1]!;
          if (ts.isBinaryExpression(parent)) {
            const shortCircuit = parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
              || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
              || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
            if (shortCircuit && current === parent.right) {
              throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: await after a short-circuit operand requires expression-value spilling`);
            }
            if (current === parent.right && !literalOrStaticReference(parent.left)) {
              throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: an effectful expression is evaluated before this await\n  hint: Move the await into a temporary declaration so Baguette can preserve exact evaluation order.`);
            }
          } else if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
            const args = parent.arguments ?? ts.factory.createNodeArray<ts.Expression>();
            const argumentIndex = args.findIndex(item => item === current || item.pos <= current.pos && current.end <= item.end);
            if (argumentIndex >= 0) {
              if (!literalOrStaticReference(parent.expression) || args.slice(0, argumentIndex).some(item => !literalOrStaticReference(item))) {
                throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: an effectful call operand is evaluated before this await\n  hint: Split the preceding call operands into explicitly typed temporaries.`);
              }
            }
          } else if (ts.isConditionalExpression(parent) && current !== parent.condition) {
            throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: await inside a conditional branch requires condition-value spilling`);
          }
        }
      };
      const resolveAndReturn = (expression?: ts.Expression): ts.Block => {
        const args = expression ? [rewrite(expression)] : [];
        return ts.factory.createBlock([
          ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(taskAccess(), "__bq_resolve"), undefined, args)),
          ts.factory.createReturnStatement(),
        ], true);
      };
      const rewriteReturnsVisitor: ts.Visitor = current => {
        if (ts.isFunctionLike(current)) return current;
        if (ts.isReturnStatement(current)) {
          if (result.isVoid) return resolveAndReturn(current.expression);
          if (!current.expression) throw new Error(`${lineAndColumn(source, current.getStart(source))}: BQ2011: non-void async return requires a value`);
          return resolveAndReturn(current.expression);
        }
        return ts.visitEachChild(current, rewriteReturnsVisitor, context);
      };
      const lowerOrdinaryStatement = (statement: ts.Statement): readonly ts.Statement[] => {
        if (ts.isVariableStatement(statement)) {
          const assignments: ts.Statement[] = [];
          const lowerBindingAssignment = (name: ts.BindingName, value: ts.Expression): void => {
            if (ts.isIdentifier(name)) {
              const symbol = symbolOf(name);
              const binding = symbol && frameBindings.get(symbol);
              if (!binding) throw new Error(`${lineAndColumn(source, name.getStart(source))}: BQ2012: cannot find coroutine local ${name.text}`);
              assignments.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(bindingAccess(binding), ts.SyntaxKind.EqualsToken, value)));
              return;
            }
            if (ts.isArrayBindingPattern(name)) {
              name.elements.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) return;
                if (element.dotDotDotToken || element.initializer) {
                  throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2021: destructuring defaults and rest bindings need dedicated native lowering\n  hint: Split this binding into explicit indexed assignments.`);
                }
                lowerBindingAssignment(element.name, ts.factory.createElementAccessExpression(value, ts.factory.createNumericLiteral(index)));
              });
              return;
            }
            for (const element of name.elements) {
              if (element.dotDotDotToken || element.initializer) {
                throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2021: destructuring defaults and rest bindings need dedicated native lowering\n  hint: Split this binding into explicit property assignments.`);
              }
              const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
              if (!property || ts.isComputedPropertyName(property)) {
                throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2022: computed destructuring keys have no fixed native field offset\n  hint: Use a statically named property or an explicit map lookup.`);
              }
              const access = ts.isIdentifier(property) || ts.isPrivateIdentifier(property)
                ? ts.factory.createPropertyAccessExpression(value, property.text)
                : ts.factory.createElementAccessExpression(value, property);
              lowerBindingAssignment(element.name, access);
            }
          };
          for (const declaration of statement.declarationList.declarations) {
            if (!declaration.initializer) continue;
            if (ts.isIdentifier(declaration.name)) {
              lowerBindingAssignment(declaration.name, rewrite(declaration.initializer));
              continue;
            }
            const rewrittenInitializer = rewrite(declaration.initializer);
            const initializerType = declaration.initializer.pos >= 0
              ? nativeTypeNode(checker.getTypeAtLocation(declaration.initializer), declaration.initializer)
              : undefined;
            if (!initializerType) {
              if (literalOrStaticReference(rewrittenInitializer)) {
                lowerBindingAssignment(declaration.name, rewrittenInitializer);
                continue;
              }
              const position = declaration.name.pos >= 0 ? declaration.name.getStart(source) : node.getStart(source);
              throw new Error(`${lineAndColumn(source, position)}: BQ2023: destructuring source has no concrete native shape\n  hint: Annotate the source with a fixed array, tuple, class or interface type.`);
            }
            const captureField = `__bq_destructure_${expressionCaptureIndex++}`;
            expressionCaptureFields.push({ field: captureField, type: initializerType });
            const captureAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, captureField);
            assignments.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(captureAccess, ts.SyntaxKind.EqualsToken, rewrittenInitializer)));
            lowerBindingAssignment(declaration.name, captureAccess);
          }
          return assignments;
        }
        const returnsLowered = ts.visitNode(statement, rewriteReturnsVisitor) as ts.Statement;
        return [rewrite(returnsLowered)];
      };

      const awaitTaskAccess = (point: AsyncAwaitPoint): ts.PropertyAccessExpression => ts.factory.createPropertyAccessExpression(frameIdentifier, point.field);
      const consumeAwait = (point: AsyncAwaitPoint): ts.Statement[] => {
        const resumed = ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(awaitTaskAccess(point), "__bq_resume"), undefined, []);
        if (point.kind === "expression") return [ts.factory.createExpressionStatement(resumed)];
        if (point.kind === "return") return [resolveAndReturn(point.resultVoid ? undefined : resumed)];
        if (point.kind === "variable" && point.target && ts.isIdentifier(point.target)) {
          const binding = frameBindings.get(symbolOf(point.target)!);
          if (!binding) throw new Error(`${lineAndColumn(source, point.target.getStart(source))}: BQ2012: cannot find coroutine local ${point.target.text}`);
          return [ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(bindingAccess(binding), ts.SyntaxKind.EqualsToken, resumed))];
        }
        if (point.kind === "assignment" && point.target) {
          return [ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(rewrite(point.target), ts.SyntaxKind.EqualsToken, resumed))];
        }
        if (point.kind === "capture" && point.captureField) {
          return [ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(frameIdentifier, point.captureField), ts.SyntaxKind.EqualsToken, resumed))];
        }
        return [];
      };

      const stateBodies = new Map<number, ts.Statement[]>();
      let nextStateId = 0;
      const allocateState = (body: ts.Statement[] = []): number => {
        const id = nextStateId++;
        stateBodies.set(id, body);
        return id;
      };
      const setStateAndContinue = (target: number): ts.Statement[] => [
        ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"), ts.SyntaxKind.EqualsToken, ts.factory.createNumericLiteral(target))),
        ts.factory.createContinueStatement(),
      ];
      const completionState = allocateState(result.isVoid ? [...resolveAndReturn().statements] : [ts.factory.createReturnStatement()]);
      interface LoopTargets { readonly breakState: number; readonly continueState?: number | undefined; }

      const compileAwait = (point: AsyncAwaitPoint, next: number): number => {
        const resumeBody = consumeAwait(point);
        if (point.kind !== "return") resumeBody.push(...setStateAndContinue(next));
        const resumeState = allocateState(resumeBody);
        const taskExpression = rewrite(point.await.expression);
        const setTask = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(awaitTaskAccess(point), ts.SyntaxKind.EqualsToken, taskExpression));
        const setResumeState = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"), ts.SyntaxKind.EqualsToken, ts.factory.createNumericLiteral(resumeState)));
        const suspend = ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(awaitTaskAccess(point), "__bq_suspend"), undefined, [frameIdentifier]));
        const notReady = ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken,
          ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(awaitTaskAccess(point), "__bq_ready"), undefined, []));
        return allocateState([
          setTask,
          setResumeState,
          ts.factory.createIfStatement(notReady, ts.factory.createBlock([suspend, ts.factory.createReturnStatement()], true)),
          ts.factory.createContinueStatement(),
        ]);
      };

      const compileNestedExpressionAwait = (statement: ts.Statement, next: number, loop?: LoopTargets): number | undefined => {
        const awaitExpression = firstAwaitIn(statement);
        if (!awaitExpression) return undefined;
        assertAwaitEvaluationOrder(awaitExpression, statement);
        const awaited = awaitResult(awaitExpression);
        if (awaited.isVoid) {
          throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2019: void await cannot be embedded in a value expression\n  hint: Put the await in its own expression statement.`);
        }
        const captureField = `__bq_expr_${expressionCaptureIndex++}`;
        expressionCaptureFields.push({ field: captureField, type: awaited.native });
        const point: AsyncAwaitPoint = {
          await: awaitExpression,
          kind: "capture",
          captureField,
          resultType: awaited.native,
          resultVoid: false,
          field: `__bq_await_${awaitIndex++}`,
        };
        allAwaitPoints.push(point);
        const captureAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, captureField);
        const remainder = replaceNode(statement, awaitExpression, captureAccess);
        const remainderEntry = compileStatement(remainder, next, loop);
        return compileAwait(point, remainderEntry);
      };

      const compileConditionalExpression = (expression: ts.Expression, trueState: number, falseState: number): number => {
        const awaitExpression = firstAwaitIn(expression);
        if (awaitExpression) {
          assertAwaitEvaluationOrder(awaitExpression, expression);
          const awaited = awaitResult(awaitExpression);
          if (awaited.isVoid) {
            throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2019: void await cannot be used as a condition value`);
          }
          const captureField = `__bq_expr_${expressionCaptureIndex++}`;
          expressionCaptureFields.push({ field: captureField, type: awaited.native });
          const point: AsyncAwaitPoint = {
            await: awaitExpression,
            kind: "capture",
            captureField,
            resultType: awaited.native,
            resultVoid: false,
            field: `__bq_await_${awaitIndex++}`,
          };
          allAwaitPoints.push(point);
          const remainder = replaceNode(expression, awaitExpression, ts.factory.createPropertyAccessExpression(frameIdentifier, captureField));
          const remainderEntry = compileConditionalExpression(remainder, trueState, falseState);
          return compileAwait(point, remainderEntry);
        }
        const choose = ts.factory.createConditionalExpression(rewrite(expression), ts.factory.createToken(ts.SyntaxKind.QuestionToken), ts.factory.createNumericLiteral(trueState), ts.factory.createToken(ts.SyntaxKind.ColonToken), ts.factory.createNumericLiteral(falseState));
        return allocateState([
          ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"), ts.SyntaxKind.EqualsToken, choose)),
          ts.factory.createContinueStatement(),
        ]);
      };

      let compileStatement: (statement: ts.Statement, next: number, loop?: LoopTargets) => number;
      const compileSequence = (statements: readonly ts.Statement[], next: number, loop?: LoopTargets): number => {
        let entry = next;
        for (let index = statements.length - 1; index >= 0; index--) entry = compileStatement(statements[index]!, entry, loop);
        return entry;
      };
      compileStatement = (statement: ts.Statement, next: number, loop?: LoopTargets): number => {
        const point = awaitPoints.get(statement);
        if (point) return compileAwait(point, next);
        if (ts.isBlock(statement)) return compileSequence(statement.statements, next, loop);
        if (ts.isEmptyStatement(statement)) return next;
        if ((ts.isExpressionStatement(statement) || ts.isReturnStatement(statement) || ts.isVariableStatement(statement)) && containsNestedAwait(statement)) {
          const nested = compileNestedExpressionAwait(statement, next, loop);
          if (nested !== undefined) return nested;
        }
        if (ts.isReturnStatement(statement)) {
          const body = result.isVoid
            ? [...resolveAndReturn(statement.expression).statements]
            : statement.expression
              ? [...resolveAndReturn(statement.expression).statements]
              : (() => { throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2011: non-void async return requires a value`); })();
          return allocateState(body);
        }
        if (ts.isIfStatement(statement)) {
          const thenState = compileStatement(statement.thenStatement, next, loop);
          const elseState = statement.elseStatement ? compileStatement(statement.elseStatement, next, loop) : next;
          return compileConditionalExpression(statement.expression, thenState, elseState);
        }
        if (ts.isWhileStatement(statement)) {
          const conditionAnchor = allocateState();
          const bodyAnchor = allocateState();
          const conditionEntry = compileConditionalExpression(statement.expression, bodyAnchor, next);
          stateBodies.set(conditionAnchor, setStateAndContinue(conditionEntry));
          const bodyEntry = compileStatement(statement.statement, conditionAnchor, { breakState: next, continueState: conditionAnchor });
          stateBodies.set(bodyAnchor, setStateAndContinue(bodyEntry));
          return conditionAnchor;
        }
        if (ts.isDoStatement(statement)) {
          const conditionAnchor = allocateState();
          const bodyAnchor = allocateState();
          const conditionEntry = compileConditionalExpression(statement.expression, bodyAnchor, next);
          stateBodies.set(conditionAnchor, setStateAndContinue(conditionEntry));
          const bodyEntry = compileStatement(statement.statement, conditionAnchor, { breakState: next, continueState: conditionAnchor });
          stateBodies.set(bodyAnchor, setStateAndContinue(bodyEntry));
          return bodyAnchor;
        }
        if (ts.isForStatement(statement)) {
          const conditionAnchor = allocateState();
          const bodyAnchor = allocateState();
          const incrementAnchor = allocateState();
          const conditionEntry = statement.condition
            ? compileConditionalExpression(statement.condition, bodyAnchor, next)
            : allocateState(setStateAndContinue(bodyAnchor));
          stateBodies.set(conditionAnchor, setStateAndContinue(conditionEntry));
          const incrementEntry = statement.incrementor
            ? compileStatement(ts.factory.createExpressionStatement(statement.incrementor), conditionAnchor)
            : conditionAnchor;
          stateBodies.set(incrementAnchor, setStateAndContinue(incrementEntry));
          const bodyEntry = compileStatement(statement.statement, incrementAnchor, { breakState: next, continueState: incrementAnchor });
          stateBodies.set(bodyAnchor, setStateAndContinue(bodyEntry));
          if (!statement.initializer) return conditionAnchor;
          if (ts.isVariableDeclarationList(statement.initializer)) {
            return compileStatement(ts.factory.createVariableStatement(undefined, statement.initializer), conditionAnchor);
          }
          return compileStatement(ts.factory.createExpressionStatement(statement.initializer), conditionAnchor);
        }
        if (ts.isBreakStatement(statement)) {
          if (!loop) throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2015: break is not inside a lowered loop`);
          return allocateState(setStateAndContinue(loop.breakState));
        }
        if (ts.isContinueStatement(statement)) {
          if (!loop || loop.continueState === undefined) throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2016: continue is not inside a lowered loop`);
          return allocateState(setStateAndContinue(loop.continueState));
        }
        if (ts.isSwitchStatement(statement)) {
          const discriminantType = nativeTypeNode(checker.getTypeAtLocation(statement.expression), statement.expression);
          if (!discriminantType) {
            throw new Error(`${lineAndColumn(source, statement.expression.getStart(source))}: BQ2025: switch discriminant has no concrete native shape`);
          }
          const captureField = `__bq_switch_${expressionCaptureIndex++}`;
          expressionCaptureFields.push({ field: captureField, type: discriminantType });
          const captureAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, captureField);
          const clauseEntries = new Map<ts.CaseOrDefaultClause, number>();
          let fallthroughState = next;
          for (let index = statement.caseBlock.clauses.length - 1; index >= 0; index--) {
            const clause = statement.caseBlock.clauses[index]!;
            const entry = compileSequence(clause.statements, fallthroughState, { breakState: next, continueState: loop?.continueState });
            clauseEntries.set(clause, entry);
            fallthroughState = entry;
          }

          // JavaScript evaluates case labels from top to bottom until one matches.
          // Each label therefore receives its own resumable state. A label may
          // suspend without evaluating later labels or losing the discriminant.
          const defaultClause = statement.caseBlock.clauses.find(ts.isDefaultClause);
          let dispatchEntry = defaultClause ? clauseEntries.get(defaultClause)! : next;
          for (let index = statement.caseBlock.clauses.length - 1; index >= 0; index--) {
            const clause = statement.caseBlock.clauses[index]!;
            if (!ts.isCaseClause(clause)) continue;
            const labelField = `__bq_switch_case_${expressionCaptureIndex++}`;
            expressionCaptureFields.push({ field: labelField, type: discriminantType });
            const labelAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, labelField);
            const compareState = allocateState([
              ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(
                ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"),
                ts.SyntaxKind.EqualsToken,
                ts.factory.createConditionalExpression(
                  ts.factory.createBinaryExpression(captureAccess, ts.SyntaxKind.EqualsEqualsEqualsToken, labelAccess),
                  ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                  ts.factory.createNumericLiteral(clauseEntries.get(clause)!),
                  ts.factory.createToken(ts.SyntaxKind.ColonToken),
                  ts.factory.createNumericLiteral(dispatchEntry),
                ),
              )),
              ts.factory.createContinueStatement(),
            ]);
            const assignLabel = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(labelAccess, ts.SyntaxKind.EqualsToken, clause.expression));
            dispatchEntry = compileStatement(assignLabel, compareState, loop);
          }
          const assignDiscriminant = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(captureAccess, ts.SyntaxKind.EqualsToken, statement.expression));
          return compileStatement(assignDiscriminant, dispatchEntry, loop);
        }
        if (ts.isForOfStatement(statement)) {
          const iterableSourceType = checker.getTypeAtLocation(statement.expression);
          const numericIndexType = checker.getIndexTypeOfType(iterableSourceType, ts.IndexKind.Number);
          const lengthProperty = iterableSourceType.getProperty("length");
          if (!numericIndexType || !lengthProperty) {
            throw new Error(`${lineAndColumn(source, statement.expression.getStart(source))}: BQ2026: for-of currently requires a statically indexable value with numeric elements and length\n  hint: Use an Array, tuple or StaticArray, or lower the iterator explicitly.`);
          }
          const iterableType = nativeTypeNode(iterableSourceType, statement.expression);
          if (!iterableType) throw new Error(`${lineAndColumn(source, statement.expression.getStart(source))}: BQ2026: for-of iterable has no concrete native shape`);
          const iterableField = `__bq_forof_values_${expressionCaptureIndex++}`;
          const indexField = `__bq_forof_index_${expressionCaptureIndex++}`;
          expressionCaptureFields.push({ field: iterableField, type: iterableType });
          expressionCaptureFields.push({ field: indexField, type: ts.factory.createTypeReferenceNode("i32", undefined) });
          const iterableAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, iterableField);
          const indexAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, indexField);
          const elementAccess = ts.factory.createElementAccessExpression(iterableAccess, indexAccess);
          const bindElementStatements: ts.Statement[] = [];
          const bindForOfName = (name: ts.BindingName, value: ts.Expression): void => {
            if (ts.isIdentifier(name)) {
              const symbol = symbolOf(name);
              const binding = symbol && frameBindings.get(symbol);
              if (!binding) throw new Error(`${lineAndColumn(source, name.getStart(source))}: BQ2012: cannot find coroutine for-of local ${name.text}`);
              bindElementStatements.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(bindingAccess(binding), ts.SyntaxKind.EqualsToken, value)));
              return;
            }
            if (ts.isArrayBindingPattern(name)) {
              name.elements.forEach((element, elementIndex) => {
                if (ts.isOmittedExpression(element)) return;
                if (element.dotDotDotToken || element.initializer) {
                  throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2027: for-of destructuring defaults and rest require explicit native assignments`);
                }
                bindForOfName(element.name, ts.factory.createElementAccessExpression(value, ts.factory.createNumericLiteral(elementIndex)));
              });
              return;
            }
            for (const element of name.elements) {
              if (element.dotDotDotToken || element.initializer) {
                throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2027: for-of destructuring defaults and rest require explicit native assignments`);
              }
              const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
              if (!property || ts.isComputedPropertyName(property)) {
                throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2022: computed destructuring keys have no fixed native field offset`);
              }
              const access = ts.isIdentifier(property) || ts.isPrivateIdentifier(property)
                ? ts.factory.createPropertyAccessExpression(value, property.text)
                : ts.factory.createElementAccessExpression(value, property);
              bindForOfName(element.name, access);
            }
          };
          if (ts.isVariableDeclarationList(statement.initializer)) {
            if (statement.initializer.declarations.length !== 1) {
              throw new Error(`${lineAndColumn(source, statement.initializer.getStart(source))}: BQ2027: for-of requires exactly one declaration`);
            }
            bindForOfName(statement.initializer.declarations[0]!.name, elementAccess);
          } else {
            bindElementStatements.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(rewrite(statement.initializer), ts.SyntaxKind.EqualsToken, elementAccess)));
          }

          const conditionAnchor = allocateState();
          const bodyAnchor = allocateState();
          const incrementAnchor = allocateState();
          const condition = ts.factory.createBinaryExpression(indexAccess, ts.SyntaxKind.LessThanToken, ts.factory.createPropertyAccessExpression(iterableAccess, "length"));
          stateBodies.set(conditionAnchor, [
            ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"), ts.SyntaxKind.EqualsToken,
              ts.factory.createConditionalExpression(condition, ts.factory.createToken(ts.SyntaxKind.QuestionToken), ts.factory.createNumericLiteral(bodyAnchor), ts.factory.createToken(ts.SyntaxKind.ColonToken), ts.factory.createNumericLiteral(next)))),
            ts.factory.createContinueStatement(),
          ]);
          stateBodies.set(incrementAnchor, [
            ts.factory.createExpressionStatement(ts.factory.createPostfixIncrement(indexAccess)),
            ...setStateAndContinue(conditionAnchor),
          ]);
          const bodyEntry = compileStatement(statement.statement, incrementAnchor, { breakState: next, continueState: incrementAnchor });
          stateBodies.set(bodyAnchor, [
            ...bindElementStatements,
            ...setStateAndContinue(bodyEntry),
          ]);
          const initialiseIndex = allocateState([
            ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(indexAccess, ts.SyntaxKind.EqualsToken, ts.factory.createNumericLiteral(0))),
            ...setStateAndContinue(conditionAnchor),
          ]);
          const assignIterable = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(iterableAccess, ts.SyntaxKind.EqualsToken, statement.expression));
          return compileStatement(assignIterable, initialiseIndex, loop);
        }
        if (ts.isForInStatement(statement)) {
          if (containsNestedAwait(statement)) throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2017: await inside for-in requires dynamic property-iterator lowering`);
        }
        if (containsNestedAwait(statement)) {
          throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2002: await expression requires a supported statement or control-flow lowering`);
        }
        return allocateState([...lowerOrdinaryStatement(statement), ...setStateAndContinue(next)]);
      };

      const entryState = compileSequence(body.statements, completionState);
      const clauses = [...stateBodies.entries()]
        .sort(([left], [right]) => left - right)
        .map(([id, body]) => ts.factory.createCaseClause(ts.factory.createNumericLiteral(id), body));
      const switchStatement = ts.factory.createSwitchStatement(ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"),
        ts.factory.createCaseBlock([...clauses, ts.factory.createDefaultClause([ts.factory.createReturnStatement()])]));
      const frameMembers: ts.ClassElement[] = [
        ts.factory.createPropertyDeclaration(undefined, "__bq_state", undefined, ts.factory.createTypeReferenceNode("i32", undefined), ts.factory.createNumericLiteral(entryState)),
        ts.factory.createPropertyDeclaration(undefined, "__bq_task", ts.factory.createToken(ts.SyntaxKind.ExclamationToken), taskType, undefined),
      ];
      if (unit.receiverType) frameMembers.push(ts.factory.createPropertyDeclaration(undefined, "__bq_this", ts.factory.createToken(ts.SyntaxKind.ExclamationToken), unit.receiverType, undefined));
      for (const binding of bindings) frameMembers.push(ts.factory.createPropertyDeclaration(undefined, binding.field, ts.factory.createToken(ts.SyntaxKind.ExclamationToken), binding.type, undefined));
      for (const capture of expressionCaptureFields) frameMembers.push(ts.factory.createPropertyDeclaration(undefined, capture.field, ts.factory.createToken(ts.SyntaxKind.ExclamationToken), capture.type, undefined));
      for (const point of allAwaitPoints) frameMembers.push(ts.factory.createPropertyDeclaration(undefined, point.field, ts.factory.createToken(ts.SyntaxKind.ExclamationToken), taskTypeFor({ native: point.resultType, isVoid: point.resultVoid }), undefined));
      const constructorParameters: ts.ParameterDeclaration[] = [
        ts.factory.createParameterDeclaration(undefined, undefined, "__bq_task", undefined, taskType, undefined),
        ...(unit.receiverType ? [ts.factory.createParameterDeclaration(undefined, undefined, "__bq_this", undefined, unit.receiverType, undefined)] : []),
        ...bindings.filter(item => item.parameter).map(item => ts.factory.createParameterDeclaration(undefined, undefined, item.parameter!.name, undefined, item.type, undefined)),
      ];
      const constructorStatements: ts.Statement[] = [
        ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createSuper(), undefined, [])),
        ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), "__bq_task"), ts.SyntaxKind.EqualsToken, ts.factory.createIdentifier("__bq_task"))),
      ];
      if (unit.receiverType) constructorStatements.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), "__bq_this"), ts.SyntaxKind.EqualsToken, ts.factory.createIdentifier("__bq_this"))));
      for (const binding of bindings.filter(item => item.parameter)) {
        const name = (binding.parameter!.name as ts.Identifier).text;
        constructorStatements.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), binding.field), ts.SyntaxKind.EqualsToken, ts.factory.createIdentifier(name))));
      }
      frameMembers.push(ts.factory.createConstructorDeclaration(undefined, constructorParameters, ts.factory.createBlock(constructorStatements, true)));
      const resumeBody = ts.factory.createBlock([
        ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
          ts.factory.createVariableDeclaration(frameIdentifier, undefined, frameTypeReference, ts.factory.createThis()),
        ], ts.NodeFlags.Const)),
        ts.factory.createWhileStatement(ts.factory.createTrue(), ts.factory.createBlock([switchStatement], true)),
      ], true);
      frameMembers.push(ts.factory.createMethodDeclaration(undefined, undefined, "__bq_resume_frame", undefined, undefined, [], ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword), resumeBody));
      const frameClass = ts.factory.createClassDeclaration(
        undefined,
        frameName,
        unit.frameTypeParameters,
        [ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [ts.factory.createExpressionWithTypeArguments(ts.factory.createIdentifier("__BqContinuation"), undefined)])],
        frameMembers,
      );

      const taskVariable = ts.factory.createIdentifier("__bq_task");
      const localFrame = ts.factory.createIdentifier("__bq_start_frame");
      const newTask = result.isVoid
        ? ts.factory.createNewExpression(ts.factory.createIdentifier("__BqTaskVoid"), undefined, [])
        : ts.factory.createNewExpression(ts.factory.createIdentifier("__BqTask"), [result.native], []);
      const newFrameArguments: ts.Expression[] = [taskVariable, ...(unit.receiverType ? [ts.factory.createThis()] : []), ...unit.parameters.map(parameter => ts.factory.createIdentifier((parameter.name as ts.Identifier).text))];
      const wrapperBody = ts.factory.createBlock([
        ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
          ts.factory.createVariableDeclaration(taskVariable, undefined, taskType, newTask),
        ], ts.NodeFlags.Const)),
        ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
          ts.factory.createVariableDeclaration(localFrame, undefined, frameTypeReference, ts.factory.createNewExpression(ts.factory.createIdentifier(frameName), frameTypeArguments, newFrameArguments)),
        ], ts.NodeFlags.Const)),
        ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(localFrame, "__bq_resume_frame"), undefined, [])),
        ts.factory.createReturnStatement(taskVariable),
      ], true);
      const symbol = unit.symbol;
      const support = [frameClass].map(statement => ts.visitEachChild(statement, visit, context) as ts.Statement);
      const wrapper = unit.method
        ? ts.factory.createMethodDeclaration(withoutAsyncModifier(unit.modifiers, false), undefined, unit.method.name, unit.method.questionToken, unit.typeParameters, unit.parameters, taskType, wrapperBody)
        : ts.factory.createFunctionDeclaration(withoutAsyncModifier(unit.modifiers, Boolean(abiSymbols.has(symbol))), undefined,
          unit.name, unit.typeParameters, unit.parameters, taskType, wrapperBody);
      return { support, wrapper: ts.visitEachChild(wrapper, visit, context) as ts.FunctionDeclaration | ts.MethodDeclaration };
    };
    visit = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return undefined;
      if (ts.isFunctionDeclaration(node) && node.name && node.body && functionHasAsyncModifier(node) && asyncLowering === "state-machine") {
        const symbol = symbolOf(node.name);
        const unit = symbol && asyncFunctionDeclarations.find(item => item.symbol === symbol);
        if (!unit) throw new Error(`${lineAndColumn(source, node.getStart(source))}: BQ2013: missing async function unit`);
        const lowered = lowerAsyncFunction(unit);
        return [...lowered.support, lowered.wrapper];
      }
      if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
        const declaration = node.declarationList.declarations[0]!;
        if (ts.isIdentifier(declaration.name) && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
          && functionHasAsyncModifier(declaration.initializer) && asyncLowering === "state-machine") {
          const symbol = symbolOf(declaration.name);
          const unit = symbol && asyncFunctionDeclarations.find(item => item.symbol === symbol);
          if (!unit) throw new Error(`${lineAndColumn(source, declaration.getStart(source))}: BQ2013: missing async expression unit`);
          const lowered = lowerAsyncFunction(unit);
          return [...lowered.support, lowered.wrapper];
        }
      }
      if (ts.isMethodDeclaration(node) && node.body && ts.isIdentifier(node.name) && functionHasAsyncModifier(node) && asyncLowering === "state-machine") {
        const symbol = symbolOf(node.name);
        const unit = symbol && asyncFunctionDeclarations.find(item => item.symbol === symbol && item.method === node);
        if (!unit) throw new Error(`${lineAndColumn(source, node.getStart(source))}: BQ2013: missing async method unit`);
        const lowered = lowerAsyncFunction(unit);
        asyncSupportStatements.push(...lowered.support);
        return lowered.wrapper;
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaceImportSymbol(node.expression)) {
        const target = symbolOf(node.name);
        const replacement = target && (abiSymbols.get(target) ?? renamedSymbols.get(target));
        if (!replacement) throw new Error(`${lineAndColumn(source, node.getStart(source))}: namespace member ${node.getText(source)} does not resolve to a flattened Baguette symbol`);
        return ts.factory.createIdentifier(replacement);
      }
      if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && namespaceImportSymbol(node.left)) {
        const target = symbolOf(node.right);
        const replacement = target && (abiSymbols.get(target) ?? renamedSymbols.get(target));
        if (!replacement) throw new Error(`${lineAndColumn(source, node.getStart(source))}: namespace type ${node.getText(source)} does not resolve to a flattened Baguette symbol`);
        return ts.factory.createIdentifier(replacement);
      }
      if (ts.isFunctionDeclaration(node) && !node.body && node.name) {
        const symbol = symbolOf(node.name);
        const implementation = symbol?.declarations?.some(declaration => ts.isFunctionDeclaration(declaration) && Boolean(declaration.body));
        if (implementation) return undefined;
      }
      if (ts.isMethodDeclaration(node) && !node.body) {
        const symbol = symbolOf(node.name);
        const implementation = symbol?.declarations?.some(declaration => ts.isMethodDeclaration(declaration) && Boolean(declaration.body));
        if (implementation) return undefined;
      }
      if (ts.isVariableDeclaration(node) && !node.type) {
        const inferred = inferredTypeFor(node.name, node.initializer);
        return ts.visitEachChild(ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, inferred, node.initializer), visit, context);
      }
      if (ts.isParameter(node) && !node.type) {
        const inferred = inferredTypeFor(node.name);
        return ts.visitEachChild(ts.factory.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, node.name, node.questionToken, inferred, node.initializer), visit, context);
      }
      if (ts.isPropertyDeclaration(node) && !node.type) {
        const inferred = inferredTypeFor(node.name, node.initializer);
        return ts.visitEachChild(ts.factory.updatePropertyDeclaration(node, node.modifiers, node.name, node.questionToken ?? node.exclamationToken, inferred, node.initializer), visit, context);
      }
      if (ts.isFunctionExpression(node) && !node.type) {
        return ts.visitEachChild(ts.factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, inferredReturnTypeFor(node), node.body), visit, context);
      }
      if (ts.isArrowFunction(node) && !node.type) {
        return ts.visitEachChild(ts.factory.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, inferredReturnTypeFor(node), node.equalsGreaterThanToken, node.body), visit, context);
      }
      if (ts.isMethodDeclaration(node) && !node.type) {
        return ts.visitEachChild(ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, inferredReturnTypeFor(node), node.body), visit, context);
      }
      if (ts.isGetAccessorDeclaration(node) && !node.type) {
        return ts.visitEachChild(ts.factory.updateGetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, inferredReturnTypeFor(node), node.body), visit, context);
      }
      if (ts.isIdentifier(node)) {
        const symbol = symbolOf(node);
        const replacement = symbol && (abiSymbols.get(symbol) ?? renamedSymbols.get(symbol));
        if (replacement && replacement !== node.text) return ts.factory.createIdentifier(replacement);
        return node;
      }
      if (ts.isShorthandPropertyAssignment(node)) {
        const symbol = symbolOf(node.name);
        const replacement = symbol && (abiSymbols.get(symbol) ?? renamedSymbols.get(symbol));
        if (replacement && replacement !== node.name.text) return ts.factory.createPropertyAssignment(node.name.text, ts.factory.createIdentifier(replacement));
      }
      if (ts.isTypeReferenceNode(node) || node.kind === ts.SyntaxKind.NumberKeyword || node.kind === ts.SyntaxKind.BigIntKeyword || node.kind === ts.SyntaxKind.BooleanKeyword) return ts.visitEachChild(assemblyType(node as ts.TypeNode), visit, context);
      if (ts.isBigIntLiteral(node)) {
        const literal = node.getText(source);
        return ts.factory.createNumericLiteral(literal.endsWith("n") ? literal.slice(0, -1) : literal);
      }
      if (ts.isAsExpression(node)) return ts.factory.createTypeAssertion(assemblyType(node.type), ts.visitNode(node.expression, visit) as ts.Expression);
      if (ts.isNonNullExpression(node)) {
        const narrowed = nativeTypeNode(checker.getTypeAtLocation(node), node);
        const expression = ts.visitNode(node.expression, visit) as ts.Expression;
        return narrowed ? ts.factory.createTypeAssertion(narrowed, expression) : expression;
      }
      if (ts.isSatisfiesExpression(node)) return ts.visitNode(node.expression, visit);
      if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
        const declaration = node.declarationList.declarations[0]!;
        if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isArrowFunction(declaration.initializer)) {
          const symbol = symbolOf(declaration.name);
          const isAbi = Boolean(symbol && abiSymbols.has(symbol));
          const arrow = declaration.initializer;
          const body = ts.isBlock(arrow.body) ? arrow.body : ts.factory.createBlock([ts.factory.createReturnStatement(arrow.body)], true);
          const functionNode = ts.factory.createFunctionDeclaration(
            stripExportModifiers(node.modifiers, isAbi), undefined, declaration.name, arrow.typeParameters, arrow.parameters, arrow.type, body,
          );
          return ts.visitEachChild(functionNode, visit, context);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        const symbol = symbolOf(node.name);
        return ts.visitEachChild(ts.factory.updateFunctionDeclaration(node, stripExportModifiers(node.modifiers, Boolean(symbol && abiSymbols.has(symbol))), node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type ?? inferredReturnTypeFor(node), node.body), visit, context);
      }
      if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
        const clone = ts.visitEachChild(node, visit, context) as ts.Node;
        if (ts.canHaveModifiers(clone)) ts.setTextRange(clone, node);
        return clone;
      }
      return ts.visitEachChild(node, visit, context);
    };
    return file => {
      const lowered = ts.visitEachChild(file, visit, context);
      return asyncSupportStatements.length
        ? ts.factory.updateSourceFile(lowered, [...lowered.statements, ...asyncSupportStatements])
        : lowered;
    };
  };
  const result = ts.transform(source, [transformer]);
  try {
    const lowered = result.transformed[0]!;
    let printed = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false }).printFile(lowered);
    // Non-function exports are internal in the flattened module. AssemblyScript would otherwise expose mutable kernel state.
    printed = printed.replace(/^export\s+(?=(?:const|let|var|class|enum|namespace|interface|type)\b)/gm, "");
    return `// source: ${entry.path}\n${printed}`;
  } finally { result.dispose(); }
};

const compilerVersion = async (packagePath: string): Promise<string> => {
  const packageText = await readText(packagePath);
  const value = JSON.parse(packageText) as { version?: string };
  return value.version ?? "unknown";
};
const ascVersion = await compilerVersion(`${root}/node_modules/assemblyscript/package.json`);
const tsVersion = ts.version;
const binaryenVersion = await compilerVersion(`${root}/node_modules/binaryen/package.json`);
const generatedBody = [asyncRuntimeSource, ...sourceEntries.map(lowerSource)].filter(Boolean).join("\n\n");
const customPrelude = config.preludeFile ? await readText(normalise(config.preludeFile)) : "";
const variantPreludes = new Map<string, { path: string | undefined; text: string; sha256: string }>();
for (const variant of variants) {
  const preludePath = variant.preludeFile ? normalise(variant.preludeFile) : undefined;
  const text = preludePath ? await readText(preludePath) : "";
  variantPreludes.set(variant.name, { path: preludePath ? relative(preludePath) : undefined, text, sha256: await sha256(encoder.encode(text)) });
}
const sourceHash = await sha256(encoder.encode(sourceEntries.map(entry => `${entry.path}\n${entry.text}`).join("\n")));
const loweredSourceHashes = Object.fromEntries(await Promise.all(variants.map(async variant => {
  const prelude = variantPreludes.get(variant.name)!;
  return [variant.name, await sha256(encoder.encode(`${prelude.text}\n${customPrelude}\n${generatedBody}`))] as const;
})));

const allowedHostImports = config.allowedHostImports ?? [{ module: "env", name: "memory", kind: "memory" as const }];
const importKey = (item: { module: string; name: string; kind: WebAssembly.ImportExportKind }): string => `${item.module}\u0000${item.name}\u0000${item.kind}`;
const allowedImportKeys = new Set(allowedHostImports.map(importKey));
const instantiateImports = (threaded: boolean): WebAssembly.Imports => {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const item of allowedHostImports) {
    const namespace = imports[item.module] ?? (imports[item.module] = {});
    if (item.kind === "memory") {
      namespace[item.name] = new WebAssembly.Memory({
        initial: Math.max(1024, config.memory?.initialPages ?? 1024),
        maximum: config.memory?.maximumPages ?? 32768,
        shared: threaded,
      });
    } else if (item.kind === "function") namespace[item.name] = (item.name === "abort" ? (() => { throw new Error("WebAssembly abort import invoked during Baguette verification"); }) : (() => 0)) as WebAssembly.ImportValue;
    else if (item.kind === "global") namespace[item.name] = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
    else if (item.kind === "table") namespace[item.name] = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  }
  return imports;
};
const argumentValue = (value: number | string): number | bigint => typeof value === "number" ? value : BigInt(value);
const verifyModule = async (wasmPath: string, threaded: boolean): Promise<Omit<VariantResult, "file" | "bytes" | "sha256" | "threaded">> => {
  const bytes = await readBytes(wasmPath);
  if (!WebAssembly.validate(bytes)) throw new Error(`${relative(wasmPath)} is not valid WebAssembly`);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const unexpectedImports = imports.filter(item => !allowedImportKeys.has(importKey(item)));
  if (unexpectedImports.length) throw new Error(`${relative(wasmPath)} has undeclared host imports: ${unexpectedImports.map(importKey).join(", ")}`);
  const exports = WebAssembly.Module.exports(module);
  const exportMap = new Map(exports.map(item => [item.name, item.kind]));
  for (const required of abiFunctions) if (exportMap.get(required.name) !== "function") throw new Error(`${relative(wasmPath)} is missing native function export ${required.name}`);
  if (!config.abi?.allowNonFunctionExports) {
    const unexpectedKinds = exports.filter(item => item.kind !== "function");
    if (unexpectedKinds.length) throw new Error(`${relative(wasmPath)} unexpectedly exports non-function state: ${unexpectedKinds.map(item => `${item.name}:${item.kind}`).join(", ")}`);
  }
  const instance = new WebAssembly.Instance(module, instantiateImports(threaded));
  const native = instance.exports as Record<string, WebAssembly.ExportValue>;
  const verification = config.abi?.verify;
  if (verification?.init) {
    const init = native[verification.init];
    if (typeof init !== "function") throw new Error(`${relative(wasmPath)} lacks verification function ${verification.init}`);
    const result = (init as CallableFunction)(...(verification.initArgs ?? []).map(argumentValue));
    if (verification.initExpected !== undefined && result !== argumentValue(verification.initExpected)) throw new Error(`${relative(wasmPath)} ${verification.init} returned ${String(result)}`);
  }
  if (verification?.valid) {
    const valid = native[verification.valid];
    if (typeof valid !== "function") throw new Error(`${relative(wasmPath)} lacks verification function ${verification.valid}`);
    const result = (valid as CallableFunction)(...(verification.validArgs ?? []).map(argumentValue));
    if (verification.validExpected !== undefined && result !== argumentValue(verification.validExpected)) throw new Error(`${relative(wasmPath)} ${verification.valid} returned ${String(result)}`);
  }
  for (const test of config.abi?.tests ?? []) {
    const fn = native[test.function];
    if (typeof fn !== "function") throw new Error(`${relative(wasmPath)} lacks ABI test function ${test.function}`);
    const result = (fn as CallableFunction)(...(test.args ?? []).map(argumentValue));
    if (result !== argumentValue(test.expected)) throw new Error(`${relative(wasmPath)} ABI test ${test.function} returned ${String(result)}, expected ${String(test.expected)}`);
  }
  return { imports, exports, functionCount: exports.filter(item => item.kind === "function").length };
};
const hostInterface = (): string => {
  const lines = [`/** Generated by Baguette ${BAGUETTE_VERSION}. Do not edit. */`, `export interface ${safeName(config.name ?? "Module")}Exports {`];
  for (const fn of abiFunctions) lines.push(`  ${fn.name}(${fn.parameters.map(parameter => `${parameter.name}: ${parameter.hostType}`).join(", ")}): ${fn.resultHostType};`);
  lines.push("}", "");
  return lines.join("\n");
};

if (validateOnly) {
  console.log(`Baguette ${BAGUETTE_VERSION} validated a ${sourceEntries.length}-module TypeScript programme from ${config.entries.length} entry point(s)`);
  console.log(`  configuration: ${relative(configPath)}`);
  console.log(`  native ABI exports: ${abiFunctions.length}`);
  console.log("  execution model: ahead-of-time WebAssembly; no JavaScript VM or bytecode interpreter");
} else {
  await fs.rm(generated, { recursive: true, force: true });
  await fs.mkdir(generated, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const variantResults: Record<string, VariantResult> = {};
  for (const variant of variants) {
    const sourcePath = `${generated}/${variant.name}.ts`;
    const rawPath = `${generated}/${variant.name}.raw.wasm`;
    const rawRepeatPath = `${generated}/${variant.name}.repeat.raw.wasm`;
    const optimisedRepeatPath = `${generated}/${variant.name}.repeat.wasm`;
    const wasmPath = `${output}/${variant.name}.wasm`;
    const watPath = `${generated}/${variant.name}.wat`;
    const variantPrelude = variantPreludes.get(variant.name)!.text;
    const sourceText = `${variantPrelude}\n${customPrelude}\n${generatedBody}`;
    await bun.write(sourcePath, sourceText);
    const asc = async (destination: string, textFile?: string): Promise<void> => {
      const command = ["node", `${root}/node_modules/assemblyscript/bin/asc.js`, sourcePath,
        "--outFile", destination, "--runtime", config.runtime ?? "stub", "--zeroFilledMemory",
        "--initialMemory", String(config.memory?.initialPages ?? 256), "--maximumMemory", String(config.memory?.maximumPages ?? 32768),
        "--optimizeLevel", "3", "--shrinkLevel", "0", "--noAssert", "--enable", "simd"];
      if (config.memory?.import !== false) command.push("--importMemory");
      if (config.memory?.export !== true) command.push("--noExportMemory");
      if (textFile) command.push("--textFile", textFile);
      if (variant.threaded) command.push("--sharedMemory", "--enable", "threads");
      await run(command, `AssemblyScript backend for ${variant.name}`, 2, 180_000);
    };
    const optimise = async (input: string, destination: string): Promise<void> => {
      if (skipOptimiser) { await fs.copyFile(input, destination); return; }
      await run([`${root}/node_modules/.bin/wasm-opt`, input, "-o", destination, "-O3", "--all-features", "--strip-debug"], `Binaryen optimisation for ${variant.name}`, 2, 120_000);
    };
    console.log(`Baguette: compiling ${variant.name} (${variant.threaded ? "threaded" : "baseline"})`);
    await asc(rawPath, watPath);
    await optimise(rawPath, wasmPath);
    if (!skipDeterminism) {
      console.log(`Baguette: verifying deterministic rebuild for ${variant.name}`);
      await asc(rawRepeatPath);
      await optimise(rawRepeatPath, optimisedRepeatPath);
      const first = await readBytes(wasmPath), second = await readBytes(optimisedRepeatPath);
      if (first.byteLength !== second.byteLength || first.some((byte, index) => byte !== second[index])) throw new Error(`${variant.name} is not deterministic across identical Baguette builds`);
      console.log(`Baguette: deterministic rebuild verified for ${variant.name}`);
    }
    const verification = await verifyModule(wasmPath, Boolean(variant.threaded));
    const bytes = await readBytes(wasmPath);
    variantResults[`${variant.name}.wasm`] = { file: relative(wasmPath), bytes: bytes.byteLength, sha256: await sha256(bytes), threaded: Boolean(variant.threaded), ...verification };
    await fs.rm(rawPath, { recursive: false, force: true });
    await fs.rm(rawRepeatPath, { recursive: false, force: true });
    await fs.rm(optimisedRepeatPath, { recursive: false, force: true });
  }
  const serialisableVariants = Object.fromEntries(Object.entries(variantResults).map(([name, result]) => [name, {
    file: result.file, bytes: result.bytes, sha256: result.sha256, threaded: result.threaded, functionCount: result.functionCount,
    imports: result.imports, exports: result.exports.map(item => item.name),
  }]));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    name: config.name ?? "Module",
    transpiler: "Baguette",
    transpilerVersion: BAGUETTE_VERSION,
    executionModel: "ahead-of-time-native-webassembly",
    javascriptInGeneratedModule: false,
    javascriptVirtualMachine: false,
    javascriptBytecodeInterpreter: false,
    configuration: relative(configPath),
    entryPoints: config.entries,
    generatedFrom: sourceEntries.map(entry => ({ path: entry.path, sha256: entry.sha256 })),
    intrinsicModules: [...intrinsicModules].map(relative),
    preludes: Object.fromEntries([...variantPreludes].map(([name, item]) => [name, { path: item.path ?? null, sha256: item.sha256 }])),
    sourceSha256: sourceHash,
    loweredSourceSha256: loweredSourceHashes,
    compiler: {
      frontend: `TypeScript ${tsVersion} semantic checker and module resolver`,
      lowering: `Baguette ${BAGUETTE_VERSION} symbol-safe whole-program lowering`,
      inferredTypeMaterialisation: materialiseInferredTypes,
      moduleFeatures: ["named and default imports", "namespace imports", "re-exports", "overload signature erasure", "native CFG coroutine lowering with generic frames, resumable switch labels, indexable for-of destructuring, arrows and instance methods"],
      asyncLowering,
      backend: `AssemblyScript ${ascVersion}`,
      optimiser: skipOptimiser ? "disabled by command line" : `Binaryen ${binaryenVersion} wasm-opt -O3`,
      runtime: config.runtime ?? "stub",
    },
    proof: {
      allowedHostImports,
      importedFunctions: Math.max(0, ...Object.values(variantResults).map(result => result.imports.filter(item => item.kind === "function").length)),
      requiredNativeExports: abiFunctions.map(item => item.name),
      deterministicRebuildVerified: !skipDeterminism,
      nativeInstantiationVerified: true,
      generatedWAT: variants.map(variant => relative(`${generated}/${variant.name}.wat`)),
    },
    completeKernel: config.completeKernel ?? false,
    productionKernel: config.productionKernel ?? "unset",
    variants: serialisableVariants,
  };
  await bun.write(`${output}/${moduleBaseName}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  await bun.write(`${output}/host-interface.d.ts`, hostInterface());
  await bun.write(`${output}/baguette-report.json`, `${JSON.stringify({
    baguetteVersion: BAGUETTE_VERSION,
    acceptedProfile: "statically analysable TypeScript with semantic type materialisation, native coroutine state machines and native managed runtime support from AssemblyScript",
    inferredTypeMaterialisation: materialiseInferredTypes,
    asyncLowering,
    moduleFeatures: ["named and default imports", "namespace imports", "re-exports", "overload signature erasure", "native CFG coroutine lowering with generic frames, resumable switch labels, indexable for-of destructuring, arrows and instance methods"],
    rejectedRuntimeFeatures: ["eval and Function", "runtime-computed imports", "generators", "JavaScript exception semantics", "undeclared JavaScript host globals", "any", "unknown without a concrete native shape", "for-in", "non-indexable for-of", "local async closure captures", "destructuring defaults and rest across suspension"],
    sourceFiles: sourceEntries.map(entry => entry.path), sourceHash, loweredSourceHashes, abiFunctions, variants: serialisableVariants,
  }, null, 2)}\n`);
  console.log(`Baguette ${BAGUETTE_VERSION} generated native ${config.name ?? "Module"} WebAssembly from ${sourceEntries.length} TypeScript modules`);
  console.log(`  entries: ${config.entries.join(", ")}`);
  console.log(`  ABI: ${abiFunctions.length} direct WebAssembly function exports`);
  for (const variant of variants) { const result = variantResults[`${variant.name}.wasm`]!; console.log(`  ${result.file}  ${result.bytes} bytes  sha256 ${result.sha256}`); }
  console.log(`  deterministic rebuild: ${skipDeterminism ? "skipped" : "verified"}`);
  console.log("  native module instantiation and configured ABI checks: verified");
}

// The compiler is an explicit build process. Terminating here prevents Bun or
// a backend shared-memory instance from retaining the event loop after all
// artefacts and verification results have been written.
processHost.exit(0);
