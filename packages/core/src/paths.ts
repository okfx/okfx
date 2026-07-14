import { basename, dirname, extname, isAbsolute, posix, relative, resolve, sep } from "node:path";

const reservedFileNames = new Set(["index.md", "log.md"]);

export function toPosixPath(path: string): string {
  return path.split(sep).join("/").replace(/\\/g, "/");
}

export function normalizeRelativePath(path: string): string {
  const normalized = posix.normalize(toPosixPath(path));
  if (normalized === ".") {
    return "";
  }

  return normalized.replace(/^\.\//, "");
}

export function relativePosixPath(root: string, filePath: string): string {
  return normalizeRelativePath(toPosixPath(relative(root, filePath)));
}

export function resolveBundleRoot(root: string): string {
  return resolve(root);
}

export function conceptIdFromPath(path: string): string {
  const normalized = normalizeRelativePath(path);
  const ext = extname(normalized);
  return ext === ".md" ? normalized.slice(0, -ext.length) : normalized;
}

export function isReservedMarkdownFile(path: string): boolean {
  return reservedFileNames.has(basename(path));
}

export function reservedFileKind(path: string): "index" | "log" | undefined {
  const name = basename(path);
  if (name === "index.md") {
    return "index";
  }
  if (name === "log.md") {
    return "log";
  }
  return undefined;
}

export function resolveMarkdownTarget(sourcePath: string, targetRaw: string): string | undefined {
  const withoutSuffix = stripMarkdownSuffix(targetRaw);
  if (!withoutSuffix) {
    return undefined;
  }

  const decodedTarget = decodeMarkdownPath(withoutSuffix);

  const targetPath = decodedTarget.startsWith("/")
    ? decodedTarget.slice(1)
    : posix.join(dirname(normalizeRelativePath(sourcePath)), decodedTarget);

  const normalized = normalizeRelativePath(targetPath);
  if (normalized.startsWith("../") || normalized === ".." || isAbsolute(normalized)) {
    return undefined;
  }

  return conceptIdFromPath(normalized);
}

function stripMarkdownSuffix(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "#" || character === "?") && !isMarkdownEscaped(value, index)) {
      return value.slice(0, index);
    }
  }

  return value;
}

function isMarkdownEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function decodeMarkdownPath(value: string): string {
  const characters = [...value];
  let unescaped = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    const next = characters[index + 1];
    if (character === "\\" && next !== undefined && isAsciiPunctuation(next)) {
      unescaped += next;
      index += 1;
    } else {
      unescaped += character;
    }
  }

  return unescaped.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

function isAsciiPunctuation(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return (code >= 0x21 && code <= 0x2f)
    || (code >= 0x3a && code <= 0x40)
    || (code >= 0x5b && code <= 0x60)
    || (code >= 0x7b && code <= 0x7e);
}

export function relativeMarkdownTarget(sourcePath: string, targetPath: string): string {
  const sourceDirectory = posix.dirname(normalizeRelativePath(sourcePath));
  return posix.relative(sourceDirectory, normalizeRelativePath(targetPath));
}
