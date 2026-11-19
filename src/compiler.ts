#!/usr/bin/env bun

import type { BaguetteConfig } from "./contracts.ts";
import processHost from "node:process";
import * as fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import * as pathHost from "node:path";
import { spawn } from "node:child_process";
import { parseConfig, parseJsonObject } from "./contracts.ts";
import { required } from "./required.ts";
import "./bake-stage.ts";
import { modularWat } from "./wat-modules.ts";
import ts from "typescript";
import { nativeParameter, nativeVariable, nativeProperty, nativeFunction, nativeMethod, annotateCallable, annotateBinding } from "./ast.ts";
import { assertCanonicalThistleSource } from "./source-contract.ts";

/** Baguette 1.0.1: kernel-independent ahead-of-time TypeScript-to-WebAssembly compiler. */
const BAGUETTE_VERSION = "1.0.1";
const MANIFEST_SCHEMA = 3;

interface BunResult { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; }
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

const root = processHost.cwd();
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const optionValue = (name: string): string | null => {
  const prefix = `${name}=`;
  const direct = processHost.argv.find(value => value.startsWith(prefix)) ?? null;
  if (direct) return direct.slice(prefix.length);
  const index = processHost.argv.indexOf(name);
  return index >= 0 ? processHost.argv[index + 1] ?? null : null;
};
const hasOption = (name: string): boolean => processHost.argv.includes(name);
const validateOnly = hasOption("--validate-only");
const skipDeterminism = hasOption("--skip-determinism-check");
const skipOptimiser = hasOption("--skip-wasm-opt");
const emitModularWat = hasOption("--emit-modular-wat");
const configPath = pathHost.resolve(root, optionValue("--config") ?? "baguette.config.json");
const configRoot = pathHost.dirname(configPath);

/** Retry only timed-out backend jobs; a normal nonzero exit indicates a compiler fault, not a transient timeout. */
const run = async (command: string[], label: string, attempts = 1, timeoutMs = 240_000): Promise<BunResult> => {
  // A timeout can leave a backend in a partial state; retries must spawn a fresh process. A normal compiler rejection is final.
  if (!(command[0] ?? null)) throw new Error(`${label} has no executable`);
  let lastExit = -1;
  let lastTimedOut = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const child = spawn(required(command[0] ?? null, "backend executable"), command.slice(1), { cwd: root, env: processHost.env, stdio: "inherit" });
    const exited = new Promise<number>(resolve => {
      child.once("exit", code => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const exitCode = await exited;
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
const readBytes = async (path: string): Promise<Uint8Array<ArrayBuffer>> => Uint8Array.from(await fs.readFile(path));
const readText = async (path: string): Promise<string> => fs.readFile(path, "utf8");
const normalise = (value: string): string => pathHost.normalize(pathHost.resolve(configRoot, value));
const relative = (value: string): string => pathHost.relative(root, value).split(pathHost.sep).join("/");
const lineAndColumn = (source: ts.SourceFile, position: number): string => {
  const place = source.getLineAndCharacterOfPosition(position);
  return `${relative(source.fileName)}:${place.line + 1}:${place.character + 1}`;
};
const diagnosticText = (diagnostic: ts.Diagnostic): string => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const file = diagnostic.file ?? null;
  const start = diagnostic.start ?? null;
  if (!file || start === null) return message;
  return `${lineAndColumn(file, start)}: ${message}`;
};
const config: BaguetteConfig = parseConfig(await readText(configPath));
assertCanonicalThistleSource(config);
if (!Array.isArray(config.entries) || config.entries.length === 0) throw new Error(`${relative(configPath)} must define at least one TypeScript entry module`);
const projectPath = normalise(config.project ?? "tsconfig.json");
const generated = normalise(config.generatedDir ?? "build/teto-generated");
const output = normalise(config.outDir ?? "dist/teto");
const moduleBaseName = config.moduleBaseName ?? "teto";
const variants = config.variants.length ? config.variants : [{ name: moduleBaseName, threaded: false, preludeFile: null }, { name: `${moduleBaseName}-threads`, threaded: true, preludeFile: null }];
const intrinsicModules = new Set((config.intrinsicModules ?? []).map(normalise));

const defaultTypeAliases: Record<string, string> = {};
const typeAliases = new Map(Object.entries({ ...defaultTypeAliases, ...(config.typeAliases ?? {}) }));
const defaultAbiTypes: Record<string, "number" | "bigint" | "void"> = { number: "number", bigint: "bigint", boolean: "number", void: "void" };
const abiTypes = new Map(Object.entries({ ...defaultAbiTypes, ...(config.abiTypes ?? {}) }));

const configFile = ts.readJsonConfigFile(projectPath, ts.sys.readFile);
const parsedProject = ts.parseJsonSourceFileConfigFileContent(configFile, ts.sys, pathHost.dirname(projectPath), {
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

const resolveDependency = (source: ts.SourceFile, specifier: string): string | null => {
  const result = ts.resolveModuleName(specifier, source.fileName, compilerOptions, ts.sys).resolvedModule ?? null;
  if (!result || (result.isExternalLibraryImport ?? false)) return null;
  const resolved = pathHost.normalize(pathHost.resolve(result.resolvedFileName.replace(/\.d\.ts$/, ".ts")));
  return sourceByAbsolute.has(resolved) ? resolved : null;
};
const typeOnlyImport = (statement: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
  if (ts.isExportDeclaration(statement)) return statement.isTypeOnly;
  const clause = statement.importClause ?? null;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings ?? null;
  return Boolean(bindings && ts.isNamedImports(bindings) && bindings.elements.every(item => item.isTypeOnly));
};
const dependencies = new Map<string, string[]>();
const unresolvedRuntimeImports: string[] = [];
for (const [absolute, source] of sourceByAbsolute) {
  const items: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier ?? null;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const dependency = resolveDependency(source, specifier.text);
      if (dependency) {
        items.push(dependency);
        continue;
      }
      const importIsTypeOnly = typeOnlyImport(statement);
      if (!importIsTypeOnly) unresolvedRuntimeImports.push(`${relative(source.fileName)} imports external runtime module ${JSON.stringify(specifier.text)}`);
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
  const source = required(sourceByAbsolute.get(absolutePath) ?? null, "sourceByAbsolute.get(absolutePath)");
  const text = await readText(absolutePath);
  sourceEntries.push({ path: relative(absolutePath), absolutePath, text, source, sha256: await sha256(encoder.encode(text)) });
}

const impossibleRuntimeIdentifiers = new Set(["Bun", "Function", "Proxy", "Reflect", "WeakMap", "WeakSet", "WebSocket", "document", "eval", "fetch", "navigator", "process", "require", "window"]);
const asyncLowering = config.asyncLowering ?? "state-machine";
interface BaguetteDiagnostic {
  readonly code: string;
  readonly node: ts.Node;
  readonly message: string;
  readonly hint: string | null;
}
const diagnosticLine = (source: ts.SourceFile, diagnostic: BaguetteDiagnostic): string => {
  const head = `${lineAndColumn(source, diagnostic.node.getStart(source))}: ${diagnostic.code}: ${diagnostic.message}`;
  return diagnostic.hint ? `${head}\n  hint: ${diagnostic.hint}` : head;
};
const isExplicitAny = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.AnyKeyword;
const isExplicitUnknown = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.UnknownKeyword;
const functionHasAsyncModifier = (node: ts.Node): boolean => ts.isFunctionLike(node)
  && ts.canHaveModifiers(node)
  && Boolean((ts.getModifiers(node) ?? []).some(item => item.kind === ts.SyntaxKind.AsyncKeyword));
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
  const fail = (node: ts.Node, code: string, message: string, hint: string | null = null): void => { errors.push({ node, code, message, hint }); };
  const validateVariable = (name: ts.Identifier): void => {
    const inferred = checker.getTypeAtLocation(name);
    if (inferred.flags & ts.TypeFlags.Any) {
      fail(name, "BQ1001", `inferred type of ${name.text} is any and has no deterministic native memory shape`, "Add a concrete type annotation or replace the value with a tagged union or opaque handle.");
    }
    if (inferred.flags & ts.TypeFlags.Unknown) {
      fail(name, "BQ1002", `inferred type of ${name.text} is unknown and cannot be materialised`, "Narrow the value to a concrete native type before storing it.");
    }
  };
  const validateParameter = (name: ts.Identifier): void => {
    const inferred = checker.getTypeAtLocation(name);
    if (inferred.flags & ts.TypeFlags.Any) {
      fail(name, "BQ1001", `parameter ${name.text} is implicitly any`, "Give the parameter an explicit native type. Baguette will not insert a dynamic JavaScript value representation.");
    }
    if (inferred.flags & ts.TypeFlags.Unknown) {
      fail(name, "BQ1002", `parameter ${name.text} remains unknown at the native boundary`, "Use a concrete type, tagged union, interface/class layout or numeric handle.");
    }
  };
  const validateAsync = (node: ts.Node): void => {
    const topLevelExpression = (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      && ts.isVariableDeclaration(node.parent)
      && ts.isIdentifier(node.parent.name)
      && ts.isVariableDeclarationList(node.parent.parent)
      && node.parent.parent.declarations.length === 1
      && ts.isVariableStatement(node.parent.parent.parent)
      && ts.isSourceFile(node.parent.parent.parent.parent);
    const classMethod = ts.isMethodDeclaration(node)
      && Boolean(node.body ?? null)
      && ts.isIdentifier(node.name)
      && ts.isClassDeclaration(node.parent)
      && Boolean(node.parent.name ?? null);
    if (!(ts.isFunctionDeclaration(node) && (node.name ?? null) && (node.body ?? null)) && !topLevelExpression && !classMethod) {
      fail(node, "BQ2003", "the current coroutine lowering supports named async functions, top-level async arrows/function expressions, and static or instance async methods", "Move local async closures into an explicit named function until their lexical capture shapes are materialised.");
    }
  };
  const validateRuntimeName = (node: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(node) ?? null;
    const declarations = symbol ? symbol.declarations ?? [] : [];
    const isLocal = declarations.some(declaration => !declaration.getSourceFile().isDeclarationFile);
    if (!isLocal) fail(node, "BQ1102", `${node.text} requires a JavaScript host runtime`, "Use an explicit numeric host capability or a native Wasm support routine instead.");
  };
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      fail(node, "BQ1101", "runtime-computed imports cannot be ahead-of-time compiled", "Use a statically resolvable import or expose the operation as an explicit host capability.");
    }
    if (asyncLowering === "reject" && (ts.isAwaitExpression(node) || functionHasAsyncModifier(node))) {
      fail(node, "BQ2001", "async/await lowering is disabled by this Baguette configuration", "Set asyncLowering to \"state-machine\" or rewrite the function as an explicit scheduler state machine.");
    }
    if (ts.isYieldExpression(node) || ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && Boolean(node.asteriskToken ?? null))) {
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
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !(node.type ?? null)) validateVariable(node.name);
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && !(node.type ?? null)) validateParameter(node.name);
    if (functionHasAsyncModifier(node) && asyncLowering === "state-machine") validateAsync(node);
    if (ts.isIdentifier(node) && impossibleRuntimeIdentifiers.has(node.text)) validateRuntimeName(node);
    ts.forEachChild(node, walk);
  };
  walk(entry.source);
  if (errors.length) throw new Error(`Baguette AOT validation failed for ${entry.path}:\n${errors.map(item => diagnosticLine(entry.source, item)).join("\n")}`);
};
for (const entry of sourceEntries) if (!intrinsicModules.has(entry.absolutePath)) validateSource(entry);

const exported = (node: ts.Node): boolean => Boolean(ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
const rawSymbolOf = (node: ts.Node): ts.Symbol | null => checker.getSymbolAtLocation(node) ?? null;
const symbolOf = (node: ts.Node): ts.Symbol | null => {
  const symbol = rawSymbolOf(node);
  if (!symbol) return null;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
};
const namespaceImportSymbol = (node: ts.Identifier): boolean => {
  const symbol = rawSymbolOf(node);
  return (symbol ? symbol.declarations ?? [] : []).some(ts.isNamespaceImport);
};
const abiExports = config.abi.exports ?? null;
const explicitAbiNames = Array.isArray(abiExports) ? new Set(abiExports) : null;
const abiSymbols = new Map<ts.Symbol, string>();
const abiFunctions: AbiFunction[] = [];
const explicitTypeName = (type: ts.TypeNode | null): string => {
  if (!type) return "";
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return type.typeName.text;
  if (type.kind === ts.SyntaxKind.NumberKeyword) return "number";
  if (type.kind === ts.SyntaxKind.BigIntKeyword) return "bigint";
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return "boolean";
  if (type.kind === ts.SyntaxKind.VoidKeyword) return "void";
  return type.getText(type.getSourceFile());
};
const hostTypeFor = (type: ts.TypeNode | null, where: string): "number" | "bigint" | "void" => {
  const name = explicitTypeName(type);
  const mapped = abiTypes.get(name) ?? null;
  if (!mapped) throw new Error(`${where}: type ${name || "<inferred>"} cannot cross the WebAssembly numeric ABI; expose a pointer or handle instead`);
  return mapped;
};
const registerAbi = (name: ts.Identifier, parameters: readonly ts.ParameterDeclaration[], result: ts.TypeNode | null, source: ts.SourceFile): void => {
  const symbol = symbolOf(name);
  if (!symbol) throw new Error(`${lineAndColumn(source, name.getStart(source))}: cannot resolve ABI symbol ${name.text}`);
  const exportName = (config.abi.exportNames ?? {})[name.text] ?? name.text;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) throw new Error(`Invalid WebAssembly ABI identifier ${exportName}`);
  if (abiFunctions.some(item => item.name === exportName)) throw new Error(`duplicate WebAssembly ABI export ${exportName}`);
  abiSymbols.set(symbol, exportName);
  abiFunctions.push({
    name: exportName,
    sourceName: `${relative(source.fileName)}#${name.text}`,
    parameters: parameters.map(parameter => ({
      name: ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(source),
      sourceType: explicitTypeName(parameter.type ?? null),
      hostType: hostTypeFor(parameter.type ?? null, `${relative(source.fileName)}:${name.text}`),
    })),
    resultSourceType: explicitTypeName(result),
    resultHostType: hostTypeFor(result, `${relative(source.fileName)}:${name.text} return`),
  });
};
for (const entry of sourceEntries) {
  if (intrinsicModules.has(entry.absolutePath)) continue;
  for (const statement of entry.source.statements) {
    const name = ts.isFunctionDeclaration(statement) ? statement.name ?? null : null;
    if (ts.isFunctionDeclaration(statement) && name && (explicitAbiNames ? explicitAbiNames.has(name.text) : exported(statement))) {
      registerAbi(name, statement.parameters, statement.type ?? null, entry.source);
    }
    if (!ts.isVariableStatement(statement) || !exported(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer ?? null;
        if (!ts.isIdentifier(declaration.name) || !initializer || !ts.isArrowFunction(initializer)) continue;
        if (explicitAbiNames && !explicitAbiNames.has(declaration.name.text)) continue;
        registerAbi(declaration.name, initializer.parameters, initializer.type ?? null, entry.source);
      }
  }
}
const foundAbiNames = new Set(abiFunctions.map(item => item.sourceName.slice(item.sourceName.lastIndexOf("#") + 1)));
const missingAbiNames = [...(explicitAbiNames ?? [])].filter(name => !foundAbiNames.has(name));
if (missingAbiNames.length) throw new Error(`configured ABI exports were not found as exported functions: ${missingAbiNames.join(", ")}`);

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
    if (ts.isIdentifier(name)) { result.push(name); return; }
    for (const item of name.elements) if (ts.isBindingElement(item)) collectBinding(item.name);
  };
  const name = (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) ? statement.name ?? null : null;
  if (name && ts.isIdentifier(name)) result.push(name);
  if (ts.isVariableStatement(statement)) {
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

const stripExportModifiers = (modifiers: readonly ts.ModifierLike[] | null, keepExport: boolean): readonly ts.Modifier[] => {
  const kept = (modifiers ?? []).filter((modifier): modifier is ts.Modifier => ts.isModifier(modifier) && modifier.kind !== ts.SyntaxKind.DefaultKeyword && (keepExport || modifier.kind !== ts.SyntaxKind.ExportKeyword));
  return kept ?? [];
};
const assemblyType = (type: ts.TypeNode): ts.TypeNode => {
  const name = ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? type.typeName.text : null;
  if (name === "Promise" && ts.isTypeReferenceNode(type)) {
    const inner = (type.typeArguments ?? [])[0] ?? null;
    return !inner || inner.kind === ts.SyntaxKind.VoidKeyword ? ts.factory.createTypeReferenceNode("__BqTaskVoid")
      : ts.factory.createTypeReferenceNode("__BqTask", [assemblyType(inner)]);
  }
  const mapped = name ? typeAliases.get(name) ?? null : null;
  if (mapped && ts.isTypeReferenceNode(type)) return ts.factory.createTypeReferenceNode(mapped, (type.typeArguments ?? []).map(assemblyType));
  if (type.kind === ts.SyntaxKind.NumberKeyword) return ts.factory.createTypeReferenceNode("f64");
  if (type.kind === ts.SyntaxKind.BigIntKeyword) return ts.factory.createTypeReferenceNode("i64");
  if (type.kind === ts.SyntaxKind.BooleanKeyword) return ts.factory.createTypeReferenceNode("bool");
  return type;
};

/**
 * Materialise TypeScript's inferred types into the flattened AssemblyScript
 * programme. This is a correctness requirement, not merely an optimisation:
 * TypeScript widens `let value = 1` to `number` (IEEE-754 f64 semantics), while
 * AssemblyScript otherwise infers i32 from the same literal.
 */
const materialiseInferredTypes = config.materialiseInferredTypes !== false;
const unionType = (type: ts.UnionType, location: ts.Node, depth: number): ts.TypeNode | null => {
  const withoutUndefined = type.types.filter(item => !(item.flags & ts.TypeFlags.Undefined));
  const hasNullish = withoutUndefined.length !== type.types.length || type.types.some(item => Boolean(item.flags & ts.TypeFlags.Null));
  const concrete = withoutUndefined.filter(item => !(item.flags & ts.TypeFlags.Null));
  const single = concrete.length === 1 ? concrete[0] ?? null : null;
  if (single) return nullableType(single, hasNullish, location, depth);
  if (concrete.every(item => Boolean(item.flags & ts.TypeFlags.NumberLike))) return ts.factory.createTypeReferenceNode("f64");
  if (concrete.every(item => Boolean(item.flags & ts.TypeFlags.BooleanLike))) return ts.factory.createTypeReferenceNode("bool");
  if (concrete.every(item => Boolean(item.flags & ts.TypeFlags.StringLike))) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
  return null;
};
const tupleType = (type: ts.Type, location: ts.Node, depth: number): ts.TypeNode | null => {
  const elements = checker.getTypeArguments(type as ts.TypeReference);
  if (!elements.length) return ts.factory.createTypeReferenceNode("Array", [ts.factory.createTypeReferenceNode("f64")]);
  const nodes = elements.map(item => nativeTypeNode(item, location, depth + 1));
  if (nodes.some(item => !item)) return null;
  const printed = nodes.map(item => ts.createPrinter().printNode(ts.EmitHint.Unspecified, required(item, "item"), location.getSourceFile()));
  if (printed.every(item => item === (printed[0] ?? null))) return ts.factory.createTypeReferenceNode("Array", [required(nodes[0] ?? null, "nodes[0]")]);
  return null;
};
const callableType = (signature: ts.Signature, location: ts.Node, depth: number): ts.TypeNode | null => {
  const parameters: ts.ParameterDeclaration[] = [];
  for (const parameter of signature.getParameters()) {
    const declaration = (parameter.valueDeclaration ?? null) ?? ((parameter.declarations ?? [])[0] ?? null) ?? location;
    const parameterType = nativeTypeNode(checker.getTypeOfSymbolAtLocation(parameter, declaration), declaration, depth + 1);
    if (!parameterType) return null;
    parameters.push(nativeParameter(parameter.getName(), parameterType));
  }
  const result = nativeTypeNode(signature.getReturnType(), location, depth + 1);
  return result ? ts.factory.createFunctionTypeNode([], parameters, result) : null;
};
const symbolType = (symbol: ts.Symbol, type: ts.Type, location: ts.Node, depth: number): ts.TypeNode | null => {
  if (symbol.getName() === "Awaited") {
    const arguments_ = type.aliasTypeArguments ?? ((type as ts.TypeReference).typeArguments ?? []);
    const inner = arguments_[0] ?? null;
    return inner ? nativeTypeNode(inner, location, depth + 1) : null;
  }
  if (symbol.getName() === "Promise") return promiseType(type, location, depth);
  const mapped = typeAliases.get(symbol.getName()) ?? null;
  if (mapped) return ts.factory.createTypeReferenceNode(mapped);
  const replacement = abiSymbols.get(symbol) ?? (renamedSymbols.get(symbol) ?? symbol.getName());
  if (!replacement || replacement === "__type") return null;
  const arguments_ = type.aliasTypeArguments ?? ((type as ts.TypeReference).typeArguments ?? []);
  const typeArguments = arguments_.map(item => nativeTypeNode(item, location, depth + 1));
  if (typeArguments.some(item => !item)) return null;
  return typeArguments ? ts.factory.createTypeReferenceNode(replacement, typeArguments.map(item => required(item, "generic type argument"))) : ts.factory.createTypeReferenceNode(replacement);
};
const nullableType = (type: ts.Type, hasNullish: boolean, location: ts.Node, depth: number): ts.TypeNode | null => {
  const inner = nativeTypeNode(type, location, depth + 1);
  if (!inner) return null;
  // AssemblyScript permits null on managed references, not numeric storage.
  const primitive = type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike);
  return hasNullish && !primitive ? ts.factory.createUnionTypeNode([inner, ts.factory.createLiteralTypeNode(ts.factory.createNull())]) : inner;
};
const promiseType = (type: ts.Type, location: ts.Node, depth: number): ts.TypeNode | null => {
  const inner = (type.aliasTypeArguments ?? ((type as ts.TypeReference).typeArguments ?? []))[0] ?? null;
  if (!inner || inner.flags & ts.TypeFlags.Void) return ts.factory.createTypeReferenceNode("__BqTaskVoid");
  const innerNode = nativeTypeNode(inner, location, depth + 1);
  return innerNode ? ts.factory.createTypeReferenceNode("__BqTask", [innerNode]) : null;
};
// Materialise only AssemblyScript storage representations. Alias resolution precedes primitive widening; nullable references and callable types require structural conversion. A depth bound prevents recursive type expansion.
const nativeTypeNode = (type: ts.Type, location: ts.Node, depth = 0): ts.TypeNode | null => {
  // Resolve aliases before primitives to preserve explicit native widths; cap recursive expansion before inspecting structural types.
  if (depth > 16) return null;
  const aliasName = (type.aliasSymbol ?? null) ? required(type.aliasSymbol ?? null, "type alias").getName() : null;
  const awaitedAlias = aliasName === "Awaited" ? (type.aliasTypeArguments ?? [])[0] ?? null : null;
  if (awaitedAlias) return nativeTypeNode(awaitedAlias, location, depth + 1);
  const aliasType = aliasName ? typeAliases.get(aliasName) ?? null : null;
  if (aliasType) return ts.factory.createTypeReferenceNode(aliasType);
  const flags = type.flags;
  if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) return null;
  if (flags & ts.TypeFlags.NumberLike) return ts.factory.createTypeReferenceNode("f64");
  if (flags & ts.TypeFlags.BigIntLike) return ts.factory.createTypeReferenceNode("i64");
  if (flags & ts.TypeFlags.BooleanLike) return ts.factory.createTypeReferenceNode("bool");
  if (flags & ts.TypeFlags.StringLike) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
  if (flags & ts.TypeFlags.Void) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  if (flags & ts.TypeFlags.Never) return ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  if (flags & ts.TypeFlags.TypeParameter) {
    const symbol = type.getSymbol() ?? null;
    return symbol ? ts.factory.createTypeReferenceNode(symbol.getName()) : null;
  }
  if (type.isUnion()) return unionType(type, location, depth);
  if (checker.isTupleType(type)) return tupleType(type, location, depth);
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0] ?? null;
    const elementNode = element ? nativeTypeNode(element, location, depth + 1) : null;
    return elementNode ? ts.factory.createTypeReferenceNode("Array", [elementNode]) : null;
  }
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (signatures.length === 1) return callableType(required(signatures[0] ?? null, "signatures[0]"), location, depth);
  const symbol = type.aliasSymbol ?? (type.getSymbol() ?? null);
  if (symbol) return symbolType(symbol, type, location, depth);
  return null;
};
const declaredTypeOfSymbol = (symbol: ts.Symbol | null, seen = new Set<ts.Symbol>()): ts.TypeNode | null => {
  if (!symbol) return null;
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (seen.has(target)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(target);
  for (const declaration of target.declarations ?? []) {
    const declared = (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) ? declaration.type ?? null : null;
    if (declared) return assemblyType(declared);
    const initializer = (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) ? declaration.initializer ?? null : null;
    const inferred = initializer ? syntacticTypeOfExpression(initializer, nextSeen) : null;
    if (inferred) return inferred;
    const result = (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration) || ts.isGetAccessorDeclaration(declaration)) ? declaration.type ?? null : null;
    if (result) return assemblyType(result);
  }
  return null;
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
const callExpressionType = (expression: ts.CallExpression | ts.NewExpression): ts.TypeNode | null => {
  const signature = checker.getResolvedSignature(expression) ?? null;
  const declaration = signature ? signature.declaration ?? null : null;
  const declarationType = declaration && "type" in declaration ? declaration.type ?? null : null;
  if (declarationType && ts.isTypeNode(declarationType) && ts.isTypeReferenceNode(declarationType) && ts.isIdentifier(declarationType.typeName) && typeAliases.has(declarationType.typeName.text)) {
    return assemblyType(declarationType);
  }
  const instantiated = signature ? nativeTypeNode(signature.getReturnType(), expression) : null;
  if (instantiated) return instantiated;
  if (declarationType && ts.isTypeNode(declarationType)) return assemblyType(declarationType);
  return null;
};
const conditionalExpressionType = (expression: ts.ConditionalExpression, seen: Set<ts.Symbol>): ts.TypeNode | null => {
  const left = syntacticTypeOfExpression(expression.whenTrue, seen);
  const right = syntacticTypeOfExpression(expression.whenFalse, seen);
  const printer = ts.createPrinter();
  const source = expression.getSourceFile();
  if (left && right && printer.printNode(ts.EmitHint.Unspecified, left, source) === printer.printNode(ts.EmitHint.Unspecified, right, source)) return left;
  if (left && numericConstantExpression(expression.whenFalse)) return left;
  if (right && numericConstantExpression(expression.whenTrue)) return right;
  const conditionOperand = numericConstantExpression(expression.whenTrue) && numericConstantExpression(expression.whenFalse) && ts.isBinaryExpression(expression.condition)
    ? syntacticTypeOfExpression(expression.condition.left, seen) ?? syntacticTypeOfExpression(expression.condition.right, seen) : null;
  if (conditionOperand) return conditionOperand;
  if ((expression.whenTrue.kind === ts.SyntaxKind.TrueKeyword || expression.whenTrue.kind === ts.SyntaxKind.FalseKeyword) &&
      (expression.whenFalse.kind === ts.SyntaxKind.TrueKeyword || expression.whenFalse.kind === ts.SyntaxKind.FalseKeyword)) {
    return ts.factory.createTypeReferenceNode("bool");
  }
  return null;
};
const binaryExpressionType = (expression: ts.BinaryExpression, seen: Set<ts.Symbol>): ts.TypeNode | null => {
  const operator = expression.operatorToken.kind;
  const comparisonOperators = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InKeyword,
    ts.SyntaxKind.InstanceOfKeyword,
  ]);
  if (comparisonOperators.has(operator)) return ts.factory.createTypeReferenceNode("bool");
  return syntacticTypeOfExpression(expression.left, seen) ?? syntacticTypeOfExpression(expression.right, seen);
};
const syntacticTypeOfExpression = (expression: ts.Expression | null, seen = new Set<ts.Symbol>()): ts.TypeNode | null => {
  if (!expression) return null;
  if (ts.isBigIntLiteral(expression)) return ts.factory.createTypeReferenceNode("i64");
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return assemblyType(expression.type);
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return syntacticTypeOfExpression(expression.expression, seen);
  if (ts.isIdentifier(expression)) return declaredTypeOfSymbol(checker.getSymbolAtLocation(expression) ?? null, seen);
  if (ts.isPropertyAccessExpression(expression)) return declaredTypeOfSymbol(checker.getSymbolAtLocation(expression.name) ?? null, seen);
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) return callExpressionType(expression);
  if (ts.isConditionalExpression(expression)) return conditionalExpressionType(expression, seen);
  if (ts.isBinaryExpression(expression)) return binaryExpressionType(expression, seen);
  if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) return syntacticTypeOfExpression(expression.operand, seen);
  return null;
};
const returnedFromTypedFunction = (node: ts.Node): ts.TypeNode | null => {
  // A directly returned local inherits its enclosing explicit return representation, including async task results.
  if (!ts.isIdentifier(node)) return null;
  const symbol = symbolOf(node);
  if (!symbol) return null;
  let current: ts.Node | null = node;
  while (current && !ts.isFunctionLike(current)) current = current.parent ?? null;
  if (!current || !(ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current))) return null;
  const type = current.type ?? null;
  const body = current.body ?? null;
  if (!type || !ts.isTypeNode(type) || !body) return null;
  let returned = false;
  const walk = (candidate: ts.Node): void => {
    if (returned) return;
    if (candidate !== current && ts.isFunctionLike(candidate)) return;
    const value = ts.isReturnStatement(candidate) ? candidate.expression ?? null : null;
    if (value) {
      let expression: ts.Expression = value;
      while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
      returned = ts.isIdentifier(expression) && symbolOf(expression) === symbol;
    }
    ts.forEachChild(candidate, walk);
  };
  walk(body);
  if (!returned) return null;
  if (functionHasAsyncModifier(current) && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "Promise") {
    const inner = (type.typeArguments ?? [])[0] ?? null;
    return inner ? assemblyType(inner) : ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  }
  return assemblyType(type);
};
const inferredTypeFor = (node: ts.Node, initializer: ts.Expression | null = null): ts.TypeNode | null => {
  if (!materialiseInferredTypes) return null;
  return syntacticTypeOfExpression(initializer) ?? returnedFromTypedFunction(node) ?? nativeTypeNode(checker.getTypeAtLocation(node), node);
};
const inferredReturnTypeFor = (node: ts.SignatureDeclaration): ts.TypeNode | null => {
  if (!materialiseInferredTypes) return null;
  const fromBody = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !ts.isBlock(node.body) ? syntacticTypeOfExpression(node.body) : null;
  if (fromBody) return fromBody;
  const signature = checker.getSignatureFromDeclaration(node) ?? null;
  const declaration = signature ? signature.declaration ?? null : null;
  const declarationType = declaration && "type" in declaration ? declaration.type ?? null : null;
  return declarationType && ts.isTypeNode(declarationType) ? assemblyType(declarationType) : signature ? nativeTypeNode(signature.getReturnType(), node) : null;
};

// JavaScript Number conversion needs an explicit native cast. Preserve the
// caller's declared scalar width when crossing a typed parameter boundary.
const numberContext = (call: ts.CallExpression): ts.TypeNode => {
  const parent = call.parent;
  const declared = ts.isVariableDeclaration(parent) ? parent.type ?? null : null;
  if (declared) return assemblyType(declared);
  const invocation = ts.isCallExpression(parent) || ts.isNewExpression(parent) ? parent : null;
  const signature = invocation ? checker.getResolvedSignature(invocation) ?? null : null;
  const declaration = signature ? signature.declaration ?? null : null;
  const index = invocation ? (invocation.arguments ?? []).findIndex(argument => argument === call) : -1;
  const parameter = declaration ? declaration.parameters[index] ?? null : null;
  const annotation = parameter && ts.isParameter(parameter) ? parameter.type ?? null : null;
  return annotation && ts.isTypeNode(annotation) ? assemblyType(annotation) : ts.factory.createTypeReferenceNode("f64");
};
const builtinNumber = (name: ts.Identifier): boolean => {
  const symbol = checker.getSymbolAtLocation(name) ?? null;
  return name.text === "Number" && (symbol ? symbol.declarations ?? [] : []).some(declaration =>
    declaration.getSourceFile().isDeclarationFile && /(?:^|[\\/])lib\.[^\\/]+\.d\.ts$/.test(declaration.getSourceFile().fileName));
};

interface AsyncUnit {
  readonly name: ts.Identifier;
  readonly declaration: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
  readonly body: ts.Block;
  readonly parameters: readonly ts.ParameterDeclaration[];
  readonly typeParameters: readonly ts.TypeParameterDeclaration[];
  readonly frameTypeParameters: readonly ts.TypeParameterDeclaration[];
  readonly modifiers: readonly ts.ModifierLike[];
  readonly symbol: ts.Symbol;
  readonly receiverType: ts.TypeNode | null;
  readonly method: ts.MethodDeclaration | null;
}
const asyncFunctionDeclarations: AsyncUnit[] = [];
for (const entry of sourceEntries) {
  if (intrinsicModules.has(entry.absolutePath)) continue;
  const collectFunction = (node: ts.FunctionDeclaration, name: ts.Identifier, body: ts.Block): void => {
    const symbol = symbolOf(name);
    if (symbol) asyncFunctionDeclarations.push({ name, declaration: node, body, parameters: node.parameters, typeParameters: node.typeParameters ?? [], frameTypeParameters: node.typeParameters ?? [], modifiers: node.modifiers ?? [], symbol, receiverType: null, method: null });
  };
  // Instance coroutine frames carry the enclosing class's generic parameters and a receiver; static methods need neither receiver nor class parameters.
  const collectMethod = (node: ts.MethodDeclaration, name: ts.Identifier, body: ts.Block): void => {
    // Static frames omit the instance receiver and class type parameters; instance frames must retain both to resume correctly.
    if (!ts.isClassDeclaration(node.parent)) return;
    const parentName = node.parent.name ?? null;
    if (!parentName) return;
    const isStatic = Boolean((ts.getModifiers(node) ?? []).some(item => item.kind === ts.SyntaxKind.StaticKeyword));
    const symbol = symbolOf(name);
    const classSymbol = symbolOf(parentName);
    if (!symbol || !classSymbol) return;
      const className = abiSymbols.get(classSymbol) ?? (renamedSymbols.get(classSymbol) ?? parentName.text);
      const classTypeParameters = node.parent.typeParameters ?? [];
      const classTypeArguments = classTypeParameters.map(parameter => ts.factory.createTypeReferenceNode(parameter.name.text));
      const frameTypeParameters = isStatic ? [...(node.typeParameters ?? [])] : [...classTypeParameters, ...(node.typeParameters ?? [])];
      asyncFunctionDeclarations.push({
        name,
        declaration: node,
        body,
        parameters: node.parameters,
        typeParameters: node.typeParameters ?? [],
        frameTypeParameters,
        modifiers: node.modifiers ?? [],
        symbol,
        receiverType: isStatic ? null : ts.factory.createTypeReferenceNode(className, classTypeArguments),
        method: node,
      });
  };
  const collectAsync = (node: ts.Node, name: ts.Identifier, body: ts.Block): void => {
    if (ts.isFunctionDeclaration(node)) collectFunction(node, name, body);
    if (ts.isMethodDeclaration(node)) collectMethod(node, name, body);
  };
  const collect = (node: ts.Node): void => {
    const body = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.body ?? null : null;
    const name = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.name ?? null : null;
    if (body && name && ts.isIdentifier(name) && functionHasAsyncModifier(node)) collectAsync(node, name, body);
    ts.forEachChild(node, collect);
  };
  collect(entry.source);
  for (const statement of entry.source.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue;
    const variable = required(statement.declarationList.declarations[0] ?? null, "statement.declarationList.declarations[0]");
    const initializer = variable.initializer ?? null;
    if (!ts.isIdentifier(variable.name) || !initializer
      || !(ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
      || !functionHasAsyncModifier(initializer)) continue;
    const symbol = symbolOf(variable.name);
    if (!symbol) continue;
    const body = ts.isBlock(initializer.body)
      ? initializer.body
      : ts.factory.createBlock([ts.factory.createReturnStatement(initializer.body)], true);
    asyncFunctionDeclarations.push({
      name: variable.name,
      declaration: initializer,
      body,
      parameters: initializer.parameters,
      typeParameters: initializer.typeParameters ?? [],
      frameTypeParameters: initializer.typeParameters ?? [],
      modifiers: statement.modifiers ?? [],
      receiverType: null,
      method: null,
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
  return symbol ? abiSymbols.get(symbol) ?? (renamedSymbols.get(symbol) ?? name.text) : name.text;
};
const asyncHelpers = new Map<ts.Symbol, { frameName: string }>();
for (const unit of asyncFunctionDeclarations) {
  const symbol = unit.symbol;
  const stem = `${safeName(finalNameOf(unit.name))}_${shortHash(`${relative(unit.declaration.getSourceFile().fileName)}:${unit.declaration.getStart()}`)}`;
  asyncHelpers.set(symbol, { frameName: `__BqFrame_${stem}` });
}
const withoutAsyncModifier = (modifiers: readonly ts.ModifierLike[], keepExport: boolean): readonly ts.Modifier[] => {
  const kept = modifiers.filter((modifier): modifier is ts.Modifier => ts.isModifier(modifier)
    && modifier.kind !== ts.SyntaxKind.AsyncKeyword
    && modifier.kind !== ts.SyntaxKind.DefaultKeyword
    && (keepExport || modifier.kind !== ts.SyntaxKind.ExportKeyword));
  return kept;
};
const promisedResultType = (node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): { source: ts.Type; native: ts.TypeNode; isVoid: boolean } => {
  const signature = checker.getSignatureFromDeclaration(node) ?? null;
  if (!signature) throw new Error(`${lineAndColumn(node.getSourceFile(), node.getStart())}: BQ2004: cannot resolve async function signature`);
  const declared = node.type ?? null;
  const arguments_ = declared && ts.isTypeReferenceNode(declared) ? declared.typeArguments ?? [] : [];
  if (declared && ts.isTypeReferenceNode(declared) && ts.isIdentifier(declared.typeName)
    && declared.typeName.text === "Promise" && arguments_.length === 1) {
    const innerNode = required(arguments_[0] ?? null, "promise result type");
    const sourceType = checker.getTypeFromTypeNode(innerNode);
    const isVoid = innerNode.kind === ts.SyntaxKind.VoidKeyword || Boolean(sourceType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined));
    const native = isVoid ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword) : assemblyType(innerNode);
    return { source: sourceType, native, isVoid };
  }
  const promised = checker.getAwaitedType(signature.getReturnType()) ?? null;
  if (!promised) throw new Error(`${lineAndColumn(node.getSourceFile(), node.getStart())}: BQ2004: async function must return Promise<T>`);
  const isVoid = Boolean(promised.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined));
  const native = isVoid ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword) : nativeTypeNode(promised, node);
  if (!native) throw new Error(`${lineAndColumn(node.getSourceFile(), node.getStart())}: BQ2004: async result type ${checker.typeToString(promised)} has no native Wasm shape`);
  return { source: promised, native, isVoid };
};
const taskTypeFor = (result: { native: ts.TypeNode; isVoid: boolean }): ts.TypeNode => result.isVoid
  ? ts.factory.createTypeReferenceNode("__BqTaskVoid")
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
  readonly parameter: ts.ParameterDeclaration | null;
}
type AsyncAwaitKind = "variable" | "assignment" | "expression" | "return" | "capture";
interface AsyncAwaitPoint {
  readonly await: ts.AwaitExpression;
  readonly kind: AsyncAwaitKind;
  readonly target: ts.Expression | null;
  readonly captureField: string | null;
  readonly resultType: ts.TypeNode;
  readonly resultVoid: boolean;
  readonly field: string;
}

const lowerSource = (entry: SourceEntry): string => {
  if (intrinsicModules.has(entry.absolutePath)) return `// intrinsic module omitted: ${entry.path}`;
  const source = entry.source;
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => {
    const asyncSupportStatements: ts.Statement[] = [];
    let visit: ts.Visitor<ts.Node, ts.Node>;
    const lowerAsyncFunction = (unit: AsyncUnit): { readonly support: readonly ts.Statement[]; readonly wrapper: ts.FunctionDeclaration | ts.MethodDeclaration } => {
      const node = unit.declaration;
      const body = unit.body;
      for (const parameter of unit.parameters) {
        if (!ts.isIdentifier(parameter.name) || (parameter.dotDotDotToken ?? null)) {
          throw new Error(`${lineAndColumn(source, parameter.getStart(source))}: BQ2007: async coroutine parameters must currently be fixed named parameters`);
        }
      }

      const result = promisedResultType(node);
      const taskType = taskTypeFor(result);
      const functionSymbol = unit.symbol;
      const helper = asyncHelpers.get(functionSymbol) ?? null;
      if (!helper) throw new Error(`${lineAndColumn(source, node.getStart(source))}: BQ2013: missing coroutine helper identity`);
      const { frameName } = helper;
      const frameTypeArguments = unit.frameTypeParameters.map(parameter => ts.factory.createTypeReferenceNode(parameter.name.text));
      const frameTypeReference = ts.factory.createTypeReferenceNode(frameName, frameTypeArguments);
      const frameBindings = new Map<ts.Symbol, AsyncFrameBinding>();
      const bindings: AsyncFrameBinding[] = [];
      let bindingIndex = 0;
      const addBinding = (name: ts.Identifier, type: ts.TypeNode | null, parameter: ts.ParameterDeclaration | null = null): AsyncFrameBinding => {
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
      for (const parameter of unit.parameters) addBinding(parameter.name as ts.Identifier, parameter.type ?? null, parameter);
      const registerFrameName = (name: ts.Identifier, type: ts.TypeNode | null = null): void => {
        const symbol = symbolOf(name);
        if (symbol && !frameBindings.has(symbol)) addBinding(name, type);
      };
      const collectBindingIdentifiers = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) { registerFrameName(name); return; }
        for (const element of name.elements) {
          if (ts.isOmittedExpression(element)) continue;
          collectBindingIdentifiers(element.name);
        }
      };
      const collectFrameBindings = (current: ts.Node): void => {
        if (ts.isFunctionLike(current) && current !== node) return;
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) registerFrameName(current.name, current.type ?? null);
        if (ts.isVariableDeclaration(current) && !ts.isIdentifier(current.name)) collectBindingIdentifiers(current.name);
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
      interface AwaitSyntax {
        readonly awaitExpression: ts.AwaitExpression;
        readonly kind: AsyncAwaitKind;
        readonly target: ts.Expression | null;
      }
      const isAwaitInitializer = (value: ts.Expression | null): boolean => value !== null && ts.isAwaitExpression(value);
      const variableAwaitSyntax = (statement: ts.VariableStatement): AwaitSyntax | null => {
        const awaitedDeclarations = statement.declarationList.declarations.filter(item => isAwaitInitializer(item.initializer ?? null));
        if (!awaitedDeclarations.length) return null;
        if (statement.declarationList.declarations.length !== 1 || awaitedDeclarations.length !== 1) {
          throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2014: an awaited variable declaration must be the only declaration in its statement`);
        }
        const declaration = required(awaitedDeclarations[0] ?? null, "awaitedDeclarations[0]");
        const initializer = declaration.initializer ?? null;
        if (!ts.isIdentifier(declaration.name) || !initializer || !ts.isAwaitExpression(initializer)) return null;
        return { awaitExpression: initializer, kind: "variable", target: declaration.name };
      };
      const awaitSyntax = (statement: ts.Statement): AwaitSyntax | null => {
        if (ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)) return { awaitExpression: statement.expression, kind: "expression", target: null };
        if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
          && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isAwaitExpression(statement.expression.right))
          return { awaitExpression: statement.expression.right, kind: "assignment", target: statement.expression.left };
        if (ts.isVariableStatement(statement)) return variableAwaitSyntax(statement);
        const value = ts.isReturnStatement(statement) ? statement.expression ?? null : null;
        if (value && ts.isAwaitExpression(value)) return { awaitExpression: value, kind: "return", target: null };
        return null;
      };
      const classifyAwait = (statement: ts.Statement): AsyncAwaitPoint | null => {
        const syntax = awaitSyntax(statement);
        if (!syntax) return null;
        const { awaitExpression, kind, target } = syntax;
        const awaited = awaitResult(awaitExpression);
        const point: AsyncAwaitPoint = {
          await: awaitExpression,
          kind,
          target,
          captureField: null,
          resultType: awaited.native,
          resultVoid: awaited.isVoid,
          field: `__bq_await_${awaitIndex++}`,
        };
        allAwaitPoints.push(point);
        return point;
      };
      const collectAwaitPoints = (current: ts.Node): void => {
        if (ts.isFunctionLike(current) && current !== node) return;
        const point = ts.isStatement(current) ? classifyAwait(current) : null;
        if (point && ts.isStatement(current)) awaitPoints.set(current, point);
        ts.forEachChild(current, collectAwaitPoints);
      };
      collectAwaitPoints(body);

      const sequenceAlwaysReturns = (statements: readonly ts.Statement[]): boolean => {
        if (!statements.length) return false;
        return statementAlwaysReturns(required(statements[statements.length - 1] ?? null, "statements[statements.length - 1]"));
      };
      const statementAlwaysReturns = (statement: ts.Statement): boolean => {
        if (ts.isReturnStatement(statement)) return true;
        if (ts.isBlock(statement)) return sequenceAlwaysReturns(statement.statements);
        const alternative = ts.isIfStatement(statement) ? statement.elseStatement ?? null : null;
        if (alternative && ts.isIfStatement(statement)) return statementAlwaysReturns(statement.thenStatement) && statementAlwaysReturns(alternative);
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
      const frameReferenceVisitor: ts.Visitor<ts.Node, ts.Node> = current => {
        if (ts.isFunctionLike(current)) return current;
        if (unit.receiverType && current.kind === ts.SyntaxKind.ThisKeyword) return receiverAccess();
        if (current.kind === ts.SyntaxKind.SuperKeyword) {
          throw new Error(`${lineAndColumn(source, current.getStart(source))}: BQ2033: super access across async suspension needs an explicit base-receiver ABI`);
        }
        if (ts.isPrivateIdentifier(current)) {
          throw new Error(`${lineAndColumn(source, current.getStart(source))}: BQ2034: ECMAScript private fields cannot be accessed from a native coroutine resume function\n  hint: Use a TypeScript private/protected field or explicit accessor method.`);
        }
        const symbol = ts.isShorthandPropertyAssignment(current) ? symbolOf(current.name) : ts.isIdentifier(current) ? symbolOf(current) : null;
        const binding = symbol ? frameBindings.get(symbol) ?? null : null;
        if (binding && ts.isShorthandPropertyAssignment(current)) return ts.factory.createPropertyAssignment(current.name.text, bindingAccess(binding));
        if (binding && ts.isIdentifier(current)) return bindingAccess(binding);
        return ts.visitEachChild(current, frameReferenceVisitor, context);
      };
      const rewrite = (current: ts.Expression): ts.Expression =>
        ts.visitNode(ts.visitNode(current, frameReferenceVisitor, ts.isExpression), visit, ts.isExpression);
      const rewriteStatement = (current: ts.Statement): ts.Statement =>
        ts.visitNode(ts.visitNode(current, frameReferenceVisitor, ts.isStatement), visit, ts.isStatement);
      const firstAwaitIn = (root: ts.Node): ts.AwaitExpression | null => {
        let found: ts.AwaitExpression | null = null;
        const scan = (current: ts.Node): void => {
          if (found) return;
          if (ts.isFunctionLike(current) && current !== root) return;
          if (ts.isAwaitExpression(current)) { found = current; return; }
          ts.forEachChild(current, scan);
        };
        scan(root);
        return found;
      };
      const replaceNode = <T extends ts.Node>(root: ts.Node, target: ts.Node, replacement: ts.Expression, test: (node: ts.Node) => node is T): T => {
        const replacer: ts.Visitor<ts.Node, ts.Node> = current => current === target ? replacement : ts.visitEachChild(current, replacer, context);
        return ts.visitNode(root, replacer, test);
      };
      const literalOrStaticReference = (expression: ts.Expression): boolean => {
        while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
        if (ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword || ts.isLiteralExpression(expression)) return true;
        if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return true;
        if (ts.isPropertyAccessExpression(expression)) return literalOrStaticReference(expression.expression);
        return false;
      };
      const verifyBinaryAwait = (parent: ts.BinaryExpression, current: ts.Node, awaitExpression: ts.AwaitExpression): void => {
        const shortCircuit = parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
        if (shortCircuit && current === parent.right) {
          throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: await after a short-circuit operand requires expression-value spilling`);
        }
        if (current === parent.right && !literalOrStaticReference(parent.left)) {
          throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: an effectful expression is evaluated before this await\n  hint: Move the await into a temporary declaration so Baguette can preserve exact evaluation order.`);
        }
      };
      const verifyCallAwait = (parent: ts.CallExpression | ts.NewExpression, current: ts.Node, awaitExpression: ts.AwaitExpression): void => {
    
        const args = parent.arguments ?? ts.factory.createNodeArray<ts.Expression>();
        const argumentIndex = args.findIndex(item => item === current || item.pos <= current.pos && current.end <= item.end);
        if (argumentIndex >= 0 && (!literalOrStaticReference(parent.expression) || args.slice(0, argumentIndex).some(item => !literalOrStaticReference(item)))) {
            throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: an effectful call operand is evaluated before this await\n  hint: Split the preceding call operands into explicitly typed temporaries.`);
        }
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
          const current = required(ancestry[index] ?? null, "ancestry[index]");
          const parent = required(ancestry[index + 1] ?? null, "ancestry[index + 1]");
          if (ts.isBinaryExpression(parent)) verifyBinaryAwait(parent, current, awaitExpression);
          if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) verifyCallAwait(parent, current, awaitExpression);
          if (ts.isConditionalExpression(parent) && current !== parent.condition) {
            throw new Error(`${lineAndColumn(source, awaitExpression.getStart(source))}: BQ2018: await inside a conditional branch requires condition-value spilling`);
          }
        }
      };
      const resolveAndReturn = (expression: ts.Expression | null = null): ts.Block => {
        const args = expression ? [rewrite(expression)] : [];
        return ts.factory.createBlock([
          ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(taskAccess(), "__bq_resolve"), [], args)),
          ts.factory.createReturnStatement(),
        ], true);
      };
      const rewriteReturnsVisitor: ts.Visitor<ts.Node, ts.Node> = current => {
        if (ts.isFunctionLike(current)) return current;
        if (ts.isReturnStatement(current) && !result.isVoid && !(current.expression ?? null)) throw new Error(`${lineAndColumn(source, current.getStart(source))}: BQ2011: non-void async return requires a value`);
        if (ts.isReturnStatement(current)) return resolveAndReturn(current.expression ?? null);
        return ts.visitEachChild(current, rewriteReturnsVisitor, context);
      };
      const requiredFrameBinding = (name: ts.Identifier, description: string): AsyncFrameBinding => {
        const symbol = symbolOf(name);
        const binding = symbol ? frameBindings.get(symbol) ?? null : null;
        if (!binding) throw new Error(`${lineAndColumn(source, name.getStart(source))}: BQ2012: cannot find ${description} ${name.text}`);
        return binding;
      };
      const lowerVariables = (statement: ts.VariableStatement): readonly ts.Statement[] => {
        const assignments: ts.Statement[] = [];
        const lowerBindingAssignment = (name: ts.BindingName, value: ts.Expression): void => {
          if (ts.isIdentifier(name)) {
            const binding = requiredFrameBinding(name, "coroutine local");
            assignments.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(bindingAccess(binding), ts.SyntaxKind.EqualsToken, value)));
            return;
          }
          if (ts.isArrayBindingPattern(name)) {
            name.elements.forEach((element, index) => {
              if (ts.isOmittedExpression(element)) return;
              if ((element.dotDotDotToken ?? null) || (element.initializer ?? null)) {
                throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2021: destructuring defaults and rest bindings need dedicated native lowering\n  hint: Split this binding into explicit indexed assignments.`);
              }
              lowerBindingAssignment(element.name, ts.factory.createElementAccessExpression(value, ts.factory.createNumericLiteral(index)));
            });
            return;
          }
          for (const element of name.elements) {
            if ((element.dotDotDotToken ?? null) || (element.initializer ?? null)) {
              throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2021: destructuring defaults and rest bindings need dedicated native lowering\n  hint: Split this binding into explicit property assignments.`);
            }
            const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : null);
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
          const initializer = declaration.initializer ?? null;
          if (!initializer) continue;
          if (ts.isIdentifier(declaration.name)) {
            lowerBindingAssignment(declaration.name, rewrite(initializer));
            continue;
          }
          const rewrittenInitializer = rewrite(initializer);
          const initializerType = initializer.pos >= 0
            ? nativeTypeNode(checker.getTypeAtLocation(initializer), initializer)
            : null;
          if (!initializerType && literalOrStaticReference(rewrittenInitializer)) {
            lowerBindingAssignment(declaration.name, rewrittenInitializer);
            continue;
          }
          if (!initializerType) {
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
      };
      const lowerOrdinaryStatement = (statement: ts.Statement): readonly ts.Statement[] => {
        if (ts.isVariableStatement(statement)) return lowerVariables(statement);
        const returnsLowered = ts.visitNode(statement, rewriteReturnsVisitor, ts.isStatement);
        return [rewriteStatement(returnsLowered)];
      };

      const awaitTaskAccess = (point: AsyncAwaitPoint): ts.PropertyAccessExpression => ts.factory.createPropertyAccessExpression(frameIdentifier, point.field);
      const consumeAwait = (point: AsyncAwaitPoint): ts.Statement[] => {
        const resumed = ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(awaitTaskAccess(point), "__bq_resume"), [], []);
        if (point.kind === "expression") return [ts.factory.createExpressionStatement(resumed)];
        if (point.kind === "return") return [resolveAndReturn(point.resultVoid ? null : resumed)];
        if (point.kind === "variable" && point.target && ts.isIdentifier(point.target)) {
          const binding = requiredFrameBinding(point.target, "coroutine local");
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
      interface LoopTargets { readonly breakState: number; readonly continueState: number | null; }

      const compileAwait = (point: AsyncAwaitPoint, next: number): number => {
        const resumeBody = consumeAwait(point);
        if (point.kind !== "return") resumeBody.push(...setStateAndContinue(next));
        const resumeState = allocateState(resumeBody);
        const taskExpression = rewrite(point.await.expression);
        const setTask = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(awaitTaskAccess(point), ts.SyntaxKind.EqualsToken, taskExpression));
        const setResumeState = ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"), ts.SyntaxKind.EqualsToken, ts.factory.createNumericLiteral(resumeState)));
        const suspend = ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(awaitTaskAccess(point), "__bq_suspend"), [], [frameIdentifier]));
        const notReady = ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken,
          ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(awaitTaskAccess(point), "__bq_ready"), [], []));
        return allocateState([
          setTask,
          setResumeState,
          ts.factory.createIfStatement(notReady, ts.factory.createBlock([suspend, ts.factory.createReturnStatement()], true)),
          ts.factory.createContinueStatement(),
        ]);
      };

      const compileNestedExpressionAwait = (statement: ts.Statement, next: number, loop: LoopTargets | null = null): number | null => {
        const awaitExpression = firstAwaitIn(statement);
        if (!awaitExpression) return null;
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
          target: null,
          captureField,
          resultType: awaited.native,
          resultVoid: false,
          field: `__bq_await_${awaitIndex++}`,
        };
        allAwaitPoints.push(point);
        const captureAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, captureField);
        const remainder = replaceNode(statement, awaitExpression, captureAccess, ts.isStatement);
        const remainderEntry = compileStatement(remainder, next, loop);
        return compileAwait(point, remainderEntry);
      };

      const compileConditionalExpression = (expression: ts.Expression, trueState: number, falseState: number): number => {
        const awaitExpression = firstAwaitIn(expression);
        if (awaitExpression) return compileAwaitCondition(expression, awaitExpression, trueState, falseState);
        const choose = ts.factory.createConditionalExpression(rewrite(expression), ts.factory.createToken(ts.SyntaxKind.QuestionToken), ts.factory.createNumericLiteral(trueState), ts.factory.createToken(ts.SyntaxKind.ColonToken), ts.factory.createNumericLiteral(falseState));
        return allocateState([
          ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(frameIdentifier, "__bq_state"), ts.SyntaxKind.EqualsToken, choose)),
          ts.factory.createContinueStatement(),
        ]);
      };
      const compileAwaitCondition = (expression: ts.Expression, awaitExpression: ts.AwaitExpression, trueState: number, falseState: number): number => {
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
          target: null,
            captureField,
            resultType: awaited.native,
            resultVoid: false,
            field: `__bq_await_${awaitIndex++}`,
          };
          allAwaitPoints.push(point);
          const remainder = replaceNode(expression, awaitExpression, ts.factory.createPropertyAccessExpression(frameIdentifier, captureField), ts.isExpression);
          const remainderEntry = compileConditionalExpression(remainder, trueState, falseState);
          return compileAwait(point, remainderEntry);
      };

      let compileStatement: (statement: ts.Statement, next: number, ...loop: [] | [LoopTargets | null]) => number;
      const compileSequence = (statements: readonly ts.Statement[], next: number, loop: LoopTargets | null = null): number => {
        let entry = next;
        for (let index = statements.length - 1; index >= 0; index--) entry = compileStatement(required(statements[index] ?? null, "statements[index]"), entry, loop);
        return entry;
      };
      const compileFor = (statement: ts.ForStatement, next: number): number => {
        const conditionAnchor = allocateState();
        const bodyAnchor = allocateState();
        const incrementAnchor = allocateState();
        const condition = statement.condition ?? null;
        const conditionEntry = condition
          ? compileConditionalExpression(condition, bodyAnchor, next)
          : allocateState(setStateAndContinue(bodyAnchor));
        stateBodies.set(conditionAnchor, setStateAndContinue(conditionEntry));
        const incrementor = statement.incrementor ?? null;
        const incrementEntry = incrementor
          ? compileStatement(ts.factory.createExpressionStatement(incrementor), conditionAnchor)
          : conditionAnchor;
        stateBodies.set(incrementAnchor, setStateAndContinue(incrementEntry));
        const bodyEntry = compileStatement(statement.statement, incrementAnchor, { breakState: next, continueState: incrementAnchor });
        stateBodies.set(bodyAnchor, setStateAndContinue(bodyEntry));
        const initializer = statement.initializer ?? null;
        if (!initializer) return conditionAnchor;
        if (ts.isVariableDeclarationList(initializer)) return compileStatement(ts.factory.createVariableStatement([], initializer), conditionAnchor);
        return compileStatement(ts.factory.createExpressionStatement(initializer), conditionAnchor);
      };
      const compileBreak = (statement: ts.BreakStatement, loop: LoopTargets | null = null): number => {
        if (!loop) throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2015: break is not inside a lowered loop`);
        return allocateState(setStateAndContinue(loop.breakState));
      };
      const compileContinue = (statement: ts.ContinueStatement, loop: LoopTargets | null = null): number => {
        if (!loop || loop.continueState == null) throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2016: continue is not inside a lowered loop`);
        return allocateState(setStateAndContinue(loop.continueState));
      };
      const compileSwitch = (statement: ts.SwitchStatement, next: number, loop: LoopTargets | null = null): number => {
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
          const clause = required(statement.caseBlock.clauses[index] ?? null, "statement.caseBlock.clauses[index]");
          const entry = compileSequence(clause.statements, fallthroughState, { breakState: next, continueState: loop ? loop.continueState : null });
          clauseEntries.set(clause, entry);
          fallthroughState = entry;
        }

        // JavaScript evaluates case labels from top to bottom until one matches.
        // Each label therefore receives its own resumable state. A label may
        // suspend without evaluating later labels or losing the discriminant.
        const defaultClause = statement.caseBlock.clauses.find(ts.isDefaultClause) ?? null;
        let dispatchEntry = defaultClause ? required(clauseEntries.get(defaultClause) ?? null, "clauseEntries.get(defaultClause)") : next;
        for (let index = statement.caseBlock.clauses.length - 1; index >= 0; index--) {
          const clause = required(statement.caseBlock.clauses[index] ?? null, "statement.caseBlock.clauses[index]");
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
                ts.factory.createNumericLiteral(required(clauseEntries.get(clause) ?? null, "clauseEntries.get(clause)")),
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
      };
      const compileForOf = (statement: ts.ForOfStatement, next: number, loop: LoopTargets | null = null): number => {
        const iterableSourceType = checker.getTypeAtLocation(statement.expression);
        const numericIndexType = checker.getIndexTypeOfType(iterableSourceType, ts.IndexKind.Number) ?? null;
        const lengthProperty = iterableSourceType.getProperty("length") ?? null;
        if (!numericIndexType || !lengthProperty) {
          throw new Error(`${lineAndColumn(source, statement.expression.getStart(source))}: BQ2026: for-of currently requires a statically indexable value with numeric elements and length\n  hint: Use an Array, tuple or StaticArray, or lower the iterator explicitly.`);
        }
        const iterableType = nativeTypeNode(iterableSourceType, statement.expression);
        if (!iterableType) throw new Error(`${lineAndColumn(source, statement.expression.getStart(source))}: BQ2026: for-of iterable has no concrete native shape`);
        const iterableField = `__bq_forof_values_${expressionCaptureIndex++}`;
        const indexField = `__bq_forof_index_${expressionCaptureIndex++}`;
        expressionCaptureFields.push({ field: iterableField, type: iterableType });
        expressionCaptureFields.push({ field: indexField, type: ts.factory.createTypeReferenceNode("i32") });
        const iterableAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, iterableField);
        const indexAccess = ts.factory.createPropertyAccessExpression(frameIdentifier, indexField);
        const elementAccess = ts.factory.createElementAccessExpression(iterableAccess, indexAccess);
        const bindElementStatements: ts.Statement[] = [];
        const bindForOfName = (name: ts.BindingName, value: ts.Expression): void => {
          if (ts.isIdentifier(name)) {
            const binding = requiredFrameBinding(name, "coroutine for-of local");
            bindElementStatements.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(bindingAccess(binding), ts.SyntaxKind.EqualsToken, value)));
            return;
          }
          if (ts.isArrayBindingPattern(name)) {
            name.elements.forEach((element, elementIndex) => {
              if (ts.isOmittedExpression(element)) return;
              if ((element.dotDotDotToken ?? null) || (element.initializer ?? null)) {
                throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2027: for-of destructuring defaults and rest require explicit native assignments`);
              }
              bindForOfName(element.name, ts.factory.createElementAccessExpression(value, ts.factory.createNumericLiteral(elementIndex)));
            });
            return;
          }
          for (const element of name.elements) {
            if ((element.dotDotDotToken ?? null) || (element.initializer ?? null)) {
              throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2027: for-of destructuring defaults and rest require explicit native assignments`);
            }
            const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : null);
            if (!property || ts.isComputedPropertyName(property)) {
              throw new Error(`${lineAndColumn(source, element.getStart(source))}: BQ2022: computed destructuring keys have no fixed native field offset`);
            }
            const access = ts.isIdentifier(property) || ts.isPrivateIdentifier(property)
              ? ts.factory.createPropertyAccessExpression(value, property.text)
              : ts.factory.createElementAccessExpression(value, property);
            bindForOfName(element.name, access);
          }
        };
        if (ts.isVariableDeclarationList(statement.initializer) && statement.initializer.declarations.length !== 1) {
          throw new Error(`${lineAndColumn(source, statement.initializer.getStart(source))}: BQ2027: for-of requires exactly one declaration`);
        }
        if (ts.isVariableDeclarationList(statement.initializer)) {
          bindForOfName(required(statement.initializer.declarations[0] ?? null, "statement.initializer.declarations[0]").name, elementAccess);
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
      };
      compileStatement = (statement: ts.Statement, next: number, loop: LoopTargets | null = null): number => {
        const point = awaitPoints.get(statement) ?? null;
        if (point) return compileAwait(point, next);
        if (ts.isBlock(statement)) return compileSequence(statement.statements, next, loop);
        if (ts.isEmptyStatement(statement)) return next;
        const nested = (ts.isExpressionStatement(statement) || ts.isReturnStatement(statement) || ts.isVariableStatement(statement)) && containsNestedAwait(statement)
          ? compileNestedExpressionAwait(statement, next, loop) : null;
        if (nested !== null) return nested;
        if (ts.isReturnStatement(statement)) {
          const expression = statement.expression ?? null;
          const body = result.isVoid
            ? [...resolveAndReturn(expression).statements]
            : expression
              ? [...resolveAndReturn(expression).statements]
              : (() => { throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2011: non-void async return requires a value`); })();
          return allocateState(body);
        }
        if (ts.isIfStatement(statement)) {
          const thenState = compileStatement(statement.thenStatement, next, loop);
          const alternative = statement.elseStatement ?? null;
           const elseState = alternative ? compileStatement(alternative, next, loop) : next;
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
        if (ts.isForStatement(statement)) return compileFor(statement, next);
        if (ts.isBreakStatement(statement)) return compileBreak(statement, loop);
        if (ts.isContinueStatement(statement)) return compileContinue(statement, loop);
        if (ts.isSwitchStatement(statement)) return compileSwitch(statement, next, loop);
        if (ts.isForOfStatement(statement)) return compileForOf(statement, next, loop);
        if (ts.isForInStatement(statement) && containsNestedAwait(statement)) throw new Error(`${lineAndColumn(source, statement.getStart(source))}: BQ2017: await inside for-in requires dynamic property-iterator lowering`);
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
        nativeProperty("__bq_state", ts.factory.createTypeReferenceNode("i32"), ts.factory.createNumericLiteral(entryState)),
        nativeProperty("__bq_task", taskType, null),
      ];
      if (unit.receiverType) frameMembers.push(nativeProperty("__bq_this", unit.receiverType, null));
      for (const binding of bindings) frameMembers.push(nativeProperty(binding.field, binding.type, null));
      for (const capture of expressionCaptureFields) frameMembers.push(nativeProperty(capture.field, capture.type, null));
      for (const point of allAwaitPoints) frameMembers.push(nativeProperty(point.field, taskTypeFor({ native: point.resultType, isVoid: point.resultVoid }), null));
      const constructorParameters: ts.ParameterDeclaration[] = [
        nativeParameter("__bq_task", taskType),
        ...(unit.receiverType ? [nativeParameter("__bq_this", unit.receiverType)] : []),
        ...bindings.filter(item => item.parameter).map(item => nativeParameter(required(item.parameter, "item.parameter").name, item.type)),
      ];
      const constructorStatements: ts.Statement[] = [
        ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createSuper(), [], [])),
        ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), "__bq_task"), ts.SyntaxKind.EqualsToken, ts.factory.createIdentifier("__bq_task"))),
      ];
      if (unit.receiverType) constructorStatements.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), "__bq_this"), ts.SyntaxKind.EqualsToken, ts.factory.createIdentifier("__bq_this"))));
      for (const binding of bindings.filter(item => item.parameter)) {
        const name = (required(binding.parameter, "binding.parameter").name as ts.Identifier).text;
        constructorStatements.push(ts.factory.createExpressionStatement(ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(ts.factory.createThis(), binding.field), ts.SyntaxKind.EqualsToken, ts.factory.createIdentifier(name))));
      }
      frameMembers.push(ts.factory.createConstructorDeclaration([], constructorParameters, ts.factory.createBlock(constructorStatements, true)));
      const resumeBody = ts.factory.createBlock([
        ts.factory.createVariableStatement([], ts.factory.createVariableDeclarationList([
          nativeVariable(frameIdentifier, frameTypeReference, ts.factory.createThis()),
        ], ts.NodeFlags.Const)),
        ts.factory.createWhileStatement(ts.factory.createTrue(), ts.factory.createBlock([switchStatement], true)),
      ], true);
      frameMembers.push(nativeMethod({name: ts.factory.createIdentifier("__bq_resume_frame"), modifiers: [], typeParameters: [], parameters: [], returns: ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword), body: resumeBody, question: false}));
      const frameClass = ts.factory.createClassDeclaration(
        [],
        frameName,
        unit.frameTypeParameters,
        [ts.factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [ts.factory.createExpressionWithTypeArguments(ts.factory.createIdentifier("__BqContinuation"), [])])],
        frameMembers,
      );

      const taskVariable = ts.factory.createIdentifier("__bq_task");
      const localFrame = ts.factory.createIdentifier("__bq_start_frame");
      const newTask = result.isVoid
        ? ts.factory.createNewExpression(ts.factory.createIdentifier("__BqTaskVoid"), [], [])
        : ts.factory.createNewExpression(ts.factory.createIdentifier("__BqTask"), [result.native], []);
      const newFrameArguments: ts.Expression[] = [taskVariable, ...(unit.receiverType ? [ts.factory.createThis()] : []), ...unit.parameters.map(parameter => ts.factory.createIdentifier((parameter.name as ts.Identifier).text))];
      const wrapperBody = ts.factory.createBlock([
        ts.factory.createVariableStatement([], ts.factory.createVariableDeclarationList([
          nativeVariable(taskVariable, taskType, newTask),
        ], ts.NodeFlags.Const)),
        ts.factory.createVariableStatement([], ts.factory.createVariableDeclarationList([
          nativeVariable(localFrame, frameTypeReference, ts.factory.createNewExpression(ts.factory.createIdentifier(frameName), frameTypeArguments, newFrameArguments)),
        ], ts.NodeFlags.Const)),
        ts.factory.createExpressionStatement(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(localFrame, "__bq_resume_frame"), [], [])),
        ts.factory.createReturnStatement(taskVariable),
      ], true);
      const symbol = unit.symbol;
      const support = [frameClass].map(statement => ts.visitEachChild(statement, visit, context) as ts.Statement);
      const wrapper = unit.method
        ? nativeMethod({name: unit.method.name, modifiers: withoutAsyncModifier(unit.modifiers, false), question: Boolean(unit.method.questionToken ?? null), typeParameters: unit.typeParameters, parameters: unit.parameters, returns: taskType, body: wrapperBody})
        : nativeFunction({name: unit.name, modifiers: withoutAsyncModifier(unit.modifiers, Boolean(abiSymbols.has(symbol))), typeParameters: unit.typeParameters, parameters: unit.parameters, returns: taskType, body: wrapperBody});
      return { support, wrapper: ts.visitEachChild(wrapper, visit, context) as ts.FunctionDeclaration | ts.MethodDeclaration };
    };
    const findAsyncUnit = (name: ts.Identifier, location: ts.Node, kind: string, method: ts.MethodDeclaration | null = null): AsyncUnit => {
      const symbol = symbolOf(name);
      const unit = symbol ? asyncFunctionDeclarations.find(item => item.symbol === symbol && (!method || item.method === method)) ?? null : null;
      if (!unit) throw new Error(`${lineAndColumn(source, location.getStart(source))}: BQ2013: missing async ${kind} unit`);
      return unit;
    };
    const namespaceName = (name: ts.Identifier, node: ts.Node, kind: string): ts.Identifier => {
      const target = symbolOf(name);
      const replacement = target ? abiSymbols.get(target) ?? (renamedSymbols.get(target) ?? null) : null;
      if (!replacement) throw new Error(`${lineAndColumn(source, node.getStart(source))}: namespace ${kind} ${node.getText(source)} does not resolve to a flattened Baguette symbol`);
      return ts.factory.createIdentifier(replacement);
    };
    const flattenedName = (name: ts.Identifier): string | null => {
      const symbol = symbolOf(name);
      return symbol ? abiSymbols.get(symbol) ?? (renamedSymbols.get(symbol) ?? null) : null;
    };
    visit = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return [];
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && builtinNumber(node.expression)) {
        const argument = node.arguments[0] ?? null;
        return argument ? ts.factory.createTypeAssertion(numberContext(node), required(ts.visitNode(argument, visit, ts.isExpression) ?? null, "Number operand")) : ts.factory.createNumericLiteral(0);
      }
      const functionName = ts.isFunctionDeclaration(node) ? node.name ?? null : null;
      const hasBody = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && Boolean(node.body ?? null);
      if (ts.isFunctionDeclaration(node) && functionName && hasBody && functionHasAsyncModifier(node) && asyncLowering === "state-machine") {
        const lowered = lowerAsyncFunction(findAsyncUnit(functionName, node, "function"));
        return [...lowered.support, lowered.wrapper];
      }
      const declaration = ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0] ?? null : null;
      const initializer = declaration ? declaration.initializer ?? null : null;
      if (declaration && ts.isIdentifier(declaration.name) && initializer
        && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        && functionHasAsyncModifier(initializer) && asyncLowering === "state-machine") {
        const lowered = lowerAsyncFunction(findAsyncUnit(declaration.name, declaration, "expression"));
        return [...lowered.support, lowered.wrapper];
      }
      if (ts.isMethodDeclaration(node) && hasBody && ts.isIdentifier(node.name) && functionHasAsyncModifier(node) && asyncLowering === "state-machine") {
        const lowered = lowerAsyncFunction(findAsyncUnit(node.name, node, "method", node));
        asyncSupportStatements.push(...lowered.support);
        return lowered.wrapper;
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && ts.isIdentifier(node.expression) && namespaceImportSymbol(node.expression)) {
        return namespaceName(node.name, node, "member");
      }
      if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && namespaceImportSymbol(node.left)) {
        return namespaceName(node.right, node, "type");
      }
      const overloadName = ts.isMethodDeclaration(node) ? node.name : functionName;
      const overloadSymbol = overloadName && !hasBody ? symbolOf(overloadName) : null;
      const hasImplementation = (overloadSymbol ? overloadSymbol.declarations ?? [] : []).some(declaration =>
        (ts.isFunctionDeclaration(node) && ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(node) && ts.isMethodDeclaration(declaration)) && Boolean(declaration.body ?? null));
      if (hasImplementation) return [];
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) && !(node.type ?? null)) {
        const inferred = inferredTypeFor(node.name, node.initializer ?? null);
        return ts.visitEachChild(inferred ? annotateBinding(node, inferred) : node, visit, context);
      }
      if ((ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && !(node.type ?? null)) {
        const inferred = inferredReturnTypeFor(node);
        return ts.visitEachChild(inferred ? annotateCallable(node, inferred, node.modifiers ?? []) : node, visit, context);
      }
      if (ts.isArrowFunction(node) && !(node.type ?? null)) {
        const inferred = inferredReturnTypeFor(node);
        const annotated = inferred ? ts.factory.updateArrowFunction(node, node.modifiers ?? [], node.typeParameters ?? [], node.parameters, inferred, node.equalsGreaterThanToken, node.body) : node;
        return ts.visitEachChild(annotated, visit, context);
      }
      if (ts.isIdentifier(node)) {
        const replacement = flattenedName(node);
        return replacement && replacement !== node.text ? ts.factory.createIdentifier(replacement) : node;
      }
      const shorthand = ts.isShorthandPropertyAssignment(node) ? flattenedName(node.name) : null;
      if (shorthand && ts.isShorthandPropertyAssignment(node) && shorthand !== node.name.text) return ts.factory.createPropertyAssignment(node.name.text, ts.factory.createIdentifier(shorthand));
      if (ts.isTypeReferenceNode(node) || node.kind === ts.SyntaxKind.NumberKeyword || node.kind === ts.SyntaxKind.BigIntKeyword || node.kind === ts.SyntaxKind.BooleanKeyword) return ts.visitEachChild(assemblyType(node as ts.TypeNode), visit, context);
      if (ts.isBigIntLiteral(node)) {
        const literal = node.getText(source);
        return ts.factory.createNumericLiteral(literal.endsWith("n") ? literal.slice(0, -1) : literal);
      }
      if (ts.isAsExpression(node)) return ts.factory.createTypeAssertion(assemblyType(node.type), ts.visitNode(node.expression, visit, ts.isExpression));
      if (ts.isNonNullExpression(node)) {
        const narrowed = nativeTypeNode(checker.getTypeAtLocation(node), node);
        const expression = ts.visitNode(node.expression, visit, ts.isExpression);
        return narrowed ? ts.factory.createTypeAssertion(narrowed, expression) : expression;
      }
      if (ts.isSatisfiesExpression(node)) return ts.visitNode(node.expression, visit, ts.isExpression);
      if (ts.isVariableStatement(node) && declaration && ts.isIdentifier(declaration.name) && initializer && ts.isArrowFunction(initializer)) {
          const symbol = symbolOf(declaration.name);
          const isAbi = Boolean(symbol && abiSymbols.has(symbol));
          const arrow = initializer;
          const body = ts.isBlock(arrow.body) ? arrow.body : ts.factory.createBlock([ts.factory.createReturnStatement(arrow.body)], true);
          const functionNode = nativeFunction({modifiers: stripExportModifiers(node.modifiers ?? null, isAbi), name: declaration.name, typeParameters: arrow.typeParameters ?? [], parameters: arrow.parameters, returns: arrow.type ?? null, body});
          return ts.visitEachChild(functionNode, visit, context);
      }
      if (ts.isFunctionDeclaration(node) && functionName) {
        const symbol = symbolOf(functionName);
        return ts.visitEachChild(annotateCallable(node, node.type ?? inferredReturnTypeFor(node), stripExportModifiers(node.modifiers ?? null, Boolean(symbol && abiSymbols.has(symbol)))), visit, context);
      }
      const preserveRange = ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(item => item.kind === ts.SyntaxKind.ExportKeyword);
      const clone = ts.visitEachChild(node, visit, context);
      if (preserveRange && ts.canHaveModifiers(clone)) ts.setTextRange(clone, node);
      return clone;
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
    const lowered = required(result.transformed[0] ?? null, "result.transformed[0]");
    let printed = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false }).printFile(lowered);
    // Non-function exports are internal in the flattened module. AssemblyScript would otherwise expose mutable kernel state.
    printed = printed.replace(/^export\s+(?=(?:const|let|var|class|enum|namespace|interface|type)\b)/gm, "");
    return `// source: ${entry.path}\n${printed}`;
  } finally { result.dispose(); }
};

const compilerVersion = async (packagePath: string): Promise<string> => {
  const packageText = await readText(packagePath);
  const value = parseJsonObject(packageText);
  const version = value.version ?? null;
  return typeof version === "string" ? version : "unreported";
};
const ascVersion = await compilerVersion(`${root}/node_modules/assemblyscript/package.json`);
const tsVersion = ts.version;
const binaryenVersion = await compilerVersion(`${root}/node_modules/binaryen/package.json`);
const generatedBody = [asyncRuntimeSource, ...sourceEntries.map(lowerSource)].filter(Boolean).join("\n\n");
const customPrelude = config.preludeFile ? await readText(normalise(config.preludeFile)) : "";
const variantPreludes = new Map<string, { path: string | null; text: string; sha256: string }>();
for (const variant of variants) {
  const preludePath = variant.preludeFile ? normalise(variant.preludeFile) : null;
  const text = preludePath ? await readText(preludePath) : "";
  variantPreludes.set(variant.name, { path: preludePath ? relative(preludePath) : null, text, sha256: await sha256(encoder.encode(text)) });
}
const sourceHash = await sha256(encoder.encode(sourceEntries.map(entry => `${entry.path}\n${entry.text}`).join("\n")));
const loweredSourceHashes = Object.fromEntries(await Promise.all(variants.map(async variant => {
  const prelude = required(variantPreludes.get(variant.name) ?? null, "variantPreludes.get(variant.name)");
  return [variant.name, await sha256(encoder.encode(`${prelude.text}\n${customPrelude}\n${generatedBody}`))] as const;
})));

const allowedHostImports = config.allowedHostImports ?? [{ module: "env", name: "memory", kind: "memory" as const }];
const importKey = (item: { module: string; name: string; kind: WebAssembly.ImportExportKind }): string => `${item.module}\u0000${item.name}\u0000${item.kind}`;
const allowedImportKeys = new Set(allowedHostImports.map(importKey));
type NativeImport = WebAssembly.Memory | WebAssembly.Global | WebAssembly.Table | (() => number);
const instantiateImports = (threaded: boolean): Record<string, Record<string, NativeImport>> => {
  const imports: Record<string, Record<string, NativeImport>> = {};
  for (const item of allowedHostImports) {
    const namespace: Record<string, NativeImport> = imports[item.module] ?? {};
    imports[item.module] = namespace;
    if (item.kind === "memory") {
      namespace[item.name] = new WebAssembly.Memory({
        initial: Math.max(1024, config.memory.initialPages ?? 1024),
        maximum: config.memory.maximumPages ?? 32768,
        shared: threaded,
      });
    }
    if (item.kind === "function") namespace[item.name] = item.name === "abort" ? (() => { throw new Error("WebAssembly abort import invoked during Baguette verification"); }) : (() => 0);
    if (item.kind === "global") namespace[item.name] = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
    if (item.kind === "table") namespace[item.name] = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  }
  return imports;
};
const argumentValue = (value: number | string): number | bigint => typeof value === "number" ? value : BigInt(value);
const verifyFunction = (native: Record<string, WebAssembly.ExportValue>, wasmPath: string, name: string, args: Array<number | string> | null, expected: number | string | null): void => {
  const fn = native[name] ?? null;
  if (typeof fn !== "function") throw new Error(`${relative(wasmPath)} lacks verification function ${name}`);
  const result = (fn as (...args: Array<number | bigint>) => number | bigint | void)(...(args ?? []).map(argumentValue));
  if (expected != null && result !== argumentValue(expected)) throw new Error(`${relative(wasmPath)} ${name} returned ${String(result)}`);
};
const verifyModule = async (wasmPath: string, threaded: boolean): Promise<Omit<VariantResult, "file" | "bytes" | "sha256" | "threaded">> => {
  // Inspect the actual native module before instantiating it with the declared host capabilities.
  const bytes = await readBytes(wasmPath);
  if (!WebAssembly.validate(bytes)) throw new Error(`${relative(wasmPath)} is not valid WebAssembly`);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  const unexpectedImports = imports.filter(item => !allowedImportKeys.has(importKey(item)));
  if (unexpectedImports.length) throw new Error(`${relative(wasmPath)} has undeclared host imports: ${unexpectedImports.map(importKey).join(", ")}`);
  const exports = WebAssembly.Module.exports(module);
  const exportMap = new Map(exports.map(item => [item.name, item.kind]));
  for (const required of abiFunctions) if ((exportMap.get(required.name) ?? null) !== "function") throw new Error(`${relative(wasmPath)} is missing native function export ${required.name}`);
  const unexpectedKinds = config.abi.allowNonFunctionExports ? [] : exports.filter(item => item.kind !== "function");
  if (unexpectedKinds.length) throw new Error(`${relative(wasmPath)} unexpectedly exports non-function state: ${unexpectedKinds.map(item => `${item.name}:${item.kind}`).join(", ")}`);
  const instance = new WebAssembly.Instance(module, instantiateImports(threaded));
  const native = instance.exports as Record<string, WebAssembly.ExportValue>;
  const verification = config.abi.verify;
  if (verification && verification.init) verifyFunction(native, wasmPath, verification.init, verification.initArgs, verification.initExpected);
  if (verification && verification.valid) verifyFunction(native, wasmPath, verification.valid, verification.validArgs, verification.validExpected);
  for (const test of config.abi.tests ?? []) {
    const fn = native[test.function] ?? null;
    if (typeof fn !== "function") throw new Error(`${relative(wasmPath)} lacks ABI test function ${test.function}`);
    const result = (fn as (...args: Array<number | bigint>) => number | bigint | void)(...(test.args ?? []).map(argumentValue));
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

const reportValidation = (): void => {
  console.log(`Baguette ${BAGUETTE_VERSION} validated a ${sourceEntries.length}-module TypeScript programme from ${config.entries.length} entry point(s)`);
  console.log(`  configuration: ${relative(configPath)}`);
  console.log(`  native ABI exports: ${abiFunctions.length}`);
  console.log("  execution model: ahead-of-time WebAssembly; no JavaScript VM or bytecode interpreter");
};
const buildOutputs = async (): Promise<void> => {
  await fs.rm(generated, { recursive: true, force: true });
  mkdirSync(generated, { recursive: true });
  mkdirSync(output, { recursive: true });
  const variantResults: Record<string, VariantResult> = {};
  const modularLayouts: Record<string, string> = {};
  for (const variant of variants) {
    const sourcePath = `${generated}/${variant.name}.ts`;
    const rawPath = `${generated}/${variant.name}.raw.wasm`;
    const rawRepeatPath = `${generated}/${variant.name}.repeat.raw.wasm`;
    const optimisedRepeatPath = `${generated}/${variant.name}.repeat.wasm`;
    const wasmPath = `${output}/${variant.name}.wasm`;
    const watPath = `${generated}/${variant.name}.wat`;
    const variantPrelude = required(variantPreludes.get(variant.name) ?? null, "variantPreludes.get(variant.name)").text;
    const sourceText = `${variantPrelude}\n${customPrelude}\n${generatedBody}`;
    await fs.writeFile(sourcePath, sourceText);
    const asc = async (destination: string, textFile: string | null = null): Promise<void> => {
      const command = [processHost.execPath, `${root}/node_modules/assemblyscript/bin/asc.js`, sourcePath,
        "--outFile", destination, "--runtime", config.runtime ?? "stub", "--zeroFilledMemory",
        "--initialMemory", String(config.memory.initialPages ?? 256), "--maximumMemory", String(config.memory.maximumPages ?? 32768),
        "--optimizeLevel", "3", "--shrinkLevel", "0", "--noAssert", "--enable", "simd"];
      if (config.memory.import !== false) command.push("--importMemory");
      if (config.memory.export !== true) command.push("--noExportMemory");
      if (textFile) command.push("--textFile", textFile);
      if (variant.threaded) command.push("--sharedMemory", "--enable", "threads");
      await run(command, `AssemblyScript backend for ${variant.name}`, 2, 180_000);
    };
    const optimise = async (input: string, destination: string): Promise<void> => {
      if (skipOptimiser) { await fs.copyFile(input, destination); return; }
      await run([processHost.execPath, `${root}/node_modules/.bin/wasm-opt`, input, "-o", destination, "-O3", "--all-features", "--strip-debug"], `Binaryen optimisation for ${variant.name}`, 2, 120_000);
    };
    console.log(`Baguette: compiling ${variant.name} (${variant.threaded ? "threaded" : "baseline"})`);
    await asc(rawPath, watPath);
    if (emitModularWat) {
      // Preserve the relative source tree from the common lowered-source root.
      const parts = sourceEntries.map(entry => entry.path.split("/"));
      let common = 0;
      while (parts.every(item => item.length > common + 1 && (item[common] ?? null) === ((parts[0] ?? [])[common] ?? null))) common++;
      const modules = sourceEntries.map((entry, index) => {
        const source = required(parts[index] ?? null, "parts[index]").slice(common).join("/");
        return {
          source,
          file: source.replace(/\.tsx?$/, ".wat"),
          symbolPrefix: `__bq_${shortHash(entry.path)}_`,
          exports: abiFunctions.filter(fn => fn.sourceName.startsWith(entry.path + "#")).map(fn => fn.name),
        };
      });
      const emitted = modularWat(await readText(watPath), modules);
      const destination = `${generated}/${variant.name}`;
      for (const [file, body] of emitted.files) {
        const target = `${destination}/${file}`;
        mkdirSync(pathHost.dirname(target), { recursive: true });
        await fs.writeFile(target, body);
      }
      const layout = `${destination}/layout.json`;
      await fs.writeFile(layout, JSON.stringify(emitted.layout, null, 2) + "\n");
      modularLayouts[variant.name] = relative(layout);
    }
    await optimise(rawPath, wasmPath);
    const verifyDeterminism = async (): Promise<void> => {
      console.log(`Baguette: verifying deterministic rebuild for ${variant.name}`);
      await asc(rawRepeatPath);
      await optimise(rawRepeatPath, optimisedRepeatPath);
      const first = await readBytes(wasmPath), second = await readBytes(optimisedRepeatPath);
      if (first.byteLength !== second.byteLength || first.some((byte, index) => byte !== (second[index] ?? null))) throw new Error(`${variant.name} is not deterministic across identical Baguette builds`);
      console.log(`Baguette: deterministic rebuild verified for ${variant.name}`);
    };
    if (!skipDeterminism) await verifyDeterminism();
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
    // The lowered paths belong to Bake's output tree. Preserve the original
    // Thistle kernel entry and its immutable checkout revision separately.
    canonicalSource: config.canonicalSource ?? null,
    canonicalRevision: config.canonicalRevision ?? null,
    canonicalOriginalEntries: config.canonicalOriginalEntries ?? config.entries,
    canonicalOriginalModules: config.canonicalOriginalModules ?? null,
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
      modularWAT: modularLayouts,
    },
    completeKernel: config.completeKernel ?? false,
    productionKernel: config.productionKernel ?? "unset",
    variants: serialisableVariants,
  };
  await fs.writeFile(`${output}/${moduleBaseName}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(`${output}/host-interface.d.ts`, hostInterface());
  await fs.writeFile(`${output}/baguette-report.json`, `${JSON.stringify({
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
  for (const variant of variants) { const result = required(variantResults[`${variant.name}.wasm`] ?? null, "variantResults[`${variant.name}.wasm`]"); console.log(`  ${result.file}  ${result.bytes} bytes  sha256 ${result.sha256}`); }
  console.log(`  deterministic rebuild: ${skipDeterminism ? "skipped" : "verified"}`);
  console.log("  native module instantiation and configured ABI checks: verified");
};

if (validateOnly) reportValidation();
if (!validateOnly) await buildOutputs();

// The compiler is an explicit build process. Terminating here prevents Bun or
// a backend shared-memory instance from retaining the event loop after all
// artefacts and verification results have been written.
processHost.exit(0);
