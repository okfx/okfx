import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { exampleWorkflow } from "../src/index.js";

describe("@okfx/github-action", () => {
  it("ships composite action metadata", async () => {
    const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");

    expect(action).toContain("using: composite");
    expect(action).toContain("okf validate");
    expect(action).toContain("okf lint");
    expect(action).toContain("okf graph");
    expect(action).toContain("okf doctor");
  });

  it("exports an example workflow", () => {
    expect(exampleWorkflow).toContain("actions/checkout@v4");
    expect(exampleWorkflow).toContain("okfx/github-action@v0");
  });
});
