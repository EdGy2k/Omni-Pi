import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { describe, expect, test } from "vitest";
import gedSmartWorkerCeiling from "../extensions/ged-smart-worker-ceiling/index.js";
import packageJson from "../package.json" with { type: "json" };
import packageLock from "../package-lock.json" with { type: "json" };
import { activeGedPaths } from "../src/ged-paths.js";
import { prepareNextTaskDispatch } from "../src/work.js";
import { initializeGedProject, planGedProject } from "../src/workflow.js";

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Ged runtime flow", () => {
  test("uses Pi-native tools without the Codex conversion adapter", () => {
    expect(packageJson.dependencies).not.toHaveProperty(
      "@howaboua/pi-codex-conversion",
    );
    expect(packageJson.pi.extensions).not.toEqual(
      expect.arrayContaining([expect.stringContaining("pi-codex-conversion")]),
    );

    const lockPackages = packageLock.packages as Record<
      string,
      { dependencies?: Record<string, unknown> } | undefined
    >;
    const rootPackage = lockPackages[""];
    expect(rootPackage?.dependencies).not.toHaveProperty(
      "@howaboua/pi-codex-conversion",
    );
    expect(
      lockPackages["node_modules/@howaboua/pi-codex-conversion"],
    ).toBeUndefined();
    expect(JSON.stringify(packageLock)).not.toContain("pi-codex-conversion");
    expect(JSON.stringify(packageJson)).not.toContain("exec_command");
    expect(JSON.stringify(packageJson)).not.toContain("apply_patch");
  });

  test("bundles current pi-subagents and pi-intercom", () => {
    expect(packageJson.dependencies).toMatchObject({
      "pi-subagents": "0.45.1",
      "pi-intercom": "0.10.0",
      typebox: "1.3.7",
      "@earendil-works/pi-agent-core": "0.84.1",
      "@mariozechner/pi-coding-agent":
        "npm:@earendil-works/pi-coding-agent@0.84.1",
      "@mariozechner/pi-tui": "npm:@earendil-works/pi-tui@0.84.1",
    });
    expect(packageJson.dependencies).not.toHaveProperty(
      "@tintinweb/pi-subagents",
    );
    expect(packageJson.pi.extensions).toEqual(
      expect.arrayContaining([
        "./node_modules/pi-subagents/index.ts",
        "./node_modules/pi-intercom/index.ts",
      ]),
    );
    expect(packageJson.pi.extensions).not.toContain(
      "./node_modules/@tintinweb/pi-subagents/src/index.ts",
    );
    expect(packageJson.pi.extensions).not.toContain(
      "./node_modules/pi-subagents/src/extension/index.ts",
    );
    expect(packageJson.pi.skills).toContain(
      "./node_modules/pi-intercom/skills",
    );
    expect(packageJson.pi.skills).toContain(
      "./node_modules/pi-subagents/skills",
    );

    expect(packageLock.packages["node_modules/pi-subagents"]).toMatchObject({
      version: "0.45.1",
    });
    expect(packageLock.packages["node_modules/pi-intercom"]).toMatchObject({
      version: "0.10.0",
    });
    expect(
      packageLock.packages["node_modules/@earendil-works/pi-agent-core"],
    ).toMatchObject({ version: "0.84.1" });
    expect(packageLock.packages["node_modules/typebox"]).toMatchObject({
      version: "1.3.7",
    });
  });

  test("configured Pi extension paths exist", async () => {
    await Promise.all(
      packageJson.pi.extensions
        .filter((extensionPath) => extensionPath.includes("node_modules"))
        .map((extensionPath) =>
          expect(access(path.resolve(extensionPath))).resolves.toBeUndefined(),
        ),
    );
  });

  test("pi-intercom loads through compatibility aliases", async () => {
    const jiti = createJiti(import.meta.url);
    const intercomModule = await jiti.import<{ default?: unknown }>(
      path.resolve("node_modules/pi-intercom/index.ts"),
    );
    expect(typeof intercomModule.default).toBe("function");
  });

  test("pi-subagents loads through its public package entrypoint", async () => {
    const jiti = createJiti(import.meta.url);
    const subagentsModule = await jiti.import<{ default?: unknown }>(
      "pi-subagents",
    );
    expect(typeof subagentsModule.default).toBe("function");
  });

  test("Smart Worker extension registers a read-only child capability ceiling", async () => {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    await gedSmartWorkerCeiling({
      on(event: string, handler: (...args: never[]) => unknown) {
        handlers.set(event, handler);
      },
    } as never);
    const sessionId = `smart-worker-${Date.now()}`;
    handlers.get("session_start")?.(
      {} as never,
      {
        sessionManager: { getSessionId: () => sessionId },
      } as never,
    );
    const moduleId = "pi-subagents/capability-ceiling";
    const capabilityApi = await createJiti(import.meta.url).import<{
      resolveSubagentCapabilityCeiling(id: string): {
        allowedAgents?: string[];
        allowedTools?: string[];
      };
    }>(moduleId);
    expect(
      capabilityApi.resolveSubagentCapabilityCeiling(sessionId).allowedAgents,
    ).toEqual([
      "ged-explorer",
      "ged-plan-reviewer",
      "ged-planner",
      "ged-verifier",
    ]);
    expect(
      capabilityApi.resolveSubagentCapabilityCeiling(sessionId).allowedTools,
    ).toEqual([
      "contact_supervisor",
      "find",
      "grep",
      "ls",
      "read",
      "structured_output",
    ]);
    handlers.get("session_shutdown")?.({} as never, {} as never);
    expect(
      capabilityApi.resolveSubagentCapabilityCeiling(sessionId),
    ).toBeUndefined();
  });

  test("prepareNextTaskDispatch creates a task brief and marks the task in progress", async () => {
    const rootDir = await createTempProject("ged-runtime-dispatch-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build the first slice.",
      desiredOutcome: "Build the first slice.",
      constraints: [],
      userSignals: [],
    });

    const dispatch = await prepareNextTaskDispatch(rootDir);
    const paths = await activeGedPaths(rootDir);
    const tasks = await readFile(paths.tasksPath, "utf8");

    expect(dispatch.kind).toBe("ready");
    expect(dispatch.taskId).toBe("T01");
    expect(dispatch.prompt).toContain("Task: T01");
    expect(dispatch.prompt).toContain("Relevant skills:");
    expect(dispatch.message).toContain("focused implementation session");
    expect(tasks).toContain(
      "| T01 | Lock the exact user requirements | - | in_progress |",
    );
    expect(tasks).toContain("ged-planning, brainstorming");
    expect(tasks).toContain("brainstorming");
  });
});
