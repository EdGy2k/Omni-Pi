import type { Api, Model } from "@earendil-works/pi-ai";
// Pi UI context type alias for the command handler
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList } from "@earendil-works/pi-tui";
import {
  type AgentModelConfig,
  formatFallbackModelRef,
  formatGedAgentsStatus,
  GED_AGENT_ROLES,
  GED_CRITIQUE_MODES,
  type GedAgentRole,
  type GedAgentsSettings,
  globalGedSettingsPath,
  type ModelAvailability,
  modelRefWithoutThinkingSuffix,
  projectGedSettingsPath,
  readEffectiveGedAgentsSettings,
  readGedPreferences,
  readGedRuntimeSettings,
  syncGedSubagentRuntimeConfig,
  writeGedAgentsSettings,
  writeGedPreference,
} from "./agent-settings.js";
import { pickModel } from "./fuzzy-picker.js";
import type { AppCommandContext, AppCommandDefinition } from "./pi.js";
import {
  formatPreferenceValue,
  PREFERENCE_DEFINITIONS,
} from "./preferences.js";
import { executeRtkCommand } from "./rtk.js";

// ─── Curated defaults for non-UI fallback ──────────────────────────────

const DEFAULT_EXPLORER = "deepseek/deepseek-v4-flash";
const DEFAULT_PLANNER = "openai/gpt-5.5";
const DEFAULT_VERIFIER = "anthropic/claude-opus-4.7";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ThinkingChoice = ThinkingLevel | "inherit";
type ThinkingPickerResult = ThinkingChoice | "cancel";

function withThinkingSuffix(modelId: string, thinking: ThinkingChoice): string {
  return thinking === "inherit" ? modelId : `${modelId}:${thinking}`;
}

// ─── Scope helpers ─────────────────────────────────────────────────────

function resolveScope(args: string[]): {
  targetPath: string;
  scopeLabel: string;
  remaining: string[];
} {
  const projectIndex = args.indexOf("--project");
  const globalIndex = args.indexOf("--global");
  if (projectIndex !== -1) {
    const remaining = args.filter((_, i) => i !== projectIndex);
    return { targetPath: "PROJECT", scopeLabel: "project", remaining };
  }
  if (globalIndex !== -1) {
    const remaining = args.filter((_, i) => i !== globalIndex);
    return { targetPath: "GLOBAL", scopeLabel: "global", remaining };
  }
  return { targetPath: "GLOBAL", scopeLabel: "global", remaining: args };
}

function resolveTargetPath(cwd: string, targetPath: string): string {
  return targetPath === "PROJECT"
    ? projectGedSettingsPath(cwd)
    : globalGedSettingsPath();
}

// ─── Model helpers ─────────────────────────────────────────────────────

function formatModelRef(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function splitModelRef(
  ref: string,
): { provider: string; id: string } | undefined {
  ref = modelRefWithoutThinkingSuffix(ref);
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex === ref.length - 1) return undefined;
  return {
    provider: ref.slice(0, slashIndex),
    id: ref.slice(slashIndex + 1),
  };
}

function modelAvailabilityFromRegistry(
  registry: ModelRegistry | undefined,
): ModelAvailability | undefined {
  if (!registry) return undefined;
  return {
    isAvailable(modelId) {
      const parsed = splitModelRef(modelId);
      if (!parsed) return false;
      return Boolean(registry.find(parsed.provider, parsed.id));
    },
  };
}

// ─── Settings I/O ──────────────────────────────────────────────────────

function roleModelObject(
  value: AgentModelConfig | undefined,
): Record<string, unknown> {
  if (!value) return {};
  return typeof value === "string" ? { model: value } : { ...value };
}

function configuredRoleModel(
  settings: GedAgentsSettings,
  role: GedAgentRole,
): AgentModelConfig | undefined {
  const roleSettings = settings.roles?.[role];
  if (roleSettings && typeof roleSettings.model === "string") {
    return roleModelObject(
      roleSettings as AgentModelConfig,
    ) as AgentModelConfig;
  }
  return settings.models?.[role];
}

function setRoleModelInSettings(
  settings: GedAgentsSettings,
  role: GedAgentRole,
  model: AgentModelConfig | undefined,
): GedAgentsSettings {
  const roles = { ...(settings.roles ?? {}) };
  const current = { ...(roles[role] ?? {}) };
  delete current.fallbackModels;
  delete current.fallback;
  delete current.thinking;
  delete current.model;
  if (model) Object.assign(current, roleModelObject(model));
  if (Object.keys(current).length > 0) roles[role] = current;
  else delete roles[role];
  const models = { ...(settings.models ?? {}) };
  delete models[role];
  return {
    ...settings,
    roles: Object.keys(roles).length > 0 ? roles : undefined,
    models: Object.keys(models).length > 0 ? models : undefined,
  };
}

function formatThinkingTag(config: AgentModelConfig | undefined): string {
  if (!config || typeof config === "string") return "";
  if (typeof config.thinking !== "string") return "";
  const thinking = config.thinking.trim();
  return THINKING_LEVELS.includes(thinking as ThinkingLevel)
    ? ` [thinking: ${thinking}]`
    : "";
}

function modelSummary(config: AgentModelConfig | undefined): string {
  if (!config) return "inherit";
  if (typeof config === "string") return config;
  const fallback = Array.isArray(config.fallback)
    ? config.fallback.filter((item): item is string => typeof item === "string")
    : [];
  return `${config.model}${formatThinkingTag(config)}${fallback.length > 0 ? ` → ${fallback.map(formatFallbackModelRef).join(" → ")}` : ""}`;
}

function roleSummary(settings: GedAgentsSettings, role: GedAgentRole): string {
  const roleSettings = settings.roles?.[role];
  const enabled = roleSettings?.enabled;
  const status =
    enabled === false
      ? "disabled"
      : enabled === true || role !== "ged-worker"
        ? "enabled"
        : "disabled";
  const config = configuredRoleModel(settings, role);
  return `${role}: ${status}; ${modelSummary(config)}`;
}

function defaultSummary(settings: GedAgentsSettings): string {
  return `Default model: ${modelSummary(settings.defaultModel)}`;
}

async function setAgentModel(
  cwd: string,
  targetPath: string,
  role: "default" | GedAgentRole,
  modelId: string | null,
  availability?: ModelAvailability,
): Promise<string> {
  const filePath = resolveTargetPath(cwd, targetPath);
  const existing = await readGedRuntimeSettings(filePath);
  const next: GedAgentsSettings = { ...(existing.agents ?? {}) };

  if (role === "default") {
    if (modelId === null) {
      delete next.defaultModel;
    } else {
      next.defaultModel = modelId;
    }
  } else {
    const current = roleModelObject(configuredRoleModel(next, role));
    if (modelId === null) delete current.model;
    else current.model = modelId;
    Object.assign(
      next,
      setRoleModelInSettings(
        next,
        role,
        typeof current.model === "string"
          ? (current as AgentModelConfig)
          : undefined,
      ),
    );
  }

  await writeGedAgentsSettings(filePath, next);
  await syncGedSubagentRuntimeConfig(cwd, { modelAvailability: availability });

  const scopeLabel = targetPath === "PROJECT" ? "project" : "global";
  const roleLabel = role === "default" ? "default model" : `${role} model`;
  if (modelId === null) {
    return `Cleared ${roleLabel} from ${scopeLabel} settings.`;
  }
  return `Set ${roleLabel} to \`${modelId}\` in ${scopeLabel} settings.`;
}

// ─── Formatters ────────────────────────────────────────────────────────

function formatModelsList(
  effective: Awaited<ReturnType<typeof readEffectiveGedAgentsSettings>>,
): string {
  const lines: string[] = ["## Current subagent models", ""];

  for (const role of GED_AGENT_ROLES) {
    const config = effective.models[role];
    const label = config
      ? typeof config === "string"
        ? config
        : modelSummary(config)
      : effective.defaultModel
        ? `inherit (${typeof effective.defaultModel === "string" ? effective.defaultModel : effective.defaultModel.model}${formatThinkingTag(effective.defaultModel)})`
        : "inherit (orchestrator)";
    const source = config
      ? "role override"
      : effective.defaultModel
        ? "default"
        : "orchestrator";
    lines.push(`- **${role}**: ${label} _(source: ${source})_`);
  }

  lines.push(
    `- **default**: ${effective.defaultModel ? `${typeof effective.defaultModel === "string" ? effective.defaultModel : effective.defaultModel.model}${formatThinkingTag(effective.defaultModel)}` : "inherit orchestrator"}`,
  );
  lines.push("");
  lines.push("Change: `/ged-agents model <role> <model-id> [--project]`");
  lines.push("Clear: `/ged-agents model <role> --clear`");

  return lines.join("\n");
}

function formatCompactSetup(): string {
  return [
    "## Quick setup (copy & run)",
    "",
    "```",
    "/ged-agents on --project",
    `/ged-agents model ged-explorer ${DEFAULT_EXPLORER} --project`,
    `/ged-agents model ged-planner ${DEFAULT_PLANNER} --project`,
    `/ged-agents model ged-verifier ${DEFAULT_VERIFIER} --project`,
    "```",
    "",
    "Or run `/ged-agents setup` in an interactive Pi session for a searchable model picker.",
  ].join("\n");
}

// ─── Interactive wizard ────────────────────────────────────────────────
async function pickThinkingLevel(
  ui: NonNullable<AppCommandContext["runtime"]>["ctx"]["ui"],
  title: string,
): Promise<ThinkingPickerResult> {
  if (!ui) return "cancel";
  const choice = await ui.select(title, [
    "Inherit/default",
    "Off",
    "Minimal",
    "Low",
    "Medium",
    "High",
    "XHigh",
    "Max",
    "Cancel",
  ]);
  if (!choice || choice === "Cancel") return "cancel";
  if (choice === "Inherit/default") return "inherit";
  return choice.toLowerCase() as ThinkingLevel;
}

async function runInteractiveAdvancedSetup(
  ctx: AppCommandContext,
): Promise<string> {
  const ui = ctx.runtime?.ctx.ui;
  const registry = ctx.runtime?.ctx.modelRegistry;
  if (!ui || !registry) return formatCompactSetup();

  const scopeChoice = await ui.select("Set up Ged subagents", [
    "This project only",
    "Globally",
    "Cancel",
  ]);
  if (!scopeChoice || scopeChoice === "Cancel") return "Setup cancelled.";
  const targetPath = scopeChoice === "This project only" ? "PROJECT" : "GLOBAL";
  const scopeLabel = targetPath === "PROJECT" ? "project" : "global";
  const filePath = resolveTargetPath(ctx.cwd, targetPath);
  const existing = await readGedRuntimeSettings(filePath);
  let next: GedAgentsSettings = { ...(existing.agents ?? {}) };
  let dirty = false;

  const ensureRole = (role: GedAgentRole): Record<string, unknown> => {
    const roles = { ...(next.roles ?? {}) };
    const current = {
      ...roleModelObject(next.models?.[role]),
      ...(roles[role] ?? {}),
    };
    roles[role] = current;
    const models = { ...(next.models ?? {}) };
    delete models[role];
    next = {
      ...next,
      roles,
      models: Object.keys(models).length > 0 ? models : undefined,
    };
    return current;
  };

  const defaultConfig = (): Record<string, unknown> =>
    roleModelObject(next.defaultModel);

  const setDefaultConfig = (config: Record<string, unknown>) => {
    next.defaultModel =
      typeof config.model === "string"
        ? (config as AgentModelConfig)
        : next.defaultModel;
  };

  const addFallbackToConfig = (
    config: Record<string, unknown>,
    modelId: string,
  ) => {
    const fallback = Array.isArray(config.fallback)
      ? config.fallback.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    config.fallback = [...new Set([...fallback, modelId])];
  };

  const pickFallbackModelRef = async (
    titlePrefix: string,
  ): Promise<string | null> => {
    const fallback = await pickModel(
      ui,
      registry,
      `${titlePrefix} fallback model`,
    );
    if (fallback === null) return null;
    const thinking = await pickThinkingLevel(
      ui,
      `${titlePrefix} fallback thinking level`,
    );
    if (thinking === "cancel") return null;
    return withThinkingSuffix(formatModelRef(fallback), thinking);
  };

  const promptForFallbacks = async (
    config: Record<string, unknown>,
    titlePrefix: string,
  ): Promise<boolean> => {
    while (true) {
      const add = await ui.select(`${titlePrefix}: add fallback?`, [
        "Yes",
        "No",
        "Cancel",
      ]);
      if (add === "Cancel" || !add) return false;
      if (add === "No") return true;
      const fallback = await pickFallbackModelRef(titlePrefix);
      if (fallback === null) return false;
      addFallbackToConfig(config, fallback);
    }
  };

  const configureModel = async (
    target: "default" | GedAgentRole,
  ): Promise<boolean> => {
    const label = target === "default" ? "Default model" : `${target} model`;
    const model = await pickModel(ui, registry, label);
    if (model === null) return false;
    const thinking = await pickThinkingLevel(ui, `${label} thinking level`);
    if (thinking === "cancel") return false;
    const config =
      target === "default" ? defaultConfig() : { ...ensureRole(target) };
    config.model = formatModelRef(model);
    if (thinking === "inherit") delete config.thinking;
    else config.thinking = thinking;
    const fallbackComplete = await promptForFallbacks(config, label);
    if (!fallbackComplete) return false;
    if (target === "default") setDefaultConfig(config);
    else Object.assign(ensureRole(target), config);
    dirty = true;
    return true;
  };

  const addFallbacks = async (
    target: "default" | GedAgentRole,
  ): Promise<boolean> => {
    const config =
      target === "default" ? defaultConfig() : { ...ensureRole(target) };
    const ok = await promptForFallbacks(
      config,
      target === "default" ? "Default model" : `${target} fallback`,
    );
    if (!ok) return false;
    if (target === "default") setDefaultConfig(config);
    else Object.assign(ensureRole(target), config);
    dirty = true;
    return true;
  };

  while (true) {
    const choice = await ui.select("Ged agent orchestration setup", [
      `Subagents: ${next.enabled ? "enabled" : "disabled"}`,
      `${defaultSummary(next)}`,
      `Intercom bridge: ${next.intercomBridge === false ? "disabled" : "enabled"}`,
      `Critique mode: ${next.critiqueMode ?? "risk-based"}`,
      ...GED_AGENT_ROLES.map((role) => roleSummary(next, role)),
      "Done",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return "Setup cancelled.";
    if (choice === "Done") break;
    if (choice.startsWith("Subagents:")) {
      next.enabled = !next.enabled;
      dirty = true;
      continue;
    }
    if (choice.startsWith("Default model:")) {
      const hasDefaultModel = Boolean(defaultConfig().model);
      const action = await ui.select(
        `Configure default model (${scopeLabel})`,
        [
          "Set model",
          ...(hasDefaultModel
            ? ["Set thinking", "Add fallback", "Clear fallbacks"]
            : []),
          "Back",
        ],
      );
      if (!action || action === "Back") continue;
      const config = defaultConfig();
      if (action === "Set model") {
        if (!(await configureModel("default"))) return "Setup cancelled.";
      } else if (action === "Set thinking") {
        const thinking = await pickThinkingLevel(
          ui,
          "Default model thinking level",
        );
        if (thinking === "cancel") return "Setup cancelled.";
        if (thinking === "inherit") delete config.thinking;
        else config.thinking = thinking;
        setDefaultConfig(config);
        dirty = true;
      } else if (action === "Add fallback") {
        if (!(await addFallbacks("default"))) return "Setup cancelled.";
      } else if (action === "Clear fallbacks") {
        delete config.fallback;
        setDefaultConfig(config);
        dirty = true;
      }
      continue;
    }
    if (choice.startsWith("Intercom bridge:")) {
      const bridge = await ui.select("Intercom bridge", [
        "Enabled",
        "Disabled",
        "Back",
      ]);
      if (bridge === "Enabled") next.intercomBridge = true;
      if (bridge === "Disabled") next.intercomBridge = false;
      if (bridge === "Enabled" || bridge === "Disabled") dirty = true;
      continue;
    }
    if (choice.startsWith("Critique mode:")) {
      const mode = await ui.select("Critique mode", [
        "off",
        "risk-based",
        "always",
        "Back",
      ]);
      if (
        mode &&
        mode !== "Back" &&
        GED_CRITIQUE_MODES.includes(mode as never)
      ) {
        next.critiqueMode = mode as GedAgentsSettings["critiqueMode"];
        dirty = true;
      }
      continue;
    }
    const role = GED_AGENT_ROLES.find((candidate) =>
      choice.startsWith(`${candidate}:`),
    );
    if (!role) continue;
    const roleSettingsForMenu = {
      ...roleModelObject(next.models?.[role]),
      ...(next.roles?.[role] ?? {}),
    };
    const roleEnabled =
      typeof roleSettingsForMenu.enabled === "boolean"
        ? roleSettingsForMenu.enabled
        : role !== "ged-worker";
    const hasRoleModel = typeof roleSettingsForMenu.model === "string";
    const action = await ui.select(
      `Configure ${role} (${roleSummary(next, role)})`,
      [
        roleEnabled ? "Disable role" : "Enable role",
        "Set model",
        ...(hasRoleModel
          ? ["Set thinking", "Add fallback", "Clear fallbacks"]
          : []),
        ...(role === "ged-worker"
          ? ["Worker max parallel", "Worker worktree"]
          : []),
        "Back",
      ],
    );
    if (!action || action === "Back") continue;
    const roleSettings = ensureRole(role);
    if (action === "Enable role") {
      roleSettings.enabled = true;
      dirty = true;
    } else if (action === "Disable role") {
      roleSettings.enabled = false;
      dirty = true;
    } else if (action === "Set model") {
      if (!(await configureModel(role))) return "Setup cancelled.";
    } else if (action === "Set thinking") {
      const thinking = await pickThinkingLevel(ui, `${role} thinking level`);
      if (thinking === "cancel") return "Setup cancelled.";
      if (thinking === "inherit") delete roleSettings.thinking;
      else roleSettings.thinking = thinking;
      dirty = true;
    } else if (action === "Add fallback") {
      if (!(await addFallbacks(role))) return "Setup cancelled.";
    } else if (action === "Clear fallbacks") {
      delete roleSettings.fallback;
      dirty = true;
    } else if (action === "Worker max parallel") {
      const value = await ui.select("Worker max parallel", [
        "1",
        "2",
        "3",
        "4",
        "Back",
      ]);
      if (value && value !== "Back") {
        roleSettings.maxParallel = Number(value);
        dirty = true;
      }
    } else if (action === "Worker worktree") {
      const value = await ui.select("Worker worktree isolation", [
        "Preferred",
        "Optional",
        "Back",
      ]);
      if (value === "Preferred") {
        roleSettings.preferWorktreeIsolation = true;
        dirty = true;
      }
      if (value === "Optional") {
        roleSettings.preferWorktreeIsolation = false;
        dirty = true;
      }
    }
  }

  if (!dirty) return "Ged advanced subagent setup unchanged.";

  await writeGedAgentsSettings(filePath, next);
  await syncGedSubagentRuntimeConfig(ctx.cwd, {
    modelAvailability: modelAvailabilityFromRegistry(registry),
  });
  ui.notify("Ged advanced subagent setup saved", "info");
  return `Ged advanced subagent setup saved for ${targetPath === "PROJECT" ? "project" : "global"} settings.`;
}

// ─── Main command handler ──────────────────────────────────────────────

async function executeGedAgentsCommand(
  cwd: string,
  args: string[] = [],
  ctx?: AppCommandContext,
): Promise<string> {
  const [action = "status", ...rest] = args;

  if (args.length === 0 && ctx?.runtime?.ctx.hasUI) {
    return await runInteractiveAdvancedSetup({ ...ctx, cwd });
  }

  if (action === "status") {
    return formatGedAgentsStatus(await readEffectiveGedAgentsSettings(cwd));
  }

  if (action === "models") {
    return formatModelsList(await readEffectiveGedAgentsSettings(cwd));
  }

  if (action === "setup") {
    if (ctx?.runtime?.ctx.hasUI) {
      return await runInteractiveAdvancedSetup(ctx);
    }
    return formatCompactSetup();
  }

  if (action === "on" || action === "off") {
    const { targetPath, scopeLabel } = resolveScope(rest);
    const filePath = resolveTargetPath(cwd, targetPath);
    const existing = await readGedRuntimeSettings(filePath);
    await writeGedAgentsSettings(filePath, {
      ...(existing.agents ?? {}),
      enabled: action === "on",
    });
    await syncGedSubagentRuntimeConfig(cwd, {
      modelAvailability: modelAvailabilityFromRegistry(
        ctx?.runtime?.ctx.modelRegistry,
      ),
    });
    return `Ged optional subagents are now ${action === "on" ? "enabled" : "disabled"} in ${scopeLabel} settings.`;
  }

  if (action === "model") {
    const { targetPath, remaining } = resolveScope(rest);
    const [role, modelId] = remaining;

    if (!role) {
      return `Usage: /ged-agents model <role> <model-id> [--project|--global]\nRoles: default, ${GED_AGENT_ROLES.join(", ")}\nUse \`--clear\` instead of a model-id to remove an override.`;
    }

    if (role !== "default" && !GED_AGENT_ROLES.includes(role as GedAgentRole)) {
      return `Unknown role: ${role}. Valid roles: default, ${GED_AGENT_ROLES.join(", ")}.`;
    }

    if (modelId === "--clear" || modelId === undefined) {
      return await setAgentModel(
        cwd,
        targetPath,
        role as "default" | GedAgentRole,
        null,
        modelAvailabilityFromRegistry(ctx?.runtime?.ctx.modelRegistry),
      );
    }

    return await setAgentModel(
      cwd,
      targetPath,
      role as "default" | GedAgentRole,
      modelId,
      modelAvailabilityFromRegistry(ctx?.runtime?.ctx.modelRegistry),
    );
  }

  if (action === "role") {
    const { targetPath, remaining } = resolveScope(rest);
    const [role, value] = remaining;
    if (!role || !value) {
      return `Usage: /ged-agents role <role> <on|off> [--project|--global]\nRoles: ${GED_AGENT_ROLES.join(", ")}`;
    }
    if (!GED_AGENT_ROLES.includes(role as GedAgentRole)) {
      return `Unknown role: ${role}. Valid roles: ${GED_AGENT_ROLES.join(", ")}.`;
    }
    if (value !== "on" && value !== "off") {
      return "Role value must be `on` or `off`.";
    }
    const filePath = resolveTargetPath(cwd, targetPath);
    const existing = await readGedRuntimeSettings(filePath);
    const roles = { ...(existing.agents?.roles ?? {}) };
    roles[role as GedAgentRole] = {
      ...(roles[role as GedAgentRole] ?? {}),
      enabled: value === "on",
    };
    await writeGedAgentsSettings(filePath, {
      ...(existing.agents ?? {}),
      roles,
    });
    await syncGedSubagentRuntimeConfig(cwd, {
      modelAvailability: modelAvailabilityFromRegistry(
        ctx?.runtime?.ctx.modelRegistry,
      ),
    });
    return `Set ${role} ${value === "on" ? "enabled" : "disabled"}.`;
  }

  if (action === "intercom") {
    const { targetPath, remaining } = resolveScope(rest);
    const [value] = remaining;
    if (value !== "on" && value !== "off") {
      return "Usage: /ged-agents intercom <on|off> [--project|--global]";
    }
    const filePath = resolveTargetPath(cwd, targetPath);
    const existing = await readGedRuntimeSettings(filePath);
    await writeGedAgentsSettings(filePath, {
      ...(existing.agents ?? {}),
      intercomBridge: value === "on",
    });
    await syncGedSubagentRuntimeConfig(cwd, {
      modelAvailability: modelAvailabilityFromRegistry(
        ctx?.runtime?.ctx.modelRegistry,
      ),
    });
    return `Ged intercom bridge ${value === "on" ? "enabled" : "disabled"}.`;
  }

  if (action === "critique") {
    const { targetPath, remaining } = resolveScope(rest);
    const [mode] = remaining;
    if (!GED_CRITIQUE_MODES.includes(mode as never)) {
      return `Usage: /ged-agents critique <${GED_CRITIQUE_MODES.join("|")}> [--project|--global]`;
    }
    const filePath = resolveTargetPath(cwd, targetPath);
    const existing = await readGedRuntimeSettings(filePath);
    await writeGedAgentsSettings(filePath, {
      ...(existing.agents ?? {}),
      critiqueMode: mode as (typeof GED_CRITIQUE_MODES)[number],
    });
    return `Ged plan critique mode set to ${mode}.`;
  }

  if (action === "thinking") {
    const { targetPath, remaining } = resolveScope(rest);
    const [role, value] = remaining;
    if (!role || !value) {
      return `Usage: /ged-agents thinking <role> <${THINKING_LEVELS.join("|")}|inherit> [--project|--global]`;
    }
    if (role !== "default" && !GED_AGENT_ROLES.includes(role as GedAgentRole)) {
      return `Unknown role: ${role}. Valid roles: default, ${GED_AGENT_ROLES.join(", ")}.`;
    }
    if (
      value !== "inherit" &&
      !THINKING_LEVELS.includes(value as ThinkingLevel)
    ) {
      return `Thinking level must be one of: inherit, ${THINKING_LEVELS.join(", ")}.`;
    }
    const filePath = resolveTargetPath(cwd, targetPath);
    const existing = await readGedRuntimeSettings(filePath);
    let next: GedAgentsSettings = { ...(existing.agents ?? {}) };
    if (role === "default") {
      const config = roleModelObject(next.defaultModel);
      if (value === "inherit") delete config.thinking;
      else config.thinking = value;
      next.defaultModel =
        typeof config.model === "string"
          ? (config as AgentModelConfig)
          : next.defaultModel;
    } else {
      const current = roleModelObject(
        configuredRoleModel(next, role as GedAgentRole),
      );
      if (value === "inherit") delete current.thinking;
      else current.thinking = value;
      next = setRoleModelInSettings(
        next,
        role as GedAgentRole,
        typeof current.model === "string"
          ? (current as AgentModelConfig)
          : undefined,
      );
    }
    await writeGedAgentsSettings(filePath, next);
    await syncGedSubagentRuntimeConfig(cwd, {
      modelAvailability: modelAvailabilityFromRegistry(
        ctx?.runtime?.ctx.modelRegistry,
      ),
    });
    return `Set ${role} thinking to ${value}.`;
  }

  if (action === "fallback") {
    const { targetPath, remaining } = resolveScope(rest);
    const [role, op, modelId, position, targetModelId] = remaining;
    if (!role || !op) {
      return "Usage: /ged-agents fallback <role> <list|add <model-id> [thinking]|set <model-id...>|remove <model-id>|move <model-id> <before|after> <target-model-id>|clear> [--project|--global]";
    }
    if (role !== "default" && !GED_AGENT_ROLES.includes(role as GedAgentRole)) {
      return `Unknown role: ${role}. Valid roles: default, ${GED_AGENT_ROLES.join(", ")}.`;
    }
    if (!["list", "add", "set", "remove", "move", "clear"].includes(op)) {
      return "Fallback operation must be list, add, set, remove, move, or clear.";
    }
    if ((op === "add" || op === "remove") && !modelId) {
      return `Usage: /ged-agents fallback <role> ${op} <model-id>${op === "add" ? " [thinking]" : ""} [--project|--global]`;
    }
    if (op === "move" && (!modelId || !position || !targetModelId)) {
      return "Usage: /ged-agents fallback <role> move <model-id> <before|after> <target-model-id> [--project|--global]";
    }
    if (op === "move" && position !== "before" && position !== "after") {
      return "Fallback move position must be before or after.";
    }
    const addThinking =
      op === "add" && THINKING_LEVELS.includes(position as ThinkingLevel)
        ? (position as ThinkingLevel)
        : undefined;
    if (op === "add" && position && !addThinking) {
      return `Fallback thinking level must be one of: ${THINKING_LEVELS.join(", ")}.`;
    }
    const addedModelId =
      modelId && addThinking
        ? withThinkingSuffix(modelId, addThinking)
        : modelId;
    const filePath = resolveTargetPath(cwd, targetPath);
    const existing = await readGedRuntimeSettings(filePath);
    let next: GedAgentsSettings = { ...(existing.agents ?? {}) };
    const currentConfig =
      role === "default"
        ? roleModelObject(next.defaultModel)
        : {
            ...roleModelObject(next.models?.[role as GedAgentRole]),
            ...(next.roles?.[role as GedAgentRole] ?? {}),
          };
    const currentFallback = Array.isArray(currentConfig.fallback)
      ? currentConfig.fallback.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    if (op === "list") {
      return currentFallback.length > 0
        ? `${role} fallback models:\n${currentFallback.map((item, index) => `${index + 1}. ${formatFallbackModelRef(item)}`).join("\n")}`
        : `${role} fallback models: none`;
    }
    const findFallbackRef = (
      items: string[],
      ref: string,
    ): string | undefined =>
      items.find((item) => item === ref) ??
      items.find((item) => modelRefWithoutThinkingSuffix(item) === ref);
    const unique = (items: string[]) => {
      const byBase = new Map<string, string>();
      for (const item of items.filter(Boolean)) {
        byBase.set(modelRefWithoutThinkingSuffix(item), item);
      }
      return [...byBase.values()];
    };
    const apply = (config: Record<string, unknown>) => {
      let fallback = [...currentFallback];
      if (op === "clear") fallback = [];
      else if (op === "add" && addedModelId)
        fallback = unique([...fallback, addedModelId]);
      else if (op === "set") fallback = unique(remaining.slice(2));
      else if (op === "remove" && modelId)
        fallback = fallback.filter(
          (item) => item !== findFallbackRef(fallback, modelId),
        );
      else if (op === "move" && modelId && position && targetModelId) {
        const storedModelId = findFallbackRef(fallback, modelId);
        const storedTargetModelId = findFallbackRef(fallback, targetModelId);
        if (!storedModelId) {
          throw new Error(`Fallback model not found: ${modelId}`);
        }
        if (!storedTargetModelId) {
          throw new Error(`Target fallback model not found: ${targetModelId}`);
        }
        fallback = fallback.filter((item) => item !== storedModelId);
        const targetIndex = fallback.indexOf(storedTargetModelId);
        fallback.splice(
          position === "before" ? targetIndex : targetIndex + 1,
          0,
          storedModelId,
        );
      }
      if (fallback.length === 0) delete config.fallback;
      else config.fallback = fallback;
    };
    try {
      if (role === "default") {
        const config = currentConfig;
        apply(config);
        next.defaultModel =
          typeof config.model === "string"
            ? (config as AgentModelConfig)
            : next.defaultModel;
      } else {
        const roles = { ...(next.roles ?? {}) };
        const roleKey = role as GedAgentRole;
        const config = currentConfig;
        apply(config);
        const legacyModels = { ...(next.models ?? {}) };
        delete legacyModels[roleKey];
        roles[roleKey] = config;
        if (Object.keys(config).length === 0) delete roles[roleKey];
        next = {
          ...next,
          roles: Object.keys(roles).length > 0 ? roles : undefined,
          models:
            Object.keys(legacyModels).length > 0 ? legacyModels : undefined,
        };
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    await writeGedAgentsSettings(filePath, next);
    await syncGedSubagentRuntimeConfig(cwd, {
      modelAvailability: modelAvailabilityFromRegistry(
        ctx?.runtime?.ctx.modelRegistry,
      ),
    });
    if (op === "clear") return `Cleared ${role} fallback models.`;
    if (op === "add") return `Added ${addedModelId} as ${role} fallback model.`;
    if (op === "set") return `Set ${role} fallback model order.`;
    if (op === "remove")
      return `Removed ${modelId} from ${role} fallback models.`;
    return `Moved ${modelId} ${position} ${targetModelId} in ${role} fallback models.`;
  }

  if (action === "worker") {
    const { targetPath, remaining } = resolveScope(rest);
    const [setting, value] = remaining;
    if (!setting || !value) {
      return "Usage: /ged-agents worker <max-parallel <n>|worktree <on|off>> [--project|--global]";
    }
    const filePath = resolveTargetPath(cwd, targetPath);
    const existing = await readGedRuntimeSettings(filePath);
    const roles = { ...(existing.agents?.roles ?? {}) };
    const worker = { ...(roles["ged-worker"] ?? {}) };
    if (setting === "max-parallel") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return "Worker max-parallel must be a positive integer.";
      }
      worker.maxParallel = parsed;
    } else if (setting === "worktree") {
      if (value !== "on" && value !== "off")
        return "Worker worktree must be on or off.";
      worker.preferWorktreeIsolation = value === "on";
    } else {
      return "Usage: /ged-agents worker <max-parallel <n>|worktree <on|off>> [--project|--global]";
    }
    roles["ged-worker"] = worker;
    await writeGedAgentsSettings(filePath, {
      ...(existing.agents ?? {}),
      roles,
    });
    await syncGedSubagentRuntimeConfig(cwd, {
      modelAvailability: modelAvailabilityFromRegistry(
        ctx?.runtime?.ctx.modelRegistry,
      ),
    });
    return `Updated ged-worker ${setting}.`;
  }

  return "Usage: /ged-agents [status|models|setup|on|off|model|role|thinking|fallback|intercom|critique|worker] [--project|--global]";
}

async function executeGedSettingsCommand(
  context: AppCommandContext,
): Promise<string> {
  const prefs = await readGedPreferences();

  // Non-UI fallback: return current values and file path.
  if (!context.runtime?.ctx.hasUI) {
    return [
      "GedPi Preferences",
      `  Commit after verification: ${formatPreferenceValue("autoCommitVerifiedWork", prefs.autoCommitVerifiedWork)} (${prefs.autoCommitVerifiedWork})`,
      `  Accepted plan review: ${formatPreferenceValue("reviewPlanBeforePlannerHandoff", prefs.reviewPlanBeforePlannerHandoff)} (${prefs.reviewPlanBeforePlannerHandoff})`,
      "",
      `Stored in: ${globalGedSettingsPath()}`,
    ].join("\n");
  }

  const ctx = context.runtime.ctx;
  await ctx.ui.custom((_tui, _theme, _kb, done) => {
    const container = new Container();
    const items = PREFERENCE_DEFINITIONS.map((def) => ({
      id: def.id,
      label: def.label,
      description: def.description,
      currentValue: prefs[def.id as keyof typeof prefs] ?? def.defaultValue,
      values: def.values,
    }));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        void writeGedPreference(id, newValue).catch(() => {
          ctx.ui.notify(`Failed to save preference "${id}"`, "error");
        });
      },
      () => {
        done(undefined);
      },
    );

    container.addChild(settingsList);

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        settingsList.handleInput?.(data);
        _tui.requestRender();
      },
    };
  });

  return "";
}

export function createGedCommands(): AppCommandDefinition[] {
  return [
    {
      name: "grill-me",
      description:
        "Clarify a genuine unresolved user-owned decision one question at a time",
      async execute() {
        return `Ask exactly one concise unresolved question and include a recommended answer or default assumption. Wait for the user's answer before continuing.

If the request is already sufficient, summarize goal, users/audience, scope, constraints, and success criteria naturally instead of emitting a special declaration. Use grill-with-docs when clarification should also update domain language, CONTEXT.md, glossary, or ADR-worthy decisions. Do not implement during grilling, and do not open mutating work while a user-owned decision remains unresolved.`;
      },
    },
    {
      name: "rtk",
      description:
        "Install RTK and check Ged's automatic bash-side RTK routing",
      async execute(context) {
        if (!context.runtime) {
          return "The /rtk command is only available inside GedPi interactive sessions.";
        }
        return await executeRtkCommand(context.args, context.runtime.ctx);
      },
    },
    {
      name: "ged-agents",
      description:
        "Configure Ged subagents, intercom, critique, models, and optional workers",
      async execute(context) {
        return await executeGedAgentsCommand(
          context.cwd,
          context.args,
          context,
        );
      },
    },
    {
      name: "ged-settings",
      description:
        "Configure GedPi workflow preferences (commit behavior, plan review)",
      async execute(context) {
        return await executeGedSettingsCommand(context);
      },
    },
  ];
}
