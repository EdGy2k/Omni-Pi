import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import {
  createAdr,
  createDirectChangeRecord,
  createHandoffProjection,
  createPlannedWorkArtifacts,
  createProjectSummary,
  createReadOnlyReport,
  createRootContext,
  taskArtifactDir,
} from "../src/durable-memory.js";
import { openGedWork } from "../src/ged-paths.js";
import {
  type DurableMemoryMigrationState,
  migrateDurableMemory,
} from "../src/memory-migration.js";
import { registerDurableMemoryTool } from "../src/memory-runtime.js";
import { ensureGedProjectCurrent } from "../src/workflow.js";

async function tempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function snapshotFiles(
  rootDir: string,
  directory = rootDir,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotFiles(rootDir, absolute));
    } else {
      result[path.relative(rootDir, absolute).split(path.sep).join("/")] = (
        await readFile(absolute)
      ).toString("base64");
    }
  }
  return result;
}

describe("durable memory artifacts", () => {
  test("creates human artifacts only on substantive writes and by work mode", async () => {
    const rootDir = await tempProject("ged-memory-lazy-");
    const direct = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "direct" },
      "Fix one parser edge case",
    );

    expect(await createProjectSummary(rootDir, "# Project\n\n")).toBe(false);
    expect(await createReadOnlyReport(rootDir, "audit", "# Audit\n\n")).toBe(
      false,
    );
    expect(
      await createDirectChangeRecord(rootDir, direct.workId, {
        summary: "Fix one parser edge case",
        decisionReason: "Bounded and deterministic",
        deterministicCheck: true,
      }),
    ).toBe(true);
    expect(await readdir(direct.paths.workDir)).toEqual([
      "DIRECT.md",
      "META.json",
    ]);

    const planned = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "planned" },
      "Migrate storage",
    );
    await createPlannedWorkArtifacts(rootDir, planned.workId);
    expect((await readdir(planned.paths.workDir)).sort()).toEqual([
      "META.json",
      "SPEC.md",
      "TASKS.md",
      "TESTS.md",
    ]);

    await expect(
      createProjectSummary(
        rootDir,
        "# Project\n\nA substantive agent-oriented project summary.\n",
      ),
    ).resolves.toBe(true);
    await expect(
      createReadOnlyReport(
        rootDir,
        "audit",
        "# Audit\n\nNo blocking findings were observed.\n",
      ),
    ).resolves.toBe(true);
    await expect(
      createRootContext(
        rootDir,
        "# Context\n\nA Checkout is the durable purchase aggregate.\n",
      ),
    ).resolves.toBe(true);
    await expect(
      createAdr(
        rootDir,
        "0001-checkout-idempotency",
        "# ADR 0001\n\nUse one idempotency key per checkout.\n",
      ),
    ).resolves.toBe(true);
    await expect(
      createHandoffProjection(
        rootDir,
        planned.workId,
        "# Session Summary\n\nStorage migration is ready for review.\n",
      ),
    ).resolves.toBe(true);
  });

  test("repeated task IDs are isolated by immutable work ID", async () => {
    const rootDir = await tempProject("ged-memory-task-scope-");
    const first = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "first" },
      "First task",
    );
    const second = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "second" },
      "Second task",
    );
    const firstHistory = path.join(
      taskArtifactDir(rootDir, first.workId, "T01"),
      "HISTORY.json",
    );
    const secondHistory = path.join(
      taskArtifactDir(rootDir, second.workId, "T01"),
      "HISTORY.json",
    );
    await mkdir(path.dirname(firstHistory), { recursive: true });
    await mkdir(path.dirname(secondHistory), { recursive: true });
    await writeFile(firstHistory, '[{"modifiedFiles":["src/first.ts"]}]');
    await writeFile(secondHistory, '[{"modifiedFiles":["src/second.ts"]}]');

    expect(firstHistory).not.toBe(secondHistory);
    expect(await readFile(firstHistory, "utf8")).toContain("src/first.ts");
    expect(await readFile(secondHistory, "utf8")).toContain("src/second.ts");
  });
});

describe("durable memory v3 migration", () => {
  test("registers lazy durable-memory creation as a governed Pi tool", () => {
    let registered: { name?: string; description?: string } | undefined;
    registerDurableMemoryTool({
      registerTool(tool: { name?: string; description?: string }) {
        registered = tool;
      },
    } as never);
    expect(registered?.name).toBe("ged_memory");
    expect(registered?.description).toContain("substantive lazy Ged memory");
  });

  test("recovers an atomically recorded lock whose owner process is dead", async () => {
    const rootDir = await tempProject("ged-memory-stale-lock-");
    const lockPath = path.join(
      rootDir,
      ".ged",
      "runtime",
      "migrations",
      "durable-memory-v3",
      "LOCKS",
      "00000000-0000-4000-8000-000000000000.json",
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    await writeFile(
      path.join(rootDir, ".ged", "GLOSSARY.md"),
      "# Glossary\n\n- Recovery: resume from durable facts.\n",
    );
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000000",
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    const results = await Promise.all([
      migrateDurableMemory(rootDir),
      migrateDurableMemory(rootDir),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "already-complete",
      "completed",
    ]);
    expect(
      await readFile(
        path.join(
          path.dirname(path.dirname(lockPath)),
          "STALE-00000000-0000-4000-8000-000000000000.json",
        ),
        "utf8",
      ),
    ).toContain('"pid":2147483647');
  });

  test("rejects corrupt completion and journal entries", async () => {
    const completedRoot = await tempProject("ged-memory-corrupt-state-");
    await mkdir(path.join(completedRoot, ".ged"), { recursive: true });
    await writeFile(path.join(completedRoot, ".ged", "VERSION"), "2\n");
    await writeFile(
      path.join(completedRoot, ".ged", "MEMORY-MIGRATION.json"),
      JSON.stringify({
        schemaVersion: 1,
        migrationId: "durable-memory-v3",
        status: "complete",
        completedAt: "2026-01-01T00:00:00.000Z",
        entries: [null],
      }),
    );
    await expect(migrateDurableMemory(completedRoot)).rejects.toThrow(
      "migration entry is invalid",
    );

    const journalRoot = await tempProject("ged-memory-corrupt-journal-");
    const journalPath = path.join(
      journalRoot,
      ".ged",
      "runtime",
      "migrations",
      "durable-memory-v3",
      "JOURNAL.json",
    );
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(path.join(journalRoot, ".ged", "VERSION"), "2\n");
    await writeFile(
      journalPath,
      JSON.stringify({
        schemaVersion: 1,
        migrationId: "durable-memory-v3",
        entries: [null],
      }),
    );
    await expect(migrateDurableMemory(journalRoot)).rejects.toThrow(
      "migration entry is invalid",
    );
  });

  test("does not overwrite a legacy source that changes during migration", async () => {
    const rootDir = await tempProject("ged-memory-source-drift-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    const glossaryPath = path.join(rootDir, ".ged", "GLOSSARY.md");
    await writeFile(glossaryPath, "# Glossary\n\n- Before: original bytes.\n");

    await expect(
      migrateDurableMemory(rootDir, {
        async beforeSourceCommit(sourcePath) {
          if (sourcePath === ".ged/GLOSSARY.md") {
            await writeFile(
              glossaryPath,
              "# Glossary\n\n- After: concurrent user edit.\n",
            );
          }
        },
      }),
    ).rejects.toThrow("changed during durable-memory migration");
    expect(await readFile(glossaryPath, "utf8")).toContain(
      "concurrent user edit",
    );
    await expect(
      readFile(path.join(rootDir, "CONTEXT.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("recovers journaled evidence after interruption following source replacement", async () => {
    const rootDir = await tempProject("ged-memory-interrupted-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    const glossary = "# Glossary\n\n- Journal: durable migration intent.\n";
    await writeFile(path.join(rootDir, ".ged", "GLOSSARY.md"), glossary);

    await expect(
      migrateDurableMemory(rootDir, {
        afterSourceCommit(sourcePath) {
          if (sourcePath === ".ged/GLOSSARY.md") {
            throw new Error("simulated interruption");
          }
        },
      }),
    ).rejects.toThrow("simulated interruption");
    expect(
      await readFile(path.join(rootDir, ".ged", "GLOSSARY.md"), "utf8"),
    ).toContain("# Glossary moved");
    await expect(
      readFile(path.join(rootDir, ".ged", "MEMORY-MIGRATION.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const recovered = await migrateDurableMemory(rootDir);
    expect(recovered.state?.entries).toContainEqual(
      expect.objectContaining({
        sourcePath: ".ged/GLOSSARY.md",
        action: "migrated-context",
      }),
    );
    const context = await readFile(path.join(rootDir, "CONTEXT.md"), "utf8");
    expect(context.split(glossary)).toHaveLength(2);
  });

  test("version 3 still migrates actionable legacy content without a completion record", async () => {
    const rootDir = await tempProject("ged-memory-version-three-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "3\n");
    await writeFile(
      path.join(rootDir, ".ged", "GLOSSARY.md"),
      "# Glossary\n\n- Upgrade: migration completion, not version alone.\n",
    );

    await expect(ensureGedProjectCurrent(rootDir)).resolves.toMatchObject({
      status: "migrated",
    });
    expect(await readFile(path.join(rootDir, "CONTEXT.md"), "utf8")).toContain(
      "migration completion, not version alone",
    );
  });

  test("retains a global task artifact when multiple work items claim its task ID", async () => {
    const rootDir = await tempProject("ged-memory-task-ambiguity-");
    const first = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "first-owner" },
      "First owner",
    );
    const second = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "second-owner" },
      "Second owner",
    );
    for (const opened of [first, second]) {
      await createPlannedWorkArtifacts(rootDir, opened.workId);
      await writeFile(
        opened.paths.tasksPath,
        "# Tasks\n\n| ID | Title | Depends On | Status | Done Criteria |\n| --- | --- | --- | --- | --- |\n| T01 | Claimed task | - | todo | Preserve history |\n",
      );
    }
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    const legacyTask = path.join(rootDir, ".ged", "tasks", "T01.history.json");
    await mkdir(path.dirname(legacyTask), { recursive: true });
    await writeFile(legacyTask, '[{"modifiedFiles":["src/shared.ts"]}]');

    const result = await migrateDurableMemory(rootDir);
    expect(await readFile(legacyTask, "utf8")).toContain("src/shared.ts");
    expect(
      result.state?.entries.find(
        (entry) => entry.sourcePath === ".ged/tasks/T01.history.json",
      ),
    ).toMatchObject({
      action: "retained-substantive",
      reason: expect.stringContaining("unambiguous"),
    });
  });

  test("rejects canonical destinations that traverse a symlink", async () => {
    const rootDir = await tempProject("ged-memory-symlink-");
    const outside = await tempProject("ged-memory-outside-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    await writeFile(
      path.join(rootDir, ".ged", "DECISIONS.md"),
      "# Decisions\n\n- Decision: never escape the repo.\n",
    );
    await symlink(outside, path.join(rootDir, "docs"));

    await expect(migrateDurableMemory(rootDir)).rejects.toThrow(
      "traverses a symbolic link",
    );
    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects a symlinked legacy task source before copying or deleting it", async () => {
    const rootDir = await tempProject("ged-memory-source-symlink-");
    const outside = await tempProject("ged-memory-source-outside-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    const outsideTask = path.join(outside, "T01.history.json");
    await writeFile(outsideTask, '[{"modifiedFiles":["outside.ts"]}]');
    await symlink(outside, path.join(rootDir, ".ged", "tasks"));

    await expect(migrateDurableMemory(rootDir)).rejects.toThrow(
      "Read source traverses a symbolic link",
    );
    expect(await readFile(outsideTask, "utf8")).toContain("outside.ts");
  });

  test("rejects a direct legacy source symlink during version 3 preflight", async () => {
    const rootDir = await tempProject("ged-memory-preflight-symlink-");
    const outside = await tempProject("ged-memory-preflight-outside-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "3\n");
    const outsideGlossary = path.join(outside, "GLOSSARY.md");
    await writeFile(outsideGlossary, "# Glossary\n\n- External: untouched.\n");
    await symlink(outsideGlossary, path.join(rootDir, ".ged", "GLOSSARY.md"));

    await expect(migrateDurableMemory(rootDir)).rejects.toThrow(
      "Read source traverses a symbolic link",
    );
    expect(await readFile(outsideGlossary, "utf8")).toContain("untouched");
  });

  test("concurrent callers converge on one completed migration", async () => {
    const rootDir = await tempProject("ged-memory-concurrent-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    const glossary = "# Glossary\n\n- Lease: exclusive writer ownership.\n";
    await writeFile(path.join(rootDir, ".ged", "GLOSSARY.md"), glossary);

    const results = await Promise.all([
      migrateDurableMemory(rootDir),
      migrateDurableMemory(rootDir),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "already-complete",
      "completed",
    ]);
    const context = await readFile(path.join(rootDir, "CONTEXT.md"), "utf8");
    expect(context.split(glossary)).toHaveLength(2);
  });

  test("preserves mixed legacy content exactly once and reruns as a no-op", async () => {
    const rootDir = await tempProject("ged-memory-migrate-");
    const opened = await openGedWork(
      rootDir,
      { sessionId: "ged-default-session", requestId: "migration" },
      "Legacy migration target",
    );
    await createPlannedWorkArtifacts(rootDir, opened.workId);
    await writeFile(
      opened.paths.tasksPath,
      "# Tasks\n\n| ID | Title | Depends On | Status | Done Criteria |\n| --- | --- | --- | --- | --- |\n| T01 | Legacy task | - | todo | Preserve history |\n",
    );
    await writeFile(path.join(rootDir, ".ged", "VERSION"), "2\n");
    const glossary =
      "# Glossary\n\n- Checkout: the durable purchase aggregate.\n";
    const decisions = `# Decisions\n\n- Date: 2026-01-01\n  - Decision: Keep exact task identity.\n  - Why: Avoid collisions.\n  - Impact: T01 is work-scoped.\n`;
    const architecture = "# Architecture\n\nA substantive legacy boundary.\n";
    await writeFile(path.join(rootDir, ".ged", "GLOSSARY.md"), glossary);
    await writeFile(path.join(rootDir, ".ged", "DECISIONS.md"), decisions);
    await writeFile(
      path.join(rootDir, ".ged", "ARCHITECTURE.md"),
      architecture,
    );
    await mkdir(path.join(rootDir, ".ged", "tasks"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".ged", "tasks", "T01.history.json"),
      '[{"modifiedFiles":["src/legacy.ts"]}]',
    );
    await writeFile(
      path.join(rootDir, ".ged", "tasks", "...history.json"),
      '[{"modifiedFiles":["src/unsafe.ts"]}]',
    );
    const legacySkill = path.join(
      rootDir,
      ".ged",
      "project-skills",
      "legacy-task-skill",
      "SKILL.md",
    );
    const legacySkillContent = `---\nname: legacy-task-skill\ndescription: Possibly edited legacy skill.\n---\n\n# Legacy\n`;
    await mkdir(path.dirname(legacySkill), { recursive: true });
    await writeFile(legacySkill, legacySkillContent);

    const first = await migrateDurableMemory(rootDir);
    expect(first.status).toBe("completed");
    const state = first.state as DurableMemoryMigrationState;
    const context = await readFile(path.join(rootDir, "CONTEXT.md"), "utf8");
    const adrEntry = state.entries.find(
      (entry) => entry.action === "migrated-decisions",
    );
    expect(adrEntry?.destinationPath).toBeTruthy();
    const adr = await readFile(
      path.join(rootDir, adrEntry?.destinationPath as string),
      "utf8",
    );
    expect(context.split(glossary)).toHaveLength(2);
    expect(adr.split(decisions)).toHaveLength(2);
    expect(
      await readFile(path.join(rootDir, ".ged", "GLOSSARY.md"), "utf8"),
    ).not.toContain("durable purchase aggregate");
    expect(
      await readFile(path.join(rootDir, ".ged", "DECISIONS.md"), "utf8"),
    ).not.toContain("Keep exact task identity");

    const contextEntry = state.entries.find(
      (entry) => entry.action === "migrated-context",
    );
    expect(
      await readFile(
        path.join(rootDir, contextEntry?.backupPath as string),
        "utf8",
      ),
    ).toBe(glossary);
    const retainedArchitecture = state.entries.find(
      (entry) => entry.sourcePath === ".ged/ARCHITECTURE.md",
    );
    expect(retainedArchitecture?.action).toBe("retained-substantive");
    expect(
      await readFile(
        path.join(rootDir, retainedArchitecture?.backupPath as string),
        "utf8",
      ),
    ).toBe(architecture);
    expect(await readFile(legacySkill, "utf8")).toBe(legacySkillContent);
    expect(
      state.entries.find((entry) => entry.sourcePath.endsWith("SKILL.md"))
        ?.action,
    ).toBe("retained-substantive");
    expect(
      await readFile(
        path.join(
          taskArtifactDir(rootDir, opened.workId, "T01"),
          "HISTORY.json",
        ),
        "utf8",
      ),
    ).toContain("src/legacy.ts");
    expect(
      await readFile(
        path.join(rootDir, ".ged", "tasks", "...history.json"),
        "utf8",
      ),
    ).toContain("src/unsafe.ts");

    const afterFirst = await snapshotFiles(rootDir);
    const second = await migrateDurableMemory(rootDir);
    expect(second.status).toBe("already-complete");
    expect(await snapshotFiles(rootDir)).toEqual(afterFirst);
  });
});
