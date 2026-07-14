import { Command, CommanderError, InvalidArgumentError } from "commander";

import { okfxVersion } from "@okfx/core";

import { createInitCommand } from "./commands/init.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createDiffCommand } from "./commands/diff.js";
import { createExportCommand } from "./commands/export.js";
import { createFmtCommand } from "./commands/fmt.js";
import { createGraphCommand } from "./commands/graph.js";
import { createIndexCommand } from "./commands/index.js";
import { createImportCommand } from "./commands/import.js";
import { createLintCommand } from "./commands/lint.js";
import { createMcpCommand } from "./commands/mcp.js";
import { createPackCommand } from "./commands/pack.js";
import { createValidateCommand } from "./commands/validate.js";

export interface CliIO {
  stdout: {
    write(text: string): unknown;
  };
  stderr: {
    write(text: string): unknown;
  };
}

export interface CliContext {
  io: CliIO;
  setExitCode(code: number): void;
}

export interface CliRuntime {
  now(): Date;
}

const defaultRuntime: CliRuntime = {
  now: () => new Date()
};

export const plannedCommands = [
  ["init", "create a starter OKF bundle"],
  ["validate", "check OKF conformance"],
  ["lint", "run quality and style rules"],
  ["fmt", "format OKF Markdown and frontmatter"],
  ["graph", "build the OKF concept graph"],
  ["doctor", "run production and agent-readiness checks"],
  ["diff", "compare two OKF bundles semantically"],
  ["pack", "create a portable OKF bundle artifact"],
  ["index", "build a local search index"],
  ["import", "produce reviewable OKF draft files from local metadata"],
  ["export", "export an OKF bundle to a consumer surface"],
  ["mcp", "run a read-only MCP server for a bundle"]
] as const;

export function createProgram(context: CliContext, runtime: CliRuntime = defaultRuntime): Command {
  const program = new Command();

  program
    .name("okf")
    .description("Developer toolkit for Open Knowledge Format bundles.")
    .version(okfxVersion, "-v, --version")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => context.io.stdout.write(text),
      writeErr: (text) => context.io.stderr.write(text)
    });

  for (const [name, description] of plannedCommands) {
    program.addCommand(createPlannedCommand(name, description, context, runtime));
  }

  return program;
}

function createPlannedCommand(
  name: typeof plannedCommands[number][0],
  description: string,
  context: CliContext,
  runtime: CliRuntime
): Command {
  switch (name) {
    case "init":
      return createInitCommand(context, runtime);
    case "validate":
      return createValidateCommand(context);
    case "lint":
      return createLintCommand(context);
    case "fmt":
      return createFmtCommand(context);
    case "graph":
      return createGraphCommand(context);
    case "doctor":
      return createDoctorCommand(context);
    case "diff":
      return createDiffCommand(context);
    case "pack":
      return createPackCommand(context);
    case "index":
      return createIndexCommand(context);
    case "import":
      return createImportCommand(context);
    case "export":
      return createExportCommand(context);
    case "mcp":
      return createMcpCommand(context);
  }

  throw new Error(`No command implementation registered for ${description}.`);
}

export async function runProgram(
  argv: string[],
  io: CliIO,
  runtime: CliRuntime = defaultRuntime
): Promise<number> {
  let exitCode = 0;
  const safeIo = terminalSafeIo(io);
  const program = createProgram({
    io: safeIo,
    setExitCode(code) {
      exitCode = code;
    }
  }, runtime);

  try {
    await program.parseAsync(["node", "okf", ...argv], { from: "node" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    if (error instanceof InvalidArgumentError) {
      safeIo.stderr.write(`${error.message}\n`);
      return 2;
    }

    safeIo.stderr.write(error instanceof Error ? `${error.message}\n` : "unknown error\n");
    return 2;
  }
}

export function sanitizeTerminalOutput(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function terminalSafeIo(io: CliIO): CliIO {
  return {
    stdout: {
      write: (text) => io.stdout.write(sanitizeTerminalOutput(text))
    },
    stderr: {
      write: (text) => io.stderr.write(sanitizeTerminalOutput(text))
    }
  };
}
