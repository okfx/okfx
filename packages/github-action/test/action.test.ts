import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { exampleWorkflow, formatOkfSummary } from "../src/index.js";

describe("@okfx/github-action", () => {
  it("ships composite action metadata", async () => {
    const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");

    expect(action).toContain("using: composite");
    expect(action).toContain("okf validate");
    expect(action).toContain("okf lint");
    expect(action).toContain("okf graph");
    expect(action).toContain("okf doctor");
    expect(action).toContain("GITHUB_STEP_SUMMARY");
    expect(action).toContain("actions/github-script@v7");
    expect(action).toContain("OKF quality gate");
    expect(action).toContain('default: "0.1.0"');
    expect(action).not.toContain('@okfx/cli":"latest"');
    expect(runBlockLines(action).some((line) => line.includes("${{ inputs."))).toBe(false);
    expect(runBlockLines(action)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("okf ")))
      .toEqual([
        'okf validate -- "$OKF_BUNDLE"',
        'okf lint --format "$OKF_LINT_FORMAT" -- "$OKF_BUNDLE"',
        'okf lint --format json --out "$OKF_LINT_JSON" -- "$OKF_BUNDLE" >/dev/null 2>&1 || true',
        'okf graph --out "$OKF_GRAPH_JSON" -- "$OKF_BUNDLE"',
        'okf doctor --json --out "$OKF_DOCTOR_JSON" -- "$OKF_BUNDLE"'
      ]);
  });

  it("exports an example workflow", () => {
    expect(exampleWorkflow).toContain("actions/checkout@v4");
    expect(exampleWorkflow).toContain("okfx/okfx/packages/github-action@v0");
    expect(exampleWorkflow).toContain('cli-version: "0.1.0"');
    expect(exampleWorkflow).toContain("pr-comment");
  });

  it("formats PR and step summaries", () => {
    const summary = formatOkfSummary({
      root: "./knowledge",
      score: 88,
      summary: {
        conceptCount: 12,
        linkCount: 30,
        brokenLinkCount: 1,
        orphanCount: 2,
        cycleCount: 0
      },
      counts: {
        error: 0,
        warning: 3,
        advice: 5,
        info: 1
      },
      artifacts: {
        lint: "okf-lint.json",
        graph: "okf-graph.json",
        doctor: "okf-doctor.json"
      }
    });

    expect(summary).toContain("## OKF Summary");
    expect(summary).toContain("Agent readiness: **88/100**");
    expect(summary).toContain("- Warnings: 3");
    expect(summary).toContain("okf-graph.json");
  });
});

function runBlockLines(action: string): string[] {
  const result: string[] = [];
  let runIndent: number | undefined;

  for (const line of action.split("\n")) {
    const indentation = /^\s*/.exec(line)?.[0].length ?? 0;
    if (/^\s+run: \|$/.test(line)) {
      runIndent = indentation;
      continue;
    }
    if (runIndent !== undefined && line.trim() && indentation <= runIndent) {
      runIndent = undefined;
    }
    if (runIndent !== undefined) {
      result.push(line);
    }
  }

  return result;
}
