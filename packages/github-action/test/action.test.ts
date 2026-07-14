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
    expect(action).toContain("<!-- okfx-summary -->");
    expect(action).toContain("github.paginate(github.rest.issues.listComments");
    expect(action).toContain("github.rest.issues.updateComment");
    expect(action).toContain("github.rest.issues.createComment");
    expect(action).toContain("OKF quality gate");
    expect(action.match(/const graph = readJson\(process\.env\.OKF_GRAPH_JSON\);/g)).toHaveLength(2);
    expect(action.match(/\.\.\.\(lint\?\.stats \?\? \{\}\)/g)).toHaveLength(2);
    expect(action.match(/OKF_RUN_DOCTOR === "true"/g)).toHaveLength(2);
    expect(action.match(/\[ ! -L "\$OKF_(?:LINT|GRAPH|DOCTOR)_JSON" \]/g)).toHaveLength(3);
    expect(action.match(/fs\.lstatSync\(path\)/g)).toHaveLength(2);
    expect(action.match(/catch \{/g)).toHaveLength(2);
    expect(action.match(/const markdownCode = \(value\) =>/g)).toHaveLength(2);
    expect(action.match(/for \(const match of visibleValue\.matchAll/g)).toHaveLength(2);
    expect(action).not.toContain("Math.max(0, ...");
    expect(action).not.toContain("fs.existsSync(process.env.OKF_DOCTOR_JSON)");
    expect(action.match(/doctor \? `- Doctor JSON:/g)).toHaveLength(2);
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

  it("keeps untrusted paths inside Markdown code spans", () => {
    const summary = formatOkfSummary({
      root: "bundle` [Injected](evil)\nnext",
      artifacts: { lint: "lint` <img src=x>.json" }
    });

    expect(summary).toContain("Bundle: ``bundle` [Injected](evil)\\nnext``");
    expect(summary).toContain("- Lint JSON: ``lint` <img src=x>.json``");
    expect(summary).not.toContain("Bundle: `bundle`");
  });

  it("handles many separate backtick runs in summary values", () => {
    const root = "`x".repeat(150_000);

    const summary = formatOkfSummary({ root });

    expect(summary.startsWith("## OKF Summary")).toBe(true);
    expect(summary).toContain("Bundle: ``");
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
