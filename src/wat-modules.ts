import { required } from "./required.ts";
export interface SourceModule {
  readonly source: string;
  readonly file: string;
  readonly symbolPrefix: string;
  readonly exports: readonly string[];
}

interface Field {
  readonly text: string;
  readonly kind: string;
  readonly symbol: string;
}

export interface WatLayout {
  readonly schema: 1;
  readonly encoding: "utf-16-code-units";
  readonly prefix: string;
  readonly suffix: string;
  readonly modules: readonly { source: string; file: string; fields: number }[];
  readonly order: readonly [file: string, offset: number, length: number][];
}

const blockCommentEnd = (text: string, from: number): number => {
  let depth = 1;
  let i = from + 2;
  while (i < text.length && depth > 0) {
    if (text.startsWith("(;", i)) { depth++; i += 2; continue; }
    if (text.startsWith(";)", i)) { depth--; i += 2; continue; }
    i++;
  }
  if (depth !== 0) throw new Error("Unterminated WAT block comment");
  return i;
};

const skipTrivia = (text: string, from: number): number => {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(required(text[i], "text[i]"))) { i++; continue; }
    if (text.startsWith(";;", i)) {
      const end = text.indexOf("\n", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("(;", i)) { i = blockCommentEnd(text, i); continue; }
    break;
  }
  return i;
};

const stringEnd = (text: string, from: number): number => {
  let i = from;
  while (i < text.length) {
    const char = text[i++];
    if (char === "\\") { i++; continue; }
    if (char === '"') return i;
  }
  throw new Error("Unterminated WAT string");
};

const endOfField = (text: string, from: number): number => {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const next = skipTrivia(text, i);
    if (next !== i) { i = next; continue; }
    const ch = text[i++];
    if (ch === '"') { i = stringEnd(text, i); continue; }
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return i;
  }
  throw new Error("Unterminated WAT module field");
};

const splitFields = (text: string): { prefix: string; fields: Field[]; suffix: string } => {
  // Preserve trivia and original character offsets, including comments between fields.
  const start = skipTrivia(text, 0);
  const head = /^\(module(?=\s|\))/.exec(text.slice(start));
  if (!head) throw new Error("Expected a WebAssembly text module");
  let cursor = start + head[0].length;
  const name = skipTrivia(text, cursor);
  const symbol = text[name] === "$" ? /^\$[^\s()]+/.exec(text.slice(name)) : undefined;
  if (text[name] === "$" && !symbol) throw new Error("Invalid WAT module name");
  if (symbol) cursor = name + symbol[0].length;
  const prefix = text.slice(0, cursor);
  const fields: Field[] = [];
  while (cursor < text.length) {
    const at = skipTrivia(text, cursor);
    if (text[at] === ")" && skipTrivia(text, at + 1) !== text.length) throw new Error("Unexpected content after WAT module");
    if (text[at] === ")") {
      return { prefix, fields, suffix: text.slice(cursor) };
    }
    if (text[at] !== "(") throw new Error("Expected a WAT module field");
    const end = endOfField(text, at);
    const kindAt = skipTrivia(text, at + 1);
    const kind = /^[^\s()]+/.exec(text.slice(kindAt))?.[0];
    if (!kind) throw new Error("Missing WAT field kind");
    const symbolAt = skipTrivia(text, kindAt + kind.length);
    const symbol = /^\$[^\s()]+/.exec(text.slice(symbolAt))?.[0] ?? "";
    fields.push({ text: text.slice(cursor, end), kind, symbol });
    cursor = end;
  }
  throw new Error("Unterminated WAT module");
};

const safeRelativePath = (file: string): void => {
  if (!/^[A-Za-z0-9_./-]+\.wat$/.test(file) ||
      file.split("/").some(part => part === ".." || part === "." || part === "")) {
    throw new Error("Unsafe WAT module path: " + file);
  }
};

const fieldOwner = (field: Field, prefixes: ReadonlyMap<string, string>, exports: ReadonlyMap<string, string>): string => {
  if (!["func", "global", "tag"].includes(field.kind)) return "module.wat";
  const name = field.symbol.slice(field.symbol.lastIndexOf("/") + 1).replace(/^\$/, "");
  const privateOwner = /__bq_[a-f0-9]{8}_/.exec(name)?.[0];
  const exportOwner = exports.get(name);
  if (privateOwner && !prefixes.has(privateOwner)) throw new Error("Unknown compiler symbol owner: " + field.symbol);
  return exportOwner ?? (privateOwner ? required(prefixes.get(privateOwner), "private symbol owner") : "runtime.wat");
};

/** Preserve backend declaration order and assign code to its compiler-owned module. */
export const modularWat = (text: string, modules: readonly SourceModule[]): {
  readonly files: ReadonlyMap<string, string>;
  readonly layout: WatLayout;
} => {
  // Validate unique ownership before splitting; retain offsets so linking reproduces the original text exactly.
  const { prefix, fields, suffix } = splitFields(text);
  const files = new Map<string, string>([["module.wat", ""], ["runtime.wat", ""]]);
  const counts = new Map<string, number>();
  const prefixes = new Map<string, string>();
  const exports = new Map<string, string>();
  for (const module of modules) {
    safeRelativePath(module.file);
    if (files.has(module.file) || prefixes.has(module.symbolPrefix)) throw new Error("Duplicate WAT module identity: " + module.source);
    files.set(module.file, "");
    prefixes.set(module.symbolPrefix, module.file);
    for (const symbol of module.exports) {
      if (exports.has(symbol)) throw new Error("Duplicate WAT export owner: " + symbol);
      exports.set(symbol, module.file);
    }
  }
  const order: [string, number, number][] = [];
  for (const field of fields) {
    const file = fieldOwner(field, prefixes, exports);
    const current = required(files.get(file), "files.get(file)");
    order.push([file, current.length, field.text.length]);
    files.set(file, current + field.text);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  for (const [file, body] of files) {
    files.set(file, body ? body + "\n" : ";; No standalone declarations emitted for this module.\n");
  }
  const layout: WatLayout = {
    schema: 1, encoding: "utf-16-code-units", prefix, suffix,
    modules: modules.map(module => ({ source: module.source, file: module.file, fields: counts.get(module.file) ?? 0 })),
    order,
  };
  const linked = prefix + order.map(([file, offset, length]) => required(files.get(file), "files.get(file)").slice(offset, offset + length)).join("") + suffix;
  if (linked !== text) throw new Error("Modular WAT changed backend output");
  return { files, layout };
};
