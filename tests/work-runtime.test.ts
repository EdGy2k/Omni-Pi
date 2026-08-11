import {
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
  const tools = new Map<string, TestTool>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: TestTool) {
      tools.set(tool.name, tool);
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
      name: "ged_work" | "ged_governance",
      params: Record<string, unknown>,
      ctx: TestContext,
      id = `${name}-call`,
    ) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`${name} was not registered`);
      return tool.execute(id, params, undefined, undefined, ctx);
    },
  };
}

function context(rootDir: string, sessionId = "session-a"): TestContext {
  return {
    cwd: rootDir,
    sessionManager: { getSessionId: () => sessionId },
  };
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
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-1", "request-2"]);

    const prompt = await startRequest(runtime, ctx);
    expect(prompt[0]).toMatchObject({
      systemPrompt: expect.stringContaining("structured ambiguity"),
    });
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
      reason: expect.stringContaining("pending durable implementation"),
    });
    expect(await readGovernanceState(rootDir, workId)).toMatchObject({
      pendingMutations: [
        expect.objectContaining({
          requestId: "request-1",
          toolCallId: "write-a",
        }),
      ],
    });
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

    await runtime.execute(
      "ged_governance",
      { action: "record-verification", summary: "Focused checks passed" },
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

  it("allows planned artifacts before acceptance and source writes only after acceptance", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-planned-"));
    const ctx = context(rootDir);
    const runtime = runtimeHarness(["request-a"]);
    await startRequest(runtime, ctx);
    const opened = await runtime.execute("ged_work", plannedOpen(), ctx);
    const workId = opened.details?.workId as string;
    const paths = await activeGedPaths(rootDir, "session-a");

    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolCallId: "plan-write",
            toolName: "write",
            input: { path: paths.specPath },
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
    await runtime.execute(
      "ged_governance",
      { action: "record-verification", summary: "All planned checks passed" },
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
      3,
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
      { action: "record-verification", summary: "Pre-write checks passed" },
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
            value === "read-only" || value === "unresolved" ? "active" : value,
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
