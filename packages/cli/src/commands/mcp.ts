import { resolve } from "node:path";

import { Command } from "commander";

import { loadConfig } from "@okfx/core";
import { getOkfMcpTools, OKF_MCP_PROMPTS, startStdioServer } from "@okfx/mcp";

import { terminalValue } from "../output.js";
import type { CliContext } from "../program.js";

export function createMcpCommand(context: CliContext): Command {
  return new Command("mcp")
    .description("run a read-only MCP server for a bundle")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--readonly", "override config and run in read-only mode")
    .option("--allow-write", "reserved for future write tools; no write tools are currently registered", false)
    .option("--describe", "print server configuration without starting stdio", false)
    .action(async (bundle: string, options: { readonly?: boolean; allowWrite: boolean; describe: boolean }) => {
      const root = resolve(bundle);
      const config = await loadConfig(root);
      const readonly = options.allowWrite ? false : options.readonly ?? config.mcp.readonly;

      if (options.describe) {
        context.io.stdout.write(`${JSON.stringify({
          root,
          readonly,
          transport: "stdio",
          tools: getOkfMcpTools(config),
          prompts: OKF_MCP_PROMPTS
        }, null, 2)}\n`);
        return;
      }

      context.io.stderr.write(`Starting OKF MCP server for ${terminalValue(root)}\n`);
      await startStdioServer({ root, readonly, config });
    });
}
