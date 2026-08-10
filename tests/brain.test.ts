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
  initCheckpointState,
  readCheckpointState,
  writeCheckpointState,
} from "../src/orchestration.js";

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
    const state = await readFile(
      path.join(rootDir, ".ged", "runtime", "root", "STATE.md"),
      "utf8",
    );

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

    expect(prompt).toContain("GedPi Single-Brain Mode");
    expect(prompt).toContain("grill-me: needed");
    expect(prompt).toContain("grill-me: skipped; reason:");
    expect(prompt).toContain("grill-with-docs");
    expect(prompt).toContain(
      "Do not dispatch ged-planner before this first-pass clarification/sufficiency check",
    );
    expect(prompt).toContain("synthesize the clarification evidence");
    expect(prompt).toContain("skill-fit reconnaissance");
    expect(prompt).toContain(
      "Ask the explorer to inventory available bundled/project/user skills",
    );
    expect(prompt).toContain("make any main-agent skill decisions");
    expect(prompt).toContain(
      "Do not end the turn after only describing the next step",
    );
    expect(prompt).toContain("make that tool call in the same response");
    expect(prompt).toContain("workflowScript");
    expect(prompt).toContain("runs.run");
    expect(prompt).toContain("async: false");
    expect(prompt).toContain("subagent_wait");
    expect(prompt).toContain("outputSchema");
    expect(prompt).toContain("outcome");
    expect(prompt).toContain("findings");
    expect(prompt).toContain("ged-planner");
    expect(prompt).toContain("criteria");
    expect(prompt).toContain("evidence");
    expect(prompt).toContain("verify");
    expect(prompt).toContain("stopRules");
    expect(prompt).not.toContain("maxFinalizationTurns");
    expect(prompt).toContain("turnBudget");
    expect(prompt).toContain("## Plan Review Preference");
    expect(prompt).toContain(
      "Current setting: Review with Plannotator (plannotator)",
    );
    expect(prompt).toContain("gedpi_plan_review");
    expect(prompt).toContain("fall back to chat approval");
    expect(prompt).toContain("ged-planner authors the plan draft");
    expect(prompt).toContain(
      "Source edits are not safe until you have accepted/written the final plan",
    );
    expect(prompt).toContain("## Commit Preference");
    expect(prompt).toContain("Current setting: ask");
    expect(prompt).toContain("ask the user whether to commit");
    expect(prompt).toContain("search the ecosystem with `npx skills find`");
    expect(prompt).not.toContain("interview tool");
    expect(prompt).toContain(
      "treat direct user instructions as requested Ged app/product behavior by default",
    );
    expect(prompt).toContain(".ged/work/root/TASKS.md");
    expect(prompt).toContain("Run onboarding clarification");
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

    test("returns nudge for root work-id", () => {
      const nudge = buildBranchNudge("root");
      expect(nudge).toContain("## ⚠️ Branch Hygiene");
      expect(nudge).toContain("No named Git branch");
      expect(nudge).toContain("`root` work namespace");
      expect(nudge).not.toContain("feature branch");
    });

    test("returns empty string for feature branches", () => {
      expect(buildBranchNudge("feat-foo")).toBe("");
      expect(buildBranchNudge("fix-bar")).toBe("");
      expect(buildBranchNudge("chore/update-deps")).toBe("");
      expect(buildBranchNudge("feature/my-cool-thing")).toBe("");
    });

    test("returns empty string for empty work-id", () => {
      expect(buildBranchNudge("")).toBe("");
    });

    test("TRUNK_BRANCHES contains expected values", () => {
      expect(TRUNK_BRANCHES.has("main")).toBe(true);
      expect(TRUNK_BRANCHES.has("master")).toBe(true);
      expect(TRUNK_BRANCHES.has("root")).toBe(true);
      expect(TRUNK_BRANCHES.size).toBe(3);
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
    expect(prompt).toContain("`root` work namespace");
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
    expect(beforeStart.systemPrompt).toContain("use grill-me in chat");
    expect(beforeStart.systemPrompt).toContain("worker-suitability check");
    expect(beforeStart.systemPrompt).toContain(
      "fix accepted verifier findings directly by default",
    );
    expect(beforeStart.systemPrompt).toContain("## Plan Review Preference");
    expect(beforeStart.systemPrompt).toContain(
      "Review with Plannotator (plannotator)",
    );
    expect(beforeStart.systemPrompt).not.toContain("interview tool");
  });

  test("gedCoreExtension records subagent checkpoints only after completed results", async () => {
    const rootDir = await createTempProject("ged-brain-subagent-results-");
    await enableProjectSubagents(rootDir);
    await writeCheckpointState(
      rootDir,
      initCheckpointState("non-trivial", "test subagent result recording"),
    );
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const runHandler = async (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    };

    await gedCoreExtension({
      registerMessageRenderer() {
        return undefined;
      },
      registerCommand() {},
      registerShortcut() {},
      registerTool() {},
      sendMessage() {},
      events: {
        on(event: string, handler: (...args: unknown[]) => unknown) {
          eventHandlers.set(event, handler);
        },
      },
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as never);

    await runHandler(
      "session_start",
      { type: "session_start" },
      {
        cwd: rootDir,
        ui: {
          setTitle() {},
          setTheme() {},
          setHeader() {},
          notify() {},
          setStatus() {},
        },
      },
    );

    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent",
        isError: false,
        input: { agent: "ged-planner", async: true },
        details: { mode: "single", asyncId: "async-1", results: [] },
      },
      { cwd: rootDir },
    );
    expect(
      (await readCheckpointState(rootDir))?.planCheckpoints["ged-planner"],
    ).toBeUndefined();

    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent",
        isError: false,
        input: { workflowScript: "return runs.run('verify', {})" },
        details: {
          mode: "workflow",
          results: [
            {
              agent: "ged-verifier",
              exitCode: 0,
              acceptance: { status: "rejected" },
            },
          ],
        },
      },
      { cwd: rootDir },
    );
    expect(
      (await readCheckpointState(rootDir))?.taskCheckpoints.auto?.[
        "ged-verifier"
      ],
    ).toBeUndefined();

    for (const childResult of [
      { agent: "ged-verifier", exitCode: 0 },
      {
        agent: "ged-verifier",
        exitCode: 0,
        acceptance: { status: "review-required" },
        structuredOutput: { outcome: "clean", findings: [] },
      },
      {
        agent: "ged-verifier",
        exitCode: 0,
        acceptance: { status: "not-required" },
        structuredOutput: {
          outcome: "findings",
          findings: [{ severity: "blocker", issue: "Broken behavior" }],
        },
      },
    ]) {
      await runHandler(
        "tool_result",
        {
          type: "tool_result",
          toolName: "subagent",
          isError: false,
          input: { workflowScript: "return runs.run('verify', {})" },
          details: { mode: "workflow", results: [childResult] },
        },
        { cwd: rootDir },
      );
    }
    expect(
      (await readCheckpointState(rootDir))?.taskCheckpoints.auto?.[
        "ged-verifier"
      ],
    ).toBeUndefined();

    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent",
        isError: false,
        input: { workflowScript: "return runs.run('verify', {})" },
        details: {
          mode: "workflow",
          results: [
            {
              agent: "ged-verifier",
              exitCode: 0,
              acceptance: { status: "not-required" },
              structuredOutput: { outcome: "clean", findings: [] },
            },
          ],
        },
      },
      { cwd: rootDir },
    );
    expect(
      (await readCheckpointState(rootDir))?.taskCheckpoints.auto?.[
        "ged-verifier"
      ],
    ).toMatchObject({
      status: "completed",
      verifierOutcome: "clean",
    });

    for (const childResult of [
      { agent: "ged-planner", exitCode: 0, progress: { status: "running" } },
      { agent: "ged-planner", exitCode: 0, status: "pending" },
      { agent: "ged-planner", exitCode: 0, state: "paused" },
    ]) {
      await runHandler(
        "tool_result",
        {
          type: "tool_result",
          toolName: "subagent",
          isError: false,
          input: { agent: "ged-planner" },
          details: {
            mode: "single",
            results: [childResult],
          },
        },
        { cwd: rootDir },
      );
    }
    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent",
        isError: false,
        input: { agent: "ged-planner" },
        details: {
          mode: "single",
          results: [{ agent: "ged-planner", exitCode: 0, detached: true }],
        },
      },
      { cwd: rootDir },
    );
    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent",
        isError: false,
        input: { agent: "ged-planner" },
        details: {
          mode: "single",
          results: [{ agent: "ged-planner", exitCode: 0, interrupted: true }],
        },
      },
      { cwd: rootDir },
    );
    expect(
      (await readCheckpointState(rootDir))?.planCheckpoints["ged-planner"],
    ).toBeUndefined();

    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent",
        isError: false,
        input: { agent: "ged-planner" },
        details: {
          mode: "single",
          results: [{ agent: "ged-planner", exitCode: 0 }],
        },
      },
      { cwd: rootDir },
    );
    expect(
      (await readCheckpointState(rootDir))?.planCheckpoints["ged-planner"]
        ?.source,
    ).toBe("auto");

    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent",
        isError: false,
        input: { tasks: [{ agent: "ged-worker" }, { agent: "ged-worker" }] },
        details: {
          mode: "parallel",
          runId: "parallel-run",
          results: [
            {
              agent: "ged-worker",
              exitCode: 0,
              runId: "worker-1",
              sliceId: "T01a",
              artifactPath: ".pi/subagents/worker-1/output.md",
              artifactPaths: { diffPath: ".pi/subagents/worker-1/diff.patch" },
              sessionFile: ".pi/sessions/worker-1.jsonl",
              worktreePath: "/tmp/worktree-1",
              worktree: true,
            },
            {
              agent: "ged-worker",
              exitCode: 0,
              runId: "worker-2",
              sliceId: "T01b",
            },
          ],
        },
      },
      { cwd: rootDir },
    );

    const workerState = await readCheckpointState(rootDir);
    expect(workerState?.workerRuns).toHaveLength(2);
    expect(workerState?.workerRuns?.[0]).toMatchObject({
      agent: "ged-worker",
      source: "auto",
      runId: "worker-1",
      sliceId: "T01a",
      diffPath: ".pi/subagents/worker-1/diff.patch",
      sessionPath: ".pi/sessions/worker-1.jsonl",
      worktree: true,
      sourceMode: "foreground",
    });

    await runHandler(
      "tool_result",
      {
        type: "tool_result",
        toolName: "subagent_wait",
        isError: false,
        input: { id: "waited-run" },
        details: {
          completions: [
            {
              runId: "waited-run",
              mode: "workflow",
              state: "complete",
              success: true,
              results: [
                {
                  agent: "ged-worker",
                  runId: "worker-waited",
                  success: true,
                  artifactPaths: {
                    outputPath: ".pi/subagents/worker-waited/output.md",
                  },
                },
              ],
            },
          ],
        },
      },
      { cwd: rootDir },
    );
    const waitedState = await readCheckpointState(rootDir);
    expect(waitedState?.workerRuns).toHaveLength(3);
    expect(waitedState?.workerRuns?.[2]).toMatchObject({
      runId: "worker-waited",
      artifactPath: ".pi/subagents/worker-waited/output.md",
      sourceMode: "async",
    });

    eventHandlers.get("subagent:async-complete")?.({
      mode: "single",
      agent: "ged-worker",
      success: true,
      runId: "async-run",
      asyncId: "async-run",
      sliceId: "T01c",
      artifactPath: ".pi/subagents/worker-async/output.md",
    });
    let asyncState = await readCheckpointState(rootDir);
    for (
      let attempt = 0;
      attempt < 20 && asyncState?.workerRuns?.length !== 4;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      asyncState = await readCheckpointState(rootDir);
    }
    expect(asyncState?.workerRuns).toHaveLength(4);
    expect(asyncState?.workerRuns?.[3]).toMatchObject({
      runId: "async-run",
      sliceId: "T01c",
      sourceMode: "async",
    });
  });

  test("gedCoreExtension explorer-first guard gives immediate recovery steps", async () => {
    const rootDir = await createTempProject("ged-brain-guard-");
    await enableProjectSubagents(rootDir);
    await mkdir(path.join(rootDir, ".ged", "runtime", "root"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, ".ged", "runtime", "root", "checkpoints.json"),
      JSON.stringify({
        schemaVersion: 3,
        lifecycleStatus: "active",
        classification: "non-trivial",
        classificationReason: "test",
        planCheckpoints: {
          clarification: {
            status: "skipped",
            sufficiency: "sufficient-from-request",
            skipReason: "test",
          },
        },
        taskCheckpoints: {},
      }),
    );
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const messages: Array<{ content?: string }> = [];

    await gedCoreExtension({
      registerMessageRenderer() {
        return undefined;
      },
      registerCommand() {},
      registerShortcut() {},
      registerTool() {},
      sendMessage(message: { content?: string }) {
        messages.push(message);
      },
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
    } as never);

    await handlers.get("session_start")?.(
      { type: "session_start" },
      {
        cwd: rootDir,
        ui: {
          setTitle() {},
          setTheme() {},
          setHeader() {},
          notify() {},
          setStatus() {},
        },
      },
    );

    const result = (await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: "src/index.ts" } },
      { cwd: rootDir },
    )) as { block: boolean; reason: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("dispatch ged-explorer with subagent now");
    expect(result.reason).toContain("wait for the result");
    expect(result.reason).toContain("then continue");
    expect(messages.at(-1)?.content).toContain("subagent tool");

    const gedWrite = await handlers.get("tool_call")?.(
      {
        toolName: "write",
        input: { path: ".ged/runtime/root/checkpoints.json" },
      },
      { cwd: rootDir },
    );
    expect(gedWrite).toBeUndefined();

    const bashBypass = (await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: "git status; cat src/index.ts" } },
      { cwd: rootDir },
    )) as { block: boolean; reason: string };
    expect(bashBypass.block).toBe(true);
  });

  test("gedCoreExtension guards stay inert when subagents are disabled", async () => {
    const rootDir = await createTempProject("ged-brain-solo-guard-");
    // Note: subagents NOT enabled (default). A non-trivial checkpoint that would
    // normally block must be ignored entirely so the solo workflow never demands
    // ged-explorer/ged-planner/ged-verifier dispatches.
    await mkdir(path.join(rootDir, ".ged", "runtime", "root"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, ".ged", "runtime", "root", "checkpoints.json"),
      JSON.stringify({
        schemaVersion: 3,
        lifecycleStatus: "active",
        classification: "non-trivial",
        classificationReason: "test",
        planCheckpoints: {},
        taskCheckpoints: {},
      }),
    );
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

    // Source inspection must not be blocked.
    const read = await handlers.get("tool_call")?.(
      { toolName: "read", input: { path: "src/index.ts" } },
      { cwd: rootDir },
    );
    expect(read).toBeUndefined();

    // Source edits must not be blocked.
    const write = await handlers.get("tool_call")?.(
      { toolName: "write", input: { path: "src/index.ts" } },
      { cwd: rootDir },
    );
    expect(write).toBeUndefined();

    // Commits must not be blocked.
    const commit = await handlers.get("tool_call")?.(
      { toolName: "bash", input: { command: 'git commit -m "test"' } },
      { cwd: rootDir },
    );
    expect(commit).toBeUndefined();
  });
});
