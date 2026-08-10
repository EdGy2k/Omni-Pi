import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  activeGedPaths,
  isActiveWorkBoundToRequest,
} from "../src/ged-paths.js";
import { initializeGovernanceState } from "../src/governance-store.js";
import { registerGedWorkRuntime } from "../src/work-runtime.js";

type Handler = (event: Record<string, unknown>, ctx: TestContext) => unknown;

interface TestContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

function runtimeHarness(requestIds: string[]) {
  const handlers = new Map<string, Handler[]>();
  let workTool:
    | {
        execute(
          id: string,
          params: {
            action: "open" | "continue";
            summary?: string;
            workId?: string;
          },
          signal: undefined,
          update: undefined,
          ctx: TestContext,
        ): Promise<{ details?: { workId?: string } }>;
      }
    | undefined;
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: typeof workTool) {
      workTool = tool;
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
    get tool() {
      if (!workTool) throw new Error("ged_work was not registered");
      return workTool;
    },
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
  };
}

describe("Ged work runtime", () => {
  it("requires explicit open or continue for each agent request", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-runtime-"));
    const ctx: TestContext = {
      cwd: rootDir,
      sessionManager: { getSessionId: () => "session-a" },
    };
    const runtime = runtimeHarness(["request-1", "request-2"]);

    await runtime.emit("session_start", { type: "session_start" }, ctx);
    const firstPrompt = await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      ctx,
    );
    expect(firstPrompt).toEqual([
      expect.objectContaining({
        systemPrompt: expect.stringContaining("ged_work"),
      }),
    ]);
    const systemPrompt = (firstPrompt[0] as { systemPrompt: string })
      .systemPrompt;
    expect(systemPrompt).toContain("`ged_work`");
    expect(systemPrompt).not.toMatch(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: this regression assertion specifically rejects hidden prompt control characters.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u,
    );

    // Pi preflights sibling calls in source order before it executes accepted
    // tools. Model that documented scheduler order: ged_work preflight cannot
    // authorize a sibling write because ged_work has not executed yet.
    const workPreflight = await runtime.emit(
      "tool_call",
      {
        type: "tool_call",
        toolName: "ged_work",
        input: { action: "open", summary: "Implement task identity" },
      },
      ctx,
    );
    expect(workPreflight).toEqual([undefined]);
    const blockedInSameBatch = await runtime.emit(
      "tool_call",
      { type: "tool_call", toolName: "write", input: { path: "src/a.ts" } },
      ctx,
    );
    expect(blockedInSameBatch).toEqual([
      expect.objectContaining({ block: true }),
    ]);

    const opened = await runtime.tool.execute(
      "tool-1",
      { action: "open", summary: "Implement task identity" },
      undefined,
      undefined,
      ctx,
    );
    const workId = opened.details?.workId;
    expect(workId).toBeTruthy();
    await expect(
      runtime.tool.execute(
        "tool-duplicate",
        { action: "open", summary: "A second task" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("already bound");
    await expect(
      isActiveWorkBoundToRequest(rootDir, {
        sessionId: "session-a",
        requestId: "request-1",
      }),
    ).resolves.toBe(true);

    const allowedAfterOpen = await runtime.emit(
      "tool_call",
      { type: "tool_call", toolName: "edit", input: { path: "src/a.ts" } },
      ctx,
    );
    expect(allowedAfterOpen).toEqual([undefined]);

    await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      ctx,
    );
    const blockedAsStale = await runtime.emit(
      "tool_call",
      { type: "tool_call", toolName: "edit", input: { path: "src/a.ts" } },
      ctx,
    );
    expect(blockedAsStale).toEqual([expect.objectContaining({ block: true })]);
    const blockedCommitAsStale = await runtime.emit(
      "tool_call",
      {
        type: "tool_call",
        toolName: "bash",
        input: { command: 'git commit -m "stale"' },
      },
      ctx,
    );
    expect(blockedCommitAsStale).toEqual([
      expect.objectContaining({ block: true }),
    ]);

    await runtime.tool.execute(
      "tool-2",
      { action: "continue", workId },
      undefined,
      undefined,
      ctx,
    );
    expect(
      (
        await runtime.emit(
          "tool_call",
          {
            type: "tool_call",
            toolName: "write",
            input: { path: "src/b.ts" },
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
            toolName: "bash",
            input: { command: 'git commit -m "current"' },
          },
          ctx,
        )
      )[0],
    ).toBeUndefined();
  });

  it("keeps session selections independent and clears a settled request", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-sessions-"));
    const runtime = runtimeHarness(["request-a", "request-b"]);
    const sessionA: TestContext = {
      cwd: rootDir,
      sessionManager: { getSessionId: () => "session-a" },
    };
    const sessionB: TestContext = {
      cwd: rootDir,
      sessionManager: { getSessionId: () => "session-b" },
    };

    await runtime.emit("session_start", { type: "session_start" }, sessionA);
    await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      sessionA,
    );
    const openedA = await runtime.tool.execute(
      "tool-a",
      { action: "open", summary: "Task A" },
      undefined,
      undefined,
      sessionA,
    );

    await runtime.emit("session_start", { type: "session_start" }, sessionB);
    await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      sessionB,
    );
    const openedB = await runtime.tool.execute(
      "tool-b",
      { action: "open", summary: "Task B" },
      undefined,
      undefined,
      sessionB,
    );

    expect((await activeGedPaths(rootDir, "session-a")).workId).toBe(
      openedA.details?.workId,
    );
    expect((await activeGedPaths(rootDir, "session-b")).workId).toBe(
      openedB.details?.workId,
    );

    await runtime.emit("agent_settled", { type: "agent_settled" }, sessionB);
    expect(
      (
        await runtime.emit(
          "tool_call",
          { type: "tool_call", toolName: "write", input: {} },
          sessionB,
        )
      )[0],
    ).toMatchObject({ block: true });
  });

  it("rejects incomplete transition arguments without changing selection", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-args-"));
    const ctx: TestContext = {
      cwd: rootDir,
      sessionManager: { getSessionId: () => "session-a" },
    };
    const runtime = runtimeHarness(["request-a"]);
    await runtime.emit("session_start", { type: "session_start" }, ctx);
    await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      ctx,
    );
    const before = await activeGedPaths(rootDir, "session-a");

    await expect(
      runtime.tool.execute(
        "tool-a",
        { action: "open" },
        undefined,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("summary");
    expect((await activeGedPaths(rootDir, "session-a")).workId).toBe(
      before.workId,
    );
  });

  it("blocks mutation when authoritative governance is paused", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-work-paused-"));
    const ctx: TestContext = {
      cwd: rootDir,
      sessionManager: { getSessionId: () => "session-a" },
    };
    const runtime = runtimeHarness(["request-a"]);
    await runtime.emit("session_start", { type: "session_start" }, ctx);
    await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      ctx,
    );
    const opened = await runtime.tool.execute(
      "tool-a",
      { action: "open", summary: "Paused task" },
      undefined,
      undefined,
      ctx,
    );
    const workId = opened.details?.workId as string;
    await initializeGovernanceState(rootDir, workId, {
      decision: {
        mode: "planned-change",
        reasonCode: "decision-needed",
        reason: "Migration review is required.",
        requiresDecision: true,
      },
      executionProfile: "solo",
      lifecycle: "paused",
      evidence: [
        {
          id: "migration-required",
          kind: "migration-required",
          source: "runtime",
          recordedAt: "2026-08-10T08:30:00.000Z",
          summary: "Legacy evidence is not authorization.",
          outcome: "failed",
        },
      ],
    });

    expect(
      (
        await runtime.emit(
          "tool_call",
          { type: "tool_call", toolName: "edit", input: { path: "src/a.ts" } },
          ctx,
        )
      )[0],
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("lifecycle paused"),
    });
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
    const ctx: TestContext = {
      cwd: rootDir,
      sessionManager: { getSessionId: () => "session-a" },
    };
    const runtime = runtimeHarness(["request-a"]);

    await runtime.emit("session_start", { type: "session_start" }, ctx);
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

    await runtime.emit(
      "before_agent_start",
      { type: "before_agent_start", systemPrompt: "base" },
      ctx,
    );
    expect((await activeGedPaths(rootDir, "session-a")).workId).not.toBe(
      plan.targetWorkId,
    );
  });
});
