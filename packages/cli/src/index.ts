#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { identifiesFile } from "./execution.js";
import { runProgram, type CliIO, type CliRuntime } from "./program.js";

export async function main(
  argv = process.argv.slice(2),
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
  runtime?: CliRuntime
): Promise<number> {
  return runProgram(argv, io, runtime);
}

if (isDirectExecution()) {
  process.exitCode = await main();
}

function isDirectExecution(): boolean {
  return identifiesFile(process.argv[1], fileURLToPath(import.meta.url));
}
