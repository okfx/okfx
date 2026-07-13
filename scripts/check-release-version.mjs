import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function packageManifestPaths(root) {
  const paths = [join(root, "package.json")];

  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      paths.push(join(root, "packages", entry.name, "package.json"));
    }
  }

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === "package.json") {
        paths.push(path);
      }
    }
  }

  await visit(join(root, "npm"));
  return paths;
}

function workspaceCargoVersion(source) {
  const lines = source.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === "[workspace.package]");
  if (sectionStart < 0) {
    throw new Error("Cargo.toml is missing [workspace.package]");
  }

  for (const line of lines.slice(sectionStart + 1)) {
    if (line.trim().startsWith("[")) {
      break;
    }
    const match = /^\s*version\s*=\s*"([^"]+)"\s*$/.exec(line);
    if (match) {
      return match[1];
    }
  }

  throw new Error("Cargo.toml [workspace.package] is missing version");
}

export async function checkReleaseVersion(tag, root = repositoryRoot) {
  const manifests = await Promise.all((await packageManifestPaths(root)).map(async (path) => ({
    path,
    manifest: JSON.parse(await readFile(path, "utf8"))
  })));
  const rootManifest = manifests.find(({ path }) => path === join(root, "package.json"))?.manifest;
  const expectedVersion = rootManifest?.version;

  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    throw new Error("Root package.json must define a version");
  }

  const mismatches = manifests
    .filter(({ manifest }) => manifest.version !== expectedVersion)
    .map(({ path, manifest }) => `${relative(root, path)}=${String(manifest.version)}`);
  const cargoVersion = workspaceCargoVersion(await readFile(join(root, "Cargo.toml"), "utf8"));
  if (cargoVersion !== expectedVersion) {
    mismatches.push(`Cargo.toml=${cargoVersion}`);
  }

  if (mismatches.length > 0) {
    throw new Error(`Release versions must all equal ${expectedVersion}: ${mismatches.join(", ")}`);
  }

  const expectedTag = `v${expectedVersion}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must equal ${expectedTag}`);
  }

  return expectedVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliArguments = process.argv.slice(2);
  const tag = (cliArguments[0] === "--" ? cliArguments[1] : cliArguments[0])
    ?? process.env.RELEASE_TAG
    ?? process.env.GITHUB_REF_NAME;
  try {
    const version = await checkReleaseVersion(tag);
    console.log(`Release version verified: v${version}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
