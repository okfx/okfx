import { describe, expect, it } from "vitest";

import { generationTimestamp } from "../src/index.js";

describe("generationTimestamp", () => {
  it("serializes an injected generation time", () => {
    expect(generationTimestamp(new Date("2024-03-02T01:02:03Z")))
      .toBe("2024-03-02T01:02:03.000Z");
  });

  it("rejects invalid dates", () => {
    expect(() => generationTimestamp(new Date(Number.NaN)))
      .toThrow("Generation time must be a valid Date");
  });
});
