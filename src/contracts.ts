/** Configuration for one generated WebAssembly variant. */
export interface BaguetteVariant { name: string; threaded?: boolean; preludeFile?: string; }

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
export interface BaguetteConfig {
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
  variants?: BaguetteVariant[];
  allowedHostImports?: Array<{ module: string; name: string; kind: WebAssembly.ImportExportKind }>;
  completeKernel?: boolean;
  productionKernel?: string;
  canonicalSource?: string;
  canonicalRevision?: string;
  canonicalOriginalEntries?: string[];
  canonicalOriginalModules?: string[];
  materialiseInferredTypes?: boolean;
  asyncLowering?: "state-machine" | "reject";
}
export type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

const isObject = (value: JsonValue): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: JsonValue): value is string => typeof value === "string";
const isBoolean = (value: JsonValue): value is boolean => typeof value === "boolean";
const isNumber = (value: JsonValue): value is number => typeof value === "number" && Number.isFinite(value);
const isArgument = (value: JsonValue): value is string | number => isString(value) || isNumber(value);
const isStringList = (value: JsonValue): value is string[] => Array.isArray(value) && value.every(isString);
const isArguments = (value: JsonValue): value is Array<string | number> => Array.isArray(value) && value.every(isArgument);
const isVariant = (value: JsonValue): boolean => isObject(value) && isString(value.name ?? null) && optional(value, "threaded", isBoolean) && optional(value, "preludeFile", isString);
const optional = (value: JsonObject, key: string, check: (item: JsonValue) => boolean): boolean => !Object.hasOwn(value, key) || check(value[key] ?? null);
const fieldsValid = (value: JsonObject, keys: readonly string[], check: (item: JsonValue) => boolean): boolean => keys.every(key => optional(value, key, check));
const isMemory = (value: JsonValue): boolean => isObject(value) && fieldsValid(value, ["initialPages", "maximumPages"], isNumber) && fieldsValid(value, ["import", "export"], isBoolean);
const isVerification = (value: JsonValue): boolean => isObject(value) && fieldsValid(value, ["init", "valid"], isString) && fieldsValid(value, ["initArgs", "validArgs"], isArguments) && fieldsValid(value, ["initExpected", "validExpected"], isArgument);
const isTest = (value: JsonValue): boolean => isObject(value) && isString(value.function ?? null) && isArgument(value.expected ?? null) && optional(value, "args", isArguments);
const isAbi = (value: JsonValue): boolean => isObject(value) && optional(value, "exports", item => item === "all-exported-functions" || isStringList(item)) && optional(value, "allowNonFunctionExports", isBoolean) && optional(value, "verify", isVerification) && optional(value, "tests", item => Array.isArray(item) && item.every(isTest));
const isHostImport = (value: JsonValue): boolean => isObject(value) && isString(value.module ?? null) && isString(value.name ?? null) && ["function", "global", "memory", "table", "tag"].some(kind => kind === value.kind);
const isAliases = (value: JsonValue): boolean => isObject(value) && Object.values(value).every(isString);
const isAbiTypes = (value: JsonValue): boolean => isObject(value) && Object.values(value).every(item => item === "number" || item === "bigint" || item === "void");

export function parseJsonObject(text: string): JsonObject {
  // JSON without a reviver yields only JSON values; verify the object root before using properties.
  const value: JsonValue = JSON.parse(text);
  if (!isObject(value)) throw new Error("Expected a JSON object");
  return value;
}

function isConfig(value: JsonObject): value is JsonObject & BaguetteConfig {
  const entries = value.entries ?? null;
  return isStringList(entries) && entries.length > 0 &&
    fieldsValid(value, ["name", "project", "generatedDir", "outDir", "moduleBaseName", "preludeFile", "productionKernel", "canonicalSource", "canonicalRevision"], isString) &&
    fieldsValid(value, ["completeKernel", "materialiseInferredTypes"], isBoolean) &&
    fieldsValid(value, ["intrinsicModules", "canonicalOriginalEntries", "canonicalOriginalModules"], isStringList) &&
    optional(value, "schema", isNumber) &&
    optional(value, "typeAliases", isAliases) && optional(value, "abiTypes", isAbiTypes) &&
    optional(value, "abi", isAbi) && optional(value, "memory", isMemory) &&
    optional(value, "runtime", item => item === "stub" || item === "minimal" || item === "incremental") &&
    optional(value, "asyncLowering", item => item === "state-machine" || item === "reject") &&
    optional(value, "variants", item => Array.isArray(item) && item.every(isVariant)) &&
    optional(value, "allowedHostImports", item => Array.isArray(item) && item.every(isHostImport));
}

export function parseConfig(text: string): BaguetteConfig {
  const value = parseJsonObject(text);
  if (!isConfig(value)) throw new Error("Invalid Baguette compiler configuration");
  return value;
}
