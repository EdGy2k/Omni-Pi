import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import gedCoreExtension from "../extensions/ged-core/index.js";
import {
  buildBrainSystemPromptSuffix,
  buildBranchNudge,
  buildPassiveGedPromptSuffix,
  ensureGedReady,
  TRUNK_BRANCHES,
} from "../src/brain.js";
import {
  activeGedPaths,
  openGedWork,
  relativeGedPath,
} from "../src/ged-paths.js";
import { resolveGovernance } from "../src/governance.js";
import {
  initializeGovernanceState,
  readGovernanceState,
} from "../src/governance-store.js";

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function enableProjectSubagents(rootDir: string): Promise<void> {
  const settingsDir = path.join(rootDir, ".gedoc");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ agents: { enabled: true } }),
  );
}

async function createTempHomeWithPreferences(
  prefs: Record<string, string>,
): Promise<string> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ged-home-"));
  const gedocDir = path.join(homeDir, ".gedoc");
  await mkdir(gedocDir, { recursive: true });
  await writeFile(
    path.join(gedocDir, "settings.json"),
    JSON.stringify({ preferences: prefs }),
  );
  return homeDir;
}

describe("Ged brain runtime", () => {
  let testHomeDir: string;

  beforeEach(async () => {
    testHomeDir = await createTempHomeWithPreferences({
      autoCommitVerifiedWork: "ask",
      reviewPlanBeforePlannerHandoff: "plannotator",
    });
  });

  afterEach(async () => {
    // Cleanup handled by OS tmp dirs.
  });

  test("ensureGedReady bootstraps .ged when ged mode is enabled", async () => {
    const rootDir = await createTempProject("ged-brain-init-");

    const result = await ensureGedReady(rootDir);
    const paths = await activeGedPaths(rootDir);
    const state = await readFile(paths.statePath, "utf8");

    expect(result.status).toBe("initialized");
    expect(state).toContain("Run onboarding clarification");
  });

  test("buildBrainSystemPromptSuffix includes the subagent workflow and durable files", async () => {
    const rootDir = await createTempProject("ged-brain-prompt-");
    await ensureGedReady(rootDir);
    await enableProjectSubagents(rootDir);

    const prompt = await buildBrainSystemPromptSuffix(rootDir, {
      homeDir: testHomeDir,
    });
    const paths = await activeGedPaths(rootDir);

    expect(prompt).toContain("GedPi Single-Brain Mode");
    expect(prompt).toContain("read-only, direct-change, or planned-change");
    expect(prompt).toContain("structured minimum mode");
    expect(prompt).toContain("ged_work open");
    expect(prompt).toContain("ged_governance accept-plan");
    expect(prompt).toContain("ged_governance record-verification");
    expect(prompt).toContain("ged_lifecycle");
    expect(prompt).toContain("terminal work never reopens");
    expect(prompt).toContain("skill-fit checkpoint");
    expect(prompt).toContain("Optional assistants are available");
    expect(prompt).toContain("staffing never changes governance");
    expect(prompt).not.toContain("grill-me: needed");
    expect(prompt).not.toContain("grill-me: skipped; reason:");
    expect(prompt).not.toContain("checkpoints.json");
    expect(prompt).not.toContain("mandatory for non-trivial");
    expect(prompt).toContain("## Plan Review Preference");
    expect(prompt).toContain(
      "Current setting: Review with Plannotator (plannotator)",
    );
    expect(prompt).toContain("gedpi_plan_review");
    expect(prompt).toContain("fall back to chat approval");
    expect(prompt).toContain(
      "ged_governance accept-plan to bind their exact bytes before source mutation",
    );
    expect(prompt).toContain("## Commit Preference");
    expect(prompt).toContain("Current setting: ask");
    expect(prompt).toContain("ask the user whether to commit");
    expect(prompt).toContain(
      "search/install/create only for a real reusable capability gap",
    );
    expect(prompt).not.toContain("interview tool");
    expect(prompt).toContain(
      "Treat direct user instructions as requested Ged app/product behavior",
    );
    expect(prompt).toContain(relativeGedPath(rootDir, paths.tasksPath));
    expect(prompt).toContain("No authoritative governance state exists");
  });

  test("buildPassiveGedPromptSuffix excludes workflow files and keeps durable guidance", async () => {
    const rootDir = await createTempProject("ged-brain-passive-");
    await ensureGedReady(rootDir);

    const prompt = await buildPassiveGedPromptSuffix(rootDir);

    expect(prompt).toContain("Ged Durable Standards");
    expect(prompt).toContain(".ged/PROJECT.md");
    expect(prompt).not.toContain("### .ged/TASKS.md");
    expect(prompt).not.toContain("### .ged/TESTS.md");
  });

  describe("buildBranchNudge", () => {
    test("returns nudge for main branch", () => {
      const nudge = buildBranchNudge("main");
      expect(nudge).toContain("## ⚠️ Branch Hygiene");
      expect(nudge).toContain("`main`");
      expect(nudge).toContain("feature branch");
      expect(nudge).toContain("git checkout -b");
    });

    test("returns nudge for master branch", () => {
      const nudge = buildBranchNudge("master");
      expect(nudge).toContain("## ⚠️ Branch Hygiene");
      expect(nudge).toContain("`master`");
      expect(nudge).toContain("feature branch");
    });

    test("returns nudge without a named Git branch", () => {
      const nudge = buildBranchNudge(null);
      expect(nudge).toContain("## ⚠️ Branch Hygiene");
      expect(nudge).toContain("No named Git branch");
      expect(nudge).toContain("work identity remains task-scoped");
      expect(nudge).toContain("feature branch");
    });

    test("returns empty string for feature branches", () => {
      expect(buildBranchNudge("feat-foo")).toBe("");
      expect(buildBranchNudge("fix-bar")).toBe("");
      expect(buildBranchNudge("chore/update-deps")).toBe("");
      expect(buildBranchNudge("feature/my-cool-thing")).toBe("");
      expect(buildBranchNudge("root")).toBe("");
    });

    test("returns empty string for empty work-id", () => {
      expect(buildBranchNudge("")).toBe("");
    });

    test("TRUNK_BRANCHES contains expected values", () => {
      expect(TRUNK_BRANCHES.has("main")).toBe(true);
      expect(TRUNK_BRANCHES.has("master")).toBe(true);
      expect(TRUNK_BRANCHES.size).toBe(2);
    });
  });

  test("buildBrainSystemPromptSuffix includes branch nudge when no git repo (root work-id)", async () => {
    const rootDir = await createTempProject("ged-brain-nudge-");
    await ensureGedReady(rootDir);

    const prompt = await buildBrainSystemPromptSuffix(rootDir, {
      homeDir: testHomeDir,
    });

    expect(prompt).toContain("## ⚠️ Branch Hygiene");
    expect(prompt).toContain("No named Git branch");
    expect(prompt).toContain("work identity remains task-scoped");
    // Nudge should appear before the passive durable standards section
    const nudgeIndex = prompt.indexOf("## ⚠️ Branch Hygiene");
    const standardsIndex = prompt.indexOf("## Ged Durable Standards");
    expect(nudgeIndex).toBeLessThan(standardsIndex);
  });

  test("buildBrainSystemPromptSuffix omits branch nudge on feature branch", async () => {
    const rootDir = await createTempProject("ged-brain-feat-");
    execSync("git init -b feat/my-work", { cwd: rootDir });
    execSync('git config user.email "test@gedpi.dev"', { cwd: rootDir });
    execSync('git config user.name "GedPi Test"', { cwd: rootDir });
    execSync("git commit --allow-empty -m 'initial'", { cwd: rootDir });
    await ensureGedReady(rootDir);

    const prompt = await buildBrainSystemPromptSuffix(rootDir, {
      homeDir: testHomeDir,
    });

    expect(prompt).not.toContain("## ⚠️ Branch Hygiene");
  });

  test("buildBrainSystemPromptSuffix includes branch nudge on main branch", async () => {
    const rootDir = await createTempProject("ged-brain-main-");
    execSync("git init -b main", { cwd: rootDir });
    execSync('git config user.email "test@gedpi.dev"', { cwd: rootDir });
    execSync('git config user.name "GedPi Test"', { cwd: rootDir });
    execSync("git commit --allow-empty -m 'initial'", { cwd: rootDir });
    await ensureGedReady(rootDir);

    const prompt = await buildBrainSystemPromptSuffix(rootDir, {
      homeDir: testHomeDir,
    });

    expect(prompt).toContain("## ⚠️ Branch Hygiene");
    expect(prompt).toContain("`main`");
  });

  test("buildBrainSystemPromptSuffix includes branch nudge on master branch", async () => {
    const rootDir = await createTempProject("ged-brain-master-");
    execSync("git init -b master", { cwd: rootDir });
    execSync('git config user.email "test@gedpi.dev"', { cwd: rootDir });
    execSync('git config user.name "GedPi Test"', { cwd: rootDir });
    execSync("git commit --allow-empty -m 'initial'", { cwd: rootDir });
    await ensureGedReady(rootDir);

    const prompt = await buildBrainSystemPromptSuffix(rootDir, {
      homeDir: testHomeDir,
    });

    expect(prompt).toContain("## ⚠️ Branch Hygiene");
    expect(prompt).toContain("`master`");
  });

  test("gedCoreExtension initializes and injects the subagent workflow prompt", async () => {
    const rootDir = await createTempProject("ged-brain-ext-");
    await enableProjectSubagents(rootDir);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();

    await gedCoreExtension({
      registerMessageRenderer() {
        return undefined;
      },
      registerCommand() {},
      registerShortcut() {},
      registerTool() {},
      sendMessage() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
    } as never);

    await handlers.get("session_start")?.(
      { type: "session_start" },
      {
        cwd: rootDir,
        sessionManager: {
          getSessionId() {
            return "ged-default-session";
          },
        },
        ui: {
          setTitle() {},
          setTheme() {},
          setHeader() {},
          notify() {},
          setStatus() {},
        },
      },
    );
    const beforeStart = (await handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "Build me a todo app",
        systemPrompt: "BASE",
      },
      { cwd: rootDir },
    )) as { systemPrompt: string };

    expect(beforeStart.systemPrompt).toContain("BASE");
    expect(beforeStart.systemPrompt).toContain("GedPi Single-Brain Mode");
    expect(beforeStart.systemPrompt).toContain("ged_work open");
    expect(beforeStart.systemPrompt).toContain("ged_lifecycle");
    expect(beforeStart.systemPrompt).not.toContain("grill-me: needed");
    expect(beforeStart.systemPrompt).toContain(
      "Optional assistants are available",
    );
    expect(beforeStart.systemPrompt).toContain(
      "staffing never changes governance",
    );
    expect(beforeStart.systemPrompt).toContain("## Plan Review Preference");
    expect(beforeStart.systemPrompt).toContain(
      "Review with Plannotator (plannotator)",
    );
    expect(beforeStart.systemPrompt).not.toContain("interview tool");
  });

  test("workflow status is projected from governance JSON, not STATE.md", async () => {
    const rootDir = await createTempProject("ged-brain-governance-status-");
    await ensureGedReady(rootDir);
    const opened = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "request-a" },
      "Authoritative status",
    );
    await initializeGovernanceState(rootDir, opened.workId, {
      decision: resolveGovernance({
        intent: { mutation: "requested", minimumMode: "direct-change" },
        ambiguity: "sufficient",
        risk: "low",
        change: {
          clearScope: true,
          bounded: true,
          reversible: true,
          deterministicCheck: true,
        },
      }),
      executionProfile: "assisted",
      currentSlice: "slice-status",
    });
    await writeFile(opened.paths.statePath, "FAKE MARKDOWN AUTHORITY\n");

    const prompt = await buildBrainSystemPromptSuffix(rootDir, {
      homeDir: testHomeDir,
    });
    expect(prompt).toContain(`Work ID: ${opened.workId}`);
    expect(prompt).toContain("Mode: direct-change");
    expect(prompt).toContain("Execution profile: assisted");
    expect(prompt).toContain("Current slice: slice-status");
    expect(prompt).not.toContain("FAKE MARKDOWN AUTHORITY");
  });

  test("staffing and legacy data cannot authorize mutation or be changed by commit", async () => {
    for (const agentsEnabled of [false, true]) {
      const rootDir = await createTempProject(
        `ged-brain-staffing-${agentsEnabled ? "on" : "off"}-`,
      );
      execSync("git init -b main", { cwd: rootDir });
      execSync('git config user.email "test@example.com"', { cwd: rootDir });
      execSync('git config user.name "Test"', { cwd: rootDir });
      await writeFile(path.join(rootDir, "README.md"), "initial\n");
      execSync("git add README.md && git commit -m initial", { cwd: rootDir });
      if (agentsEnabled) await enableProjectSubagents(rootDir);
      const handlers = new Map<
        string,
        Array<(...args: unknown[]) => unknown>
      >();
      const tools = new Map<
        string,
        {
          execute(
            ...args: unknown[]
          ): Promise<{ details?: { workId?: string } }>;
        }
      >();
      const api = {
        registerMessageRenderer() {},
        registerCommand() {},
        registerShortcut() {},
        registerTool(tool: {
          name: string;
          execute(
            ...args: unknown[]
          ): Promise<{ details?: { workId?: string } }>;
        }) {
          tools.set(tool.name, tool);
        },
        sendMessage() {},
        on(event: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
      };
      await gedCoreExtension(api as never);
      const ctx = {
        cwd: rootDir,
        mode: "rpc",
        sessionManager: { getSessionId: () => "session-a" },
      };
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start" }, ctx);
      }
      for (const handler of handlers.get("before_agent_start") ?? []) {
        await handler(
          {
            type: "before_agent_start",
            prompt: "change",
            systemPrompt: "base",
          },
          ctx,
        );
      }
      const workTool = tools.get("ged_work");
      if (!workTool) throw new Error("ged_work missing");
      const opened = await workTool.execute(
        "open",
        {
          action: "open",
          summary: "Staffing-independent task",
          minimumMode: "planned-change",
          ambiguity: "sufficient",
          risk: "normal",
          clearScope: true,
          bounded: true,
          reversible: true,
          deterministicCheck: true,
        },
        undefined,
        undefined,
        ctx,
      );
      const workId = opened.details?.workId as string;
      const paths = await activeGedPaths(rootDir, "session-a");
      const legacyState = {
        schemaVersion: 3,
        lifecycleStatus: "verified",
        classification: "trivial",
        classificationReason: "Legacy state must be ignored",
        planCheckpoints: {},
        taskCheckpoints: {},
      };
      await writeFile(paths.checkpointsPath, JSON.stringify(legacyState));
      for (const handler of handlers.get("tool_result") ?? []) {
        await handler(
          {
            type: "tool_result",
            toolCallId: "subagent-result",
            toolName: "subagent",
            input: {},
            content: [],
            details: {
              results: [
                {
                  agent: "ged-verifier",
                  success: true,
                  structuredOutput: { outcome: "clean", findings: [] },
                },
              ],
            },
            isError: false,
          },
          ctx,
        );
      }

      const results = [];
      for (const handler of handlers.get("tool_call") ?? []) {
        results.push(
          await handler(
            {
              type: "tool_call",
              toolCallId: "source-write",
              toolName: "write",
              input: { path: "src/index.ts" },
            },
            ctx,
          ),
        );
      }
      expect(results[0]).toMatchObject({
        block: true,
        reason: expect.stringContaining("without satisfied plan evidence"),
      });
      expect((await readGovernanceState(rootDir, workId)).evidence).toEqual([]);

      const governanceTool = tools.get("ged_governance");
      if (!governanceTool) throw new Error("ged_governance missing");
      await governanceTool.execute(
        "accept-plan",
        { action: "accept-plan", summary: "Accepted plan" },
        undefined,
        undefined,
        ctx,
      );
      for (const handler of handlers.get("tool_call") ?? []) {
        expect(
          await handler(
            {
              type: "tool_call",
              toolCallId: "implemented-source",
              toolName: "write",
              input: { path: "src/index.ts" },
            },
            ctx,
          ),
        ).toBeUndefined();
      }
      await mkdir(path.join(rootDir, "src"), { recursive: true });
      await writeFile(path.join(rootDir, "src", "index.ts"), "export {};\n");
      for (const handler of handlers.get("tool_result") ?? []) {
        await handler(
          {
            type: "tool_result",
            toolCallId: "implemented-source",
            toolName: "write",
            input: { path: "src/index.ts" },
            content: [],
            isError: false,
          },
          ctx,
        );
      }
      execSync("git add src/index.ts", { cwd: rootDir });
      await governanceTool.execute(
        "record-verification",
        {
          action: "record-verification",
          summary: "Checks passed",
          checks: [
            { command: process.execPath, args: ["-e", "process.exit(0)"] },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      for (const handler of handlers.get("tool_call") ?? []) {
        expect(
          await handler(
            {
              type: "tool_call",
              toolCallId: "successful-commit",
              toolName: "bash",
              input: { command: 'git commit -m "verified"' },
            },
            ctx,
          ),
        ).toBeUndefined();
      }
      execSync('git commit -m "verified"', { cwd: rootDir });
      for (const handler of handlers.get("tool_result") ?? []) {
        await handler(
          {
            type: "tool_result",
            toolCallId: "successful-commit",
            toolName: "bash",
            input: { command: 'git commit -m "verified"' },
            content: [],
            isError: false,
          },
          ctx,
        );
      }
      expect((await readGovernanceState(rootDir, workId)).lifecycle).toBe(
        "active",
      );
      expect(JSON.parse(await readFile(paths.checkpointsPath, "utf8"))).toEqual(
        legacyState,
      );
    }
  });
});
