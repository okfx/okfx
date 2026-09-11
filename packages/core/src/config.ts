import { pathToFileURL } from "node:url";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createJiti } from "jiti";

import { compareStrings } from "./compare.js";
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
  assertConfig(config);
  const configuredPresets = ownProperty(config, "presets");
  const configuredFrontmatter = ownProperty(config, "frontmatter");
  const configuredResourcePolicy = ownProperty(config, "resourcePolicy");
  const configuredMcp = ownProperty(config, "mcp");
  const presets = configuredPresets ?? [...defaultConfig.presets];
  const presetConfigs = presets.map(resolvePreset);
  const presetRules = Object.assign(
    {},
    ...presetConfigs.map((preset) => ownProperty(preset, "rules") ?? {})
  ) as Record<string, RuleConfig>;
  const presetFailOn = presetConfigs
    .map((preset) => ownProperty(preset, "failOn"))
    .reverse()
    .find((failOn) => failOn !== undefined);

  return {
    okfVersion: ownProperty(config, "okfVersion") ?? defaultConfig.okfVersion,
    include: ownProperty(config, "include") ?? [...defaultConfig.include],
    exclude: ownProperty(config, "exclude") ?? [...defaultConfig.exclude],
    presets,
    plugins: normalizePluginReferences(ownProperty(config, "plugins") ?? []),
    rules: {
      ...presetRules,
      ...(ownProperty(config, "rules") ?? {})
    },
    failOn: ownProperty(config, "failOn") ?? presetFailOn ?? defaultConfig.failOn,
    frontmatter: {
      keyOrder: configuredFrontmatter
        ? ownProperty(configuredFrontmatter, "keyOrder") ?? [...defaultConfig.frontmatter.keyOrder]
        : [...defaultConfig.frontmatter.keyOrder]
    },
    resourcePolicy: {
      allowHosts: (configuredResourcePolicy
        ? ownProperty(configuredResourcePolicy, "allowHosts") ?? []
        : []).map(normalizeConfiguredHost)
    },
    mcp: {
      readonly: configuredMcp
        ? ownProperty(configuredMcp, "readonly") ?? defaultConfig.mcp.readonly
        : defaultConfig.mcp.readonly,
      exposeDiagnostics: configuredMcp
        ? ownProperty(configuredMcp, "exposeDiagnostics") ?? defaultConfig.mcp.exposeDiagnostics
        : defaultConfig.mcp.exposeDiagnostics,
      exposeGraph: configuredMcp
        ? ownProperty(configuredMcp, "exposeGraph") ?? defaultConfig.mcp.exposeGraph
        : defaultConfig.mcp.exposeGraph
    },
    configPath
  };
}

function normalizeConfiguredHost(value: string): string {
  const withoutTrailingDot = value.trim().replace(/\.+$/u, "");
  const withoutBrackets = withoutTrailingDot.startsWith("[") && withoutTrailingDot.endsWith("]")
    ? withoutTrailingDot.slice(1, -1)
    : withoutTrailingDot;
  return withoutBrackets.toLowerCase();
}

export function mergeConfig(
  base: ResolvedOkfxConfig,
  override: OkfxConfig | ResolvedOkfxConfig = {}
): ResolvedOkfxConfig {
  const resolvedOverride = resolveConfig(override, base.configPath);
  const configuredPresets = ownProperty(override, "presets");
  const configuredPlugins = ownProperty(override, "plugins");
  const configuredRules = ownProperty(override, "rules");
  const configuredFrontmatter = ownProperty(override, "frontmatter");
  const configuredResourcePolicy = ownProperty(override, "resourcePolicy");
  const configuredMcp = ownProperty(override, "mcp");
  const overridePresets = configuredPresets !== undefined;

  return {
    ...base,
    okfVersion: ownProperty(override, "okfVersion") ?? base.okfVersion,
    include: ownProperty(override, "include") ?? base.include,
    exclude: ownProperty(override, "exclude") ?? base.exclude,
    presets: configuredPresets ?? base.presets,
    plugins: configuredPlugins !== undefined ? resolvedOverride.plugins : base.plugins,
    rules: overridePresets
      ? resolvedOverride.rules
      : {
          ...base.rules,
          ...(configuredRules ?? {})
        },
    failOn: ownProperty(override, "failOn") ?? (overridePresets ? resolvedOverride.failOn : base.failOn),
    frontmatter: {
      keyOrder: configuredFrontmatter
        ? ownProperty(configuredFrontmatter, "keyOrder") ?? base.frontmatter.keyOrder
        : base.frontmatter.keyOrder
    },
    resourcePolicy: {
      allowHosts: configuredResourcePolicy
        && ownProperty(configuredResourcePolicy, "allowHosts") !== undefined
        ? resolvedOverride.resourcePolicy.allowHosts
        : base.resourcePolicy.allowHosts
    },
    mcp: {
      readonly: configuredMcp
        ? ownProperty(configuredMcp, "readonly") ?? base.mcp.readonly
        : base.mcp.readonly,
      exposeDiagnostics: configuredMcp
        ? ownProperty(configuredMcp, "exposeDiagnostics") ?? base.mcp.exposeDiagnostics
        : base.mcp.exposeDiagnostics,
      exposeGraph: configuredMcp
        ? ownProperty(configuredMcp, "exposeGraph") ?? base.mcp.exposeGraph
        : base.mcp.exposeGraph
    },
    configPath: base.configPath
  };
}

function assertConfig(value: unknown): asserts value is OkfxConfig {
  if (!isRecord(value)) {
    invalidConfig("config", "an object");
  }

  optionalString(value, "okfVersion");
  optionalStringArray(value, "include");
  optionalStringArray(value, "exclude");
  optionalStringArray(value, "presets");

  const failOn = ownProperty(value, "failOn");
  if (failOn !== undefined && !isDiagnosticSeverity(failOn)) {
    invalidConfig("failOn", "one of error, warning, advice, or info");
  }

  const plugins = ownProperty(value, "plugins");
  if (plugins !== undefined) {
    if (!Array.isArray(plugins)) {
      invalidConfig("plugins", "an array");
    }
    for (const [index, plugin] of plugins.entries()) {
      if (typeof plugin === "string") {
        if (!plugin.trim()) {
          invalidConfig(`plugins[${index}]`, "a non-empty package string or plugin object");
        }
        continue;
      }
      if (!isRecord(plugin)) {
        invalidConfig(`plugins[${index}].package`, "a non-empty string");
      }
      const packageName = ownProperty(plugin, "package");
      if (typeof packageName !== "string" || !packageName.trim()) {
        invalidConfig(`plugins[${index}].package`, "a non-empty string");
      }
      const enabled = ownProperty(plugin, "enabled");
      if (enabled !== undefined && typeof enabled !== "boolean") {
        invalidConfig(`plugins[${index}].enabled`, "a boolean");
      }
      const options = ownProperty(plugin, "options");
      if (options !== undefined && !isRecord(options)) {
        invalidConfig(`plugins[${index}].options`, "an object");
      }
    }
  }

  const rules = ownProperty(value, "rules");
  if (rules !== undefined) {
    if (!isRecord(rules)) {
      invalidConfig("rules", "an object");
    }
    for (const [id, rule] of Object.entries(rules)) {
      if (Array.isArray(rule)) {
        if (rule.length !== 2 || !isRuleLevel(rule[0]) || !isRecord(rule[1])) {
          invalidConfig(`rules.${id}`, "a rule level or [rule level, options] tuple");
        }
      } else if (!isRuleLevel(rule)) {
        invalidConfig(`rules.${id}`, "one of error, warning, advice, info, or off");
      }
    }
  }

  const frontmatter = ownProperty(value, "frontmatter");
  if (frontmatter !== undefined) {
    if (!isRecord(frontmatter)) {
      invalidConfig("frontmatter", "an object");
    }
    optionalStringArray(frontmatter, "keyOrder", "frontmatter.keyOrder");
  }

  const resourcePolicy = ownProperty(value, "resourcePolicy");
  if (resourcePolicy !== undefined) {
    if (!isRecord(resourcePolicy)) {
      invalidConfig("resourcePolicy", "an object");
    }
    optionalStringArray(resourcePolicy, "allowHosts", "resourcePolicy.allowHosts");
  }

  const mcp = ownProperty(value, "mcp");
  if (mcp !== undefined) {
    if (!isRecord(mcp)) {
      invalidConfig("mcp", "an object");
    }
    for (const key of ["readonly", "exposeDiagnostics", "exposeGraph"] as const) {
      const setting = ownProperty(mcp, key);
      if (setting !== undefined && typeof setting !== "boolean") {
        invalidConfig(`mcp.${key}`, "a boolean");
      }
    }
  }
}

function optionalString(record: Record<string, unknown>, key: string): void {
  const value = ownProperty(record, key);
  if (value !== undefined && typeof value !== "string") {
    invalidConfig(key, "a string");
  }
}

function optionalStringArray(record: Record<string, unknown>, key: string, path = key): void {
  const value = ownProperty(record, key);
  if (value !== undefined
    && (!Array.isArray(value) || Array.from(value).some((entry) => typeof entry !== "string"))) {
    invalidConfig(path, "an array of strings");
  }
}

function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === "error" || value === "warning" || value === "advice" || value === "info";
}

function isRuleLevel(value: unknown): value is RuleLevel {
  return value === "off" || isDiagnosticSeverity(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownProperty<T extends object, K extends keyof T>(record: T, key: K): T[K] | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function invalidConfig(path: string, expected: string): never {
  throw new TypeError(`Invalid okfx config: ${path} must be ${expected}.`);
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

    const packageName = ownProperty(plugin, "package");
    if (packageName === undefined) {
      invalidConfig("plugins[].package", "a non-empty string");
    }

    return {
      package: packageName,
      enabled: ownProperty(plugin, "enabled") ?? true,
      options: ownProperty(plugin, "options") ?? {}
    };
  });
}

function resolvePreset(name: string): OkfxConfig {
  const normalizedName = normalizePresetName(name);
  const preset = Object.hasOwn(builtinPresets, normalizedName)
    ? builtinPresets[normalizedName]
    : undefined;
  if (!preset) {
    throw new Error(`Unknown okfx preset "${name}". Available presets: ${Object.keys(builtinPresets).sort(compareStrings).join(", ")}.`);
  }
  return preset;
}

function normalizePresetName(name: string): string {
  return name
    .replace(/^@okfxjs\/preset-/, "")
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
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }
  }

  return undefined;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
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
