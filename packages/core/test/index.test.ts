import { describe, expect, it } from "vitest";

import { defineConfig, okfxVersion } from "../src/index.js";

describe("@okfx/core", () => {
  it("exports the okfx version", () => {
    expect(okfxVersion).toBe("0.1.0");
  });

  it("returns typed config unchanged", () => {
    const config = defineConfig({ okfVersion: "0.1" });
    expect(config).toEqual({ okfVersion: "0.1" });
  });
});
