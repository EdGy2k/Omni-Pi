import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createJiti } from "jiti";
import { describe, expect, test } from "vitest";
import {
  cleanAgentsSettings,
  type EffectiveGedAgentsSettings,
  formatGedAgentsStatus,
  GED_AGENT_ROLES,
  modelCandidates,
  projectGedSettingsPath,
  readEffectiveGedAgentsSettings,
  readGedPreferences,
  selectAgentModel,
  syncGedSubagentRuntimeConfig,
  writeGedAgentsSettings,
  writeGedPreference,
} from "../src/agent-settings.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function effectiveFixture(
  overrides: Partial<EffectiveGedAgentsSettings>,
): EffectiveGedAgentsSettings {
  return {
    enabled: true,
    profile: "custom",
    supervisorBridge: true,
    peerMessaging: false,
    intercomBridge: true,
    critiqueMode: "risk-based",
    models: {},
    roles: Object.fromEntries(
      GED_AGENT_ROLES.map((role) => [
        role,
        {
          enabled: role !== "ged-worker" && role !== "ged-smart-worker",
          model: overrides.models?.[role],
        },
      ]),
    ) as EffectiveGedAgentsSettings["roles"],
    allowCheckpointBypass: false,
    ...overrides,
  };
}

describe("Ged optional agent settings", () => {
  test("reads plan-review preference modes with legacy on as chat", async () => {
    const homeDir = await tempDir("ged-preferences-home-");
    await writeGedPreference("reviewPlanBeforePlannerHandoff", "on", homeDir);

    await expect(readGedPreferences(homeDir)).resolves.toMatchObject({
      reviewPlanBeforePlannerHandoff: "chat",
    });

    await writeGedPreference(
      "reviewPlanBeforePlannerHandoff",
      "plannotator",
      homeDir,
    );
    await expect(readGedPreferences(homeDir)).resolves.toMatchObject({
      reviewPlanBeforePlannerHandoff: "plannotator",
    });
  });

  test("defaults to disabled with no configured models", async () => {
    const rootDir = await tempDir("ged-agent-settings-root-");
    const homeDir = await tempDir("ged-agent-settings-home-");

    await expect(
      readEffectiveGedAgentsSettings(rootDir, { homeDir }),
    ).resolves.toMatchObject({
      enabled: false,
      intercomBridge: true,
      critiqueMode: "risk-based",
      models: {},
      allowCheckpointBypass: false,
    });
  });

  test("merges global settings with project override", async () => {
    const rootDir = await tempDir("ged-agent-settings-root-");
    const homeDir = await tempDir("ged-agent-settings-home-");
    await writeGedAgentsSettings(
      path.join(homeDir, ".gedoc", "settings.json"),
      {
        enabled: true,
        defaultModel: "openai/gpt-5-mini",
        models: { "ged-explorer": "opencode/nemotron" },
      },
    );
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: false,
      models: {
        "ged-planner": { model: "openai/gpt-5.5", reasoningEffort: "high" },
      },
    });

    await expect(
      readEffectiveGedAgentsSettings(rootDir, { homeDir }),
    ).resolves.toMatchObject({
      enabled: false,
      defaultModel: "openai/gpt-5-mini",
      models: {
        "ged-explorer": "opencode/nemotron",
        "ged-planner": { model: "openai/gpt-5.5", thinking: "high" },
      },
      allowCheckpointBypass: false,
    });
  });

  test("project legacy model overrides global role model during migration", async () => {
    const rootDir = await tempDir("ged-agent-settings-root-");
    const homeDir = await tempDir("ged-agent-settings-home-");
    await writeGedAgentsSettings(
      path.join(homeDir, ".gedoc", "settings.json"),
      {
        enabled: true,
        roles: {
          "ged-planner": {
            model: "global/new-role-model",
            thinking: "high",
          },
        },
      },
    );
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      models: { "ged-planner": "project/legacy-model" },
    });

    await expect(
      readEffectiveGedAgentsSettings(rootDir, { homeDir }),
    ).resolves.toMatchObject({
      models: { "ged-planner": "project/legacy-model" },
    });
  });

  test("cleans unknown roles and preserves optional worker", async () => {
    expect(
      cleanAgentsSettings({
        enabled: true,
        models: {
          "ged-explorer": "model/a",
          "ged-worker": "model/b",
          worker: "model/c",
        },
      }),
    ).toEqual({
      enabled: true,
      models: { "ged-explorer": "model/a", "ged-worker": "model/b" },
    });
  });

  test("settings writes persist only cleaned agents values", async () => {
    const rootDir = await tempDir("ged-agent-settings-root-");
    const settingsPath = projectGedSettingsPath(rootDir);
    await writeGedAgentsSettings(settingsPath, {
      enabled: true,
      models: {
        "ged-verifier": "model/v",
        "ged-worker": "model/w",
      } as never,
    });

    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as {
      agents: { models: Record<string, unknown> };
    };
    expect(raw.agents.models).toEqual({
      "ged-verifier": "model/v",
      "ged-worker": "model/w",
    });
  });

  test("selects the first available model from a fallback chain", () => {
    const config = {
      model: "provider/missing-primary",
      fallback: ["provider/missing-fallback", "provider/available"],
    };

    expect(modelCandidates(config)).toEqual([
      "provider/missing-primary",
      "provider/missing-fallback",
      "provider/available",
    ]);
    expect(
      selectAgentModel(config, {
        isAvailable: (modelId) => modelId === "provider/available",
      }),
    ).toBe("provider/available");
  });

  test("omits model selection when no configured model is available", () => {
    const config = {
      model: "provider/missing-primary",
      fallback: ["provider/missing-fallback"],
    };

    expect(
      selectAgentModel(config, {
        isAvailable: () => false,
      }),
    ).toBeUndefined();
  });

  test("runtime sync exposes Ged roles and suppresses bundled defaults", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await mkdir(path.join(rootDir, ".pi"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".pi", "settings.json"),
      JSON.stringify({
        subagents: { agentOverrides: { reviewer: { disabled: true } } },
      }),
    );
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      defaultModel: "openai/gpt-5-mini",
      models: {
        "ged-explorer": "openai/gpt-5-mini",
        "ged-planner": "openai/gpt-5.5",
      },
    });
    const homeDir = await tempDir("ged-agent-sync-home-");

    await syncGedSubagentRuntimeConfig(rootDir, { homeDir });

    const explorer = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-explorer.md"),
      "utf8",
    );
    const settings = JSON.parse(
      await readFile(path.join(rootDir, ".pi", "settings.json"), "utf8"),
    ) as { subagents: { agentOverrides: { reviewer: { disabled: boolean } } } };

    expect(explorer).toContain("description: Read-only Ged codebase scout");
    expect(explorer).toContain("name: ged-explorer");
    expect(explorer).toContain("model: openai/gpt-5-mini");
    expect(explorer).toContain(
      "tools: read, grep, find, ls, contact_supervisor",
    );
    expect(explorer).toContain("systemPromptMode: replace");
    expect(explorer).toContain("inheritSkills: false");
    expect(explorer).toContain("completionGuard: false");
    expect(explorer).toContain("read-only intelligence contributor");
    expect(explorer).toContain("Inventory bundled, project, and user skills");
    expect(explorer).toContain("npx skills find <query>");
    expect(explorer).toContain("Do not edit files");
    const planner = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-planner.md"),
      "utf8",
    );
    expect(planner).toContain("model: openai/gpt-5.5");
    expect(planner).toContain("draft concrete SPEC/TASKS/TESTS content");
    expect(explorer).toContain("Do not edit files");
    expect(settings.subagents).toMatchObject({
      agentOverrides: { reviewer: { disabled: true } },
      disableBuiltins: true,
    });
    await expect(
      readFile(
        path.join(rootDir, ".pi", "agents", "ged-plan-reviewer.md"),
        "utf8",
      ),
    ).resolves.toContain("Ged Plan Reviewer");
    await expect(
      readFile(path.join(rootDir, ".pi", "agents", "ged-verifier.md"), "utf8"),
    ).resolves.toContain("strict structured output schema");
    await expect(
      readFile(path.join(rootDir, ".pi", "agents", "ged-worker.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("runtime sync writes agents discoverable by pi-subagents", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      models: { "ged-explorer": "openai/gpt-5-mini" },
    });
    const homeDir = await tempDir("ged-agent-sync-home-");

    await syncGedSubagentRuntimeConfig(rootDir, { homeDir });

    type PreflightResult =
      | { ok: true; contract: { agent: { name: string } } }
      | { ok: false; code: string };
    const jiti = createJiti(import.meta.url);
    const { resolveSubagentLaunchContract } = await jiti.import<{
      resolveSubagentLaunchContract(input: {
        agent: string;
        cwd: string;
        agentScope: "project";
        artifacts: false;
      }): Promise<PreflightResult>;
    }>(import.meta.resolve("pi-subagents/preflight"));
    for (const role of [
      "ged-explorer",
      "ged-planner",
      "ged-plan-reviewer",
      "ged-verifier",
    ]) {
      const result = await resolveSubagentLaunchContract({
        agent: role,
        cwd: rootDir,
        agentScope: "project",
        artifacts: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.contract.agent.name).toBe(role);
    }
    const worker = await resolveSubagentLaunchContract({
      agent: "ged-worker",
      cwd: rootDir,
      agentScope: "project",
      artifacts: false,
    });
    expect(worker).toMatchObject({ ok: false, code: "missing_agent" });
  });

  test("adaptive profile generates and preflights exact capability contracts", async () => {
    const rootDir = await tempDir("ged-agent-adaptive-root-");
    const homeDir = await tempDir("ged-agent-adaptive-home-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      profile: "adaptive",
    });
    await syncGedSubagentRuntimeConfig(rootDir, {
      homeDir,
      modelAvailability: {
        isAvailable: (modelId) =>
          modelId === "openai-codex/gpt-5.6-sol" ||
          modelId === "openai-codex/gpt-5.6-luna",
      },
    });

    type PreflightResult =
      | {
          ok: true;
          contract: {
            agent: { name: string };
            context: string;
            model?: string;
            thinking?: string;
            tools: { fanoutAuthorized: boolean; effectiveAllowlist: string[] };
          };
        }
      | { ok: false; code: string; message: string };
    const jiti = createJiti(import.meta.url);
    const { resolveSubagentLaunchContract } = await jiti.import<{
      resolveSubagentLaunchContract(input: {
        agent: string;
        cwd: string;
        agentScope: "project";
        artifacts: false;
        availableModels: Array<{ provider: string; id: string }>;
      }): Promise<PreflightResult>;
    }>(import.meta.resolve("pi-subagents/preflight"));
    const preflight = (agent: string) =>
      resolveSubagentLaunchContract({
        agent,
        cwd: rootDir,
        agentScope: "project",
        artifacts: false,
        availableModels: [
          { provider: "openai-codex", id: "gpt-5.6-sol" },
          { provider: "openai-codex", id: "gpt-5.6-luna" },
        ],
      });

    const scout = await preflight("ged-explorer");
    expect(scout).toMatchObject({
      ok: true,
      contract: {
        context: "fresh",
        model: "openai-codex/gpt-5.6-sol:low",
        thinking: "low",
        tools: { fanoutAuthorized: false },
      },
    });
    if (scout.ok) {
      expect(scout.contract.tools.effectiveAllowlist).not.toContain("bash");
      expect(scout.contract.tools.effectiveAllowlist).not.toContain("edit");
      expect(scout.contract.tools.effectiveAllowlist).not.toContain("write");
    }
    const worker = await preflight("ged-worker");
    expect(worker).toMatchObject({
      ok: true,
      contract: {
        context: "fork",
        model: "openai-codex/gpt-5.6-luna:max",
        thinking: "max",
        tools: {
          fanoutAuthorized: false,
          effectiveAllowlist: expect.arrayContaining(["contact_supervisor"]),
        },
      },
    });
    const smartWorker = await preflight("ged-smart-worker");
    expect(smartWorker).toMatchObject({
      ok: true,
      contract: {
        context: "fork",
        model: "openai-codex/gpt-5.6-sol:high",
        thinking: "high",
        tools: {
          fanoutAuthorized: true,
          effectiveAllowlist: expect.arrayContaining(["subagent"]),
        },
      },
    });
    const verifier = await preflight("ged-verifier");
    expect(verifier).toMatchObject({
      ok: true,
      contract: {
        context: "fresh",
        model: "openai-codex/gpt-5.6-sol:high",
        thinking: "high",
        tools: { fanoutAuthorized: false },
      },
    });
    if (verifier.ok) {
      expect(verifier.contract.tools.effectiveAllowlist).not.toContain("bash");
      expect(verifier.contract.tools.effectiveAllowlist).not.toContain("edit");
      expect(verifier.contract.tools.effectiveAllowlist).not.toContain("write");
    }
  });

  test("adaptive profile preserves overrides and reports unavailable chains", async () => {
    const rootDir = await tempDir("ged-agent-adaptive-diagnostic-");
    const homeDir = await tempDir("ged-agent-adaptive-diagnostic-home-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      profile: "adaptive",
      intercomBridge: false,
      peerMessaging: true,
      roles: {
        "ged-verifier": {
          model: "anthropic/claude-opus-4.8",
          reasoningEffort: "maximum",
          fallback: ["openai-codex/gpt-5.6-sol:maximum"],
        },
      },
    });
    const effective = await readEffectiveGedAgentsSettings(rootDir, {
      homeDir,
    });
    expect(effective).toMatchObject({
      profile: "adaptive",
      supervisorBridge: false,
      peerMessaging: true,
      models: {
        "ged-worker": {
          model: "openai-codex/gpt-5.6-luna",
          thinking: "max",
        },
        "ged-smart-worker": {
          model: "openai-codex/gpt-5.6-sol",
          thinking: "high",
        },
        "ged-verifier": {
          model: "anthropic/claude-opus-4.8",
          thinking: "max",
          fallback: ["openai-codex/gpt-5.6-sol:maximum"],
        },
      },
    });
    const result = await syncGedSubagentRuntimeConfig(rootDir, {
      homeDir,
      modelAvailability: {
        isAvailable: (modelId) => modelId === "anthropic/claude-opus-4.8",
      },
    });
    expect(result.diagnostics.join("\n")).toContain("ged-worker");
    expect(result.diagnostics.join("\n")).not.toContain("ged-verifier");
  });

  test("runtime sync maps explicit intercom setting to pi-subagents bridge config", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    const piAgentDir = await tempDir("ged-agent-dir-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;
    try {
      await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
        enabled: true,
        intercomBridge: false,
      });

      await syncGedSubagentRuntimeConfig(rootDir);

      const config = JSON.parse(
        await readFile(
          path.join(piAgentDir, "extensions", "subagent", "config.json"),
          "utf8",
        ),
      ) as { intercomBridge?: { mode?: string } };
      expect(config.intercomBridge?.mode).toBe("off");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("runtime sync writes configured thinking levels", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      models: {
        "ged-planner": {
          model: "openai/gpt-5.5",
          fallback: ["anthropic/claude-opus-4.7"],
          thinking: "high",
        },
        "ged-verifier": {
          model: "anthropic/claude-opus-4.7",
          thinking: "off",
        },
      },
    });

    await syncGedSubagentRuntimeConfig(rootDir);

    await expect(
      readFile(path.join(rootDir, ".pi", "agents", "ged-planner.md"), "utf8"),
    ).resolves.toContain("thinking: high");
    await expect(
      readFile(path.join(rootDir, ".pi", "agents", "ged-verifier.md"), "utf8"),
    ).resolves.toContain("thinking: off");
  });

  test("runtime sync preserves Pi maximum thinking and strips it for availability", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    const availabilityChecks: string[] = [];
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      roles: {
        "ged-worker": {
          enabled: true,
          model: "openai-codex/gpt-5.6-luna",
          thinking: "max",
          fallback: ["openai-codex/gpt-5.6-sol:max"],
        },
      },
    });

    await syncGedSubagentRuntimeConfig(rootDir);

    const worker = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-worker.md"),
      "utf8",
    );
    expect(worker).toContain("model: openai-codex/gpt-5.6-luna");
    expect(worker).toContain("thinking: max");
    expect(worker).toContain("fallbackModels: openai-codex/gpt-5.6-sol:max");
    expect(
      selectAgentModel(
        {
          model: "provider/missing",
          fallback: ["openai-codex/gpt-5.6-sol:max"],
        },
        {
          isAvailable(modelId) {
            availabilityChecks.push(modelId);
            return modelId === "openai-codex/gpt-5.6-sol";
          },
        },
      ),
    ).toBe("openai-codex/gpt-5.6-sol:max");
    expect(availabilityChecks).toContain("openai-codex/gpt-5.6-sol");
    expect(availabilityChecks).not.toContain("openai-codex/gpt-5.6-sol:max");
  });

  test("runtime sync ignores invalid thinking levels", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      models: {
        "ged-planner": { model: "openai/gpt-5.5", thinking: "bogus" },
      },
    });

    await syncGedSubagentRuntimeConfig(rootDir);

    const planner = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-planner.md"),
      "utf8",
    );
    expect(planner).not.toContain("thinking: bogus");
  });

  test("runtime sync writes fallbackModels for the new pi-subagents contract", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      models: {
        "ged-planner": {
          model: "provider/missing-primary",
          fallback: ["provider/available-fallback"],
        },
      },
    });

    await syncGedSubagentRuntimeConfig(rootDir, {
      modelAvailability: {
        isAvailable: (modelId) => modelId === "provider/available-fallback",
      },
    });

    const planner = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-planner.md"),
      "utf8",
    );
    expect(planner).toContain("model: provider/missing-primary");
    expect(planner).toContain("fallbackModels: provider/available-fallback");
  });

  test("runtime sync preserves recognized fallback thinking suffixes", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      models: {
        "ged-planner": {
          model: "openai/gpt-5.5",
          fallback: [
            "anthropic/claude-opus-4.7:high",
            "provider/model:free",
            "provider/model:free:off",
          ],
          thinking: "medium",
        },
      },
    });

    await syncGedSubagentRuntimeConfig(rootDir, {
      modelAvailability: {
        isAvailable: (modelId) =>
          [
            "openai/gpt-5.5",
            "anthropic/claude-opus-4.7",
            "provider/model:free",
          ].includes(modelId),
      },
    });

    const planner = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-planner.md"),
      "utf8",
    );
    expect(planner).toContain(
      "fallbackModels: anthropic/claude-opus-4.7:high, provider/model:free, provider/model:free:off",
    );
    expect(planner).toContain("thinking: medium");
  });

  test("runtime sync omits invalid unavailable fallback filtering", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      models: {
        "ged-planner": {
          model: "provider/missing-primary",
          fallback: ["provider/missing-fallback"],
        },
      },
    });

    await syncGedSubagentRuntimeConfig(rootDir, {
      modelAvailability: {
        isAvailable: () => false,
      },
    });

    const planner = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-planner.md"),
      "utf8",
    );
    expect(planner).toContain("model: provider/missing-primary");
    expect(planner).toContain("fallbackModels: provider/missing-fallback");
  });

  test("runtime sync generates worker only when enabled", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
      roles: {
        "ged-worker": {
          enabled: true,
          model: "openai/gpt-5-mini",
          maxParallel: 3,
          preferWorktreeIsolation: true,
        },
      },
    });

    await syncGedSubagentRuntimeConfig(rootDir);

    const worker = await readFile(
      path.join(rootDir, ".pi", "agents", "ged-worker.md"),
      "utf8",
    );
    expect(worker).toContain("Optional Ged implementation worker");
    expect(worker).toContain("model: openai/gpt-5-mini");
    expect(worker).toContain("tools: read, grep, find, ls, bash, edit, write");
    expect(worker).toContain("after its worker-suitability check");
    expect(worker).toContain(
      "too difficult, ambiguous, risky, coupled, hard to verify",
    );
    expect(worker).toContain("main agent should implement it directly");
    expect(worker).toContain("new isolated mechanical slice");
    expect(worker).toContain("Do not commit, push, rebase, merge");
    expect(worker).toContain("current public criteria");
    expect(worker).toContain("contact_supervisor");
    expect(worker).not.toContain("maxFinalizationTurns");
    expect(worker).not.toContain("turnBudget");
    expect(worker).toContain("acceptanceRole: writer");
  });

  test("runtime sync disables legacy ged-brain project agent", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await mkdir(path.join(rootDir, ".pi", "agents"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".pi", "agents", "ged-brain.md"),
      "---\nname: ged-brain\ndescription: Main brain\n---\n\nBody\n",
    );
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: false,
    });

    await syncGedSubagentRuntimeConfig(rootDir);

    await expect(
      readFile(path.join(rootDir, ".pi", "agents", "ged-brain.md"), "utf8"),
    ).resolves.toContain("disabled: true");
  });

  test("status reports configured thinking including off legacy", () => {
    const effective = effectiveFixture({
      models: {
        "ged-planner": { model: "openai/gpt-5.5", thinking: "off" },
      },
    });
    effective.roles["ged-planner"].model = {
      model: "openai/gpt-5.5",
      thinking: "off",
    };
    expect(formatGedAgentsStatus(effective)).toContain(
      "- ged-planner (planner): enabled; openai/gpt-5.5 [thinking: off]",
    );
  });

  test("status reports maximum thinking", () => {
    const effective = effectiveFixture({
      models: {
        "ged-worker": {
          model: "openai-codex/gpt-5.6-luna",
          thinking: "max",
        },
      },
    });
    effective.roles["ged-worker"].enabled = true;
    effective.roles["ged-worker"].model = effective.models["ged-worker"];
    expect(formatGedAgentsStatus(effective)).toContain(
      "openai-codex/gpt-5.6-luna [thinking: max]",
    );
  });

  test("status formats fallback thinking suffixes readably", () => {
    const effective = effectiveFixture({
      models: {
        "ged-planner": {
          model: "openai/gpt-5.5",
          fallback: ["anthropic/claude-opus-4.7:high", "provider/model:free"],
          thinking: "medium",
        },
      },
    });
    effective.roles["ged-planner"].model = effective.models["ged-planner"];
    expect(formatGedAgentsStatus(effective)).toContain(
      "openai/gpt-5.5 → anthropic/claude-opus-4.7 [thinking: high] → provider/model:free [thinking: medium]",
    );
  });

  test("status ignores invalid thinking levels legacy", () => {
    const effective = effectiveFixture({
      models: {
        "ged-planner": { model: "openai/gpt-5.5", thinking: "bogus" },
      },
    });
    effective.roles["ged-planner"].model = {
      model: "openai/gpt-5.5",
      thinking: "bogus",
    };
    expect(formatGedAgentsStatus(effective)).toContain(
      "- ged-planner (planner): enabled; openai/gpt-5.5; read-only",
    );
  });

  test("runtime sync gitignores project gedoc settings in git repos", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await mkdir(path.join(rootDir, ".git"));
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
    });

    await syncGedSubagentRuntimeConfig(rootDir);

    await expect(
      readFile(path.join(rootDir, ".gitignore"), "utf8"),
    ).resolves.toContain(".gedoc/");
  });

  test("runtime sync removes Ged roles when disabled", async () => {
    const rootDir = await tempDir("ged-agent-sync-root-");
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: true,
    });
    await syncGedSubagentRuntimeConfig(rootDir);
    await writeGedAgentsSettings(projectGedSettingsPath(rootDir), {
      enabled: false,
    });

    await syncGedSubagentRuntimeConfig(rootDir);

    await expect(
      readFile(path.join(rootDir, ".pi", "agents", "ged-explorer.md"), "utf8"),
    ).rejects.toThrow();
  });
});
