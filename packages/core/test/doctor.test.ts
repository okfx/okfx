import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { doctorBundle, loadBundle } from "../src/index.js";

async function withBundle(files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "okfx-doctor-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(root, path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("doctorBundle", () => {
  it("scores agent readiness and reports production checks", async () => {
    await withBundle({
      "metrics/wau.md": `---
type: Metric
title: WAU
description: Weekly active users.
timestamp: 2025-01-01T00:00:00Z
---

# WAU
`
    }, async (root) => {
      const result = doctorBundle(await loadBundle(root, { loadConfigFile: false }), {
        now: new Date("2026-07-07T00:00:00Z")
      });
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

      expect(result.score).toBeLessThan(100);
      expect(codes).toContain("agent/missing-index");
      expect(codes).toContain("agent/metric-missing-source");
      expect(codes).toContain("agent/stale-timestamp");
      expect(codes).toContain("agent/missing-owner");
      expect(codes).toContain("agent/missing-usage");
    });
  });

  it("recognizes metric source table links", async () => {
    await withBundle({
      "index.md": "# Index\n[WAU](metrics/wau.md)\n",
      "metrics/wau.md": `---
type: Metric
title: WAU
description: Weekly active users.
---

# WAU

## Usage

[Events](../tables/events.md)
`,
      "tables/events.md": "---\ntype: Table\ntitle: Events\ndescription: Source table.\n---\n# Events\n"
    }, async (root) => {
      const result = doctorBundle(await loadBundle(root, { loadConfigFile: false }));

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("agent/metric-missing-source");
    });
  });

  it("uses failOn from config", async () => {
    await withBundle({
      "concept.md": "---\ntype: Note\n---\n# Concept\n"
    }, async (root) => {
      const result = doctorBundle(await loadBundle(root, { loadConfigFile: false }), {
        config: {
          failOn: "warning"
        }
      });

      expect(result.ok).toBe(false);
      expect(result.failOn).toBe("warning");
    });
  });

  it("reports deprecated concepts without replacement context", async () => {
    await withBundle({
      "old.md": "---\ntype: Note\ntitle: Old\nstatus: deprecated\n---\n# Old\n",
      "tagged.md": "---\ntype: Note\ntitle: Tagged\ntags:\n  - deprecated\nreplacement: new\n---\n# Tagged\n"
    }, async (root) => {
      const result = doctorBundle(await loadBundle(root, { loadConfigFile: false }));
      const deprecatedDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === "agent/deprecated-missing-replacement");

      expect(deprecatedDiagnostics).toEqual([
        expect.objectContaining({
          path: "old.md",
          severity: "warning"
        })
      ]);
    });
  });
});
