import { describe, expect, it } from "vitest";

import { produceMarkdownOkf } from "../src/index.js";

describe("@okfx/adapter-markdown", () => {
  it("produces OKF notes", () => {
    const files = produceMarkdownOkf([{ path: "notes/demo", body: "# Demo\n" }]);
    expect(files[0]).toMatchObject({ path: "notes/demo.md" });
    expect(files[0]?.content).toContain("type: Note");
  });
});
