export const actionName = "okfx";

export interface OkfActionSummaryInput {
  root?: string;
  score?: number;
  summary?: {
    conceptCount?: number;
    linkCount?: number;
    brokenLinkCount?: number;
    orphanCount?: number;
    cycleCount?: number;
  };
  counts?: {
    error?: number;
    warning?: number;
    advice?: number;
    info?: number;
  };
  artifacts?: {
    lint?: string;
    graph?: string;
    doctor?: string;
  };
}

export function formatOkfSummary(input: OkfActionSummaryInput): string {
  const summary = input.summary ?? {};
  const counts = input.counts ?? {};
  const artifacts = input.artifacts ?? {};
  const lines = [
    "## OKF Summary",
    "",
    input.root ? `Bundle: \`${input.root}\`` : undefined,
    input.score === undefined ? undefined : `Agent readiness: **${input.score}/100**`,
    "",
    "### Concepts",
    `- Concepts: ${summary.conceptCount ?? 0}`,
    `- Links: ${summary.linkCount ?? 0}`,
    `- Broken links: ${summary.brokenLinkCount ?? 0}`,
    `- Orphan concepts: ${summary.orphanCount ?? 0}`,
    `- Cycles: ${summary.cycleCount ?? 0}`,
    "",
    "### Diagnostics",
    `- Errors: ${counts.error ?? 0}`,
    `- Warnings: ${counts.warning ?? 0}`,
    `- Advice: ${counts.advice ?? 0}`,
    `- Info: ${counts.info ?? 0}`,
    "",
    "### Artifacts",
    artifacts.lint ? `- Lint JSON: \`${artifacts.lint}\`` : undefined,
    artifacts.graph ? `- Graph JSON: \`${artifacts.graph}\`` : undefined,
    artifacts.doctor ? `- Doctor JSON: \`${artifacts.doctor}\`` : undefined
  ].filter((line): line is string => line !== undefined);

  return `${lines.join("\n")}\n`;
}

export const exampleWorkflow = `name: OKF

on:
  pull_request:
  push:
    branches: [main]

jobs:
  okf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: okfx/okfx/packages/github-action@v0
        with:
          cli-version: "0.1.0"
          bundle: ./knowledge
          lint-format: json
          graph-out: okf-graph.json
          summary: "true"
          pr-comment: "true"
`;
