import { pathToFileURL } from "node:url";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createJiti } from "jiti";

import type { DiagnosticSeverity } from "./types.js";

export type RuleLevel = DiagnosticSeverity | "off";
export type RuleConfig = RuleLevel | [RuleLevel, Record<string, unknown>];
export type OkfxPluginReference = string | {
  package: string;
  enabled?: boolean;
  options?: Record<string, unknown>;
};

export interface ResolvedOkfxPluginReference {
  package: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface OkfxConfig {
  okfVersion?: string;
  include?: string[];
  exclude?: string[];
  presets?: string[];
  plugins?: OkfxPluginReference[];
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
  plugins: ResolvedOkfxPluginReference[];
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
  plugins: [],
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

export const builtinPresets: Record<string, OkfxConfig> = {
  recommended: {
    rules: {
      "spec/missing-type": "error",
      "spec/invalid-frontmatter": "error",
      "hygiene/missing-title": "warning",
      "hygiene/missing-description": "warning",
      "hygiene/empty-body": "warning",
      "graph/broken-internal-link": "warning",
      "graph/orphan-concept": "advice",
      "security/suspicious-secret": "error",
      "security/private-key": "error",
      "security/token-looking-value": "warning",
      "security/unredacted-email": "warning",
      "security/internal-url": "warning"
    }
  },
  strict: {
    failOn: "warning",
    rules: {
      "hygiene/missing-title": "error",
      "hygiene/missing-description": "error",
      "hygiene/empty-body": "error",
      "graph/broken-internal-link": "error",
      "graph/no-backlinks": "warning",
      "style/frontmatter-key-order": "warning",
      "style/timestamp-format": "warning",
      "security/private-key": "error",
      "security/token-looking-value": "warning",
      "security/unredacted-email": "warning",
      "security/internal-url": "warning",
      "security/private-url": "warning",
      "security/non-allowlisted-resource": "error"
    }
  },
  "agent-ready": {
    rules: {
      "agent/missing-summary": "advice",
      "agent/missing-usage": "advice",
      "agent/missing-owner": "advice",
      "agent/metric-missing-source": "warning",
      "agent/runbook-missing-symptoms": "warning",
      "agent/api-missing-auth-notes": "advice",
      "graph/no-backlinks": "advice",
      "graph/orphan-concept": "advice"
    }
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
  const presets = config.presets ?? [...defaultConfig.presets];
  const presetConfigs = presets.map(resolvePreset);
  const presetRules = Object.assign({}, ...presetConfigs.map((preset) => preset.rules ?? {})) as Record<string, RuleConfig>;
  const presetFailOn = [...presetConfigs].reverse().find((preset) => preset.failOn)?.failOn;

  return {
    okfVersion: config.okfVersion ?? defaultConfig.okfVersion,
    include: config.include ?? [...defaultConfig.include],
    exclude: config.exclude ?? [...defaultConfig.exclude],
    presets,
    plugins: normalizePluginReferences(config.plugins ?? []),
    rules: {
      ...presetRules,
      ...(config.rules ?? {})
    },
    failOn: config.failOn ?? presetFailOn ?? defaultConfig.failOn,
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

function normalizePluginReferences(plugins: OkfxPluginReference[]): ResolvedOkfxPluginReference[] {
  return plugins.map((plugin) => {
    if (typeof plugin === "string") {
      return {
        package: plugin,
        enabled: true,
        options: {}
      };
    }

    return {
      package: plugin.package,
      enabled: plugin.enabled ?? true,
      options: plugin.options ?? {}
    };
  });
}

function resolvePreset(name: string): OkfxConfig {
  const preset = builtinPresets[normalizePresetName(name)];
  if (!preset) {
    throw new Error(`Unknown okfx preset "${name}". Available presets: ${Object.keys(builtinPresets).sort().join(", ")}.`);
  }
  return preset;
}

function normalizePresetName(name: string): string {
  return name
    .replace(/^@okfx\/preset-/, "")
    .replace(/^preset-/, "");
}

export function resolveRuleLevel(config: RuleConfig | undefined, defaultLevel: RuleLevel): RuleLevel {
  const value = Array.isArray(config) ? config[0] : config;
  return value ?? defaultLevel;
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
