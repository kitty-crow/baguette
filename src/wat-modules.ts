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

const skipTrivia = (text: string, from: number): number => {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue; }
    if (text.startsWith(";;", i)) {
      const end = text.indexOf("\n", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("(;", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith("(;", i)) { depth++; i += 2; }
        else if (text.startsWith(";)", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth !== 0) throw new Error("Unterminated WAT block comment");
      continue;
    }
    break;
  }
  return i;
};

const endOfField = (text: string, from: number): number => {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const next = skipTrivia(text, i);
    if (next !== i) { i = next; continue; }
    const ch = text[i++];
    if (ch === '"') {
      let closed = false;
      while (i < text.length) {
        const char = text[i++];
        if (char === "\\") { i++; continue; }
        if (char === '"') { closed = true; break; }
      }
      if (!closed) throw new Error("Unterminated WAT string");
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  throw new Error("Unterminated WAT module field");
};

const splitFields = (text: string): { prefix: string; fields: Field[]; suffix: string } => {
  const start = skipTrivia(text, 0);
  const head = /^\(module(?=\s|\))/.exec(text.slice(start));
  if (!head) throw new Error("Expected a WebAssembly text module");
  let cursor = start + head[0].length;
  const name = skipTrivia(text, cursor);
  if (text[name] === "$") {
    const symbol = /^\$[^\s()]+/.exec(text.slice(name));
    if (!symbol) throw new Error("Invalid WAT module name");
    cursor = name + symbol[0].length;
  }
  const prefix = text.slice(0, cursor);
  const fields: Field[] = [];
  while (cursor < text.length) {
    const at = skipTrivia(text, cursor);
    if (text[at] === ")") {
      if (skipTrivia(text, at + 1) !== text.length) throw new Error("Unexpected content after WAT module");
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

/** Preserve backend declaration order and assign code to its compiler-owned module. */
export const modularWat = (text: string, modules: readonly SourceModule[]): {
  readonly files: ReadonlyMap<string, string>;
  readonly layout: WatLayout;
} => {
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
    let file = "module.wat";
    if (["func", "global", "tag"].includes(field.kind)) {
      const name = field.symbol.slice(field.symbol.lastIndexOf("/") + 1).replace(/^\$/, "");
      const privateOwner = /__bq_[a-f0-9]{8}_/.exec(name)?.[0];
      const exportOwner = exports.get(name);
      if (privateOwner && !prefixes.has(privateOwner)) throw new Error("Unknown compiler symbol owner: " + field.symbol);
      file = exportOwner ?? (privateOwner ? prefixes.get(privateOwner)! : "runtime.wat");
    }
    const current = files.get(file)!;
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
  const linked = prefix + order.map(([file, offset, length]) => files.get(file)!.slice(offset, offset + length)).join("") + suffix;
  if (linked !== text) throw new Error("Modular WAT changed backend output");
  return { files, layout };
};
