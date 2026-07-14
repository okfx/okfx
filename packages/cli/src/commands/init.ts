import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { InvalidArgumentError, Command } from "commander";

import { generationTimestamp } from "@okfx/plugin-api";

import { terminalValue } from "../output.js";
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
      await ensureSafeRoot(root);
      const existing = await existingGeneratedFiles(root, files);
      if (existing.length > 0) {
        if (!options.force) {
          context.io.stderr.write(
            `okf init: refusing to overwrite existing files: ${existing.join(", ")}\n`
          );
          context.setExitCode(2);
          return;
        }
      }

      for (const file of files) {
        const path = join(root, file.path);
        await ensureSafeTemplateParent(root, file.path);
        await inspectTemplatePath(root, file.path);
        await writeTemplateFile(path, file.content, options.force);
      }

      context.io.stdout.write(`Created OKF bundle at ${terminalValue(root)}\n`);
      for (const file of files) {
        context.io.stdout.write(`  ${terminalValue(file.path)}\n`);
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
  const existing = await Promise.all(files.map((file) => inspectTemplatePath(root, file.path)));
  return files.filter((_, index) => existing[index]).map((file) => file.path);
}

async function ensureSafeRoot(root: string): Promise<void> {
  try {
    const entry = await lstat(root);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to initialize through symbolic link bundle root: ${root}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`Refusing to initialize non-directory bundle root: ${root}`);
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
    await mkdir(root, { recursive: true });
    const entry = await lstat(root);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing to initialize unsafe bundle root: ${root}`);
    }
  }
}

async function inspectTemplatePath(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = root;

  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to write through symbolic link in template path: ${relativePath}`);
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw new Error(`Refusing to write through non-directory template path: ${relativePath}`);
      }
      if (index === segments.length - 1 && !entry.isFile()) {
        throw new Error(`Refusing to overwrite non-file template path: ${relativePath}`);
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  return true;
}

async function ensureSafeTemplateParent(root: string, relativePath: string): Promise<void> {
  const parent = dirname(relativePath);
  if (parent === ".") {
    return;
  }

  let current = root;
  for (const segment of parent.split("/")) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to write through symbolic link in template path: ${relativePath}`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`Refusing to write through non-directory template path: ${relativePath}`);
      }
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
      await mkdir(current);
    }
  }
}

async function writeTemplateFile(path: string, content: string, force: boolean): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY
    | constants.O_CREAT
    | noFollow
    | (force ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(path, flags, 0o666);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function filesForTemplate(template: InitTemplate, timestamp: string): TemplateFile[] {
  const common = commonFiles("Example Concept", "concepts/example.md", timestamp);

  if (template === "data-platform") {
    return [
      ...commonFiles("Weekly Active Users", "metrics/weekly_active_users.md", timestamp),
      userEventsConcept(timestamp),
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
          owner: "orders-team",
          tags: ["api", "orders"],
          body: `# Orders API

Use this API for order lookup and order lifecycle operations.

## Usage

- [Orders Runbook](../runbooks/orders-api.md)

## Auth Notes

Requests require a bearer token with the appropriate orders scope.
`
        }, timestamp)
      },
      {
        path: "runbooks/orders-api.md",
        content: concept({
          type: "Runbook",
          title: "Orders API Runbook",
          description: "Operational guide for Orders API incidents.",
          owner: "orders-team",
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
    return [
      ...common,
      userEventsConcept(timestamp),
      metricConcept("concepts/example.md", timestamp)
    ];
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
    keyOrder: ["type", "title", "description", "owner", "resource", "tags", "timestamp"]
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
      owner: "analytics-team",
      resource: "https://docs.example.com/metrics/wau",
      tags: ["analytics", "engagement"],
      body: `# Weekly Active Users

Weekly Active Users measures the number of unique users who performed at least one qualifying event in the last 7 days.

## Usage

Use this metric to monitor weekly engagement trends and compare cohorts.

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

function userEventsConcept(timestamp: string): TemplateFile {
  return {
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
  };
}

function concept(input: {
  type: string;
  title: string;
  description: string;
  owner?: string;
  resource?: string;
  tags: string[];
  body: string;
}, timestamp: string): string {
  const owner = input.owner ? `owner: ${input.owner}\n` : "";
  const resource = input.resource ? `resource: ${input.resource}\n` : "";
  const tags = input.tags.map((tag) => `  - ${tag}`).join("\n");
  return `---
type: ${input.type}
title: ${input.title}
description: ${input.description}
${owner}${resource}tags:
${tags}
timestamp: ${timestamp}
---

${input.body}`;
}
