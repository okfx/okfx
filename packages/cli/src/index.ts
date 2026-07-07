#!/usr/bin/env node

import { okfxVersion } from "@okfx/core";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${okfxVersion}\n`);
    return 0;
  }

  process.stderr.write("okf: command implementation is not installed yet\n");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
