#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bq-tarot-"));
const repo = path.join(tmp, "tarot");
const out = path.join(tmp, "wide");
const report = path.join(tmp, "report.json");
const project = path.join(repo, "tsconfig.baguette-core.json");

function run(bin, args, cwd = root, allowFail = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", code => {
      const value = code ?? -1;
      if (value === 0 || allowFail) resolve(value);
      else reject(new Error(`${bin} exited with status ${value}`));
    });
  });
}

function group(items, key) {
  const map = new Map();
  for (const item of items) map.set(item[key], (map.get(item[key]) ?? 0) + 1);
  return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

try {
  await run("git", [
    "clone", "--depth", "1", "--branch", "agent/online-arcana",
    "https://github.com/kitty-crow/tarot_engine.git", repo
  ]);
  await fs.writeFile(project, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      lib: ["ES2022", "DOM"]
    },
    include: ["src/core/**/*.ts"]
  }, null, 2)}\n`);

  await run("npm", ["run", "build"], path.join(root, "vendor/bake"));
  const code = await run(process.execPath, [
    path.join(root, "vendor/bake/dist/cli.js"),
    "--engine", "host",
    "--project", project,
    "--out-dir", out,
    "--report", report,
    "--lowering", "wide"
  ], root, true);

  const data = JSON.parse(await fs.readFile(report, "utf8"));
  const errors = data.diagnostics.filter(item => item.severity === "error");
  const warnings = data.diagnostics.filter(item => item.severity === "warning");
  console.log("\nTarot engine wide audit");
  console.log(`commit: ${await fs.readFile(path.join(repo, ".git/refs/heads/agent/online-arcana"), "utf8").catch(() => "unknown")}`.trim());
  console.log(`files: ${data.emittedFiles.length}`);
  console.log(`errors: ${errors.length}`);
  console.log(`warnings: ${warnings.length}`);
  console.log("\nBy diagnostic");
  for (const [name, count] of group(errors, "code")) console.log(`${String(count).padStart(3)}  ${name}`);
  console.log("\nBy file");
  for (const [name, count] of group(errors, "file")) console.log(`${String(count).padStart(3)}  ${path.relative(repo, name)}`);
  console.log("\nFirst errors");
  for (const item of errors.slice(0, 40)) {
    console.log(`${path.relative(repo, item.file)}:${item.line}:${item.column} ${item.code} ${item.message}`);
  }
  if (code !== 0 || errors.length) process.exitCode = 1;
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
