import { compareStrings, type BundleIR, type DiagnosticIR, type OkfxGraphIR, type ResolvedOkfxConfig } from "@okfx/core";

export { compareStrings };

export interface OkfxRuleContext {
  bundle: BundleIR;
  config: ResolvedOkfxConfig;
  plugin?: {
    name: string;
    source?: string;
    version?: string;
  };
  options?: Record<string, unknown>;
}

export interface OkfxRule {
  meta: {
    description: string;
    defaultSeverity?: DiagnosticIR["severity"];
    severity?: DiagnosticIR["severity"];
  };
  run(context: OkfxRuleContext): DiagnosticIR[] | Promise<DiagnosticIR[]>;
}

export interface OkfxAdapterContext {
  root: string;
  config: ResolvedOkfxConfig;
}

export interface OkfxGenerationOptions {
  now?: Date;
}

export interface IdentifiedGeneratedFile {
  path: string;
  content: string;
  identity: string;
}

export interface OkfxProducerAdapter {
  produce(context: OkfxAdapterContext): Promise<Array<{ path: string; content: string }>>;
}

export interface OkfxConsumerAdapter {
  consume(context: OkfxAdapterContext & { bundle: BundleIR; graph?: OkfxGraphIR }): Promise<Array<{ path: string; content: string }> | void>;
}

export interface OkfxPlugin {
  name: string;
  version?: string;
  rules?: Record<string, OkfxRule>;
  adapters?: Record<string, OkfxProducerAdapter | OkfxConsumerAdapter>;
  mcpTools?: Record<string, unknown>;
}

export function definePlugin<TPlugin extends OkfxPlugin>(plugin: TPlugin): TPlugin {
  return plugin;
}

export function generationTimestamp(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Generation time must be a valid Date.");
  }
  return now.toISOString();
}

export function escapeMarkdownText(value: string): string {
  return value
    .replace(/\r\n?|\n/g, " ")
    .replace(/([!-/:-@[-`{-~])/g, "\\$1");
}

export function markdownCodeSpan(value: string): string {
  const flattened = value.replace(/\r\n?|\n/g, " ");
  const longestRun = Math.max(0, ...(flattened.match(/`+/g) ?? []).map((run) => run.length));
  const delimiter = "`".repeat(longestRun + 1);
  return `${delimiter} ${flattened} ${delimiter}`;
}

export function disambiguateGeneratedPaths(
  files: IdentifiedGeneratedFile[]
): Array<{ path: string; content: string }> {
  const indexesByPath = new Map<string, number[]>();
  for (const [index, file] of files.entries()) {
    indexesByPath.set(file.path, [...(indexesByPath.get(file.path) ?? []), index]);
  }

  const assignedPaths = files.map((file) => file.path);
  const usedPaths = new Set(
    [...indexesByPath]
      .filter(([, indexes]) => indexes.length === 1)
      .map(([path]) => path)
  );

  for (const [basePath, indexes] of [...indexesByPath].sort(([left], [right]) => compareStrings(left, right))) {
    if (indexes.length === 1) {
      continue;
    }

    const sortedIndexes = [...indexes].sort((left, right) =>
      compareStrings(files[left]!.identity, files[right]!.identity) || left - right
    );
    for (let index = 1; index < sortedIndexes.length; index += 1) {
      if (files[sortedIndexes[index - 1]!]!.identity === files[sortedIndexes[index]!]!.identity) {
        throw new Error(
          `Generated files share path ${JSON.stringify(basePath)} and duplicate identity ${JSON.stringify(files[sortedIndexes[index]!]!.identity)}.`
        );
      }
    }

    for (const fileIndex of sortedIndexes) {
      const suffix = stableIdentityHash(files[fileIndex]!.identity);
      let candidate = appendPathSuffix(basePath, suffix);
      let attempt = 2;
      while (usedPaths.has(candidate)) {
        candidate = appendPathSuffix(basePath, `${suffix}-${attempt}`);
        attempt += 1;
      }
      usedPaths.add(candidate);
      assignedPaths[fileIndex] = candidate;
    }
  }

  return files.map((file, index) => ({
    path: assignedPaths[index]!,
    content: file.content
  }));
}

function appendPathSuffix(path: string, suffix: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const extensionIndex = dot > slash ? dot : path.length;
  return `${path.slice(0, extensionIndex)}-${suffix}${path.slice(extensionIndex)}`;
}

function stableIdentityHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}
