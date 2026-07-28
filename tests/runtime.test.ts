import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import packageLock from "../package-lock.json" with { type: "json" };
import { prepareNextTaskDispatch } from "../src/work.js";
import { initializeGedProject, planGedProject } from "../src/workflow.js";

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Ged runtime flow", () => {
  test("bundles Codex conversion adapter with an exact lock", () => {
    expect(packageJson.dependencies).toMatchObject({
      "@howaboua/pi-codex-conversion": "2.2.27",
    });
    expect(packageJson.pi.extensions).toEqual(
      expect.arrayContaining([
        "./node_modules/@howaboua/pi-codex-conversion/src/index.ts",
      ]),
    );

    const rootPackage = packageLock.packages[""];
    expect(rootPackage?.dependencies).toMatchObject({
      "@howaboua/pi-codex-conversion": "2.2.27",
    });

    const codexPackage =
      packageLock.packages["node_modules/@howaboua/pi-codex-conversion"];
    expect(codexPackage).toMatchObject({
      version: "2.2.27",
      resolved: expect.stringContaining(
        "@howaboua/pi-codex-conversion/-/pi-codex-conversion-2.2.27.tgz",
      ),
      integrity:
        "sha512-yCti0DD4lT0PCsAjk1o0IZz8z+HNQ98Use8AFnGVB/M1WO4K4hIEBMpDg4v8uM3lSZUBQWMGWnMzlVvkxA5SrA==",
    });
  });

  test("bundles current pi-subagents and pi-intercom", () => {
    expect(packageJson.dependencies).toMatchObject({
      "pi-subagents": "0.37.2",
      "pi-intercom": "0.6.0",
      "@mariozechner/pi-coding-agent":
        "npm:@earendil-works/pi-coding-agent@0.82.1",
      "@mariozechner/pi-tui": "npm:@earendil-works/pi-tui@0.82.1",
    });
    expect(packageJson.dependencies).not.toHaveProperty(
      "@tintinweb/pi-subagents",
    );
    expect(packageJson.pi.extensions).toEqual(
      expect.arrayContaining([
        "./node_modules/pi-subagents/src/extension/index.ts",
        "./node_modules/pi-intercom/index.ts",
      ]),
    );
    expect(packageJson.pi.extensions).not.toContain(
      "./node_modules/@tintinweb/pi-subagents/src/index.ts",
    );
    expect(packageJson.pi.skills).toContain(
      "./node_modules/pi-intercom/skills",
    );
    expect(packageJson.pi.skills).toContain(
      "./node_modules/pi-subagents/skills",
    );

    expect(packageLock.packages["node_modules/pi-subagents"]).toMatchObject({
      version: "0.37.2",
    });
    expect(packageLock.packages["node_modules/pi-intercom"]).toMatchObject({
      version: "0.6.0",
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
    const tasks = await readFile(
      path.join(rootDir, ".ged", "work", "root", "TASKS.md"),
      "utf8",
    );

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
