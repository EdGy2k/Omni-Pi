import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, type Mock, test, vi } from "vitest";

import {
  buildGlimpsePlanReviewHtml,
  importPlannotatorServer,
  registerPlanReviewTool,
  requestGlimpsePlanReview,
} from "../src/plan-review.js";

async function createPlanArtifacts(): Promise<{
  rootDir: string;
  tasksPath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ged-plan-review-"));
  const workDir = path.join(rootDir, ".ged", "work", "planned");
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, "SPEC.md"), "# Spec\n");
  await writeFile(path.join(workDir, "TASKS.md"), "# Tasks\n");
  await writeFile(path.join(workDir, "TESTS.md"), "# Tests\n");
  return { rootDir, tasksPath: path.join(workDir, "TASKS.md") };
}

describe("Glimpse plan review", () => {
  test("registers the planned-work review tool with an exact approved plan binding", async () => {
    const { rootDir, tasksPath } = await createPlanArtifacts();
    let registered:
      | {
          name: string;
          execute: (...args: never[]) => Promise<{
            details?: Record<string, unknown>;
          }>;
        }
      | undefined;
    const api = {
      registerTool(tool: typeof registered) {
        registered = tool;
      },
      events: { emit() {}, on() {} },
    } as unknown as ExtensionAPI;
    registerPlanReviewTool(api, {
      requestGlimpse: async () => ({ approved: true }),
    });

    expect(registered?.name).toBe("gedpi_plan_review");
    const result = await registered?.execute(
      "review-call" as never,
      { filePath: path.relative(rootDir, tasksPath) } as never,
      undefined as never,
      undefined as never,
      { cwd: rootDir } as never,
    );
    expect(result?.details).toMatchObject({
      approved: true,
      surface: "glimpse",
      planBinding: {
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        paths: [
          ".ged/work/planned/SPEC.md",
          ".ged/work/planned/TASKS.md",
          ".ged/work/planned/TESTS.md",
        ],
      },
    });
  });

  test("rejects a visual approval when any plan artifact changes during review", async () => {
    const { rootDir, tasksPath } = await createPlanArtifacts();
    let registered:
      | {
          execute: (...args: never[]) => Promise<{
            details?: Record<string, unknown>;
          }>;
        }
      | undefined;
    const api = {
      registerTool(tool: typeof registered) {
        registered = tool;
      },
      events: { emit() {}, on() {} },
    } as unknown as ExtensionAPI;
    registerPlanReviewTool(api, {
      requestGlimpse: async () => {
        await writeFile(tasksPath, "# Changed tasks\n");
        return { approved: true };
      },
    });

    const result = await registered?.execute(
      "review-call" as never,
      { filePath: path.relative(rootDir, tasksPath) } as never,
      undefined as never,
      undefined as never,
      { cwd: rootDir } as never,
    );
    expect(result?.details).toMatchObject({
      approved: false,
      surface: "glimpse",
      staleReview: true,
    });
    expect(result?.details).not.toHaveProperty("planBinding");
  });
  test("imports Plannotator's TypeScript server module through the production helper", async () => {
    const server = await importPlannotatorServer();

    expect(server.startPlanReviewServer).toEqual(expect.any(Function));
  });

  test("renders a full Plannotator iframe wrapper with browser fallback", () => {
    const html = buildGlimpsePlanReviewHtml(
      "http://127.0.0.1:48123/?token=<unsafe>",
    );

    expect(html).toContain("Full Plannotator plan review");
    expect(html).toContain("<iframe");
    expect(html).toContain("Use browser fallback");
    expect(html).toContain("Open in browser");
    expect(html).toContain("http://127.0.0.1:48123/?token=&lt;unsafe&gt;");
    expect(html).not.toContain("token=<unsafe>");
  });

  test("does not render raw plan markdown or the old approval dialog", () => {
    const html = buildGlimpsePlanReviewHtml("http://127.0.0.1:48123/");

    expect(html).not.toContain("Approve plan");
    expect(html).not.toContain("Deny / request changes");
    expect(html).not.toContain("Feedback / notes");
    expect(html).not.toContain("<pre>");
  });

  test("closes the Glimpse window when the embedded review returns a decision", async () => {
    const window = new EventEmitter() as EventEmitter & {
      close: Mock;
    };
    window.close = vi.fn();
    const stop = vi.fn();

    const decision = await requestGlimpsePlanReview("plan", {
      importGlimpse: async () => ({
        open: () => window,
      }),
      startServer: async () => ({
        reviewId: "review-1",
        url: "http://127.0.0.1:48123/",
        waitForDecision: async () => ({
          approved: true,
          feedback: " looks good ",
        }),
        stop,
      }),
    });

    expect(decision).toEqual({
      approved: true,
      feedback: "looks good",
      savedPath: undefined,
      agentSwitch: undefined,
      permissionMode: undefined,
    });
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  test("returns null for Glimpse browser fallback messages", async () => {
    const window = new EventEmitter() as EventEmitter & {
      close: Mock;
    };
    window.close = vi.fn();

    const decision = requestGlimpsePlanReview("plan", {
      importGlimpse: async () => ({
        open: () => {
          setTimeout(() => window.emit("message", { fallback: true }), 0);
          return window;
        },
      }),
      startServer: async () => ({
        reviewId: "review-1",
        url: "http://127.0.0.1:48123/",
        waitForDecision: () => new Promise(() => {}),
        stop: vi.fn(),
      }),
    });

    await expect(decision).resolves.toBeNull();
    expect(window.close).toHaveBeenCalledTimes(1);
  });
});
