import { describe, expect, it } from "vitest";

import { compareStrings, defineConfig, okfxVersion } from "../src/index.js";

describe("@okfx/core", () => {
  it("exports the okfx version", () => {
    expect(okfxVersion).toBe("0.1.0");
  });

  it("returns typed config unchanged", () => {
    const config = defineConfig({ okfVersion: "0.1" });
    expect(config).toEqual({ okfVersion: "0.1" });
  });

  it("compares strings by Unicode code point without locale dependence", () => {
    expect(["ä", "z", "𐐀", "\ue000"].sort(compareStrings))
      .toEqual(["z", "ä", "\ue000", "𐐀"]);
  });
});
