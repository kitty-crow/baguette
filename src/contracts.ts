/** Configuration for one generated WebAssembly variant. */
export interface BaguetteVariant { name: string; threaded: boolean; preludeFile: string | null; }

interface BaguetteMemoryConfig {
  initialPages: number | null;
  maximumPages: number | null;
  import: boolean | null;
  export: boolean | null;
}
interface BaguetteAbiVerification {
  init: string | null;
  initArgs: Array<number | string> | null;
  initExpected: number | string | null;
  valid: string | null;
  validArgs: Array<number | string> | null;
  validExpected: number | string | null;
}
interface BaguetteAbiTest { function: string; args: Array<number | string>; expected: number | string; }
interface BaguetteAbiConfig {
  exports: "all-exported-functions" | string[] | null;
  allowNonFunctionExports: boolean | null;
  verify: BaguetteAbiVerification | null;
  tests: BaguetteAbiTest[] | null;
}
export interface BaguetteConfig {
  schema: number | null;
  name: string | null;
  project: string | null;
  entries: string[];
  generatedDir: string | null;
  outDir: string | null;
  moduleBaseName: string | null;
  preludeFile: string | null;
  intrinsicModules: string[] | null;
  typeAliases: Record<string, string> | null;
  abiTypes: Record<string, "number" | "bigint" | "void"> | null;
  abi: BaguetteAbiConfig;
  memory: BaguetteMemoryConfig;
  runtime: "stub" | "minimal" | "incremental" | null;
  variants: BaguetteVariant[];
  allowedHostImports: Array<{ module: string; name: string; kind: WebAssembly.ImportExportKind }> | null;
  completeKernel: boolean | null;
  productionKernel: string | null;
  canonicalSource: string | null;
  canonicalRevision: string | null;
  canonicalOriginalEntries: string[] | null;
  canonicalOriginalModules: string[] | null;
  materialiseInferredTypes: boolean | null;
  asyncLowering: "state-machine" | "reject" | null;
}
export type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }


const decode: (text: string) => JsonValue = JSON.parse;
const isObject = (value: JsonValue): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: JsonValue): value is string => typeof value === "string";
const isBoolean = (value: JsonValue): value is boolean => typeof value === "boolean";
const isNumber = (value: JsonValue): value is number => typeof value === "number" && Number.isFinite(value);
const isArgument = (value: JsonValue): value is string | number => isString(value) || isNumber(value);
const isStringList = (value: JsonValue): value is string[] => Array.isArray(value) && value.every(isString);
const isArguments = (value: JsonValue): value is Array<number | string> => Array.isArray(value) && value.every(isArgument);
const isAliases = (value: JsonValue): value is Record<string, string> => isObject(value) && Object.values(value).every(isString);
const isAbiTypes = (value: JsonValue): value is Record<string, "number" | "bigint" | "void"> => isObject(value) && Object.values(value).every(item => item === "number" || item === "bigint" || item === "void");
const isRuntime = (value: JsonValue): value is "stub" | "minimal" | "incremental" => value === "stub" || value === "minimal" || value === "incremental";
const isAsyncMode = (value: JsonValue): value is "state-machine" | "reject" => value === "state-machine" || value === "reject";
const isAbiExports = (value: JsonValue): value is "all-exported-functions" | string[] => value === "all-exported-functions" || isStringList(value);
const isImportKind = (value: JsonValue): value is WebAssembly.ImportExportKind => value === "function" || value === "global" || value === "memory" || value === "table" || value === "tag";

function field<T extends JsonValue>(obj: JsonObject, key: string, check: (value: JsonValue) => value is T): T | null {
  const value = obj[key] ?? null;
  if (value === null) return null;
  if (!check(value)) throw new Error("Invalid Baguette configuration field: " + key);
  return value;
}
function object(value: JsonValue): JsonObject {
  if (!isObject(value)) throw new Error("Expected a JSON object");
  return value;
}
function list<T>(value: JsonValue, read: (item: JsonValue) => T): T[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error("Expected a configuration array");
  return value.map(read);
}
function requiredField<T extends JsonValue>(obj: JsonObject, key: string, check: (value: JsonValue) => value is T): T {
  const value = field(obj, key, check);
  if (value === null) throw new Error("Missing Baguette configuration field: " + key);
  return value;
}
function variant(value: JsonValue): BaguetteVariant {
  const obj = object(value);
  return {name: requiredField(obj, "name", isString), threaded: field(obj, "threaded", isBoolean) ?? false, preludeFile: field(obj, "preludeFile", isString)};
}
function abiTest(value: JsonValue): BaguetteAbiTest {
  const obj = object(value);
  return {function: requiredField(obj, "function", isString), args: field(obj, "args", isArguments) ?? [], expected: requiredField(obj, "expected", isArgument)};
}
function hostImport(value: JsonValue): {module: string; name: string; kind: WebAssembly.ImportExportKind} {
  const obj = object(value);
  return {module: requiredField(obj, "module", isString), name: requiredField(obj, "name", isString), kind: requiredField(obj, "kind", isImportKind)};
}
function verification(value: JsonValue): BaguetteAbiVerification | null {
  if (value === null) return null;
  const obj = object(value);
  return {init: field(obj, "init", isString), initArgs: field(obj, "initArgs", isArguments), initExpected: field(obj, "initExpected", isArgument), valid: field(obj, "valid", isString), validArgs: field(obj, "validArgs", isArguments), validExpected: field(obj, "validExpected", isArgument)};
}
function abi(value: JsonValue): BaguetteAbiConfig {
  const obj = object(value ?? {});
  return {exports: field(obj, "exports", isAbiExports), allowNonFunctionExports: field(obj, "allowNonFunctionExports", isBoolean), verify: verification(obj.verify ?? null), tests: list(obj.tests ?? null, abiTest)};
}
function memory(value: JsonValue): BaguetteMemoryConfig {
  const obj = object(value ?? {});
  return {initialPages: field(obj, "initialPages", isNumber), maximumPages: field(obj, "maximumPages", isNumber), import: field(obj, "import", isBoolean), export: field(obj, "export", isBoolean)};
}
export function parseJsonObject(text: string): JsonObject {
  // JSON without a reviver yields only JSON values; verify the root before using its properties.
  return object(decode(text));
}
export function parseConfig(text: string): BaguetteConfig {
  const obj = parseJsonObject(text);
  const entries = requiredField(obj, "entries", isStringList);
  if (!entries.length) throw new Error("Baguette requires at least one entry");
  return {
    entries, schema: field(obj, "schema", isNumber),
    name: field(obj, "name", isString),
    project: field(obj, "project", isString),
    generatedDir: field(obj, "generatedDir", isString),
    outDir: field(obj, "outDir", isString),
    moduleBaseName: field(obj, "moduleBaseName", isString),
    preludeFile: field(obj, "preludeFile", isString),
    productionKernel: field(obj, "productionKernel", isString),
    canonicalSource: field(obj, "canonicalSource", isString),
    canonicalRevision: field(obj, "canonicalRevision", isString),
    completeKernel: field(obj, "completeKernel", isBoolean),
    materialiseInferredTypes: field(obj, "materialiseInferredTypes", isBoolean),
    intrinsicModules: field(obj, "intrinsicModules", isStringList),
    canonicalOriginalEntries: field(obj, "canonicalOriginalEntries", isStringList),
    canonicalOriginalModules: field(obj, "canonicalOriginalModules", isStringList),
    typeAliases: field(obj, "typeAliases", isAliases), abiTypes: field(obj, "abiTypes", isAbiTypes),
    abi: abi(obj.abi ?? null), memory: memory(obj.memory ?? null),
    runtime: field(obj, "runtime", isRuntime), asyncLowering: field(obj, "asyncLowering", isAsyncMode),
    variants: list(obj.variants ?? null, variant) ?? [], allowedHostImports: list(obj.allowedHostImports ?? null, hostImport),
  };
}
