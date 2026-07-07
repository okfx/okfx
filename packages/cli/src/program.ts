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

export function createProgram(context: CliContext): Command {
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
    program.addCommand(
      name === "init"
        ? createInitCommand(context)
        : name === "import"
          ? createImportCommand(context)
        : name === "export"
          ? createExportCommand(context)
        : name === "validate"
          ? createValidateCommand(context)
          : name === "lint"
            ? createLintCommand(context)
            : name === "graph"
              ? createGraphCommand(context)
              : name === "doctor"
                ? createDoctorCommand(context)
                : name === "fmt"
                  ? createFmtCommand(context)
                  : name === "diff"
                    ? createDiffCommand(context)
                    : name === "pack"
                      ? createPackCommand(context)
                      : name === "index"
                        ? createIndexCommand(context)
                        : name === "mcp"
                          ? createMcpCommand(context)
        : createPlaceholderCommand(name, description, context)
    );
  }

  return program;
}

export async function runProgram(argv: string[], io: CliIO): Promise<number> {
  let exitCode = 0;
  const program = createProgram({
    io,
    setExitCode(code) {
      exitCode = code;
    }
  });

  try {
    await program.parseAsync(["node", "okf", ...argv], { from: "node" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }

    if (error instanceof InvalidArgumentError) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }

    io.stderr.write(error instanceof Error ? `${error.message}\n` : "unknown error\n");
    return 2;
  }
}

function createPlaceholderCommand(name: string, description: string, context: CliContext): Command {
  return new Command(name)
    .description(description)
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--format <format>", "output format", "pretty")
    .option("--out <path>", "write output to a file")
    .option("--debug", "print debug diagnostics")
    .option("--trace", "print trace diagnostics")
    .option("--timings", "print runtime timings")
    .action(() => {
      context.io.stderr.write(`okf ${name}: command implementation is not installed yet\n`);
      context.setExitCode(2);
    });
}
