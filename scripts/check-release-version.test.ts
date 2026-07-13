import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repositoryRoot, "scripts/check-release-version.mjs");
const version = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;

describe("release version check", () => {
  it("accepts the repository version tag", () => {
    const result = spawnSync(process.execPath, [script, `v${version}`], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Release version verified: v${version}`);
  });

  it("rejects a tag that does not match the artifacts", () => {
    const result = spawnSync(process.execPath, [script, "v999.0.0"], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`must equal v${version}`);
  });
});
