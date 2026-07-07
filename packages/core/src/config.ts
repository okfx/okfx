import { pathToFileURL } from "node:url";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createJiti } from "jiti";

import type { DiagnosticSeverity } from "./types.js";

export type RuleLevel = DiagnosticSeverity | "off";
export type RuleConfig = RuleLevel | [RuleLevel, Record<string, unknown>];

export interface OkfxConfig {
  okfVersion?: string;
  include?: string[];
  exclude?: string[];
  presets?: string[];
  rules?: Record<string, RuleConfig>;
  failOn?: DiagnosticSeverity;
  frontmatter?: {
    keyOrder?: string[];
  };
  resourcePolicy?: {
    allowHosts?: string[];
  };
  mcp?: {
    readonly?: boolean;
    exposeDiagnostics?: boolean;
    exposeGraph?: boolean;
  };
}

export interface ResolvedOkfxConfig {
  okfVersion: string;
  include: string[];
  exclude: string[];
  presets: string[];
  rules: Record<string, RuleConfig>;
  failOn: DiagnosticSeverity;
  frontmatter: {
    keyOrder: string[];
  };
  resourcePolicy: {
    allowHosts: string[];
  };
  mcp: {
    readonly: boolean;
    exposeDiagnostics: boolean;
    exposeGraph: boolean;
  };
  configPath?: string;
}

export const defaultFrontmatterKeyOrder = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp"
] as const;

export const defaultConfig: ResolvedOkfxConfig = {
  okfVersion: "0.1",
  include: ["**/*.md"],
  exclude: ["node_modules/**", ".git/**", ".okfx/**", "dist/**"],
  presets: ["recommended"],
  rules: {},
  failOn: "error",
  frontmatter: {
    keyOrder: [...defaultFrontmatterKeyOrder]
  },
  resourcePolicy: {
    allowHosts: []
  },
  mcp: {
    readonly: true,
    exposeDiagnostics: true,
    exposeGraph: true
  }
};

export const configFileNames = [
  "okfx.config.ts",
  "okfx.config.mts",
  "okfx.config.mjs",
  "okfx.config.js",
  "okfx.config.cjs",
  "okfx.config.json"
] as const;

export function defineConfig<TConfig extends OkfxConfig>(config: TConfig): TConfig {
  return config;
}

export function resolveConfig(config: OkfxConfig = {}, configPath?: string): ResolvedOkfxConfig {
  return {
    okfVersion: config.okfVersion ?? defaultConfig.okfVersion,
    include: config.include ?? [...defaultConfig.include],
    exclude: config.exclude ?? [...defaultConfig.exclude],
    presets: config.presets ?? [...defaultConfig.presets],
    rules: config.rules ?? {},
    failOn: config.failOn ?? defaultConfig.failOn,
    frontmatter: {
      keyOrder: config.frontmatter?.keyOrder ?? [...defaultConfig.frontmatter.keyOrder]
    },
    resourcePolicy: {
      allowHosts: config.resourcePolicy?.allowHosts ?? []
    },
    mcp: {
      readonly: config.mcp?.readonly ?? defaultConfig.mcp.readonly,
      exposeDiagnostics: config.mcp?.exposeDiagnostics ?? defaultConfig.mcp.exposeDiagnostics,
      exposeGraph: config.mcp?.exposeGraph ?? defaultConfig.mcp.exposeGraph
    },
    configPath
  };
}

export async function findConfigFile(root: string): Promise<string | undefined> {
  for (const fileName of configFileNames) {
    const candidate = resolve(root, fileName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep searching known config file names.
    }
  }

  return undefined;
}

export async function loadConfig(root: string): Promise<ResolvedOkfxConfig> {
  const configPath = await findConfigFile(root);
  if (!configPath) {
    return resolveConfig();
  }

  if (configPath.endsWith(".json")) {
    const config = JSON.parse(await readFile(configPath, "utf8")) as OkfxConfig;
    return resolveConfig(config, configPath);
  }

  const jiti = createJiti(pathToFileURL(configPath).href, {
    interopDefault: true,
    moduleCache: false
  });
  const config = await jiti.import<OkfxConfig>(configPath, { default: true });
  return resolveConfig(config ?? {}, configPath);
}
