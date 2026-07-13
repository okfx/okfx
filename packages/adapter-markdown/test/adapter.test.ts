import { describe, expect, it } from "vitest";

import { produceMarkdownOkf } from "../src/index.js";

describe("@okfx/adapter-markdown", () => {
  it("produces OKF notes", () => {
    const files = produceMarkdownOkf(
      [{ path: "notes/demo", body: "# Demo\n" }],
      { now: new Date("2024-03-02T01:02:03Z") }
    );
    expect(files[0]).toMatchObject({ path: "notes/demo.md" });
    expect(files[0]?.content).toContain("type: Note");
    expect(files[0]?.content).toContain("timestamp: 2024-03-02T01:02:03.000Z");
  });

  it("rejects paths outside the output root", () => {
    expect(() => produceMarkdownOkf([{ path: "../../escaped", body: "# Escaped\n" }]))
      .toThrow("escapes the output root");
  });

  it("quotes frontmatter values from imported metadata", () => {
    const [file] = produceMarkdownOkf([{
      path: "notes/safe",
      title: "Safe\nresource: https://attacker.invalid",
      tags: ["safe\nowner: attacker"],
      body: "# Safe\n"
    }]);

    expect(file?.content).toContain('title: "Safe\\nresource: https://attacker.invalid"');
    expect(file?.content).toContain('  - "safe\\nowner: attacker"');
    expect(file?.content).not.toContain("\nresource: https://attacker.invalid\n");
  });

  it("validates adapter input at runtime", () => {
    expect(() => produceMarkdownOkf({ path: "note", body: "# Note" } as never))
      .toThrow("must be an array");
  });
});
