import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import * as tar from "tar";
import { describe, expect, it } from "vitest";

import { packBundle } from "../src/index.js";

const execFileAsync = promisify(execFile);

describe("packBundle", () => {
  it("rejects POSIX filenames with literal backslashes before staging them", async () => {
    if (sep === "\\") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-backslash-"));
    const out = join(root, "..", "backslash.okf.tar.gz");
    try {
      await writeFile(join(root, "evil\\name.md"), "# Evil\n", "utf8");

      await expect(packBundle(root, { out, writeMetadata: false }))
        .rejects.toThrow("non-portable backslash");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("writes metadata and archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-"));
    const out = join(root, "..", "knowledge.okf.tar.gz");
    try {
      await mkdir(join(root, "concepts"), { recursive: true });
      await writeFile(join(root, "okfx.config.ts"), "export default { okfVersion: '0.1' };\n", "utf8");
      await writeFile(join(root, "concepts/example.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");

      const result = await packBundle(root, {
        out,
        createdAt: new Date("2026-07-07T00:00:00Z")
      });
      const manifest = JSON.parse(await readFile(join(root, ".okfx", "manifest.json"), "utf8")) as typeof result.manifest;
      const entries: string[] = [];
      await tar.list({
        file: out,
        onentry(entry) {
          entries.push(entry.path);
        }
      });

      expect((await stat(out)).size).toBeGreaterThan(0);
      expect(manifest).toMatchObject({
        okfx_version: "0.1.0",
        okf_version: "0.1",
        concept_count: 1,
        file_count: 2
      });
      expect(manifest.files.map((file) => file.path).sort()).toEqual(["concepts/example.md", "okfx.config.ts"]);
      expect(entries).toContain(".okfx/manifest.json");
      expect(entries).toContain("concepts/example.md");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("does not include an existing output archive when packing repeatedly", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-repeat-"));
    const out = join(root, "knowledge.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");

      await packBundle(root, { out, createdAt: new Date("2026-07-07T00:00:00Z") });
      const result = await packBundle(root, { out, createdAt: new Date("2026-07-07T00:00:00Z") });
      const entries = await archiveEntries(out);

      expect(result.manifest.files.map((file) => file.path)).toEqual(["concept.md"]);
      expect(entries).not.toContain("knowledge.okf.tar.gz");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the portable manifest content hash algorithm", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-hash-"));
    const out = join(root, "..", "hash.okf.tar.gz");
    try {
      await writeFile(join(root, "a.md"), "a", "utf8");
      await writeFile(join(root, "b.md"), "b", "utf8");

      const result = await packBundle(root, { out, writeMetadata: false });

      expect(result.manifest.content_hash)
        .toBe("58657a1c026e23ab8fa445d46d482b1fa234d4571859961b08b0c1cf4c1ac5af");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("preserves file config when applying runtime overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-config-"));
    const out = join(root, "..", "configured.okf.tar.gz");
    try {
      await mkdir(join(root, "private"));
      await writeFile(
        join(root, "okfx.config.json"),
        JSON.stringify({ exclude: ["private/**"] }),
        "utf8"
      );
      await writeFile(join(root, "concept.md"), "---\ntype: Note\n---\n# Concept\n", "utf8");
      await writeFile(join(root, "private/ignored.txt"), "do not pack", "utf8");

      const result = await packBundle(root, {
        out,
        config: { okfVersion: "9.9" },
        writeMetadata: false
      });

      expect(result.manifest.okf_version).toBe("9.9");
      expect(result.manifest.files.map((file) => file.path)).not.toContain("private/ignored.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("excludes common credentials while retaining examples and public certificates", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-secrets-"));
    const out = join(root, "..", "secrets.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");
      await writeFile(join(root, ".env"), "TOKEN=secret\n", "utf8");
      await writeFile(join(root, ".env.local"), "TOKEN=local-secret\n", "utf8");
      await writeFile(join(root, ".env.example"), "TOKEN=\n", "utf8");
      await writeFile(join(root, ".npmrc"), "//registry.example/:_authToken=secret\n", "utf8");
      await writeFile(join(root, "application_default_credentials.json"), "{\"private_key\":\"secret\"}\n", "utf8");
      await mkdir(join(root, ".aws"));
      await writeFile(join(root, ".aws/credentials"), "aws_secret_access_key=secret\n", "utf8");
      await mkdir(join(root, "nested/.aws"), { recursive: true });
      await mkdir(join(root, "nested/.ssh"), { recursive: true });
      await mkdir(join(root, "nested/.kube"), { recursive: true });
      await writeFile(join(root, "nested/.aws/credentials"), "aws_secret_access_key=nested-secret\n", "utf8");
      await writeFile(join(root, "nested/.ssh/custom-key"), "nested ssh secret\n", "utf8");
      await writeFile(join(root, "nested/.kube/config"), "nested kube secret\n", "utf8");
      await writeFile(join(root, "terraform.tfstate"), JSON.stringify({ secret: "value" }), "utf8");
      await writeFile(join(root, "server.pem"), "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n", "utf8");
      await writeFile(
        join(root, "secret.md"),
        "---\ntype: Note\n---\n# Secret\n\n-----BEGIN PRIVATE KEY-----\nsecret\n",
        "utf8"
      );
      await writeFile(
        join(root, "late-secret.txt"),
        `${"safe prefix\n".repeat(7_000)}-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n`,
        "utf8"
      );
      await writeFile(join(root, "certificate.pem"), "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----\n", "utf8");

      const result = await packBundle(root, { out });

      expect(result.manifest.concept_count).toBe(1);
      expect(result.manifest.files.map((file) => file.path)).toEqual([
        ".env.example",
        "certificate.pem",
        "concept.md"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("keeps verification metadata in the archive without writing it to the bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-no-metadata-"));
    const out = join(root, "..", "no-metadata.okf.tar.gz");
    const extracted = await mkdtemp(join(tmpdir(), "okfx-pack-extracted-"));
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");

      const result = await packBundle(root, { out, writeMetadata: false });

      expect(await archiveEntries(out)).toEqual([
        "concept.md",
        ".okfx/manifest.json",
        ".okfx/checksums.json",
        ".okfx/provenance.json"
      ]);
      await expect(stat(join(root, ".okfx"))).rejects.toMatchObject({ code: "ENOENT" });
      await tar.extract({ file: out, cwd: extracted });
      expect(JSON.parse(await readFile(join(extracted, ".okfx", "manifest.json"), "utf8")))
        .toEqual(result.manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
      await rm(extracted, { recursive: true, force: true });
    }
  });

  it("redacts credentials embedded in provenance Git remotes", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-remote-"));
    const out = join(root, "..", "remote.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");
      await git(root, ["init"]);
      await git(root, ["config", "user.name", "okfx test"]);
      await git(root, ["config", "user.email", "okfx@example.com"]);
      await git(root, ["add", "concept.md"]);
      await git(root, ["commit", "-m", "initial"]);
      await git(root, [
        "remote",
        "add",
        "origin",
        "https://user:password-secret@example.com/org/repo.git?access_token=query-secret#fragment-secret"
      ]);

      const result = await packBundle(root, { out, writeMetadata: false });

      expect(result.manifest.source.git_remote).toBe("https://example.com/org/repo.git");
      expect(JSON.stringify(result.provenance)).not.toContain("secret");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { force: true });
    }
  });

  it("refuses a symlinked metadata directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-metadata-link-"));
    const external = await mkdtemp(join(tmpdir(), "okfx-pack-metadata-external-"));
    const out = join(root, "bundle.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");
      await symlink(external, join(root, ".okfx"), process.platform === "win32" ? "junction" : "dir");

      await expect(packBundle(root, { out })).rejects.toThrow("unsafe pack metadata directory");
      await expect(stat(join(external, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked archive target", async () => {
    const root = await mkdtemp(join(tmpdir(), "okfx-pack-archive-link-"));
    const external = join(root, "external.tar.gz");
    const out = join(root, "bundle.okf.tar.gz");
    try {
      await writeFile(join(root, "concept.md"), "---\ntype: Note\ntitle: Example\n---\n# Example\n", "utf8");
      await writeFile(external, "sentinel", "utf8");
      await symlink(external, out, "file");

      await expect(packBundle(root, { out })).rejects.toThrow("unsafe pack archive");
      expect(await readFile(external, "utf8")).toBe("sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function archiveEntries(path: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.list({
    file: path,
    onentry(entry) {
      entries.push(entry.path);
    }
  });
  return entries;
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root });
}
