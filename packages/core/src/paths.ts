import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import { unescapeMarkdownDestination } from "./markdown-destination.js";

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
  return normalized.endsWith(".md") ? normalized.slice(0, -3) : normalized;
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
  const unescapedTarget = unescapeMarkdownDestination(targetRaw);
  const [withoutHash] = unescapedTarget.split("#", 1);
  const [withoutQuery] = withoutHash.split("?", 1);
  if (!withoutQuery) {
    return undefined;
  }

  const decodedTarget = decodePercentEncodedPath(withoutQuery);
  if (decodedTarget.includes("\0")) {
    return undefined;
  }

  const targetPath = decodedTarget.startsWith("/")
    ? decodedTarget.slice(1)
    : posix.join(dirname(normalizeRelativePath(sourcePath)), decodedTarget);

  const normalized = normalizeRelativePath(targetPath);
  if (normalized.startsWith("../") || normalized === ".." || isAbsolute(normalized)) {
    return undefined;
  }

  return conceptIdFromPath(normalized);
}

function decodePercentEncodedPath(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
}

export function relativeMarkdownTarget(sourcePath: string, targetPath: string): string {
  const sourceDirectory = posix.dirname(normalizeRelativePath(sourcePath));
  return posix.relative(sourceDirectory, normalizeRelativePath(targetPath));
}
