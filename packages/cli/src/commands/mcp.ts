import { resolve } from "node:path";

import { Command } from "commander";

import { OKF_MCP_PROMPTS, OKF_MCP_TOOLS, startStdioServer } from "@okfx/mcp";

import type { CliContext } from "../program.js";

export function createMcpCommand(context: CliContext): Command {
  return new Command("mcp")
    .description("run a read-only MCP server for a bundle")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--readonly", "run in read-only mode", true)
    .option("--allow-write", "reserved for future write tools; no write tools are currently registered", false)
    .option("--describe", "print server configuration without starting stdio", false)
    .action(async (bundle: string, options: { readonly: boolean; allowWrite: boolean; describe: boolean }) => {
      const root = resolve(bundle);
      const readonly = options.allowWrite ? false : options.readonly;

      if (options.describe) {
        context.io.stdout.write(`${JSON.stringify({
          root,
          readonly,
          transport: "stdio",
          tools: OKF_MCP_TOOLS,
          prompts: OKF_MCP_PROMPTS
        }, null, 2)}\n`);
        return;
      }

      context.io.stderr.write(`Starting OKF MCP server for ${root}\n`);
      await startStdioServer({ root, readonly });
    });
}
