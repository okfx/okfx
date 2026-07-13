import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { InvalidArgumentError, Command } from "commander";

import { generationTimestamp } from "@okfx/plugin-api";

import type { CliContext, CliRuntime } from "../program.js";

type InitTemplate = "minimal" | "data-platform" | "api-catalog" | "metrics";

const templates = new Set<InitTemplate>(["minimal", "data-platform", "api-catalog", "metrics"]);

export function createInitCommand(context: CliContext, runtime: CliRuntime): Command {
  return new Command("init")
    .description("create a starter OKF bundle")
    .argument("[bundle]", "OKF bundle root", ".")
    .option("--template <template>", "bundle template", parseTemplate, "minimal")
    .option("--force", "overwrite generated files if they already exist", false)
    .action(async (bundle: string, options: { template: InitTemplate; force: boolean }) => {
      const root = resolve(bundle);
      const timestamp = generationTimestamp(runtime.now());
      const files = filesForTemplate(options.template, timestamp);
      const existing = options.force ? [] : await existingGeneratedFiles(root, files);
      if (existing.length > 0) {
        context.io.stderr.write(
          `okf init: refusing to overwrite existing files: ${existing.join(", ")}\n`
        );
        context.setExitCode(2);
        return;
      }

      await Promise.all(files.map(async (file) => {
        const path = join(root, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, "utf8");
      }));

      context.io.stdout.write(`Created OKF bundle at ${root}\n`);
      for (const file of files) {
        context.io.stdout.write(`  ${file.path}\n`);
      }
    });
}

interface TemplateFile {
  path: string;
  content: string;
}

function parseTemplate(value: string): InitTemplate {
  if (templates.has(value as InitTemplate)) {
    return value as InitTemplate;
  }

  throw new InvalidArgumentError(`unknown template "${value}"`);
}

async function existingGeneratedFiles(root: string, files: TemplateFile[]): Promise<string[]> {
  const existing = new Set(await listExistingFiles(root));
  return files.map((file) => file.path).filter((path) => existing.has(path));
}

async function listExistingFiles(root: string, prefix = ""): Promise<string[]> {
  try {
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    const paths = await Promise.all(entries.map(async (entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listExistingFiles(root, path) : [path];
    }));
    return paths.flat().sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function filesForTemplate(template: InitTemplate, timestamp: string): TemplateFile[] {
  const common = commonFiles("Example Concept", "concepts/example.md", timestamp);

  if (template === "data-platform") {
    return [
      ...commonFiles("Weekly Active Users", "metrics/weekly_active_users.md", timestamp),
      {
        path: "tables/user_events.md",
        content: concept({
          type: "Table",
          title: "User Events",
          description: "Event-level activity emitted by users.",
          tags: ["analytics", "source-table"],
          body: `# User Events

User Events records product activity at event granularity.
`
        }, timestamp)
      },
      metricConcept("metrics/weekly_active_users.md", timestamp)
    ];
  }

  if (template === "api-catalog") {
    return [
      ...commonFiles("Orders API", "apis/orders-api.md", timestamp),
      {
        path: "apis/orders-api.md",
        content: concept({
          type: "API",
          title: "Orders API",
          description: "Service API for reading and updating orders.",
          tags: ["api", "orders"],
          body: `# Orders API

Use this API for order lookup and order lifecycle operations.

## Usage

- [Orders Runbook](../runbooks/orders-api.md)
`
        }, timestamp)
      },
      {
        path: "runbooks/orders-api.md",
        content: concept({
          type: "Runbook",
          title: "Orders API Runbook",
          description: "Operational guide for Orders API incidents.",
          tags: ["runbook", "orders"],
          body: `# Orders API Runbook

## Symptoms

- Elevated error rate
- Slow response time
`
        }, timestamp)
      }
    ];
  }

  if (template === "metrics") {
    return [...common, metricConcept("concepts/example.md", timestamp)];
  }

  return [
    ...common,
    {
      path: "concepts/example.md",
      content: concept({
        type: "Note",
        title: "Example Concept",
        description: "A starter OKF concept.",
        tags: ["example"],
        body: `# Example Concept

Use this document as a small, human-readable OKF concept.

## Usage

Link related concepts with Markdown links.
`
      }, timestamp)
    }
  ];
}

function commonFiles(indexTitle: string, indexTarget: string, timestamp: string): TemplateFile[] {
  return [
    {
      path: "index.md",
      content: `# Knowledge Index

- [${indexTitle}](${indexTarget})
`
    },
    {
      path: "log.md",
      content: `# Knowledge Log

## ${timestamp.slice(0, 10)}

- Created initial OKF bundle.
`
    },
    {
      path: "okfx.config.ts",
      content: `export default {
  okfVersion: "0.1",
  include: ["**/*.md"],
  exclude: ["node_modules/**", ".git/**", ".okfx/**", "dist/**"],
  presets: ["recommended", "agent-ready"],
  failOn: "error",
  frontmatter: {
    keyOrder: ["type", "title", "description", "resource", "tags", "timestamp"]
  },
  mcp: {
    readonly: true,
    exposeDiagnostics: true,
    exposeGraph: true
  }
};
`
    }
  ];
}

function metricConcept(path: string, timestamp: string): TemplateFile {
  return {
    path,
    content: concept({
      type: "Metric",
      title: "Weekly Active Users",
      description: "Number of unique users active in the last 7 days.",
      resource: "https://docs.example.com/metrics/wau",
      tags: ["analytics", "engagement"],
      body: `# Weekly Active Users

Weekly Active Users measures the number of unique users who performed at least one qualifying event in the last 7 days.

## Source Tables

- [User Events](../tables/user_events.md)

## Calculation

Count distinct \`user_id\` where \`event_timestamp\` is within the last 7 days.

## Notes

This metric excludes internal test users.
`
    }, timestamp)
  };
}

function concept(input: {
  type: string;
  title: string;
  description: string;
  resource?: string;
  tags: string[];
  body: string;
}, timestamp: string): string {
  const resource = input.resource ? `resource: ${input.resource}\n` : "";
  const tags = input.tags.map((tag) => `  - ${tag}`).join("\n");
  return `---
type: ${input.type}
title: ${input.title}
description: ${input.description}
${resource}tags:
${tags}
timestamp: ${timestamp}
---

${input.body}`;
}
