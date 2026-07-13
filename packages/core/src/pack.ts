import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import fg from "fast-glob";
import * as tar from "tar";

import { defaultConfig, loadConfig, resolveConfig, type OkfxConfig, type ResolvedOkfxConfig } from "./config.js";
import { loadBundle } from "./bundle.js";
import { sha256Hex } from "./hash.js";
import { relativePosixPath, resolveBundleRoot } from "./paths.js";
import { okfxVersion } from "./version.js";

const execFileAsync = promisify(execFile);

export interface PackOptions {
  config?: OkfxConfig | ResolvedOkfxConfig;
  loadConfigFile?: boolean;
  out?: string;
  bundleName?: string;
  createdAt?: Date;
  writeMetadata?: boolean;
}

export interface PackFileManifestEntry {
  path: string;
  sha256: string;
  concept_id?: string;
}

export interface PackManifestIR {
  manifest_schema_version: 1;
  okfx_version: string;
  okf_version: string;
  bundle_name: string;
  created_at: string;
  concept_count: number;
  file_count: number;
  content_hash: string;
  source: {
    git_commit?: string;
    git_remote?: string;
    dirty?: boolean;
  };
  files: PackFileManifestEntry[];
}

export interface ChecksumsIR {
  algorithm: "sha256";
  files: Record<string, string>;
}

export interface ProvenanceIR {
  created_at: string;
  created_by: "okfx";
  okfx_version: string;
  source: PackManifestIR["source"];
}

export interface PackResult {
  out: string;
  metadataDir: string;
  manifest: PackManifestIR;
  checksums: ChecksumsIR;
  provenance: ProvenanceIR;
}

export async function packBundle(rootInput: string, options: PackOptions = {}): Promise<PackResult> {
  const root = resolveBundleRoot(rootInput);
  const config = options.loadConfigFile === false
    ? resolveConfig(options.config)
    : resolveConfig(options.config ?? await loadConfig(root));
  const bundle = await loadBundle(root, { config, loadConfigFile: false });
  const out = resolve(options.out ?? `${options.bundleName ?? basename(root)}.okf.tar.gz`);
  const files = await discoverPackFiles(root, config, out);
  const conceptIdsByPath = new Map(bundle.concepts.map((concept) => [concept.path, concept.id]));
  const metadataDir = join(root, ".okfx");
  const stagingRoot = await mkdtemp(join(tmpdir(), "okfx-pack-"));

  try {
    const manifestFiles = await Promise.all(files.map((path) => stagePackFile(
      root,
      stagingRoot,
      path,
      conceptIdsByPath.get(path)
    )));
    const createdAt = (options.createdAt ?? new Date()).toISOString();
    const source = await gitSource(root);
    const checksums: ChecksumsIR = {
      algorithm: "sha256",
      files: Object.fromEntries(manifestFiles.map((file) => [file.path, file.sha256]))
    };
    const manifest: PackManifestIR = {
      manifest_schema_version: 1,
      okfx_version: okfxVersion,
      okf_version: config.okfVersion,
      bundle_name: options.bundleName ?? basename(root),
      created_at: createdAt,
      concept_count: bundle.stats.conceptCount,
      file_count: manifestFiles.length,
      content_hash: sha256Hex(JSON.stringify(manifestFiles.map((file) => [file.path, file.sha256]))),
      source,
      files: manifestFiles
    };
    const provenance: ProvenanceIR = {
      created_at: createdAt,
      created_by: "okfx",
      okfx_version: okfxVersion,
      source
    };
    const metadataFiles = [".okfx/manifest.json", ".okfx/checksums.json", ".okfx/provenance.json"];
    const stagingMetadataDir = join(stagingRoot, ".okfx");
    await mkdir(stagingMetadataDir, { recursive: true });
    await writePackMetadata(stagingMetadataDir, manifest, checksums, provenance);

    if (options.writeMetadata ?? true) {
      await mkdir(metadataDir, { recursive: true });
      await writePackMetadata(metadataDir, manifest, checksums, provenance);
    }

    await mkdir(dirname(out), { recursive: true });
    await tar.create({
      cwd: stagingRoot,
      file: out,
      gzip: true,
      portable: true,
      noMtime: true
    }, [...files, ...metadataFiles]);

    return {
      out,
      metadataDir,
      manifest,
      checksums,
      provenance
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function stagePackFile(
  root: string,
  stagingRoot: string,
  path: string,
  conceptId: string | undefined
): Promise<PackFileManifestEntry> {
  const sourcePath = join(root, path);
  const [content, sourceStat] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
  const stagedPath = join(stagingRoot, path);
  const mode = sourceStat.mode & 0o777;
  await mkdir(dirname(stagedPath), { recursive: true });
  await writeFile(stagedPath, content, { mode });
  await chmod(stagedPath, mode);
  return {
    path,
    sha256: sha256Hex(content),
    concept_id: conceptId
  };
}

async function writePackMetadata(
  directory: string,
  manifest: PackManifestIR,
  checksums: ChecksumsIR,
  provenance: ProvenanceIR
): Promise<void> {
  await Promise.all([
    writeJson(join(directory, "manifest.json"), manifest),
    writeJson(join(directory, "checksums.json"), checksums),
    writeJson(join(directory, "provenance.json"), provenance)
  ]);
}

async function discoverPackFiles(root: string, config: ResolvedOkfxConfig, out: string): Promise<string[]> {
  const entries = await fg(["**/*"], {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: [...defaultConfig.exclude, ...config.exclude, ".okfx/**", "**/*.okf.tar.gz"]
  });

  return entries
    .filter((entry) => resolve(entry) !== out)
    .map((entry) => relativePosixPath(root, entry))
    .filter((path) => !isSensitivePackFile(path))
    .sort((a, b) => a.localeCompare(b));
}

function isSensitivePackFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function gitSource(root: string): Promise<PackManifestIR["source"]> {
  try {
    const [commit, remote, status] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]),
      git(root, ["config", "--get", "remote.origin.url"]).catch(() => undefined),
      git(root, ["status", "--porcelain"]).catch(() => "")
    ]);

    return {
      git_commit: commit,
      git_remote: sanitizeGitRemote(remote),
      dirty: status !== ""
    };
  } catch {
    return {};
  }
}

function sanitizeGitRemote(remote: string | undefined): string | undefined {
  if (!remote) {
    return remote;
  }

  try {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    }
  } catch {
    // SCP-style Git remotes do not contain URL password fields and are safe to retain.
  }

  return remote;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}
