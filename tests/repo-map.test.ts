import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import gedCoreExtension from "../extensions/ged-core/index.js";
import { refreshRepoMapState } from "../src/repo-map-index.js";
import {
  getRepoMapDebugSnapshot,
  recordRepoMapSignal,
  warmRepoMap,
} from "../src/repo-map-runtime.js";
import { repoMapStatePath } from "../src/repo-map-store.js";

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("repo map", () => {
  test("stores repo-map cache under .pi and respects .gitignore during discovery", async () => {
    const rootDir = await createTempProject("repo-map-discovery-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await mkdir(path.join(rootDir, "dist"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".gitignore"),
      "dist/\nignored.ts\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "main.ts"),
      "export const main = true;\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "dist", "skip.ts"),
      "export const skip = true;\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "ignored.ts"),
      "export const ignored = true;\n",
      "utf8",
    );

    const result = await refreshRepoMapState(rootDir);
    const stored = JSON.parse(
      await readFile(repoMapStatePath(rootDir), "utf8"),
    ) as {
      files: Record<string, unknown>;
    };

    expect(result.state.files).toHaveProperty("src/main.ts");
    expect(result.state.files).not.toHaveProperty("dist/skip.ts");
    expect(result.state.files).not.toHaveProperty("ignored.ts");
    expect(Object.keys(stored.files)).toEqual(["src/main.ts"]);
    expect(repoMapStatePath(rootDir)).toContain(`${path.sep}.pi${path.sep}`);
  });

  test("re-indexes changed files incrementally without rescanning unchanged files", async () => {
    const rootDir = await createTempProject("repo-map-incremental-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "a.ts"),
      "export const a = 1;\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "b.ts"),
      "export const b = 2;\n",
      "utf8",
    );

    const first = await refreshRepoMapState(rootDir);
    const firstA = first.state.files["src/a.ts"];
    const firstB = first.state.files["src/b.ts"];

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      path.join(rootDir, "src", "a.ts"),
      "export const a = 3;\n",
      "utf8",
    );

    const second = await refreshRepoMapState(rootDir);

    expect(second.indexedPaths).toEqual(["src/a.ts"]);
    expect(second.reusedPaths).toEqual(["src/b.ts"]);
    expect(second.state.files["src/a.ts"].indexedAt).not.toBe(firstA.indexedAt);
    expect(second.state.files["src/b.ts"].indexedAt).toBe(firstB.indexedAt);
  });

  test("ranking reflects structural importance and recent activity signals", async () => {
    const rootDir = await createTempProject("repo-map-ranking-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "core.ts"),
      "export function core() {}\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "feature-a.ts"),
      "import { core } from './core';\nexport const featureA = core;\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "feature-b.ts"),
      "import { core } from './core';\nexport const featureB = core;\n",
      "utf8",
    );

    await refreshRepoMapState(rootDir);
    let snapshot = await getRepoMapDebugSnapshot(rootDir, { prompt: "" });

    expect(snapshot.ranked[0]?.path).toBe("src/core.ts");

    recordRepoMapSignal(rootDir, "edit", "src/feature-a.ts");
    snapshot = await getRepoMapDebugSnapshot(rootDir, {
      prompt: "work on feature-a.ts",
    });

    expect(snapshot.ranked[0]?.path).toBe("src/feature-a.ts");
    expect(snapshot.rendered).toContain("recently-edited");
  });

  test("prompt integration includes a repo-map block and recent edits affect subsequent ranking", async () => {
    const rootDir = await createTempProject("repo-map-prompt-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "brain.ts"),
      "export function brain() {}\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "workflow.ts"),
      "import { brain } from './brain';\nexport const workflow = brain;\n",
      "utf8",
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

    let beforeStart = (await handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "inspect workflow.ts",
        systemPrompt: "BASE",
      },
      { cwd: rootDir },
    )) as { systemPrompt: string };

    expect(beforeStart.systemPrompt).toContain("## Repo Map");
    expect(beforeStart.systemPrompt).toContain(
      'BEGIN trust=runtime-data file="repository-map"',
    );
    expect(beforeStart.systemPrompt).toContain("src/workflow.ts");

    recordRepoMapSignal(rootDir, "edit", "src/workflow.ts");
    beforeStart = (await handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "update workflow.ts",
        systemPrompt: "BASE",
      },
      { cwd: rootDir },
    )) as { systemPrompt: string };

    const repoMapSection =
      beforeStart.systemPrompt.split("## Repo Map")[1] ?? "";
    expect(repoMapSection).toContain("src/workflow.ts");
    expect(repoMapSection.indexOf("src/workflow.ts")).toBeLessThan(
      repoMapSection.indexOf("src/brain.ts"),
    );
  });

  test("prompt integration always includes the full workflow alongside the repo map", async () => {
    const rootDir = await createTempProject("repo-map-always-on-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "brain.ts"),
      "export function brain() {}\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "workflow.ts"),
      "import { brain } from './brain';\nexport const workflow = brain;\n",
      "utf8",
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
        prompt: "inspect workflow.ts",
        systemPrompt: "BASE",
      },
      { cwd: rootDir },
    )) as { systemPrompt: string };

    expect(beforeStart.systemPrompt).toContain("BASE");
    expect(beforeStart.systemPrompt).toContain("## Repo Map");
    expect(beforeStart.systemPrompt).toContain("src/workflow.ts");
    expect(beforeStart.systemPrompt).toContain("## Current Ged Workflow Data");
  });

  test("parser/index fallback on one file does not collapse repo-map output", async () => {
    const rootDir = await createTempProject("repo-map-fallback-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "good.ts"),
      "export function good() {}\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "weird.ts"),
      "\u0000\u0001binary-ish",
      "utf8",
    );

    const result = await refreshRepoMapState(rootDir);
    const snapshot = await getRepoMapDebugSnapshot(rootDir, {
      prompt: "good.ts",
    });

    expect(result.state.files["src/weird.ts"]?.parserStatus).toBe(
      "binary-fallback",
    );
    expect(snapshot.rendered).toContain("src/good.ts");
  });

  test("file fingerprints carry a discriminant tag", async () => {
    const rootDir = await createTempProject("repo-map-fingerprint-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "indexed.ts"),
      "export const indexed = true;\n",
      "utf8",
    );

    const result = await refreshRepoMapState(rootDir);
    const fingerprint = result.state.files["src/indexed.ts"]?.fingerprint;
    expect(fingerprint?.kind).toBe("hash");
    expect(typeof fingerprint?.value).toBe("string");
    expect(fingerprint?.value.length).toBeGreaterThan(0);
  });

  test("warmRepoMap preserves edits arriving during a refresh", async () => {
    const rootDir = await createTempProject("repo-map-dirty-snapshot-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "a.ts"),
      "export const a = 1;\n",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "src", "b.ts"),
      "export const b = 1;\n",
      "utf8",
    );

    await refreshRepoMapState(rootDir);

    recordRepoMapSignal(rootDir, "edit", "src/a.ts");
    const refresh = warmRepoMap(rootDir);
    // Simulate an edit landing while the refresh is in flight.
    recordRepoMapSignal(rootDir, "edit", "src/b.ts");
    await refresh;

    // src/a.ts was in the snapshot and should be cleared; src/b.ts arrived
    // after the snapshot and must remain dirty so the next refresh picks it up.
    const followUp = warmRepoMap(rootDir);
    const result = await followUp;
    expect(result.indexedPaths).toContain("src/b.ts");
    expect(result.indexedPaths).not.toContain("src/a.ts");
  });

  test("warmRepoMap preserves repeated edits to the same path during a refresh", async () => {
    const rootDir = await createTempProject("repo-map-dirty-generation-");
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(
      path.join(rootDir, "src", "a.ts"),
      "export const a = 1;\n",
      "utf8",
    );

    await refreshRepoMapState(rootDir);

    recordRepoMapSignal(rootDir, "edit", "src/a.ts");
    const refresh = warmRepoMap(rootDir);
    // Same path, newer edit: this must survive snapshot cleanup so the next
    // refresh can index the post-snapshot generation.
    recordRepoMapSignal(rootDir, "edit", "src/a.ts");
    await refresh;

    const result = await warmRepoMap(rootDir);
    expect(result.indexedPaths).toContain("src/a.ts");
  });
});
