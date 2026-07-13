import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface ResolvedGeneratedFile extends GeneratedFile {
  path: string;
  relativePath: string;
}

export function resolveGeneratedFiles(root: string, files: GeneratedFile[]): ResolvedGeneratedFile[] {
  const seen = new Set<string>();

  return files.map((file) => {
    assertPortableRelativePath(file.path);
    if (typeof file.content !== "string") {
      throw new Error(`Generated file content must be a string: ${JSON.stringify(file.path)}`);
    }

    const path = resolve(root, file.path);
    const relativePath = relative(root, path);
    if (
      !relativePath
      || relativePath === ".."
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error(`Generated output path escapes the output root: ${JSON.stringify(file.path)}`);
    }

    const collisionKey = portablePathKey(relativePath);
    if (seen.has(collisionKey)) {
      throw new Error(`Generated files contain duplicate output path: ${JSON.stringify(file.path)}`);
    }
    seen.add(collisionKey);
    return {
      ...file,
      path,
      relativePath
    };
  });
}

export async function inspectGeneratedPath(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split(sep);
  let current = root;

  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to write through symbolic link in output path: ${relativePath}`);
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw new Error(`Refusing to write through non-directory output path: ${relativePath}`);
      }
      if (index === segments.length - 1 && !entry.isFile()) {
        throw new Error(`Refusing to overwrite non-file output path: ${relativePath}`);
      }
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  return true;
}

export async function ensureSafeGeneratedParent(root: string, relativePath: string): Promise<void> {
  await ensureSafeOutputRoot(root);
  const parent = dirname(relativePath);
  if (parent === ".") {
    return;
  }

  let current = root;
  for (const segment of parent.split(sep)) {
    current = resolve(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to write through symbolic link in output path: ${relativePath}`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`Refusing to write through non-directory output path: ${relativePath}`);
      }
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
      await mkdir(current);
    }
  }
}

export async function writeGeneratedFile(path: string, content: string, force: boolean): Promise<void> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY
    | constants.O_CREAT
    | noFollow
    | (force ? constants.O_TRUNC : constants.O_EXCL);
  const handle = await open(path, flags, 0o666);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

async function ensureSafeOutputRoot(root: string): Promise<void> {
  try {
    const entry = await lstat(root);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to write through symbolic link output root: ${root}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`Refusing to use non-directory output root: ${root}`);
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
    await mkdir(root, { recursive: true });
    const entry = await lstat(root);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing to use unsafe output root: ${root}`);
    }
  }
}

function assertPortableRelativePath(path: unknown): asserts path is string {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.includes("\\")
    || path.includes("\0")
    || isAbsolute(path)
  ) {
    throw new Error(`Generated file has an invalid relative path: ${JSON.stringify(path)}`);
  }

  for (const segment of path.split("/")) {
    const deviceName = segment.split(".", 1)[0]?.toUpperCase();
    if (
      !segment
      || segment === "."
      || segment === ".."
      || /[<>:"|?*\u0000-\u001f]/.test(segment)
      || /[ .]$/.test(segment)
      || deviceName === "CON"
      || deviceName === "PRN"
      || deviceName === "AUX"
      || deviceName === "NUL"
      || /^COM[1-9]$/.test(deviceName ?? "")
      || /^LPT[1-9]$/.test(deviceName ?? "")
    ) {
      throw new Error(`Generated file has a non-portable path: ${JSON.stringify(path)}`);
    }
  }
}

function portablePathKey(path: string): string {
  return path
    .split(sep)
    .join("/")
    .normalize("NFC")
    .toLowerCase();
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
