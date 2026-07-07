import { describe, expect, it } from "vitest";

import { main } from "../src/index.js";
import { plannedCommands, type CliIO } from "../src/program.js";

function capture(): { io: CliIO; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string): boolean {
          stdout += chunk;
          return true;
        }
      },
      stderr: {
        write(chunk: string): boolean {
          stderr += chunk;
          return true;
        }
      }
    },
    stdout: () => stdout,
    stderr: () => stderr
  };
}

describe("@okfx/cli command shell", () => {
  it("prints the version", async () => {
    const output = capture();
    const code = await main(["--version"], output.io);

    expect(code).toBe(0);
    expect(output.stdout()).toBe("0.1.0\n");
    expect(output.stderr()).toBe("");
  });

  it("lists planned commands in help", async () => {
    const output = capture();
    const code = await main(["--help"], output.io);

    expect(code).toBe(0);
    for (const [command] of plannedCommands) {
      expect(output.stdout()).toContain(command);
    }
  });

  it("returns a runtime/config exit code for placeholder commands", async () => {
    const output = capture();
    const code = await main(["mcp", "knowledge"], output.io);

    expect(code).toBe(2);
    expect(output.stderr()).toContain("okf mcp: command implementation is not installed yet");
  });
});
