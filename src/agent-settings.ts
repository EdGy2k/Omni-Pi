import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./atomic.js";
import {
  AUTO_COMMIT_ID,
  type GedPreferences,
  normalizeAutoCommitVerifiedWork,
  normalizeReviewPlanBeforePlannerHandoff,
  REVIEW_PLAN_ID,
} from "./preferences.js";
import { GED_AGENT_ALIASES, GED_AGENT_CAPABILITIES } from "./staffing.js";
import { ensureIgnoredInGitignore } from "./standards.js";

export const GED_AGENT_ROLES = [
  "ged-explorer",
  "ged-planner",
  "ged-plan-reviewer",
  "ged-verifier",
  "ged-worker",
  "ged-smart-worker",
] as const;

export type GedAgentRole = (typeof GED_AGENT_ROLES)[number];

export const GED_WORKER_ROLE: GedAgentRole = "ged-worker";

export const GED_AGENT_PROFILES = ["custom", "adaptive"] as const;
export type GedAgentProfile = (typeof GED_AGENT_PROFILES)[number];

export const ADAPTIVE_PROFILE_REQUIRED_MODELS = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-luna",
] as const;

export const ADAPTIVE_GED_ROLE_MODELS: Readonly<
  Partial<Record<GedAgentRole, AgentModelConfig>>
> = {
  "ged-explorer": {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "low",
    fallback: ["openai-codex/gpt-5.6-luna:low"],
  },
  "ged-planner": {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    fallback: ["openai-codex/gpt-5.6-luna:high"],
  },
  "ged-plan-reviewer": {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    fallback: ["openai-codex/gpt-5.6-luna:max"],
  },
  "ged-verifier": {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    fallback: ["openai-codex/gpt-5.6-luna:max"],
  },
  "ged-worker": {
    model: "openai-codex/gpt-5.6-luna",
    thinking: "max",
    fallback: ["openai-codex/gpt-5.6-sol:max"],
  },
  "ged-smart-worker": {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    fallback: ["openai-codex/gpt-5.6-luna:max"],
  },
};

export const GED_CRITIQUE_MODES = ["off", "risk-based", "always"] as const;
export type GedCritiqueMode = (typeof GED_CRITIQUE_MODES)[number];

const ALLOWED_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function normalizeThinkingLevel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "maximum") return "max";
  return ALLOWED_THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

export function splitFallbackThinkingSuffix(ref: string): {
  model: string;
  thinking?: string;
} {
  const trimmed = ref.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return { model: trimmed };
  const suffix = normalizeThinkingLevel(trimmed.slice(colonIndex + 1));
  if (!suffix) return { model: trimmed };
  return { model: trimmed.slice(0, colonIndex), thinking: suffix };
}

export function modelRefWithoutThinkingSuffix(ref: string): string {
  return splitFallbackThinkingSuffix(ref).model;
}

export function formatFallbackModelRef(ref: string): string {
  const parsed = splitFallbackThinkingSuffix(ref);
  return parsed.thinking
    ? `${parsed.model} [thinking: ${parsed.thinking}]`
    : parsed.model;
}

export type AgentModelConfig =
  | string
  | ({ model: string; fallback?: string[]; fallbackModels?: string[] } & Record<
      string,
      unknown
    >);

export type GedRoleSettings = {
  enabled?: boolean;
  maxParallel?: number;
  preferWorktreeIsolation?: boolean;
} & Record<string, unknown>;

export interface GedAgentsSettings {
  enabled?: boolean;
  profile?: GedAgentProfile;
  supervisorBridge?: boolean;
  peerMessaging?: boolean;
  /** Legacy name migrated to supervisorBridge semantics. */
  intercomBridge?: boolean;
  critiqueMode?: GedCritiqueMode;
  defaultModel?: AgentModelConfig;
  /** Legacy shape retained for existing settings compatibility. */
  models?: Partial<Record<GedAgentRole, AgentModelConfig>>;
  roles?: Partial<Record<GedAgentRole, GedRoleSettings>>;
  allowCheckpointBypass?: boolean;
}

export interface GedRuntimeSettings {
  agents?: GedAgentsSettings;
}

export interface ModelAvailability {
  isAvailable(modelId: string): boolean;
}

export interface SyncGedSubagentRuntimeOptions {
  homeDir?: string;
  modelAvailability?: ModelAvailability;
}

export interface SyncGedSubagentRuntimeResult {
  diagnostics: string[];
}

export interface EffectiveGedRoleSettings {
  enabled: boolean;
  model?: AgentModelConfig;
  maxParallel?: number;
  preferWorktreeIsolation?: boolean;
}

export interface EffectiveGedAgentsSettings {
  enabled: boolean;
  profile: GedAgentProfile;
  supervisorBridge: boolean;
  peerMessaging: boolean;
  /** Compatibility projection for existing consumers. */
  intercomBridge: boolean;
  critiqueMode: GedCritiqueMode;
  defaultModel?: AgentModelConfig;
  models: Partial<Record<GedAgentRole, AgentModelConfig>>;
  roles: Record<GedAgentRole, EffectiveGedRoleSettings>;
  allowCheckpointBypass: boolean;
}

const DEFAULT_ROLE_ENABLED: Record<GedAgentRole, boolean> = {
  "ged-explorer": true,
  "ged-planner": true,
  "ged-plan-reviewer": true,
  "ged-verifier": true,
  "ged-worker": false,
  "ged-smart-worker": false,
};

export function globalGedSettingsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".gedoc", "settings.json");
}

export function projectGedSettingsPath(rootDir: string): string {
  return path.join(rootDir, ".gedoc", "settings.json");
}

function projectPiSettingsPath(rootDir: string): string {
  return path.join(rootDir, ".pi", "settings.json");
}

function piCodingAgentDir(homeDir = os.homedir()): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return homeDir;
  if (configured?.startsWith("~/")) {
    return path.join(homeDir, configured.slice(2));
  }
  return configured || path.join(homeDir, ".pi", "agent");
}

function piSubagentExtensionConfigPath(homeDir = os.homedir()): string {
  return path.join(
    piCodingAgentDir(homeDir),
    "extensions",
    "subagent",
    "config.json",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim());
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseModelConfig(value: unknown): AgentModelConfig | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (isRecord(value) && typeof value.model === "string") {
    const model = value.model.trim();
    if (model.length === 0) return undefined;
    const config: Record<string, unknown> = { ...value, model };
    const thinking = normalizeThinkingLevel(
      value.thinking ?? value.reasoningEffort,
    );
    delete config.reasoningEffort;
    if (thinking) config.thinking = thinking;
    else delete config.thinking;
    const fallback = cleanStringArray(value.fallback ?? value.fallbackModels);
    delete config.fallbackModels;
    if (fallback) config.fallback = fallback;
    else delete config.fallback;
    return config as AgentModelConfig;
  }
  return undefined;
}

function parseCritiqueMode(value: unknown): GedCritiqueMode | undefined {
  return typeof value === "string" &&
    GED_CRITIQUE_MODES.includes(value as GedCritiqueMode)
    ? (value as GedCritiqueMode)
    : undefined;
}

function parseAgentProfile(value: unknown): GedAgentProfile | undefined {
  return typeof value === "string" &&
    GED_AGENT_PROFILES.includes(value as GedAgentProfile)
    ? (value as GedAgentProfile)
    : undefined;
}

function parseRoleSettings(value: unknown): GedRoleSettings | undefined {
  if (!isRecord(value)) return undefined;
  const role: GedRoleSettings = {};
  if (typeof value.enabled === "boolean") role.enabled = value.enabled;
  const model = parseModelConfig(value);
  if (model) {
    if (typeof model === "string") {
      role.model = model;
    } else {
      Object.assign(role, model);
    }
  }
  if (
    typeof value.maxParallel === "number" &&
    Number.isInteger(value.maxParallel) &&
    value.maxParallel > 0
  ) {
    role.maxParallel = value.maxParallel;
  }
  if (typeof value.preferWorktreeIsolation === "boolean") {
    role.preferWorktreeIsolation = value.preferWorktreeIsolation;
  }
  return Object.keys(role).length > 0 ? role : undefined;
}

function roleModelConfig(
  role: GedRoleSettings | undefined,
): AgentModelConfig | undefined {
  if (!role || typeof role.model !== "string") return undefined;
  const config: Record<string, unknown> = { ...role };
  delete config.enabled;
  delete config.maxParallel;
  delete config.preferWorktreeIsolation;
  return parseModelConfig(config);
}

export function cleanAgentsSettings(value: unknown): GedAgentsSettings {
  if (!isRecord(value)) {
    return {};
  }

  const settings: GedAgentsSettings = {};
  if (typeof value.enabled === "boolean") {
    settings.enabled = value.enabled;
  }
  const profile = parseAgentProfile(value.profile);
  if (profile) settings.profile = profile;
  if (typeof value.supervisorBridge === "boolean") {
    settings.supervisorBridge = value.supervisorBridge;
  }
  if (typeof value.peerMessaging === "boolean") {
    settings.peerMessaging = value.peerMessaging;
  }
  if (typeof value.intercomBridge === "boolean") {
    settings.intercomBridge = value.intercomBridge;
  }
  const critiqueMode = parseCritiqueMode(value.critiqueMode);
  if (critiqueMode) settings.critiqueMode = critiqueMode;

  const defaultModel = parseModelConfig(value.defaultModel);
  if (defaultModel) settings.defaultModel = defaultModel;

  if (isRecord(value.models)) {
    const models: Partial<Record<GedAgentRole, AgentModelConfig>> = {};
    for (const role of GED_AGENT_ROLES) {
      const model = parseModelConfig(value.models[role]);
      if (model) models[role] = model;
    }
    if (Object.keys(models).length > 0) settings.models = models;
  }

  if (isRecord(value.roles)) {
    const roles: Partial<Record<GedAgentRole, GedRoleSettings>> = {};
    for (const role of GED_AGENT_ROLES) {
      const roleSettings = parseRoleSettings(value.roles[role]);
      if (roleSettings) roles[role] = roleSettings;
    }
    if (Object.keys(roles).length > 0) settings.roles = roles;
  }

  if (typeof value.allowCheckpointBypass === "boolean") {
    settings.allowCheckpointBypass = value.allowCheckpointBypass;
  }

  return settings;
}

function legacyGedocSettingsPath(filePath: string): string | null {
  const marker = `${path.sep}.gedoc${path.sep}settings.json`;
  return filePath.endsWith(marker)
    ? `${filePath.slice(0, -marker.length)}${path.sep}.gedcode${path.sep}settings.json`
    : null;
}

async function readJsonExact(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const current = await readJsonExact(filePath);
  if (current) return current;
  const legacyPath = legacyGedocSettingsPath(filePath);
  if (legacyPath) return (await readJsonExact(legacyPath)) ?? {};
  return {};
}

async function hasExplicitSupervisorBridgeSetting(
  rootDir: string,
): Promise<boolean> {
  const [globalRaw, projectRaw] = await Promise.all([
    readJson(globalGedSettingsPath()),
    readJson(projectGedSettingsPath(rootDir)),
  ]);
  const globalAgents = isRecord(globalRaw.agents) ? globalRaw.agents : {};
  const projectAgents = isRecord(projectRaw.agents) ? projectRaw.agents : {};
  return (
    typeof globalAgents.supervisorBridge === "boolean" ||
    typeof projectAgents.supervisorBridge === "boolean" ||
    typeof globalAgents.intercomBridge === "boolean" ||
    typeof projectAgents.intercomBridge === "boolean"
  );
}

export async function readGedRuntimeSettings(
  filePath: string,
): Promise<GedRuntimeSettings> {
  const raw = await readJson(filePath);
  return { agents: cleanAgentsSettings(raw.agents) };
}

function mergeRole(
  role: GedAgentRole,
  globalAgents: GedAgentsSettings,
  projectAgents: GedAgentsSettings,
  enabled: boolean,
  profile: GedAgentProfile,
): EffectiveGedRoleSettings {
  const globalRole = globalAgents.roles?.[role];
  const projectRole = projectAgents.roles?.[role];
  const model =
    roleModelConfig(projectRole) ??
    projectAgents.models?.[role] ??
    roleModelConfig(globalRole) ??
    globalAgents.models?.[role] ??
    (profile === "adaptive" ? ADAPTIVE_GED_ROLE_MODELS[role] : undefined);
  const profileDefaultEnabled =
    profile === "adaptive" ? true : DEFAULT_ROLE_ENABLED[role];
  return {
    enabled:
      enabled &&
      (projectRole?.enabled ?? globalRole?.enabled ?? profileDefaultEnabled),
    model,
    maxParallel:
      projectRole?.maxParallel ??
      globalRole?.maxParallel ??
      (role === "ged-worker" ? 2 : role === "ged-smart-worker" ? 1 : undefined),
    preferWorktreeIsolation:
      projectRole?.preferWorktreeIsolation ??
      globalRole?.preferWorktreeIsolation ??
      false,
  };
}

export async function readEffectiveGedAgentsSettings(
  rootDir: string,
  options: { homeDir?: string } = {},
): Promise<EffectiveGedAgentsSettings> {
  const [globalSettings, projectSettings] = await Promise.all([
    readGedRuntimeSettings(globalGedSettingsPath(options.homeDir)),
    readGedRuntimeSettings(projectGedSettingsPath(rootDir)),
  ]);
  const globalAgents = globalSettings.agents ?? {};
  const projectAgents = projectSettings.agents ?? {};
  const enabled = projectAgents.enabled ?? globalAgents.enabled ?? false;
  const profile =
    projectAgents.profile ?? globalAgents.profile ?? ("custom" as const);
  const defaultModel = projectAgents.defaultModel ?? globalAgents.defaultModel;

  const roles = Object.fromEntries(
    GED_AGENT_ROLES.map((role) => [
      role,
      mergeRole(role, globalAgents, projectAgents, enabled, profile),
    ]),
  ) as Record<GedAgentRole, EffectiveGedRoleSettings>;
  const models = Object.fromEntries(
    GED_AGENT_ROLES.flatMap((role) => {
      const model = roles[role].model;
      return model ? [[role, model]] : [];
    }),
  ) as Partial<Record<GedAgentRole, AgentModelConfig>>;

  return {
    enabled,
    profile,
    supervisorBridge:
      projectAgents.supervisorBridge ??
      projectAgents.intercomBridge ??
      globalAgents.supervisorBridge ??
      globalAgents.intercomBridge ??
      true,
    peerMessaging:
      projectAgents.peerMessaging ?? globalAgents.peerMessaging ?? false,
    intercomBridge:
      projectAgents.supervisorBridge ??
      projectAgents.intercomBridge ??
      globalAgents.supervisorBridge ??
      globalAgents.intercomBridge ??
      true,
    critiqueMode:
      projectAgents.critiqueMode ?? globalAgents.critiqueMode ?? "risk-based",
    defaultModel,
    models,
    roles,
    allowCheckpointBypass:
      projectAgents.allowCheckpointBypass ??
      globalAgents.allowCheckpointBypass ??
      false,
  };
}

export async function writeGedAgentsSettings(
  filePath: string,
  agents: GedAgentsSettings,
): Promise<void> {
  const existing = await readJson(filePath);
  const next = { ...existing, agents: cleanAgentsSettings(agents) };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Read effective GedPi workflow preferences.
 * Falls back to defaults for any missing or invalid keys.
 * On first read, migrates values from the old pi-extension-settings
 * file (~/.pi/agent/settings-extensions.json) if present.
 */
export async function readGedPreferences(
  homeDir?: string,
): Promise<GedPreferences> {
  const settingsPath = globalGedSettingsPath(homeDir);
  const raw = await readJson(settingsPath);
  const stored = isRecord(raw.preferences) ? raw.preferences : {};

  const prefs: GedPreferences = {
    autoCommitVerifiedWork: normalizeAutoCommitVerifiedWork(
      stored.autoCommitVerifiedWork,
    ),
    reviewPlanBeforePlannerHandoff: normalizeReviewPlanBeforePlannerHandoff(
      stored.reviewPlanBeforePlannerHandoff,
    ),
  };

  const needAutoCommit = stored.autoCommitVerifiedWork === undefined;
  const needReviewPlan = stored.reviewPlanBeforePlannerHandoff === undefined;
  if (needAutoCommit || needReviewPlan) {
    const migrated = await migrateLegacyPreferences(homeDir ?? os.homedir());
    if (migrated) {
      let shouldWrite = false;
      if (needAutoCommit && migrated.autoCommitVerifiedWork !== undefined) {
        prefs.autoCommitVerifiedWork = normalizeAutoCommitVerifiedWork(
          migrated.autoCommitVerifiedWork,
        );
        shouldWrite = true;
      }
      if (
        needReviewPlan &&
        migrated.reviewPlanBeforePlannerHandoff !== undefined
      ) {
        prefs.reviewPlanBeforePlannerHandoff =
          normalizeReviewPlanBeforePlannerHandoff(
            migrated.reviewPlanBeforePlannerHandoff,
          );
        shouldWrite = true;
      }
      if (shouldWrite) {
        await writeRawSettings(settingsPath, (next) => {
          const prefsObj: Record<string, unknown> =
            next.preferences && isRecord(next.preferences)
              ? next.preferences
              : {};
          if (needAutoCommit)
            prefsObj[AUTO_COMMIT_ID] = prefs.autoCommitVerifiedWork;
          if (needReviewPlan)
            prefsObj[REVIEW_PLAN_ID] = prefs.reviewPlanBeforePlannerHandoff;
          next.preferences = prefsObj;
          return next;
        });
      }
    }
  }

  return prefs;
}

/** Write a single preference key, preserving agents and other top-level fields. */
export async function writeGedPreference(
  key: string,
  value: string,
  homeDir?: string,
): Promise<void> {
  const settingsPath = globalGedSettingsPath(homeDir);
  await writeRawSettings(settingsPath, (next) => {
    if (!next.preferences || !isRecord(next.preferences)) next.preferences = {};
    (next.preferences as Record<string, unknown>)[key] = value;
    return next;
  });
}

async function writeRawSettings(
  filePath: string,
  update: (next: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const existing = await readJson(filePath);
  const next = update(existing);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

interface LegacyPreferences {
  autoCommitVerifiedWork?: unknown;
  reviewPlanBeforePlannerHandoff?: unknown;
}

async function migrateLegacyPreferences(
  homeDir: string,
): Promise<LegacyPreferences | null> {
  const legacyPath = path.join(
    homeDir,
    ".pi",
    "agent",
    "settings-extensions.json",
  );
  try {
    const raw = await readJson(legacyPath);
    const gedpi = raw.gedpi;
    if (isRecord(gedpi)) {
      return {
        autoCommitVerifiedWork: gedpi.autoCommitVerifiedWork,
        reviewPlanBeforePlannerHandoff: gedpi.reviewPlanBeforePlannerHandoff,
      };
    }
  } catch {
    // File doesn't exist or is unreadable — no legacy values to migrate.
  }
  return null;
}

export function formatGedAgentsStatus(
  effective: EffectiveGedAgentsSettings,
  availability?: ModelAvailability,
): string {
  const modelLines = GED_AGENT_ROLES.map((role) => {
    const roleSettings = effective.roles[role];
    const config = roleSettings.model ?? effective.defaultModel ?? "inherit";
    const modelLabel = formatModelConfig(
      config === "inherit" ? undefined : config,
    );
    const thinking = thinkingLevel(config === "inherit" ? undefined : config);
    const thinkingTag = thinking ? ` [thinking: ${thinking}]` : "";
    const enabled = roleSettings.enabled
      ? "enabled"
      : "disabled → main fallback";
    const capabilityId = GED_AGENT_ALIASES[role];
    const capability = GED_AGENT_CAPABILITIES[capabilityId];
    const workerExtras = capability.writer
      ? ` [maxParallel: ${roleSettings.maxParallel ?? capability.maxParallel}, parallel isolation: required]`
      : "";
    return `- ${role} (${capabilityId}): ${enabled}; ${modelLabel}${thinkingTag}; ${capability.readOnly ? "read-only" : "writer"}; context ${capability.defaultContext}${capability.mayFanout ? "; fanout depth 1/read-only children" : "; leaf"}${workerExtras}`;
  });
  const unavailable = unavailableProfileModels(effective, availability);
  return [
    `Subagents: ${effective.enabled ? "enabled" : "disabled"}`,
    `Profile: ${effective.profile}`,
    `Supervisor bridge: ${effective.supervisorBridge ? "enabled" : "disabled"}`,
    `Peer messaging: ${effective.peerMessaging ? "enabled (exact-target verified fact sends only)" : "disabled"}`,
    `Critique mode: ${effective.critiqueMode}`,
    `Default model: ${formatModelConfig(effective.defaultModel)}`,
    "Role models:",
    ...modelLines,
    `Allowed roles: ${GED_AGENT_ROLES.join(", ")}`,
    "Default/builtin pi-subagents agents: disabled/hidden by GedPi runtime sync",
    "Writer roles: optional capacity; main agent owns scope, acceptance, patch adjudication, commits, pushes, and lifecycle",
    ...(unavailable.length > 0
      ? [
          `Unavailable profile diagnostic: no configured candidate is live for ${unavailable.join(", ")}. Settings were preserved; no provider was substituted.`,
        ]
      : []),
  ].join("\n");
}

function modelId(value: AgentModelConfig | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.model;
}

export function modelCandidates(value: AgentModelConfig | undefined): string[] {
  const primary = modelId(value);
  if (!primary) return [];
  return [...new Set([primary, ...fallbackChain(value)])];
}

export function selectAgentModel(
  value: AgentModelConfig | undefined,
  availability?: ModelAvailability,
): string | undefined {
  const candidates = modelCandidates(value);
  if (candidates.length === 0) return undefined;
  if (!availability) return candidates[0];
  return candidates.find((candidate) =>
    availability.isAvailable(modelRefWithoutThinkingSuffix(candidate)),
  );
}

export function missingAdaptiveProfileModels(
  availability: ModelAvailability,
): string[] {
  return ADAPTIVE_PROFILE_REQUIRED_MODELS.filter(
    (model) => !availability.isAvailable(model),
  );
}

function fallbackChain(value: AgentModelConfig | undefined): string[] {
  if (!value || typeof value === "string") return [];
  const fb = value.fallback ?? value.fallbackModels;
  return Array.isArray(fb)
    ? fb.filter((item): item is string => typeof item === "string")
    : [];
}

function thinkingLevel(
  value: AgentModelConfig | undefined,
): string | undefined {
  if (!value || typeof value === "string") return undefined;
  const thinking = value.thinking;
  if (typeof thinking === "string") {
    return normalizeThinkingLevel(thinking);
  }
  return undefined;
}

export function unavailableProfileModels(
  effective: EffectiveGedAgentsSettings,
  availability?: ModelAvailability,
): string[] {
  if (!availability) return [];
  return GED_AGENT_ROLES.flatMap((role) => {
    if (!effective.roles[role].enabled) return [];
    const configured = effective.roles[role].model ?? effective.defaultModel;
    if (
      configured === undefined ||
      selectAgentModel(configured, availability) !== undefined
    ) {
      return [];
    }
    const candidates = modelCandidates(configured).map(
      modelRefWithoutThinkingSuffix,
    );
    return [`${role} [${candidates.join(", ")}]`];
  });
}

function formatModelConfig(value: AgentModelConfig | undefined): string {
  if (!value) return "inherit orchestrator";
  if (typeof value === "string") return value;
  const primary = value.model;
  const fb = fallbackChain(value);
  if (fb.length === 0) return primary;
  return `${primary} → ${fb.map(formatFallbackModelRef).join(" → ")}`;
}

function frontmatterModelLines(config: AgentModelConfig | undefined): string {
  const primary = modelId(config);
  const modelLine = primary ? `model: ${primary}\n` : "";
  const fallback = fallbackChain(config);
  const fallbackLine =
    fallback.length > 0 ? `fallbackModels: ${fallback.join(", ")}\n` : "";
  const thinking = thinkingLevel(config);
  const thinkingLine = thinking ? `thinking: ${thinking}\n` : "";
  return `${modelLine}${fallbackLine}${thinkingLine}`;
}

function commonFrontmatter(
  role: GedAgentRole,
  effective: EffectiveGedAgentsSettings,
): string {
  const roleSettings = effective.roles[role];
  const config = roleSettings.model ?? effective.defaultModel;
  const capability = GED_AGENT_CAPABILITIES[GED_AGENT_ALIASES[role]];
  const supervisorTool = effective.supervisorBridge
    ? ", contact_supervisor"
    : "";
  const tools = capability.writer
    ? capability.mayFanout
      ? `read, grep, find, ls, bash, edit, write, subagent, subagent_wait${supervisorTool}`
      : `read, grep, find, ls, bash, edit, write${supervisorTool}`
    : `read, grep, find, ls${supervisorTool}`;
  const smartWorkerExtensions = capability.mayFanout
    ? `subagentOnlyExtensions: ${fileURLToPath(import.meta.resolve("pi-subagents"))}, ${fileURLToPath(new URL("../extensions/ged-smart-worker-ceiling/index.ts", import.meta.url))}\n`
    : "";
  return `name: ${role}\n${frontmatterModelLines(config)}tools: ${tools}\n${smartWorkerExtensions}systemPromptMode: replace\ninheritProjectContext: ${capability.writer}\ninheritSkills: false\ndefaultContext: ${capability.defaultContext}\nmaxSubagentDepth: ${capability.mayFanout ? 1 : 0}\nacceptanceRole: ${capability.writer ? "writer" : "read-only"}\ncompletionGuard: ${capability.writer}\n`;
}

function bundledRolePrompt(
  role: GedAgentRole,
  effective: EffectiveGedAgentsSettings,
): string {
  const prompts: Record<GedAgentRole, string> = {
    "ged-explorer": `---
description: Read-only Ged codebase scout for evidence-backed discovery packets.
${commonFrontmatter(role, effective)}---

# Ged Explorer

You are a read-only intelligence contributor for GedPi. Gather evidence before the main agent plans or edits.

Do:
- Inventory bundled, project, and user skills; evaluate relevance and coverage.
- Search the public skill ecosystem with \`npx skills find <query>\` only when there is a real coverage gap.
- Map relevant files, tests, docs, entry points, types, data flow, and risks.
- Report concise evidence with file paths and line references.

Do not edit files, install skills, create project skills, write planning artifacts, commit, push, or make scope decisions.
`,
    "ged-planner": `---
description: Ged planning author that drafts SPEC/TASKS/TESTS from clarified requirements and explorer findings.
${commonFrontmatter(role, effective)}---

# Ged Planner

You author draft implementation plans for GedPi. Use the clarified user goal, constraints, explorer findings, and durable .ged context to draft concrete SPEC/TASKS/TESTS content.

Before drafting, check semantic sufficiency. If the dispatch lacks goal, users/audience, scope, constraints, risks, or acceptance criteria, return \`outcome: refused-needs-clarification\` and list the missing dimensions.

When sufficient, produce:
- Draft SPEC sections with goal, approach, design, risks, and open questions.
- Bounded TASKS slices.
- Verification strategy and focused checks.

You do not own final scope. The main agent accepts, edits, or rejects your draft and writes final .ged files. Do not edit source, commit, push, or make product decisions.
`,
    "ged-plan-reviewer": `---
description: Ged plan reviewer for risk-based critique of accepted planner drafts.
${commonFrontmatter(role, effective)}---

# Ged Plan Reviewer

You critique accepted Ged plans before implementation. Look for missing requirements, unsafe sequencing, unclear tests, hidden coupling, worker-safety risks, and unnecessary scope. Flag slices that are too ambiguous, coupled, risky, judgment-heavy, or hard to verify for safe worker delegation.

Return blockers separately from non-blocking suggestions. Do not rewrite the plan wholesale unless asked. Never edit files, implement, commit, or push.
`,
    "ged-verifier": `---
description: Ged clean-context reviewer for diffs and verification evidence.
${commonFrontmatter(role, effective)}---

# Ged Verifier

You are a clean-context reviewer. Inspect diffs, tests, logs, and scope match. Report findings with severity, evidence, suggested fix, confidence, and whether each blocks commit.

The dispatch must provide a strict structured output schema with \`outcome\` (\`clean\` or \`findings\`) and a \`findings\` array. Return \`outcome: "clean"\` only when the findings array is empty. Any finding, including non-blocking findings, uses \`outcome: "findings"\` so the main agent can adjudicate it before a fresh verifier run.

Never edit files, adjudicate acceptance, commit, push, or open PRs. The main agent owns final judgment, fixes accepted findings directly by default, reruns verification, and commits.
`,
    "ged-worker": `---
description: Optional Ged implementation worker for approved, bounded plan slices.
${commonFrontmatter(role, effective)}---

# Ged Worker

You implement only the approved slice assigned by the main Ged agent after its worker-suitability check. Stay inside the task boundaries and report anything that changes scope.

When the dispatch includes a pi-subagents acceptance contract, satisfy its current public criteria, evidence, verification commands, and stop rules, then provide the required structured acceptance report. Do not reinterpret child evidence as governance authority.

Allowed when explicitly enabled:
- Edit source for the assigned slice.
- Run relevant checks.
- Ask the supervisor via \`contact_supervisor\` when blocked or when a decision changes product behavior, API shape, data migration, risk, or scope.

Forbidden:
- Do not commit, push, rebase, merge, resolve broad conflicts, or perform unsafe git operations.
- Do not edit unrelated files or broaden scope.
- Do not continue through ambiguity; escalate instead.
- Do not continue if the slice appears too difficult, ambiguous, risky, coupled, hard to verify, or judgment-heavy; report that the main agent should implement it directly.
- Do not handle verifier-finding follow-up unless the main agent explicitly dispatches a new isolated mechanical slice with a clear verification path.

Final output must summarize files changed, tests run, remaining risks, and any decisions needed. Worker completion never replaces verifier review or main-agent acceptance.
`,
    "ged-smart-worker": `---
description: Bounded Ged smart implementation worker with depth-one read-only fanout.
${commonFrontmatter(role, effective)}---

# Ged Smart Worker

You implement one approved difficult but bounded slice as the sole writer for your checkout/worktree. The coordinator owns scope, architecture, product decisions, patch application, evidence adjudication, commits, pushes, and lifecycle.

You may use the \`subagent\` tool only when the coordinator explicitly assigns read-only fanout. Use public \`workflowScript\` with stable lane keys and only these read-only agents: ged-explorer, ged-planner, ged-plan-reviewer, and ged-verifier. The inherited capability ceiling enforces this list, and maxSubagentDepth limits fanout to one level. Never dispatch a worker, Smart Worker, generic writer, or a child that can edit.

Keep your own implementation within the approved slice. Use \`contact_supervisor\` for a required decision or a plan-changing discovery; return routine completion through the normal result. Stop rather than invent product, API, security, migration, architecture, or UX choices.

Do not commit, push, rebase, merge, open PRs, or broaden scope. Final output must name changed files, commands and exit codes, residual risks, nested read-only evidence used, and decisions still needed. Completion never authorizes coordinator governance.
`,
  };
  return prompts[role];
}

async function ensurePiSubagentSuppression(rootDir: string): Promise<void> {
  const settingsPath = projectPiSettingsPath(rootDir);
  const existing = await readJson(settingsPath);
  const subagents = isRecord(existing.subagents)
    ? { ...existing.subagents }
    : {};
  if (subagents.disableBuiltins === true) return;
  subagents.disableBuiltins = true;
  const next = { ...existing, subagents };
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

function existingIntercomBridgeMode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.mode === "string" &&
    (value.mode === "always" || value.mode === "fork-only")
    ? value.mode
    : undefined;
}

async function ensurePiSubagentExtensionConfig(
  effective: EffectiveGedAgentsSettings,
): Promise<void> {
  const configPath = piSubagentExtensionConfigPath();
  const existing = (await readJsonExact(configPath)) ?? {};
  const currentBridge = isRecord(existing.intercomBridge)
    ? { ...existing.intercomBridge }
    : {};
  currentBridge.mode = effective.supervisorBridge
    ? (existingIntercomBridgeMode(currentBridge) ?? "always")
    : "off";
  const next = { ...existing, intercomBridge: currentBridge };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

async function disableLegacyGedBrainSubagent(rootDir: string): Promise<void> {
  const brainPath = path.join(rootDir, ".pi", "agents", "ged-brain.md");
  if (!existsSync(brainPath)) return;
  const raw = await readFile(brainPath, "utf8").catch(() => "");
  if (!raw.startsWith("---\n") || raw.includes("\ndisabled: true\n")) return;
  const marker = "\n---";
  const end = raw.indexOf(marker, 4);
  if (end === -1) return;
  const next = `${raw.slice(0, end)}\ndisabled: true${raw.slice(end)}`;
  await writeFileAtomic(brainPath, next);
}

export async function syncGedSubagentRuntimeConfig(
  rootDir: string,
  options: SyncGedSubagentRuntimeOptions = {},
): Promise<SyncGedSubagentRuntimeResult> {
  const effective = await readEffectiveGedAgentsSettings(rootDir, {
    homeDir: options.homeDir,
  });
  await ensureIgnoredInGitignore(rootDir, ".gedoc/");
  await ensureIgnoredInGitignore(rootDir, ".gedcode/");
  await ensurePiSubagentSuppression(rootDir);
  await disableLegacyGedBrainSubagent(rootDir);
  if (
    effective.enabled &&
    (await hasExplicitSupervisorBridgeSetting(rootDir))
  ) {
    await ensurePiSubagentExtensionConfig(effective);
  }

  const agentsDir = path.join(rootDir, ".pi", "agents");

  if (!effective.enabled) {
    await Promise.all(
      GED_AGENT_ROLES.map((role) =>
        rm(path.join(agentsDir, `${role}.md`), { force: true }),
      ),
    );
    return { diagnostics: [] };
  }

  await mkdir(agentsDir, { recursive: true });
  await Promise.all(
    GED_AGENT_ROLES.map(async (role) => {
      const filePath = path.join(agentsDir, `${role}.md`);
      if (!effective.roles[role].enabled) {
        await rm(filePath, { force: true });
        return;
      }
      await writeFileAtomic(filePath, bundledRolePrompt(role, effective));
    }),
  );
  const unavailable = unavailableProfileModels(
    effective,
    options.modelAvailability,
  );
  return {
    diagnostics:
      unavailable.length > 0
        ? [
            `No configured live model candidate for: ${unavailable.join(", ")}. Profile settings were preserved and no provider was substituted.`,
          ]
        : [],
  };
}
