#!/usr/bin/env bun

import processHost from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The wrapper forwards arguments only; consumer-specific tests belong downstream.
const compilerPath = fileURLToPath(new URL("./compiler.ts", import.meta.url));
const result = spawnSync(processHost.execPath, [compilerPath, ...processHost.argv.slice(2)], {
  cwd: processHost.cwd(),
  env: processHost.env,
  stdio: "inherit",
});
processHost.exitCode = result.status ?? 1;
