import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import gedCoreExtension from "../extensions/ged-core/index.js";
import {
  projectGedSettingsPath,
  readGedRuntimeSettings,
  writeGedAgentsSettings,
} from "../src/agent-settings.js";
import { createGedCommands } from "../src/commands.js";
import { rewriteCommandWithRtk } from "../src/rtk.js";

describe("Ged command surface", () => {
  test("createGedCommands exposes GedPi commands", () => {
    expect(createGedCommands().map((command) => command.name)).toEqual([
      "grill-me",
      "rtk",
      "ged-agents",
      "ged-settings",
    ]);
  });

  test("gedCoreExtension registers the GedPi commands", async () => {
    let rendererRegistrations = 0;
    const commands: string[] = [];
    const events: string[] = [];
    const emittedEvents: Array<{ channel: string; data: unknown }> = [];

    await gedCoreExtension({
      registerMessageRenderer() {
        rendererRegistrations += 1;
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      registerShortcut() {},
      registerTool() {},
      on(event: string) {
        events.push(event);
      },
      events: {
        emit(channel: string, data: unknown) {
          emittedEvents.push({ channel, data });
        },
        on() {},
      },
    } as never);

    expect(rendererRegistrations).toBeGreaterThan(0);
    expect(commands).toEqual([
      "grill-me",
      "rtk",
      "ged-agents",
      "ged-settings",
      "update",
    ]);
    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("tool_call");
  });

  test("grill-me command returns clarification instructions", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "grill-me",
    );

    const result = await command?.execute({ cwd: process.cwd(), args: [] });

    expect(result).toContain("exactly one concise unresolved question");
    expect(result).toContain("summarize");
    expect(result).toContain("grill-with-docs");
    expect(result).toContain("recommended answer or default assumption");
  });

  test("rewriteCommandWithRtk returns rewritten bash command when supported", async () => {
    await expect(
      rewriteCommandWithRtk("git status", process.cwd(), async () => ({
        stdout: "rtk git status\n",
        stderr: "",
        code: 0,
      })),
    ).resolves.toBe("rtk git status");

    await expect(
      rewriteCommandWithRtk("echo hi", process.cwd(), async () => ({
        stdout: "",
        stderr: "unsupported",
        code: 1,
      })),
    ).resolves.toBeNull();
  });

  test("ged-agents status reports read-only role contract", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));

    const result = await command?.execute({ cwd, args: ["status"] });

    expect(result).toMatch(/Subagents: (enabled|disabled)/u);
    expect(result).toContain("ged-explorer");
    expect(result).toContain("ged-planner");
    expect(result).toContain("ged-plan-reviewer");
    expect(result).toContain("ged-verifier");
    expect(result).toContain("ged-worker");
    expect(result).toContain("ged-smart-worker");
    expect(result).toContain("Default/builtin pi-subagents agents");
    expect(result).toContain("Writer roles: optional capacity");
  });

  test("ged-agents project toggles preserve configured models", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    await writeGedAgentsSettings(projectGedSettingsPath(cwd), {
      enabled: false,
      defaultModel: "openai/gpt-5-mini",
      models: { "ged-planner": "openai/gpt-5.5" },
    });

    await command?.execute({ cwd, args: ["on", "--project"] });
    const status = await command?.execute({ cwd, args: ["status"] });

    expect(status).toContain("Subagents: enabled");
    expect(status).toContain("Default model: openai/gpt-5-mini");
    expect(status).toContain(
      "- ged-planner (planner): enabled; openai/gpt-5.5",
    );
  });

  test("ged-agents models shows current assignments", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    await writeGedAgentsSettings(projectGedSettingsPath(cwd), {
      enabled: true,
      defaultModel: "anthropic/claude-sonnet-4",
      models: { "ged-planner": "openai/gpt-5.5" },
    });

    const result = await command?.execute({ cwd, args: ["models"] });

    expect(result).toContain("ged-explorer");
    expect(result).toContain("ged-planner");
    expect(result).toContain("ged-verifier");
    expect(result).toContain("openai/gpt-5.5");
    expect(result).toContain("anthropic/claude-sonnet-4");
    expect(result).toContain("Change:");
  });

  test("ged-agents models shows configured thinking levels", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    await writeGedAgentsSettings(projectGedSettingsPath(cwd), {
      enabled: true,
      defaultModel: { model: "openai/gpt-5-mini", thinking: "minimal" },
      models: {
        "ged-planner": { model: "openai/gpt-5.5", thinking: "low" },
      },
    });

    const result = await command?.execute({ cwd, args: ["models"] });

    expect(result).toContain("ged-planner");
    expect(result).toContain("openai/gpt-5.5 [thinking: low]");
    expect(result).toContain(
      "default**: openai/gpt-5-mini [thinking: minimal]",
    );
  });

  test("ged-agents adaptive profile validates the live registry before saving", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const missingRoot = await mkdtemp(
      path.join(os.tmpdir(), "ged-agents-profile-missing-"),
    );
    const missing = await command?.execute({
      cwd: missingRoot,
      args: ["profile", "adaptive", "--project"],
      runtime: {
        pi: {} as never,
        ctx: {
          modelRegistry: { find: () => undefined },
        } as never,
      },
    });
    expect(missing).toContain(
      "openai-codex/gpt-5.6-sol, openai-codex/gpt-5.6-luna",
    );
    await expect(
      readGedRuntimeSettings(projectGedSettingsPath(missingRoot)),
    ).resolves.toEqual({ agents: {} });

    const root = await mkdtemp(
      path.join(os.tmpdir(), "ged-agents-profile-live-"),
    );
    const result = await command?.execute({
      cwd: root,
      args: ["profile", "adaptive", "--project"],
      runtime: {
        pi: {} as never,
        ctx: {
          modelRegistry: {
            find: (provider: string, id: string) =>
              provider === "openai-codex" &&
              (id === "gpt-5.6-sol" || id === "gpt-5.6-luna")
                ? { provider, id }
                : undefined,
          },
        } as never,
      },
    });
    expect(result).toContain("adaptive staffing profile saved");
    await expect(
      readGedRuntimeSettings(projectGedSettingsPath(root)),
    ).resolves.toMatchObject({
      agents: { enabled: true, profile: "adaptive" },
    });
    const status = await command?.execute({ cwd: root, args: ["status"] });
    expect(status).toContain("Profile: adaptive");
    expect(status).toContain("openai-codex/gpt-5.6-luna [thinking: max]");
  });

  test("ged-agents keeps external peer messaging separate", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-peer-"));
    await command?.execute({ cwd, args: ["peer", "on", "--project"] });
    await expect(
      readGedRuntimeSettings(projectGedSettingsPath(cwd)),
    ).resolves.toMatchObject({ agents: { peerMessaging: true } });
    const status = await command?.execute({ cwd, args: ["status"] });
    expect(status).toContain(
      "Peer messaging: enabled (exact-target verified fact sends only)",
    );
  });

  test("ged-agents model sets per-role model", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));

    const result = await command?.execute({
      cwd,
      args: ["model", "ged-planner", "anthropic/claude-opus-4", "--project"],
    });

    expect(result).toContain("Set ged-planner model");
    expect(result).toContain("anthropic/claude-opus-4");
    expect(result).toContain("project");
  });

  test("ged-agents model sets default model", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));

    const result = await command?.execute({
      cwd,
      args: ["model", "default", "openai/gpt-5", "--project"],
    });

    expect(result).toContain("Set default model");
    expect(result).toContain("openai/gpt-5");
  });

  test("ged-agents model --clear removes per-role override", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    await writeGedAgentsSettings(projectGedSettingsPath(cwd), {
      enabled: true,
      models: { "ged-explorer": "anthropic/claude-sonnet-4" },
    });

    const result = await command?.execute({
      cwd,
      args: ["model", "ged-explorer", "--clear", "--project"],
    });

    expect(result).toContain("Cleared ged-explorer model");
  });

  test("ged-agents model rejects unknown role", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));

    const result = await command?.execute({
      cwd,
      args: ["model", "ged-writer", "anthropic/claude-sonnet-4"],
    });

    expect(result).toContain("Unknown role");
  });

  test("ged-agents configures worker, intercom, critique, thinking, and fallbacks", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    const piAgentDir = await mkdtemp(path.join(os.tmpdir(), "ged-agent-dir-"));
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piAgentDir;

    try {
      await command?.execute({
        cwd,
        args: ["role", "ged-worker", "on", "--project"],
      });
      await command?.execute({
        cwd,
        args: ["worker", "max-parallel", "4", "--project"],
      });
      await command?.execute({
        cwd,
        args: ["worker", "worktree", "on", "--project"],
      });
      await command?.execute({ cwd, args: ["intercom", "off", "--project"] });
      await command?.execute({
        cwd,
        args: ["critique", "always", "--project"],
      });
      await command?.execute({
        cwd,
        args: ["model", "ged-worker", "openai/gpt-5-mini", "--project"],
      });
      await command?.execute({
        cwd,
        args: ["thinking", "ged-worker", "max", "--project"],
      });
      await command?.execute({
        cwd,
        args: ["model", "ged-worker", "openai/gpt-5.5", "--project"],
      });
      await command?.execute({
        cwd,
        args: [
          "fallback",
          "ged-worker",
          "add",
          "anthropic/claude-sonnet-4",
          "--project",
        ],
      });

      const settings = await readGedRuntimeSettings(
        projectGedSettingsPath(cwd),
      );
      expect(settings.agents).toMatchObject({
        supervisorBridge: false,
        critiqueMode: "always",
        roles: {
          "ged-worker": {
            enabled: true,
            model: "openai/gpt-5.5",
            thinking: "max",
            fallback: ["anthropic/claude-sonnet-4"],
            maxParallel: 4,
            preferWorktreeIsolation: true,
          },
        },
      });
      expect(settings.agents?.models?.["ged-worker"]).toBeUndefined();
    } finally {
      if (previousPiAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
  });

  test("ged-agents fallback supports list, set, move, and remove", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));

    await command?.execute({
      cwd,
      args: ["model", "ged-planner", "openai/gpt-5.5", "--project"],
    });
    await command?.execute({
      cwd,
      args: [
        "fallback",
        "ged-planner",
        "set",
        "model/a",
        "model/b",
        "model/c",
        "--project",
      ],
    });
    await command?.execute({
      cwd,
      args: [
        "fallback",
        "ged-planner",
        "move",
        "model/c",
        "before",
        "model/a",
        "--project",
      ],
    });
    const list = await command?.execute({
      cwd,
      args: ["fallback", "ged-planner", "list", "--project"],
    });
    expect(list).toContain("1. model/c");
    expect(list).toContain("2. model/a");

    await command?.execute({
      cwd,
      args: ["fallback", "ged-planner", "remove", "model/a", "--project"],
    });
    const settings = await readGedRuntimeSettings(projectGedSettingsPath(cwd));
    expect(settings.agents?.roles?.["ged-planner"]?.fallback).toEqual([
      "model/c",
      "model/b",
    ]);
  });

  test("ged-agents fallback supports thinking suffixes and base-model operations", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));

    await command?.execute({
      cwd,
      args: ["model", "ged-planner", "openai/gpt-5.5", "--project"],
    });
    await command?.execute({
      cwd,
      args: [
        "fallback",
        "ged-planner",
        "add",
        "anthropic/claude-opus-4.7",
        "high",
        "--project",
      ],
    });
    await command?.execute({
      cwd,
      args: [
        "fallback",
        "ged-planner",
        "add",
        "provider/model:free",
        "--project",
      ],
    });

    const list = await command?.execute({
      cwd,
      args: ["fallback", "ged-planner", "list", "--project"],
    });
    expect(list).toContain("1. anthropic/claude-opus-4.7 [thinking: high]");
    expect(list).toContain("2. provider/model:free");

    await command?.execute({
      cwd,
      args: [
        "fallback",
        "ged-planner",
        "remove",
        "anthropic/claude-opus-4.7",
        "--project",
      ],
    });
    const settings = await readGedRuntimeSettings(projectGedSettingsPath(cwd));
    expect(settings.agents?.roles?.["ged-planner"]?.fallback).toEqual([
      "provider/model:free",
    ]);

    await expect(
      command?.execute({
        cwd,
        args: [
          "fallback",
          "ged-planner",
          "add",
          "anthropic/claude-opus-4.7",
          "turbo",
          "--project",
        ],
      }),
    ).resolves.toContain("Fallback thinking level must be one of");
  });

  test("ged-agents setup advanced configures role-aware settings", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    const models = [
      { provider: "openai", id: "gpt-5.5", name: "GPT" },
      { provider: "anthropic", id: "claude-opus-4.7", name: "Claude" },
    ];
    const selectResponses = [
      "This project only",
      "Subagents:",
      "Supervisor bridge:",
      "Disabled",
      "ged-worker:",
      "Enable role",
      "ged-worker:",
      "Set model",
      "Low",
      "Yes",
      "High",
      "No",
      "ged-worker:",
      "Worker max parallel",
      "3",
      "ged-worker:",
      "Worker worktree",
      "Preferred",
      "Done",
    ];
    let customIndex = 0;

    const result = await command?.execute({
      cwd,
      args: ["setup", "advanced"],
      runtime: {
        pi: {} as never,
        ctx: {
          hasUI: true,
          ui: {
            select: async (_title: string, options: string[]) => {
              const response = selectResponses.shift();
              return options.find((option) =>
                option.startsWith(response ?? ""),
              );
            },
            custom: async () => models[customIndex++],
            confirm: async () => true,
            notify: () => {},
          },
          modelRegistry: {
            getAvailable: () => models,
            find: (provider: string, id: string) =>
              models.find(
                (model) => model.provider === provider && model.id === id,
              ),
          },
        } as never,
      },
    });

    expect(result).toContain("advanced subagent setup saved");
    const settings = await readGedRuntimeSettings(projectGedSettingsPath(cwd));
    expect(settings.agents).toMatchObject({
      enabled: true,
      supervisorBridge: false,
      roles: {
        "ged-worker": {
          enabled: true,
          model: "openai/gpt-5.5",
          thinking: "low",
          fallback: ["anthropic/claude-opus-4.7:high"],
          maxParallel: 3,
          preferWorktreeIsolation: true,
        },
      },
    });
  });

  test("ged-agents opens a guided menu from the bare command", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    const models = [
      { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek" },
      { provider: "openai", id: "gpt-5.5", name: "GPT" },
      { provider: "anthropic", id: "claude-opus-4.7", name: "Claude" },
    ];
    const selectResponses = [
      "This project only",
      "Subagents:",
      "ged-planner:",
      "Set model",
      "Low",
      "Yes",
      "High",
      "Yes",
      "Inherit/default",
      "No",
      "Done",
    ];
    let customIndex = 0;

    const result = await command?.execute({
      cwd,
      args: [],
      runtime: {
        pi: {} as never,
        ctx: {
          hasUI: true,
          ui: {
            select: async (_title: string, options: string[]) => {
              const response = selectResponses.shift();
              return options.find((option) =>
                option.startsWith(response ?? ""),
              );
            },
            custom: async () => models[customIndex++],
            confirm: async () => true,
            notify: () => {},
          },
          modelRegistry: {
            getAvailable: () => models,
            find: (provider: string, id: string) =>
              models.find(
                (model) => model.provider === provider && model.id === id,
              ),
          },
        } as never,
      },
    });

    expect(result).toContain("advanced subagent setup saved");

    const settings = await readGedRuntimeSettings(projectGedSettingsPath(cwd));
    expect(settings.agents?.enabled).toBe(true);
    expect(settings.agents?.roles?.["ged-planner"]).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      thinking: "low",
      fallback: ["openai/gpt-5.5:high", "anthropic/claude-opus-4.7"],
    });
    expect(settings.agents?.roles?.["ged-worker"]?.enabled).toBeUndefined();
  });

  test("ged-agents status remains text-only in UI sessions", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    let selectCalled = false;

    const result = await command?.execute({
      cwd,
      args: ["status"],
      runtime: {
        pi: {} as never,
        ctx: {
          hasUI: true,
          ui: {
            select: async () => {
              selectCalled = true;
              return "Cancel";
            },
            custom: async () => null,
            confirm: async () => false,
            notify: () => {},
          },
        } as never,
      },
    });

    expect(selectCalled).toBe(false);
    expect(result).toContain("Subagents:");
  });

  test("ged-agents menu exits without enabling subagents or worker", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    const models = [{ provider: "openai", id: "gpt-5.5", name: "GPT" }];
    const selectResponses = ["This project only", "Done"];

    const result = await command?.execute({
      cwd,
      args: [],
      runtime: {
        pi: {} as never,
        ctx: {
          hasUI: true,
          ui: {
            select: async (_title: string, options: string[]) => {
              const response = selectResponses.shift();
              return options.find((option) =>
                option.startsWith(response ?? ""),
              );
            },
            custom: async () => models[0],
            confirm: async () => true,
            notify: () => {},
          },
          modelRegistry: {
            getAvailable: () => models,
            find: () => models[0],
          },
        } as never,
      },
    });

    expect(result).toContain("unchanged");
    const settings = await readGedRuntimeSettings(projectGedSettingsPath(cwd));
    expect(settings.agents?.enabled).toBeUndefined();
    expect(settings.agents?.roles?.["ged-worker"]?.enabled).toBeUndefined();
  });

  test("ged-agents role menus show only the relevant enable toggle", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    const models = [{ provider: "openai", id: "gpt-5.5", name: "GPT" }];
    const selectResponses = [
      "This project only",
      "ged-worker:",
      "Back",
      "ged-planner:",
      "Back",
      "Done",
    ];
    const roleMenus: Record<string, string[]> = {};

    await command?.execute({
      cwd,
      args: ["setup", "advanced"],
      runtime: {
        pi: {} as never,
        ctx: {
          hasUI: true,
          ui: {
            select: async (title: string, options: string[]) => {
              if (title.startsWith("Configure ged-worker")) {
                roleMenus.worker = options;
              }
              if (title.startsWith("Configure ged-planner")) {
                roleMenus.planner = options;
              }
              const response = selectResponses.shift();
              return options.find((option) =>
                option.startsWith(response ?? ""),
              );
            },
            custom: async () => models[0],
            confirm: async () => true,
            notify: () => {},
          },
          modelRegistry: {
            getAvailable: () => models,
            find: () => models[0],
          },
        } as never,
      },
    });

    expect(roleMenus.worker).toContain("Enable role");
    expect(roleMenus.worker).not.toContain("Disable role");
    expect(roleMenus.worker).not.toContain("Set thinking");
    expect(roleMenus.worker).not.toContain("Add fallback");
    expect(roleMenus.planner).toContain("Disable role");
    expect(roleMenus.planner).not.toContain("Enable role");
  });

  test("ged-agents menu labels resolve inherited role enabled defaults", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    await writeGedAgentsSettings(projectGedSettingsPath(cwd), {
      enabled: true,
      roles: {
        "ged-explorer": { model: "openai/gpt-5.5" },
        "ged-worker": { model: "anthropic/claude-sonnet-4" },
      },
    });
    const models = [{ provider: "openai", id: "gpt-5.5", name: "GPT" }];
    let topLevelOptions: string[] = [];

    await command?.execute({
      cwd,
      args: [],
      runtime: {
        pi: {} as never,
        ctx: {
          hasUI: true,
          ui: {
            select: async (title: string, options: string[]) => {
              if (title === "Ged agent orchestration setup") {
                topLevelOptions = options;
              }
              return title === "Set up Ged subagents"
                ? "This project only"
                : "Done";
            },
            custom: async () => models[0],
            confirm: async () => true,
            notify: () => {},
          },
          modelRegistry: {
            getAvailable: () => models,
            find: () => models[0],
          },
        } as never,
      },
    });

    expect(topLevelOptions).toContain("ged-explorer: enabled; openai/gpt-5.5");
    expect(topLevelOptions).not.toContain(
      "ged-explorer: inherit; openai/gpt-5.5",
    );
    expect(topLevelOptions).toContain(
      "ged-worker: disabled; anthropic/claude-sonnet-4",
    );
  });

  test("ged-agents setup cancels without writing at thinking selection", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));
    const models = [{ provider: "openai", id: "gpt-5.5", name: "GPT" }];

    const result = await command?.execute({
      cwd,
      args: ["setup"],
      runtime: {
        pi: {} as never,
        ctx: {
          hasUI: true,
          ui: {
            select: async (title: string) =>
              title === "Set up Ged subagents" ? "This project only" : "Cancel",
            custom: async () => models[0],
            confirm: async () => true,
            notify: () => {},
          },
          modelRegistry: {
            getAvailable: () => models,
            find: () => models[0],
          },
        } as never,
      },
    });

    expect(result).toBe("Setup cancelled.");
    await expect(
      readGedRuntimeSettings(projectGedSettingsPath(cwd)),
    ).resolves.toEqual({
      agents: {},
    });
  });

  test("ged-agents setup returns compact commands in non-UI mode", async () => {
    const command = createGedCommands().find(
      (candidate) => candidate.name === "ged-agents",
    );
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ged-agents-command-"));

    const result = await command?.execute({ cwd, args: ["setup"] });

    expect(result).toContain("/ged-agents profile adaptive");
    expect(result).toContain("openai-codex/gpt-5.6-sol");
    expect(result).toContain("openai-codex/gpt-5.6-luna");
  });
});
