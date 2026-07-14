import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import fg from "fast-glob";
import * as tar from "tar";

import {
  defaultConfig,
  loadConfig,
  mergeConfig,
  resolveConfig,
  type OkfxConfig,
  type ResolvedOkfxConfig
} from "./config.js";
import { loadBundle } from "./bundle.js";
import { sha256Hex } from "./hash.js";
import { relativePosixPath, resolveBundleRoot } from "./paths.js";
import { okfxVersion } from "./version.js";

const execFileAsync = promisify(execFile);
const sensitivePackFileNames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".yarnrc.yml",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);

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
    : mergeConfig(await loadConfig(root), options.config);
  const bundle = await loadBundle(root, { config, loadConfigFile: false });
  const out = resolve(options.out ?? `${options.bundleName ?? basename(root)}.okf.tar.gz`);
  const files = await discoverPackFiles(root, config, out);
  const conceptIdsByPath = new Map(bundle.concepts.map((concept) => [concept.path, concept.id]));
  const metadataDir = join(root, ".okfx");
  const stagingRoot = await mkdtemp(join(tmpdir(), "okfx-pack-"));
  let archiveStagingDir: string | undefined;

  try {
    await mkdir(dirname(out), { recursive: true });
    await assertSafeFileTarget(out, "archive");
    archiveStagingDir = await mkdtemp(join(dirname(out), ".okfx-pack-archive-"));
    const stagedArchive = join(archiveStagingDir, basename(out));
    const stagedFiles = await Promise.all(files.map((path) => stagePackFile(
      root,
      stagingRoot,
      path,
      conceptIdsByPath.get(path)
    )));
    const manifestFiles = stagedFiles.filter((file): file is PackFileManifestEntry => file !== undefined);
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
      concept_count: manifestFiles.filter((file) => file.concept_id !== undefined).length,
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
      await ensureSafeDirectory(metadataDir, "metadata directory");
      await writePackMetadata(metadataDir, manifest, checksums, provenance);
    }

    await tar.create({
      cwd: stagingRoot,
      file: stagedArchive,
      gzip: true,
      portable: true,
      noMtime: true
    }, [...manifestFiles.map((file) => file.path), ...metadataFiles]);
    await assertSafeFileTarget(out, "archive");
    await rename(stagedArchive, out);

    return {
      out,
      metadataDir,
      manifest,
      checksums,
      provenance
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    if (archiveStagingDir) {
      await rm(archiveStagingDir, { recursive: true, force: true });
    }
  }
}

async function stagePackFile(
  root: string,
  stagingRoot: string,
  path: string,
  conceptId: string | undefined
): Promise<PackFileManifestEntry | undefined> {
  const sourcePath = join(root, path);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(sourcePath, constants.O_RDONLY | noFollow).catch((error: unknown) => {
    if (isFileSystemError(error, "ELOOP")) {
      throw new Error(`Refusing to pack symbolic link: ${path}`);
    }
    throw error;
  });

  try {
    const sourceStat = await handle.stat();
    if (!sourceStat.isFile()) {
      throw new Error(`Refusing to pack non-file entry: ${path}`);
    }
    const content = await handle.readFile();
    if (containsPrivateKeyMarker(content)) {
      return undefined;
    }

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
  } finally {
    await handle.close();
  }
}

async function writePackMetadata(
  directory: string,
  manifest: PackManifestIR,
  checksums: ChecksumsIR,
  provenance: ProvenanceIR
): Promise<void> {
  const entries = [
    [join(directory, "manifest.json"), manifest],
    [join(directory, "checksums.json"), checksums],
    [join(directory, "provenance.json"), provenance]
  ] as const;
  await Promise.all(entries.map(([path]) => assertSafeFileTarget(path, "metadata file")));
  await Promise.all([
    ...entries.map(([path, value]) => writeJson(path, value))
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

  const paths = entries
    .filter((entry) => resolve(entry) !== out)
    .map((entry) => relativePosixPath(root, entry))
    .sort((a, b) => a.localeCompare(b));
  return paths.filter((path) => !isSensitivePackPath(path));
}

function isSensitivePackPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const name = basename(path).toLowerCase();
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return true;
  }
  if (sensitivePackFileNames.has(name)) {
    return true;
  }
  if (
    containsPathDirectory(normalized, ".ssh")
    || containsPathDirectory(normalized, ".gnupg")
    || hasPathSuffix(normalized, ".aws/credentials")
    || hasPathSuffix(normalized, ".docker/config.json")
    || hasPathSuffix(normalized, ".kube/config")
    || hasPathSuffix(normalized, ".cargo/credentials")
    || hasPathSuffix(normalized, ".cargo/credentials.toml")
    || hasPathSuffix(normalized, ".composer/auth.json")
    || hasPathSuffix(normalized, "application_default_credentials.json")
    || name.endsWith(".tfstate")
    || name.includes(".tfstate.")
    || /\.(?:p12|pfx|jks|keystore)$/.test(name)
  ) {
    return true;
  }

  return false;
}

function containsPathDirectory(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`) || path.includes(`/${directory}/`);
}

function hasPathSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`/${suffix}`);
}

function containsPrivateKeyMarker(content: Buffer): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
    .test(content.toString("utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
    0o666
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function ensureSafeDirectory(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing to use unsafe pack ${label}: ${path}`);
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing to use unsafe pack ${label}: ${path}`);
    }
  }
}

async function assertSafeFileTarget(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Refusing to overwrite unsafe pack ${label}: ${path}`);
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
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
