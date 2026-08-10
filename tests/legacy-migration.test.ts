import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  activeWorkPointerPath,
  continueGedWork,
  isActiveWorkBoundToRequest,
  openGedWork,
  readActiveWorkPointer,
  readWorkItemMeta,
} from "../src/ged-paths.js";
import { readGovernanceState } from "../src/governance-store.js";
import {
  ensureLegacyCheckpointMigration,
  type LegacyMigrationPlan,
  legacyMigrationPaths,
} from "../src/legacy-migration.js";
import {
  ensureGedProjectCurrent,
  initializeGedProject,
} from "../src/workflow.js";

const MIGRATION_DATE = new Date("2026-08-10T08:30:00.000Z");
const execFileAsync = promisify(execFile);

function checkpoint(
  schemaVersion: number,
  lifecycleStatus: "active" | "verified" | "closed" = "active",
  includeLifecycle = schemaVersion >= 3,
): string {
  return `${JSON.stringify(
    {
      schemaVersion,
      ...(includeLifecycle ? { lifecycleStatus } : {}),
      classification: "non-trivial",
      classificationReason: "Legacy task required planning",
      planCheckpoints: {
        "ged-planner": {
          agent: "ged-planner",
          status: "completed",
          source: "auto",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      },
      taskCheckpoints: {
        T01: {
          "ged-verifier": {
            agent: "ged-verifier",
            status: "completed",
            source: "auto",
            timestamp: "2026-01-01T00:00:00.000Z",
            verifierOutcome: "clean",
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function tempProject(prefix = "ged-legacy-migration-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeCandidate(
  rootDir: string,
  slug: string,
  raw: string,
  options: { direct?: boolean; logicalWorkId?: string } = {},
): Promise<string> {
  const runtimeDir = options.direct
    ? path.join(rootDir, ".ged", "runtime")
    : path.join(rootDir, ".ged", "runtime", slug);
  const workDir = path.join(rootDir, ".ged", "work", slug);
  await Promise.all([
    mkdir(runtimeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ]);
  const checkpointPath = path.join(runtimeDir, "checkpoints.json");
  await Promise.all([
    writeFile(checkpointPath, raw),
    writeFile(path.join(runtimeDir, "STATE.md"), `legacy-state:${slug}\n`),
    writeFile(path.join(workDir, "SPEC.md"), `legacy-spec:${slug}\n`),
    writeFile(
      path.join(workDir, "META.json"),
      `${JSON.stringify({
        schema: 1,
        workId: options.logicalWorkId ?? slug,
      })}\n`,
    ),
  ]);
  return checkpointPath;
}

function migrationOptions(id = "migration-test-id") {
  return {
    now: () => new Date(MIGRATION_DATE),
    createMigrationId: () => id,
  };
}

async function readPlan(rootDir: string): Promise<LegacyMigrationPlan> {
  return JSON.parse(
    await readFile(legacyMigrationPaths(rootDir).planPath, "utf8"),
  ) as LegacyMigrationPlan;
}

async function fileSnapshot(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else
        result.set(
          path.relative(directory, absolute),
          (await readFile(absolute)).toString("base64"),
        );
    }
  };
  await visit(directory);
  return result;
}

describe("legacy checkpoint migration", () => {
  it("backs up and imports one active v2 record as paused non-selectable work", async () => {
    const rootDir = await tempProject();
    const sourceRaw = checkpoint(2);
    const sourcePath = await writeCandidate(rootDir, "main", sourceRaw);
    await mkdir(path.join(rootDir, ".ged", "work", "main", "artifacts"));
    await writeFile(
      path.join(rootDir, ".ged", "work", "main", "artifacts", "report.txt"),
      "substantive legacy report\n",
    );

    const result = await ensureLegacyCheckpointMigration(
      rootDir,
      migrationOptions(),
    );

    expect(result).toMatchObject({ status: "completed", outcome: "imported" });
    expect(await readFile(sourcePath, "utf8")).toBe(sourceRaw);
    expect(await readActiveWorkPointer(rootDir, "session-a")).toBeNull();
    const plan = await readPlan(rootDir);
    expect(plan.manifest.map((entry) => entry.sourcePath)).toContain(
      ".ged/work/main/artifacts/report.txt",
    );
    expect(plan.candidates).toEqual([
      expect.objectContaining({ classification: "supported-active-v2" }),
    ]);
    expect(plan.targetWorkId).toBe(result.targetWorkId);
    for (const entry of plan.manifest) {
      expect(await readFile(path.join(rootDir, entry.backupPath))).toEqual(
        await readFile(path.join(rootDir, entry.sourcePath)),
      );
    }

    const workId = plan.targetWorkId as string;
    const meta = await readWorkItemMeta(rootDir, workId);
    expect(meta.origin).toMatchObject({
      kind: "legacy-import",
      migrationId: plan.migrationId,
      selectable: false,
    });
    const state = await readGovernanceState(rootDir, workId);
    expect(state).toMatchObject({
      revision: 0,
      lifecycle: "paused",
      executionProfile: "solo",
      approvals: [],
      decision: {
        mode: "planned-change",
        reasonCode: "decision-needed",
        requiresDecision: true,
      },
    });
    expect(state.evidence).toEqual([
      expect.objectContaining({
        id: plan.evidenceId,
        kind: "migration-required",
        source: "runtime",
        outcome: "failed",
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain("ged-planner");
    expect(JSON.stringify(state)).not.toContain("ged-verifier");
    await expect(
      continueGedWork(
        rootDir,
        { sessionId: "session-a", requestId: "request-a" },
        workId,
      ),
    ).rejects.toMatchObject({
      code: "non-selectable-work",
    });
    const forgedPointer = activeWorkPointerPath(rootDir, "session-a");
    await mkdir(path.dirname(forgedPointer), { recursive: true });
    await writeFile(
      forgedPointer,
      `${JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-a",
        workId,
        operation: "continue",
        selectedAt: MIGRATION_DATE.toISOString(),
        requestId: "request-a",
      })}\n`,
    );
    await expect(
      isActiveWorkBoundToRequest(
        rootDir,
        { sessionId: "session-a", requestId: "request-a" },
        workId,
      ),
    ).rejects.toMatchObject({ code: "non-selectable-work" });
    await rm(forgedPointer);

    const before = await fileSnapshot(
      legacyMigrationPaths(rootDir).migrationDir,
    );
    await expect(
      ensureLegacyCheckpointMigration(rootDir, migrationOptions("ignored-id")),
    ).resolves.toMatchObject({ targetWorkId: workId });
    expect(
      await fileSnapshot(legacyMigrationPaths(rootDir).migrationDir),
    ).toEqual(before);

    await writeCandidate(rootDir, "late", checkpoint(3, "closed"));
    await expect(
      ensureLegacyCheckpointMigration(rootDir),
    ).rejects.toMatchObject({ code: "source-drift" });
  });

  it("imports one active v3 candidate when every other candidate is inactive", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "main", checkpoint(3, "active"));
    await writeCandidate(rootDir, "done", checkpoint(3, "closed"));

    const result = await ensureLegacyCheckpointMigration(
      rootDir,
      migrationOptions("mixed-v3"),
    );
    const plan = await readPlan(rootDir);

    expect(result.outcome).toBe("imported");
    expect(plan.importDecision.candidateId).toBe(
      plan.candidates.find((entry) => entry.checkpointPath.includes("main"))
        ?.id,
    );
    expect(plan.candidates.map((entry) => entry.classification).sort()).toEqual(
      ["supported-active-v3", "supported-inactive-v3"],
    );
  });

  it("backs up nested direct-root runtime content", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "root", checkpoint(3), { direct: true });
    const nestedSource = path.join(
      rootDir,
      ".ged",
      "runtime",
      "artifacts",
      "legacy-report.json",
    );
    await mkdir(path.dirname(nestedSource), { recursive: true });
    await writeFile(nestedSource, '{"legacy":true}\n');

    await ensureLegacyCheckpointMigration(
      rootDir,
      migrationOptions("nested-direct-root"),
    );
    const plan = await readPlan(rootDir);
    const manifest = plan.manifest.find(
      (entry) =>
        entry.sourcePath === ".ged/runtime/artifacts/legacy-report.json",
    );
    expect(manifest).toBeDefined();
    expect(
      await readFile(path.join(rootDir, manifest?.backupPath ?? "")),
    ).toEqual(await readFile(nestedSource));
  });

  it("defaults v2 lifecycle but requires explicit v3 lifecycle", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "current-v2", checkpoint(2, "active", false));
    await writeCandidate(rootDir, "done-v3", checkpoint(3, "closed"));

    await expect(
      ensureLegacyCheckpointMigration(
        rootDir,
        migrationOptions("canonical-lifecycle"),
      ),
    ).resolves.toMatchObject({ outcome: "imported" });
    expect(
      (await readPlan(rootDir)).candidates.map((entry) => entry.classification),
    ).toEqual(["supported-active-v2", "supported-inactive-v3"]);

    const missingLifecycleRoot = await tempProject();
    await writeCandidate(
      missingLifecycleRoot,
      "missing-lifecycle",
      checkpoint(3, "active", false),
    );
    await expect(
      ensureLegacyCheckpointMigration(
        missingLifecycleRoot,
        migrationOptions("missing-v3-lifecycle"),
      ),
    ).resolves.toMatchObject({ outcome: "no-import" });
    expect((await readPlan(missingLifecycleRoot)).candidates[0]).toMatchObject({
      classification: "invalid-shape",
    });
  });

  it.each([
    {
      name: "two active root aliases",
      records: [
        { slug: "root", raw: checkpoint(3), direct: true },
        { slug: "root", raw: checkpoint(3) },
      ],
    },
    {
      name: "an active and corrupt record",
      records: [
        { slug: "main", raw: checkpoint(3) },
        { slug: "corrupt", raw: "not-json\n" },
      ],
    },
    {
      name: "a newer schema",
      records: [
        { slug: "main", raw: checkpoint(3) },
        {
          slug: "future",
          raw: '{"schemaVersion":99,"lifecycleStatus":"active"}\n',
        },
      ],
    },
    {
      name: "malformed nested checkpoint records",
      records: [
        { slug: "main", raw: checkpoint(3) },
        {
          slug: "malformed",
          raw: `${JSON.stringify({
            schemaVersion: 3,
            lifecycleStatus: "active",
            classification: "non-trivial",
            classificationReason: "Malformed nested legacy record",
            planCheckpoints: { "ged-planner": "not-a-record" },
            taskCheckpoints: {},
          })}\n`,
        },
      ],
    },
    {
      name: "only inactive work",
      records: [{ slug: "done", raw: checkpoint(3, "verified") }],
    },
    {
      name: "duplicate logical work IDs",
      records: [
        { slug: "one", raw: checkpoint(3), logicalWorkId: "same-slug" },
        {
          slug: "two",
          raw: checkpoint(3, "closed"),
          logicalWorkId: "same-slug",
        },
      ],
    },
  ])("backs up but does not import $name", async ({ records }) => {
    const rootDir = await tempProject();
    const originals = new Map<string, Buffer>();
    for (const record of records) {
      const sourcePath = await writeCandidate(
        rootDir,
        record.slug,
        record.raw,
        {
          direct: "direct" in record ? record.direct : undefined,
          logicalWorkId:
            "logicalWorkId" in record ? record.logicalWorkId : undefined,
        },
      );
      originals.set(sourcePath, await readFile(sourcePath));
    }

    const result = await ensureLegacyCheckpointMigration(
      rootDir,
      migrationOptions(`no-import-${records[0].slug}`),
    );
    const plan = await readPlan(rootDir);

    expect(result).toMatchObject({ status: "completed", outcome: "no-import" });
    expect(plan.targetWorkId).toBeNull();
    for (const [sourcePath, raw] of originals) {
      expect(await readFile(sourcePath)).toEqual(raw);
    }
    for (const entry of plan.manifest) {
      expect(await readFile(path.join(rootDir, entry.backupPath))).toEqual(
        await readFile(path.join(rootDir, entry.sourcePath)),
      );
    }
  });

  it("excludes generated work and fails closed for legacy symlinks", async () => {
    const generatedRoot = await tempProject();
    const generated = await openGedWork(
      generatedRoot,
      { sessionId: "session-a", requestId: "request-a" },
      "Already generated",
    );
    await writeFile(generated.paths.checkpointsPath, checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(generatedRoot),
    ).resolves.toEqual({ status: "not-needed" });

    const unsafeRoot = await tempProject();
    const outside = await tempProject("ged-legacy-outside-");
    await mkdir(path.join(unsafeRoot, ".ged", "runtime"), { recursive: true });
    await symlink(outside, path.join(unsafeRoot, ".ged", "runtime", "legacy"));
    await expect(
      ensureLegacyCheckpointMigration(unsafeRoot),
    ).rejects.toMatchObject({ code: "unsafe-layout" });
  });

  it.skipIf(process.platform === "win32")(
    "rejects checkpoint FIFOs without blocking",
    async () => {
      const rootDir = await tempProject();
      const runtimeDir = path.join(rootDir, ".ged", "runtime", "main");
      await mkdir(runtimeDir, { recursive: true });
      await execFileAsync("mkfifo", [
        path.join(runtimeDir, "checkpoints.json"),
      ]);

      await expect(
        ensureLegacyCheckpointMigration(rootDir),
      ).rejects.toMatchObject({ code: "unsafe-layout" });
    },
  );

  it.each([
    "plan",
    "backup-file",
    "backup-complete",
    "import-started",
    "target-files",
    "governance",
    "import-complete",
  ] as const)("resumes without duplication after interruption at %s", async (phase) => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "main", checkpoint(3));
    let interrupted = false;

    await expect(
      ensureLegacyCheckpointMigration(rootDir, {
        ...migrationOptions(`interrupt-${phase}`),
        afterPhase(current) {
          if (!interrupted && current === phase) {
            interrupted = true;
            throw new Error(`interrupt:${phase}`);
          }
        },
      }),
    ).rejects.toThrow(`interrupt:${phase}`);

    if (phase === "governance") {
      const interruptedPlan = await readPlan(rootDir);
      await rm(
        path.join(
          rootDir,
          ".ged",
          "runtime",
          interruptedPlan.targetWorkId as string,
          "STATE.md",
        ),
      );
    }

    const result = await ensureLegacyCheckpointMigration(
      rootDir,
      migrationOptions("must-not-replace-plan"),
    );
    const plan = await readPlan(rootDir);
    expect(result).toMatchObject({
      outcome: "imported",
      targetWorkId: plan.targetWorkId,
    });
    const state = await readGovernanceState(
      rootDir,
      plan.targetWorkId as string,
    );
    expect(state.evidence).toHaveLength(1);
    expect(state.evidence[0]?.id).toBe(plan.evidenceId);
    const generated = await readdir(path.join(rootDir, ".ged", "work"));
    expect(generated.filter((entry) => isGenerated(entry))).toEqual([
      plan.targetWorkId,
    ]);
  });

  it("rejects source drift, conflicting backup, corrupt journals, and missing completed targets", async () => {
    const sourceDriftRoot = await tempProject();
    const driftSource = await writeCandidate(
      sourceDriftRoot,
      "main",
      checkpoint(3),
    );
    await expect(
      ensureLegacyCheckpointMigration(sourceDriftRoot, {
        ...migrationOptions("source-drift"),
        afterPhase(phase) {
          if (phase === "plan") throw new Error("stop-after-plan");
        },
      }),
    ).rejects.toThrow("stop-after-plan");
    await writeFile(driftSource, "changed\n");
    await expect(
      ensureLegacyCheckpointMigration(sourceDriftRoot),
    ).rejects.toMatchObject({ code: "source-drift" });

    const conflictRoot = await tempProject();
    await writeCandidate(conflictRoot, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(conflictRoot, {
        ...migrationOptions("backup-conflict"),
        afterPhase(phase) {
          if (phase === "plan") throw new Error("stop-after-plan");
        },
      }),
    ).rejects.toThrow("stop-after-plan");
    const conflictPlan = await readPlan(conflictRoot);
    const backupPath = path.join(
      conflictRoot,
      conflictPlan.manifest[0]?.backupPath ?? "",
    );
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "conflict\n");
    await expect(
      ensureLegacyCheckpointMigration(conflictRoot),
    ).rejects.toMatchObject({ code: "artifact-conflict" });

    const corruptRoot = await tempProject();
    await writeCandidate(corruptRoot, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(corruptRoot, {
        ...migrationOptions("corrupt-plan"),
        afterPhase(phase) {
          if (phase === "plan") throw new Error("stop-after-plan");
        },
      }),
    ).rejects.toThrow("stop-after-plan");
    await writeFile(
      legacyMigrationPaths(corruptRoot).planPath,
      '{"schemaVersion":99}\n',
    );
    await expect(
      ensureLegacyCheckpointMigration(corruptRoot),
    ).rejects.toMatchObject({ code: "invalid-journal" });

    const missingRoot = await tempProject();
    await writeCandidate(missingRoot, "main", checkpoint(3));
    const completed = await ensureLegacyCheckpointMigration(
      missingRoot,
      migrationOptions("missing-target"),
    );
    await rm(
      path.join(missingRoot, ".ged", "work", completed.targetWorkId as string),
      { recursive: true },
    );
    await expect(
      ensureLegacyCheckpointMigration(missingRoot),
    ).rejects.toMatchObject({ code: "integrity-failure" });
  });

  it("rejects semantically corrupt plans, skipped phases, and symlinked journals", async () => {
    const semanticRoot = await tempProject();
    await writeCandidate(semanticRoot, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(semanticRoot, {
        ...migrationOptions("semantic-plan"),
        afterPhase(phase) {
          if (phase === "plan") throw new Error("stop-after-plan");
        },
      }),
    ).rejects.toThrow("stop-after-plan");
    const semanticPlan = await readPlan(semanticRoot);
    await writeFile(
      legacyMigrationPaths(semanticRoot).planPath,
      `${JSON.stringify({ ...semanticPlan, manifest: [] }, null, 2)}\n`,
    );
    await expect(
      ensureLegacyCheckpointMigration(semanticRoot),
    ).rejects.toMatchObject({ code: "invalid-journal" });

    const skippedRoot = await tempProject();
    await writeCandidate(skippedRoot, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(skippedRoot, {
        ...migrationOptions("skipped-phase"),
        afterPhase(phase) {
          if (phase === "backup-complete") {
            throw new Error("stop-after-backup");
          }
        },
      }),
    ).rejects.toThrow("stop-after-backup");
    const skippedPlan = await readPlan(skippedRoot);
    await writeFile(
      legacyMigrationPaths(skippedRoot).importCompletePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          migrationId: skippedPlan.migrationId,
          phase: "import-complete",
          recordedAt: skippedPlan.createdAt,
          outcome: "imported",
          targetWorkId: skippedPlan.targetWorkId,
        },
        null,
        2,
      )}\n`,
    );
    await expect(
      ensureLegacyCheckpointMigration(skippedRoot),
    ).rejects.toMatchObject({ code: "invalid-journal" });

    const symlinkRoot = await tempProject();
    await writeCandidate(symlinkRoot, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(symlinkRoot, {
        ...migrationOptions("symlink-plan"),
        afterPhase(phase) {
          if (phase === "plan") throw new Error("stop-after-plan");
        },
      }),
    ).rejects.toThrow("stop-after-plan");
    const planPath = legacyMigrationPaths(symlinkRoot).planPath;
    const externalPlan = path.join(
      await tempProject("ged-external-plan-"),
      "PLAN.json",
    );
    await writeFile(externalPlan, await readFile(planPath));
    await rm(planPath);
    await symlink(externalPlan, planPath);
    await expect(
      ensureLegacyCheckpointMigration(symlinkRoot),
    ).rejects.toMatchObject({ code: "unsafe-layout" });
  });

  it("fails closed when legacy inventory changes after planning", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(rootDir, {
        ...migrationOptions("inventory-drift"),
        afterPhase(phase) {
          if (phase === "plan") throw new Error("stop-after-plan");
        },
      }),
    ).rejects.toThrow("stop-after-plan");
    await writeCandidate(rootDir, "second", checkpoint(3));

    await expect(
      ensureLegacyCheckpointMigration(rootDir),
    ).rejects.toMatchObject({ code: "source-drift" });
    const plan = await readPlan(rootDir);
    await expect(
      readFile(
        path.join(
          rootDir,
          ".ged",
          "work",
          plan.targetWorkId as string,
          "META.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite a conflicting partial target projection", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(rootDir, {
        ...migrationOptions("projection-conflict"),
        afterPhase(phase) {
          if (phase === "target-files") throw new Error("stop-after-target");
        },
      }),
    ).rejects.toThrow("stop-after-target");
    const plan = await readPlan(rootDir);
    const statePath = path.join(
      rootDir,
      ".ged",
      "runtime",
      plan.targetWorkId as string,
      "STATE.md",
    );
    await writeFile(statePath, "user-owned conflict\n");

    await expect(
      ensureLegacyCheckpointMigration(rootDir),
    ).rejects.toMatchObject({ code: "artifact-conflict" });
    expect(await readFile(statePath, "utf8")).toBe("user-owned conflict\n");
  });

  it("concurrent callers converge on one immutable plan and import", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "main", checkpoint(3));

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        ensureLegacyCheckpointMigration(
          rootDir,
          migrationOptions(`concurrent-${index}`),
        ),
      ),
    );
    const plan = await readPlan(rootDir);
    expect(new Set(results.map((result) => result.migrationId))).toEqual(
      new Set([plan.migrationId]),
    );
    expect(new Set(results.map((result) => result.targetWorkId))).toEqual(
      new Set([plan.targetWorkId]),
    );
    expect(
      (await readdir(path.join(rootDir, ".ged", "work"))).filter((entry) =>
        isGenerated(entry),
      ),
    ).toEqual([plan.targetWorkId]);
  });

  it("separate Node processes converge on one plan and import", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "main", checkpoint(3));
    const script = `
      import { createJiti } from "jiti";
      const jiti = createJiti(process.cwd() + "/migration-child.mjs");
      const migration = await jiti.import("./src/legacy-migration.ts");
      const result = await migration.ensureLegacyCheckpointMigration(process.env.GED_TEST_ROOT);
      process.stdout.write(JSON.stringify(result));
    `;
    const runChild = () =>
      execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: path.resolve("."),
        env: { ...process.env, GED_TEST_ROOT: rootDir },
      });

    const children = await Promise.all([runChild(), runChild()]);
    const results = children.map(
      ({ stdout }) =>
        JSON.parse(stdout) as { migrationId: string; targetWorkId: string },
    );
    expect(new Set(results.map((result) => result.migrationId))).toHaveLength(
      1,
    );
    expect(new Set(results.map((result) => result.targetWorkId))).toHaveLength(
      1,
    );
    await expect(
      ensureLegacyCheckpointMigration(rootDir),
    ).resolves.toMatchObject({
      status: "completed",
      targetWorkId: results[0]?.targetWorkId,
    });
  });

  it("runs before bootstrap selection and blocks initialization on integrity failure", async () => {
    const rootDir = await tempProject();
    await writeCandidate(rootDir, "main", checkpoint(3));

    await ensureGedProjectCurrent(rootDir);
    const plan = await readPlan(rootDir);
    const pointer = await readActiveWorkPointer(rootDir);
    expect(pointer?.workId).not.toBe(plan.targetWorkId);
    expect(pointer?.operation).toBe("bootstrap");

    const directRoot = await tempProject();
    await writeCandidate(directRoot, "main", checkpoint(3));
    await initializeGedProject(directRoot);
    const directPlan = await readPlan(directRoot);
    expect((await readActiveWorkPointer(directRoot))?.workId).not.toBe(
      directPlan.targetWorkId,
    );

    const blockedRoot = await tempProject();
    const source = await writeCandidate(blockedRoot, "main", checkpoint(3));
    await expect(
      ensureLegacyCheckpointMigration(blockedRoot, {
        ...migrationOptions("blocked-init"),
        afterPhase(phase) {
          if (phase === "plan") throw new Error("stop-after-plan");
        },
      }),
    ).rejects.toThrow("stop-after-plan");
    await writeFile(source, "drifted\n");
    await expect(ensureGedProjectCurrent(blockedRoot)).rejects.toMatchObject({
      code: "source-drift",
    });
    await expect(
      readFile(activeWorkPointerPath(blockedRoot)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(blockedRoot, ".ged", "VERSION")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function isGenerated(workId: string): boolean {
  return /^.+-\d{17}-[a-f0-9]{32}$/u.test(workId);
}

import { execFile } from "node:child_process";
