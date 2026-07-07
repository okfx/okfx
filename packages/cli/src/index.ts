#!/usr/bin/env node

import { runProgram, type CliIO } from "./program.js";

export async function main(
  argv = process.argv.slice(2),
  io: CliIO = { stdout: process.stdout, stderr: process.stderr }
): Promise<number> {
  return runProgram(argv, io);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
