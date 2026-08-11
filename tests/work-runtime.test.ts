import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  activeGedPaths,
  activeWorkPointerPath,
  openGedWork,
  readActiveWorkPointer,
} from "../src/ged-paths.js";
import { resolveGovernance } from "../src/governance.js";
import {
  initializeGovernanceState,
  readGovernanceState,
} from "../src/governance-store.js";
import { registerGedWorkRuntime } from "../src/work-runtime.js";

type Handler = (event: Record<string, unknown>, ctx: TestContext) => unknown;

interface TestContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

interface TestTool {
  name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    ctx: TestContext,
  ): Promise<{ details?: Record<string, unknown> }>;
}

function runtimeHarness(requestIds: string[]) {
  const handlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Array<(payload: unknown) => unknown>>();
  const tools = new Map<string, TestTool>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: TestTool) {
      tools.set(tool.name, tool);
    },
    events: {
      on(event: string, handler: (payload: unknown) => unknown) {
        eventHandlers.set(event, [
          ...(eventHandlers.get(event) ?? []),
          handler,
        ]);
        return () => {};
      },
    },
  } as unknown as ExtensionAPI;

  registerGedWorkRuntime(api, {
    createRequestId() {
      const next = requestIds.shift();
      if (!next) throw new Error("Missing test request ID");
      return next;
    },
  });

  return {
    handlers,
    async emit(
      event: string,
      payload: Record<string, unknown>,
      ctx: TestContext,
    ) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
    execute(
      name: "ged_work" | "ged_governance" | "ged_lifecycle",
      params: Record<string, unknown>,
      ctx: TestContext,
      id = `${name}-call`,
    ) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`${name} was not registered`);
      return tool.execute(id, params, undefined, undefined, ctx);
    },
    async emitEvent(event: string, payload: unknown) {
      for (const handler of eventHandlers.get(event) ?? []) {
        await handler(payload);
      }
    },
  };
}

function context(rootDir: string, sessionId = "session-a"): TestContext {
  return {
    cwd: rootDir,
    sessionManager: { getSessionId: () => sessionId },
  };
}

async function initializeGit(rootDir: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main"], { cwd: rootDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: rootDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: rootDir });
  await writeFile(path.join(rootDir, "README.md"), "initial\n");
  execFileSync("git", ["add", "README.md"], { cwd: rootDir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: rootDir });
}

const directOpen = (summary = "Direct task") => ({
  action: "open",
  summary,
  minimumMode: "direct-change",
  ambiguity: "sufficient",
  risk: "low",
  clearScope: true,
  bounded: true,
  reversible: true,
  deterministicCheck: true,
  executionProfile: "solo",
});

const plannedOpen = (summary = "Planned task") => ({
  ...directOpen(summary),
  minimumMode: "planned-change",
  risk: "normal",
  executionProfile: "coordinated",
});

const verificationParams = (summary: string) => ({
  action: "record-verification",
  summary,
  checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
});

async function startRequest(
  runtime: ReturnType<typeof runtimeHarness>,
  ctx: TestContext,
) {
  await runtime.emit("session_start", { type: "session_start" }, ctx);
  return runtime.emit(
    "before_agent_start",
    { type: "before_agent_start", systemPrompt: "base" },
    ctx,
  );
}

async function successfulWrite(
  runtime: ReturnType<typeof runtimeHarness>,
  ctx: TestContext,
  toolCallId: string,
  filePath: string,
  toolName: "write" | "edit" = "write",
) {
  const preflight = await runtime.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId,
      toolName,
      input: { path: filePath },
    },
    ctx,
  );
  expect(preflight).toEqual([undefined]);
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.cwd, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${toolCallId}\n`);
  await runtime.emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId,
      toolName,
      input: { path: filePath },
      content: [],
      isError: false,
    },
    ctx,
  );
}

describe("Ged governance runtime", () => {
  it("blocks unisolated parallel writer workflowScript dispatches", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-staffing-guard-"),
    );
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const blocked = (
      await runtime.emit(
        "tool_call",
        {
          type: "tool_call",
          toolCallId: "parallel-writers",
          toolName: "subagent",
          input: {
            workflowScript: `return runs.all([
              { key: "a", agent: "ged-worker", task: "A" },
              { key: "b", agent: "ged-smart-worker", task: "B" }
            ]);`,
          },
        },
        ctx,
      )
    )[0];
    expect(blocked).toMatchObject({
      block: true,
      reason: expect.stringContaining("blocks parallel writers"),
    });

    const isolated = (
      await runtime.emit(
        "tool_call",
        {
          type: "tool_call",
          toolCallId: "isolated-writers",
          toolName: "subagent",
          input: {
            worktree: true,
            workflowScript: `return runs.all([
              { key: "a", agent: "ged-worker", task: "A" },
              { key: "b", agent: "ged-worker", task: "B" }
            ]);`,
          },
        },
        ctx,
      )
    )[0];
    expect(isolated).toMatchObject({
      block: true,
      reason: expect.stringContaining("not bound"),
    });
  });

  it("holds one current-checkout writer lease through async completion", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-writer-lease-"));
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;
    const independent = runtimeHarness(["request-b"]);
    const independentCtx = context(rootDir, "session-b");
    await startRequest(independent, independentCtx);
    await independent.execute(
      "ged_work",
      directOpen("Independent work item"),
      independentCtx,
    );
    const writerInput = {
      workflowScript:
        'return runs.run("implementation", { agent: "ged-worker", task: "Implement the slice" });',
    };
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "writer-one",
            toolName: "subagent",
            input: writerInput,
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    const asyncDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-writer-async-run-"),
    );
    await writeFile(
      path.join(asyncDir, "status.json"),
      JSON.stringify({ runId: "writer-run-1", state: "running" }),
    );
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "writer-one",
        toolName: "subagent",
        input: writerInput,
        content: [],
        details: { mode: "async", asyncId: "writer-run-1", asyncDir },
        isError: false,
      },
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "writer-two",
            toolName: "subagent",
            input: writerInput,
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("another writer"),
    });

    expect(
      (
        await independent.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "independent-writer",
            toolName: "subagent",
            input: writerInput,
          },
          independentCtx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("checkout writer lease"),
    });

    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "src", "worker.ts"), "worker\n");
    await runtime.emitEvent("subagent:async-complete", {
      runId: "writer-run-1",
      success: true,
      state: "complete",
    });
    const state = await readGovernanceState(rootDir, workId);
    expect(state.pendingMutations).toEqual([]);
    expect(
      state.evidence.find((entry) => entry.kind === "implementation")?.binding,
    ).toMatchObject({ changedPaths: ["src/worker.ts"] });

    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "writer-three",
            toolName: "subagent",
            input: writerInput,
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "writer-three",
        toolName: "subagent",
        input: writerInput,
        content: [],
        details: { mode: "foreground" },
        isError: false,
      },
      ctx,
    );
  });

  it("reconciles terminal writer mutation evidence after runtime restart", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-writer-restart-"),
    );
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;
    const input = {
      workflowScript:
        'return runs.run("implementation", { agent: "ged-worker", task: "Implement" });',
    };
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "restart-writer",
            toolName: "subagent",
            input,
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    const asyncDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-writer-restart-run-"),
    );
    const statusPath = path.join(asyncDir, "status.json");
    await writeFile(
      statusPath,
      JSON.stringify({ runId: "restart-run", state: "running" }),
    );
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "restart-writer",
        toolName: "subagent",
        input,
        content: [],
        details: { mode: "async", asyncId: "restart-run", asyncDir },
        isError: false,
      },
      ctx,
    );
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "src", "restart.ts"), "restart\n");
    await writeFile(
      statusPath,
      JSON.stringify({ runId: "restart-run", state: "complete" }),
    );

    const restarted = runtimeHarness(["request-b"]);
    await startRequest(restarted, context(rootDir, "session-b"));
    const state = await readGovernanceState(rootDir, workId);
    expect(state.pendingMutations).toEqual([]);
    expect(
      state.evidence.find((entry) => entry.kind === "implementation")?.binding,
    ).toMatchObject({ changedPaths: ["src/restart.ts"] });
    await expect(
      readFile(
        path.join(
          rootDir,
          ".ged",
          "runtime",
          "checkout-writer-lease",
          "lease.json",
        ),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("rejects incomplete or unresolved open evidence before request binding", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-open-"));
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-open"]);
    await startRequest(runtime, ctx);

    await expect(
      runtime.execute(
        "ged_work",
        { action: "open", summary: "Incomplete" },
        ctx,
      ),
    ).rejects.toThrow("requires minimumMode");
    await expect(
      runtime.execute(
        "ged_work",
        { ...directOpen("Unresolved"), ambiguity: "decision-needed" },
        ctx,
      ),
    ).rejects.toThrow("user-owned decision remains unresolved");
    expect(await readActiveWorkPointer(rootDir, "session-a")).toMatchObject({
      operation: "bootstrap",
      requestId: null,
    });
  });

  it("opens governed work, tracks successful writes, and requires fresh verification", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-runtime-"));
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-1", "request-2"]);

    const prompt = await startRequest(runtime, ctx);
    expect(prompt[0]).toMatchObject({
      systemPrompt: expect.stringContaining("structured ambiguity"),
    });
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "read-only-bash",
            toolName: "bash",
            input: { command: "pwd" },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "mutating-bash-before-open",
            toolName: "bash",
            input: { command: "echo changed > file.txt" },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({ block: true });
    expect(
      await runtime.emit(
        "tool_call",
        {
          type: "tool_call",
          toolCallId: "blocked-before-open",
          toolName: "write",
          input: { path: "src/a.ts" },
        },
        ctx,
      ),
    ).toEqual([expect.objectContaining({ block: true })]);

    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;
    expect(await readGovernanceState(rootDir, workId)).toMatchObject({
      workId,
      revision: 0,
      decision: { mode: "direct-change" },
      executionProfile: "solo",
      lifecycle: "active",
      contentBaseline: {
        version: 1,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(await readActiveWorkPointer(rootDir, "session-a")).toMatchObject({
      workId,
      operation: "open",
      requestId: "request-1",
    });

    const pending = await runtime.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "write-a",
        toolName: "write",
        input: { path: "src/a.ts" },
      },
      ctx,
    );
    expect(pending).toEqual([undefined]);
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "commit-pending",
            toolName: "bash",
            input: { command: 'git commit -m "pending"' },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("pending durable completion"),
    });
    expect(await readGovernanceState(rootDir, workId)).toMatchObject({
      pendingMutations: [
        expect.objectContaining({
          requestId: "request-1",
          toolCallId: "write-a",
        }),
      ],
    });
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "src", "a.ts"), "write-a\n");
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "write-a",
        toolName: "write",
        input: { path: "src/a.ts" },
        content: [],
        isError: false,
      },
      ctx,
    );
    let state = await readGovernanceState(rootDir, workId);
    expect(state.evidence).toEqual([
      expect.objectContaining({
        kind: "implementation",
        source: "runtime",
        outcome: "observed",
      }),
    ]);

    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "commit-unverified",
            toolName: "bash",
            input: { command: 'git commit -m "unverified"' },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("verification"),
    });

    execFileSync("git", ["add", "src/a.ts"], { cwd: rootDir });
    await runtime.execute(
      "ged_governance",
      verificationParams("Focused checks passed"),
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "commit-verified",
            toolName: "bash",
            input: { command: 'git commit -m "verified"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "commit-verified",
        toolName: "bash",
        input: { command: 'git commit -m "verified"' },
        content: [],
        isError: false,
      },
      ctx,
    );
    state = await readGovernanceState(rootDir, workId);
    expect(state.lifecycle).toBe("active");
    expect(state.lifecycleTransitions).toEqual([]);

    await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "stale-request",
            toolName: "edit",
            input: { path: "src/a.ts" },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({ block: true });
    await runtime.execute(
      "ged_work",
      { action: "continue", workId },
      ctx,
      "continue-call",
    );
  });

  it("pauses, resumes, and explicitly completes exact work", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-lifecycle-"));
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-1", "request-2", "request-3"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute(
      "ged_work",
      directOpen("Lifecycle task"),
      ctx,
    );
    const workId = opened.details?.workId as string;

    const paused = await runtime.execute(
      "ged_lifecycle",
      { action: "pause", workId, reason: "Pause between sessions" },
      ctx,
    );
    expect(paused.details).toMatchObject({
      workId,
      from: "active",
      to: "paused",
    });
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "paused-write",
            toolName: "write",
            input: { path: "src/a.ts" },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("lifecycle paused"),
    });

    await startRequest(runtime, ctx);
    const resumed = await runtime.execute(
      "ged_lifecycle",
      { action: "resume", workId, reason: "Continue the same task" },
      ctx,
    );
    expect(resumed.details).toMatchObject({ from: "paused", to: "active" });
    await runtime.execute("ged_work", { action: "continue", workId }, ctx);
    await successfulWrite(runtime, ctx, "lifecycle-write", "src/a.ts");
    await expect(
      runtime.execute(
        "ged_lifecycle",
        { action: "complete", workId, reason: "Implementation finished" },
        ctx,
      ),
    ).rejects.toThrow("without content-bound verification");
    await runtime.execute(
      "ged_governance",
      verificationParams("All checks passed"),
      ctx,
    );
    await writeFile(path.join(rootDir, "src", "a.ts"), "completion drift\n");
    await expect(
      runtime.execute(
        "ged_lifecycle",
        { action: "complete", workId, reason: "Drifted completion" },
        ctx,
      ),
    ).rejects.toThrow("differs from verification");
    await writeFile(path.join(rootDir, "src", "a.ts"), "lifecycle-write\n");
    const completed = await runtime.execute(
      "ged_lifecycle",
      { action: "complete", workId, reason: "Verified work is complete" },
      ctx,
    );
    expect(completed.details).toMatchObject({
      from: "active",
      to: "completed",
    });
    expect(await readGovernanceState(rootDir, workId)).toMatchObject({
      lifecycle: "completed",
      lifecycleTransitions: [
        expect.objectContaining({ from: "active", to: "paused" }),
        expect.objectContaining({ from: "paused", to: "active" }),
        expect.objectContaining({ from: "active", to: "completed" }),
      ],
    });

    await startRequest(runtime, ctx);
    await expect(
      runtime.execute("ged_work", { action: "continue", workId }, ctx),
    ).rejects.toThrow("lifecycle completed");
    await expect(
      runtime.execute(
        "ged_lifecycle",
        { action: "resume", workId, reason: "Terminal work cannot reopen" },
        ctx,
      ),
    ).rejects.toThrow("invalid from completed");
  });

  it("allows planned artifacts before acceptance and source writes only after acceptance", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-planned-"));
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", plannedOpen(), ctx);
    const workId = opened.details?.workId as string;
    const paths = await activeGedPaths(rootDir, "session-a");

    await successfulWrite(runtime, ctx, "plan-write", paths.specPath);
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "source-before-plan",
            toolName: "write",
            input: { path: "src/a.ts" },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("without satisfied plan evidence"),
    });

    await runtime.execute(
      "ged_governance",
      {
        action: "accept-plan",
        summary: "Coordinator accepted SPEC/TASKS/TESTS",
      },
      ctx,
    );
    await successfulWrite(runtime, ctx, "source-after-plan", "src/a.ts");
    execFileSync("git", ["add", "src/a.ts"], { cwd: rootDir });
    await runtime.execute(
      "ged_governance",
      verificationParams("All planned checks passed"),
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "planned-commit",
            toolName: "bash",
            input: { command: 'git commit -m "planned"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    expect((await readGovernanceState(rootDir, workId)).evidence).toHaveLength(
      4,
    );
  });

  it("records implementation only after successful write results", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-failed-"));
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;

    await runtime.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "failed-write",
        toolName: "write",
        input: { path: "src/a.ts" },
      },
      ctx,
    );
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "failed-write",
        toolName: "write",
        input: { path: "src/a.ts" },
        content: [],
        isError: true,
      },
      ctx,
    );
    expect(await readGovernanceState(rootDir, workId)).toMatchObject({
      evidence: [],
      pendingMutations: [],
    });

    await successfulWrite(runtime, ctx, "successful-edit", "src/a.ts", "edit");
    const evidence = (await readGovernanceState(rootDir, workId)).evidence;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      kind: "implementation",
      outcome: "observed",
    });
  });

  it("protects runtime-owned and out-of-scope Ged paths", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-paths-"));
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", plannedOpen(), ctx);
    const workId = opened.details?.workId as string;
    const paths = await activeGedPaths(rootDir, "session-a");

    for (const [index, filePath] of [
      paths.governancePath,
      activeWorkPointerPath(rootDir, "session-a"),
      paths.metaPath,
      path.join(
        paths.workDir,
        "..",
        "..",
        "runtime",
        workId,
        "governance.json",
      ),
      path.join(rootDir, ".ged", "work", "another", "SPEC.md"),
    ].entries()) {
      expect(
        (
          await runtime.emit(
            "tool_call",
            {
              type: "tool_call",
              toolCallId: `protected-${index}`,
              toolName: "write",
              input: { path: filePath },
            },
            ctx,
          )
        )[0],
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining("runtime-owned"),
      });
    }

    await mkdir(path.join(rootDir, "src"), { recursive: true });
    const sourceAlias = path.join(rootDir, "src", "governance-alias.json");
    await symlink(paths.governancePath, sourceAlias);
    await rm(paths.notesPath);
    await symlink(paths.governancePath, paths.notesPath);
    for (const [index, filePath] of [sourceAlias, paths.notesPath].entries()) {
      expect(
        (
          await runtime.emit(
            "tool_call",
            {
              type: "tool_call",
              toolCallId: `symlink-${index}`,
              toolName: "write",
              input: { path: filePath },
            },
            ctx,
          )
        )[0],
      ).toMatchObject({
        block: true,
        reason: expect.stringContaining("runtime-owned"),
      });
    }
  });

  it("protects governance when the runtime directory resolves outside the repository", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-root-"));
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;
    const governancePath = (await activeGedPaths(rootDir, "session-a"))
      .governancePath;
    const runtimeDir = path.join(rootDir, ".ged", "runtime");
    const externalParent = await mkdtemp(
      path.join(os.tmpdir(), "ged-work-external-runtime-"),
    );
    const externalRuntime = path.join(externalParent, "runtime");
    await rename(runtimeDir, externalRuntime);
    await symlink(externalRuntime, runtimeDir);

    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "external-ged-governance",
            toolName: "write",
            input: { path: governancePath },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("runtime-owned"),
    });
    expect((await readGovernanceState(rootDir, workId)).workId).toBe(workId);
  });

  it("keeps unfinished mutations durably commit-blocking across runtime restart", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-pending-"));
    const ctx = context(rootDir);
    const firstRuntime = runtimeHarness(["request-first"]);
    await startRequest(firstRuntime, ctx);
    const opened = await firstRuntime.execute(
      "ged_work",
      directOpen("Durable pending mutation"),
      ctx,
    );
    const workId = opened.details?.workId as string;
    await firstRuntime.execute(
      "ged_governance",
      verificationParams("Pre-write checks passed"),
      ctx,
    );
    expect(
      (
        await firstRuntime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "unfinished-write",
            toolName: "write",
            input: { path: "src/a.ts" },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();

    const restartedRuntime = runtimeHarness(["request-after-restart"]);
    await startRequest(restartedRuntime, ctx);
    await restartedRuntime.execute(
      "ged_work",
      { action: "continue", workId },
      ctx,
    );
    expect(
      (
        await restartedRuntime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "commit-after-restart",
            toolName: "bash",
            input: { command: 'git commit -m "stale"' },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("pending durable completion evidence"),
    });
  });

  it("rejects continue for missing, malformed, read-only, unresolved, and non-active governance", async () => {
    const cases = [
      "missing",
      "malformed",
      "unbound-content",
      "read-only",
      "unresolved",
      "paused",
      "completed",
      "abandoned",
      "superseded",
    ] as const;
    for (const value of cases) {
      const rootDir = await mkdtemp(
        path.join(os.tmpdir(), `ged-continue-${value}-`),
      );
      const ctx = context(rootDir);
      const opened = await openGedWork(
        rootDir,
        { sessionId: "setup", requestId: "setup" },
        `${value} work`,
      );
      if (value === "malformed") {
        await writeFile(opened.paths.governancePath, "not-json\n");
      } else if (value !== "missing") {
        const decision =
          value === "read-only"
            ? resolveGovernance({
                intent: { mutation: "none" },
                ambiguity: "sufficient",
                risk: "low",
              })
            : resolveGovernance({
                intent: {
                  mutation: "requested",
                  minimumMode: "planned-change",
                },
                ambiguity:
                  value === "unresolved" ? "decision-needed" : "sufficient",
                risk: "normal",
                change: {
                  clearScope: true,
                  bounded: true,
                  reversible: true,
                  deterministicCheck: true,
                },
              });
        await initializeGovernanceState(rootDir, opened.workId, {
          decision,
          executionProfile: "solo",
          lifecycle:
            value === "read-only" ||
            value === "unresolved" ||
            value === "unbound-content"
              ? "active"
              : value,
        });
      }

      const runtime = runtimeHarness([`request-${value}`]);
      await startRequest(runtime, ctx);
      await expect(
        runtime.execute(
          "ged_work",
          { action: "continue", workId: opened.workId },
          ctx,
        ),
      ).rejects.toThrow();
      expect(
        (
          await runtime.emit(
            "tool_call",
            {
              type: "tool_call",
              toolCallId: `blocked-${value}`,
              toolName: "write",
              input: { path: "src/a.ts" },
            },
            ctx,
          )
        )[0],
      ).toMatchObject({ block: true });
    }
  });

  it("keeps interleaved session request state independent", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-sessions-"));
    const sessionA = context(rootDir, "session-a");
    const sessionB = context(rootDir, "session-b");
    const runtime = runtimeHarness(["request-a", "request-b"]);

    await startRequest(runtime, sessionA);
    const openedA = await runtime.execute(
      "ged_work",
      directOpen("Task A"),
      sessionA,
    );
    await startRequest(runtime, sessionB);
    const openedB = await runtime.execute(
      "ged_work",
      plannedOpen("Task B"),
      sessionB,
    );

    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "session-a-write",
            toolName: "write",
            input: { path: "src/a.ts" },
          },
          sessionA,
        )
      )[0],
    ).toBeUndefined();
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "session-b-write",
            toolName: "write",
            input: { path: "src/b.ts" },
          },
          sessionB,
        )
      )[0],
    ).toMatchObject({ block: true });
    expect((await activeGedPaths(rootDir, "session-a")).workId).toBe(
      openedA.details?.workId,
    );
    expect((await activeGedPaths(rootDir, "session-b")).workId).toBe(
      openedB.details?.workId,
    );
  });

  it("binds accepted plans and observes bash and unknown-tool mutations", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-content-tools-"));
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", plannedOpen(), ctx);
    const workId = opened.details?.workId as string;
    const paths = await activeGedPaths(rootDir, "session-a");
    await successfulWrite(runtime, ctx, "plan-content", paths.specPath);
    await runtime.execute(
      "ged_governance",
      { action: "accept-plan", summary: "Accept exact plan bytes" },
      ctx,
    );
    await writeFile(paths.specPath, "drifted plan bytes\n");
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "blocked-plan-drift",
            toolName: "write",
            input: { path: "src/a.ts" },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("plan bytes changed"),
    });
    await runtime.execute(
      "ged_governance",
      { action: "accept-plan", summary: "Reaccept drifted plan" },
      ctx,
    );

    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "bash-mutation",
            toolName: "bash",
            input: { command: "sed -i.bak s/initial/changed/ README.md" },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    await writeFile(path.join(rootDir, "README.md"), "changed\n");
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "bash-mutation",
        toolName: "bash",
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    let state = await readGovernanceState(rootDir, workId);
    expect(state.evidence.at(-1)).toMatchObject({
      kind: "implementation",
      binding: {
        type: "mutation-content",
        changedPaths: ["README.md"],
      },
    });

    const evidenceCount = state.evidence.length;
    await runtime.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "no-op-script",
        toolName: "bash",
        input: { command: "node noop.js" },
      },
      ctx,
    );
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "no-op-script",
        toolName: "bash",
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    expect((await readGovernanceState(rootDir, workId)).evidence).toHaveLength(
      evidenceCount,
    );

    await runtime.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "modify-restore",
        toolName: "formatter_like",
        input: {},
      },
      ctx,
    );
    await writeFile(path.join(rootDir, "README.md"), "temporary\n");
    await writeFile(path.join(rootDir, "README.md"), "changed\n");
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "modify-restore",
        toolName: "formatter_like",
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    expect((await readGovernanceState(rootDir, workId)).evidence).toHaveLength(
      evidenceCount,
    );

    await runtime.emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "unknown-mutator",
        toolName: "apply_patch_like",
        input: {},
      },
      ctx,
    );
    await writeFile(path.join(rootDir, "unknown.txt"), "changed\n");
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "unknown-mutator",
        toolName: "apply_patch_like",
        input: {},
        content: [],
        isError: true,
      },
      ctx,
    );
    state = await readGovernanceState(rootDir, workId);
    expect(state.evidence.at(-1)).toMatchObject({
      kind: "implementation",
      binding: {
        type: "mutation-content",
        changedPaths: ["unknown.txt"],
      },
    });
  });

  it("executes content-bound verification and records proven commit milestones", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-content-commit-"),
    );
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;
    await successfulWrite(runtime, ctx, "commit-source", "src/a.ts");
    execFileSync("git", ["add", "src/a.ts"], { cwd: rootDir });
    await expect(
      runtime.execute(
        "ged_governance",
        {
          ...verificationParams("Review has findings"),
          review: {
            outcome: "findings",
            findings: ["Blocking review finding"],
          },
        },
        ctx,
      ),
    ).rejects.toThrow("review findings are non-authorizing");
    await expect(
      runtime.execute(
        "ged_governance",
        {
          action: "record-verification",
          summary: "Failing check",
          checks: [
            { command: process.execPath, args: ["-e", "process.exit(2)"] },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow("Verification commands failed");
    await runtime.execute(
      "ged_governance",
      verificationParams("Passing check"),
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "compound-commit",
            toolName: "bash",
            input: { command: 'git commit -m "bad" || true' },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("compound"),
    });
    for (const [toolCallId, command, reason] of [
      [
        "absolute-git-auto-stage",
        '/usr/bin/git commit -am "bad"',
        "may not stage content",
      ],
      [
        "env-git-auto-stage",
        'env TEST=1 git commit -am "bad"',
        "may not stage content",
      ],
      [
        "expanded-git-flags",
        'command git commit $FLAGS -m "bad"',
        "compound commit commands",
      ],
    ] as const) {
      expect(
        (
          await runtime.emit(
            "tool_call",
            {
              type: "tool_call",
              toolCallId,
              toolName: "bash",
              input: { command },
            },
            ctx,
          )
        )[0],
      ).toMatchObject({ block: true, reason: expect.stringContaining(reason) });
    }

    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "proven-commit",
            toolName: "bash",
            input: { command: 'git commit -m "verified"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    execFileSync("git", ["commit", "-m", "verified"], { cwd: rootDir });
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "proven-commit",
        toolName: "bash",
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    let state = await readGovernanceState(rootDir, workId);
    expect(state.lifecycle).toBe("active");
    expect(
      state.evidence.filter((entry) => entry.kind === "milestone"),
    ).toEqual([
      expect.objectContaining({
        outcome: "observed",
        binding: expect.objectContaining({ type: "commit-milestone" }),
      }),
    ]);

    await runtime.execute(
      "ged_governance",
      verificationParams("Verify current HEAD for amend"),
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "auto-stage-commit",
            toolName: "bash",
            input: { command: 'git commit -am "forbidden"' },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("may not stage content"),
    });
    await writeFile(path.join(rootDir, "README.md"), "drift\n");
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "drifted-amend",
            toolName: "bash",
            input: { command: 'git commit --amend -m "drifted"' },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("differs from the verified snapshot"),
    });
    await writeFile(path.join(rootDir, "README.md"), "initial\n");
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "amend-commit",
            toolName: "bash",
            input: { command: 'git commit --amend -m "amended"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    execFileSync("git", ["commit", "--amend", "-m", "amended"], {
      cwd: rootDir,
    });
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "amend-commit",
        toolName: "bash",
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    state = await readGovernanceState(rootDir, workId);
    expect(
      state.evidence.filter((entry) => entry.kind === "milestone"),
    ).toHaveLength(2);

    await successfulWrite(runtime, ctx, "hook-source", "src/b.ts");
    execFileSync("git", ["add", "src/b.ts"], { cwd: rootDir });
    await runtime.execute(
      "ged_governance",
      verificationParams("Verify hook fixture"),
      ctx,
    );
    const hookPath = path.join(rootDir, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    await chmod(hookPath, 0o755);
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "failed-hook-commit",
            toolName: "bash",
            input: { command: 'git commit -m "blocked by hook"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    expect(() =>
      execFileSync("git", ["commit", "-m", "blocked by hook"], {
        cwd: rootDir,
        stdio: "pipe",
      }),
    ).toThrow();
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "failed-hook-commit",
        toolName: "bash",
        input: {},
        content: [],
        isError: true,
      },
      ctx,
    );
    state = await readGovernanceState(rootDir, workId);
    expect(
      state.evidence.filter((entry) => entry.kind === "milestone"),
    ).toHaveLength(2);
  });

  it("rejects staged baseline changes outside observed work scope", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-content-unrelated-"),
    );
    await initializeGit(rootDir);
    await writeFile(path.join(rootDir, "README.md"), "user staged change\n");
    execFileSync("git", ["add", "README.md"], { cwd: rootDir });
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    await runtime.execute("ged_work", directOpen(), ctx);
    await runtime.execute(
      "ged_governance",
      verificationParams("Checks do not claim baseline user changes"),
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "unrelated-commit",
            toolName: "bash",
            input: { command: 'git commit -m "unrelated"' },
          },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("unrelated staged paths"),
    });
  });

  it("keeps hook-expanded commit trees durably unproven", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-content-hook-tree-"),
    );
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;
    await successfulWrite(runtime, ctx, "hook-tree-source", "src/a.ts");
    execFileSync("git", ["add", "src/a.ts"], { cwd: rootDir });
    await runtime.execute(
      "ged_governance",
      verificationParams("Verify intended tree"),
      ctx,
    );
    const hookPath = path.join(rootDir, ".git", "hooks", "pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\necho injected > hook-added.txt\ngit add hook-added.txt\n",
    );
    await chmod(hookPath, 0o755);
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "hook-expanded-commit",
            toolName: "bash",
            input: { command: 'git commit -m "hook expanded"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    execFileSync("git", ["commit", "-m", "hook expanded"], { cwd: rootDir });
    await runtime.emit(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "hook-expanded-commit",
        toolName: "bash",
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    const state = await readGovernanceState(rootDir, workId);
    expect(
      state.evidence.filter((entry) => entry.kind === "milestone"),
    ).toEqual([]);
    expect(state.pendingCommits).toHaveLength(1);

    const restarted = runtimeHarness(["request-b"]);
    await startRequest(restarted, ctx);
    await expect(
      restarted.execute("ged_work", { action: "continue", workId }, ctx),
    ).rejects.toThrow("resulting tree does not match verified staged content");
  });

  it("reconciles a proven commit after runtime restart", async () => {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "ged-content-reconcile-"),
    );
    await initializeGit(rootDir);
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", directOpen(), ctx);
    const workId = opened.details?.workId as string;
    await successfulWrite(runtime, ctx, "reconcile-source", "src/a.ts");
    execFileSync("git", ["add", "src/a.ts"], { cwd: rootDir });
    await runtime.execute(
      "ged_governance",
      verificationParams("Verify before interrupted commit"),
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "interrupted-commit",
            toolName: "bash",
            input: { command: 'git commit -m "interrupted result"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
    execFileSync("git", ["commit", "-m", "interrupted result"], {
      cwd: rootDir,
    });

    const restarted = runtimeHarness(["request-b"]);
    await startRequest(restarted, ctx);
    await restarted.execute("ged_work", { action: "continue", workId }, ctx);
    const state = await readGovernanceState(rootDir, workId);
    expect(state.pendingCommits).toEqual([]);
    expect(
      state.evidence.filter((entry) => entry.kind === "milestone"),
    ).toHaveLength(1);
  });

  it("migrates legacy checkpoints before runtime bootstrap selection", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-migrate-"));
    const runtimeDir = path.join(rootDir, ".ged", "runtime", "main");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      path.join(runtimeDir, "checkpoints.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        lifecycleStatus: "active",
        classification: "non-trivial",
        classificationReason: "Legacy runtime task",
        planCheckpoints: {},
        taskCheckpoints: {},
      })}\n`,
    );
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);

    await startRequest(runtime, ctx);
    const plan = JSON.parse(
      await readFile(
        path.join(
          rootDir,
          ".ged",
          "runtime",
          "migrations",
          "legacy-checkpoints-v1",
          "PLAN.json",
        ),
        "utf8",
      ),
    ) as { targetWorkId: string };
    expect((await activeGedPaths(rootDir, "session-a")).workId).not.toBe(
      plan.targetWorkId,
    );
  });
});
