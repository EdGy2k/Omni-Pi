import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { readConfig, writeConfig } from "../src/config.js";
import {
  consumeBudget,
  createBudget,
  estimateTokens,
  fitsInBudget,
  gatherPhaseContext,
  gatherTaskContext,
  getPhaseFiles,
  renderContextSummary,
} from "../src/context.js";
import { detectPreset } from "../src/contracts.js";
import { detectStuck, renderDoctorReport, runDoctor } from "../src/doctor.js";
import { activeGedPaths, relativeGedPath } from "../src/ged-paths.js";
import {
  buildBranchName,
  buildCommitMessage,
  generatePrBody,
  prepareCommitPlan,
} from "../src/git.js";
import { gatherPlanningContext, renderTasksMarkdown } from "../src/planning.js";
import {
  appendProgress,
  cleanupCompletedPlans,
  createPlan,
  readPlanIndex,
  readProgress,
  renderPlanIndex,
  updatePlanStatus,
} from "../src/plans.js";
import {
  applyInstallResults,
  cleanupUnusedProjectSkills,
  ensureTaskSkillDependencies,
  loadSkillTriggers,
  matchSkillsForTask,
  projectSkillsDir,
  readSkillRegistry,
} from "../src/skills.js";
import { renderCompactStatus, renderPlainStatus } from "../src/status.js";
import {
  findNextExecutableTask,
  readTasks,
  renderTaskTable,
  updateTaskStatus,
} from "../src/tasks.js";
import type { WorkEngine } from "../src/work.js";
import {
  initializeGedProject,
  planGedProject,
  readGedStatus,
  syncGedProject,
  workOnGedProject,
} from "../src/workflow.js";

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Ged workflow", () => {
  test("initializeGedProject creates starter files and recommends skills", async () => {
    const rootDir = await createTempProject("ged-init-");

    const result = await initializeGedProject(rootDir);
    const paths = await activeGedPaths(rootDir);

    expect(result.created).toContain(".ged/VERSION");
    expect(result.created).toContain(".ged/PROJECT.md");
    expect(result.created).toContain(relativeGedPath(rootDir, paths.statePath));
    expect(result.created).toContain(".pi/agents/ged-brain.md");
    expect(
      result.skillCandidates.some(
        (candidate) => candidate.name === "find-skills",
      ),
    ).toBe(true);

    const skillsContent = await readFile(
      path.join(rootDir, ".ged", "SKILLS.md"),
      "utf8",
    );
    expect(skillsContent).toContain("find-skills");
    expect(skillsContent).toContain("skill-creator");
    expect(skillsContent).toContain("auto-install");
    expect(skillsContent).not.toContain("Planned install commands:");

    const registry = await readSkillRegistry(rootDir);
    expect(
      registry.installed.some((skill) => skill.name === "find-skills"),
    ).toBe(true);
    expect(
      registry.installed.some((skill) => skill.name === "skill-creator"),
    ).toBe(true);
  });

  test("initializeGedProject discovers repo-wide standards and leaves them pending without confirmation", async () => {
    const rootDir = await createTempProject("ged-init-standards-");
    await writeFile(
      path.join(rootDir, "AGENTS.md"),
      "# AGENTS\n\nKeep diffs small and test changes.",
      "utf8",
    );

    const result = await initializeGedProject(rootDir);
    const standards = await readFile(
      path.join(rootDir, ".ged", "STANDARDS.md"),
      "utf8",
    );

    expect(
      result.discoveredStandards.some((entry) => entry.path === "AGENTS.md"),
    ).toBe(true);
    expect(
      result.pendingStandards.some((entry) => entry.path === "AGENTS.md"),
    ).toBe(true);
    expect(result.standardsPromptNeeded).toBe(true);
    expect(standards).toContain(
      "No imported standards have been accepted yet.",
    );
  });

  test("initializeGedProject can import discovered standards when confirmed", async () => {
    const rootDir = await createTempProject("ged-init-standards-accept-");
    await writeFile(
      path.join(rootDir, "CLAUDE.md"),
      "# CLAUDE\n\nPrefer updating docs when behavior changes.",
      "utf8",
    );

    const result = await initializeGedProject(rootDir, {
      ui: {
        async confirm() {
          return true;
        },
      },
    });
    const standards = await readFile(
      path.join(rootDir, ".ged", "STANDARDS.md"),
      "utf8",
    );

    expect(
      result.acceptedStandards.some((entry) => entry.path === "CLAUDE.md"),
    ).toBe(true);
    expect(result.pendingStandards).toEqual([]);
    expect(standards).toContain("CLAUDE.md");
    expect(standards).toContain("Prefer updating docs when behavior changes.");
  });

  test("initializeGedProject adds .pi to .gitignore in git repos", async () => {
    const rootDir = await createTempProject("ged-init-gitignore-");
    await mkdir(path.join(rootDir, ".git"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".gitignore"),
      "node_modules/\n",
      "utf8",
    );

    const result = await initializeGedProject(rootDir);
    const gitignore = await readFile(path.join(rootDir, ".gitignore"), "utf8");

    expect(result.gitignoreUpdated).toBe(true);
    expect(gitignore).toContain(".pi/");
  });

  test("initializeGedProject detects repo signals from a TypeScript frontend project", async () => {
    const rootDir = await createTempProject("ged-signals-");

    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify(
        {
          name: "demo",
          dependencies: { react: "1.0.0", next: "1.0.0" },
          devDependencies: { vitest: "1.0.0", typescript: "1.0.0" },
        },
        null,
        2,
      ),
      "utf8",
    );

    await writeFile(
      path.join(rootDir, "playwright.config.ts"),
      "export default {};",
      "utf8",
    );
    await writeFile(path.join(rootDir, "tsconfig.json"), "{}", "utf8");

    const result = await initializeGedProject(rootDir);

    expect(result.repoSignals.languages).toContain("typescript");
    expect(result.repoSignals.frameworks).toContain("react");
    expect(result.repoSignals.frameworks).toContain("nextjs");
    expect(result.repoSignals.tools).toContain("playwright");
    expect(
      result.skillCandidates.some(
        (candidate) => candidate.name === "browser-test-helpers",
      ),
    ).toBe(true);
  });

  test("initializeGedProject detects Python, Go, and Rust projects", async () => {
    const rootDir = await createTempProject("ged-signals-multi-");
    await writeFile(path.join(rootDir, "requirements.txt"), "flask\n", "utf8");
    await writeFile(path.join(rootDir, "go.mod"), "module example\n", "utf8");
    await writeFile(path.join(rootDir, "Cargo.toml"), "[package]\n", "utf8");
    await writeFile(path.join(rootDir, "Makefile"), "all:\n", "utf8");

    const result = await initializeGedProject(rootDir);

    expect(result.repoSignals.languages).toContain("python");
    expect(result.repoSignals.languages).toContain("go");
    expect(result.repoSignals.languages).toContain("rust");
    expect(result.repoSignals.tools).toContain("make");
    expect(
      result.skillCandidates.some(
        (candidate) =>
          candidate.name === "rust-debugging" ||
          candidate.name === "rust-ui-architecture",
      ),
    ).toBe(false);
  });

  test("initializeGedProject marks sparse repos as needing onboarding clarification", async () => {
    const rootDir = await createTempProject("ged-init-onboarding-");

    const result = await initializeGedProject(rootDir);
    const state = await readGedStatus(rootDir);

    expect(result.onboardingInterviewNeeded).toBe(true);
    expect(result.onboardingReason).toContain("First-run onboarding needed");
    expect(state.activeTask).toBe("Run onboarding clarification");
    expect(state.nextStep).toContain("Run a short grill-me clarification");
  });

  test("initializeGedProject skips onboarding clarification for well-documented repos", async () => {
    const rootDir = await createTempProject("ged-init-docs-clear-");
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        name: "clear-repo",
        description:
          "A documented product for operations teams to manage deployment workflows safely.",
      }),
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "README.md"),
      `# Clear Repo

This product helps operations teams manage deployment workflows safely across multiple environments. It exists to reduce release errors and make approvals auditable. Success means teams can ship with fewer incidents and a clear record of why each deployment happened.

## Users

Platform engineers, release managers, and operators use the system every day.

## Constraints

The product must preserve audit history, avoid surprise downtime, and keep rollback steps explicit. Non-goals include replacing the underlying CI provider or storing long-term secrets.
`,
      "utf8",
    );
    await mkdir(path.join(rootDir, "docs"), { recursive: true });
    await writeFile(
      path.join(rootDir, "docs", "architecture.md"),
      "# Architecture\n\nSystem overview.",
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "docs", "constraints.md"),
      "# Constraints\n\nOperational limits and non-goals.",
      "utf8",
    );

    const result = await initializeGedProject(rootDir);
    const state = await readGedStatus(rootDir);

    expect(result.onboardingInterviewNeeded).toBe(false);
    expect(state.activeTask).toBe("Capture exact requirements");
  });

  test("planGedProject writes spec, tasks, tests, and updates status", async () => {
    const rootDir = await createTempProject("ged-plan-");
    await initializeGedProject(rootDir);

    const result = await planGedProject(rootDir, {
      summary: "Build a guided planning workflow for GedPi.",
      desiredOutcome: "Guided planning workflow",
      constraints: ["Keep tasks small", "Stay beginner-friendly"],
      userSignals: [],
    });

    const spec = await readFile(result.specPath, "utf8");
    const tasks = await readFile(result.tasksPath, "utf8");
    const tests = await readFile(result.testsPath, "utf8");

    expect(spec).toContain("Guided planning workflow");
    expect(tasks).toContain("T01");
    expect(tests).toContain(
      "Implementation retries before the plan must be tightened: 2",
    );

    const state = await readGedStatus(rootDir);
    expect(state.currentPhase).toBe("plan");
    expect(state.nextStep).toContain("Implement the next bounded slice");
  });

  test("readGedStatus returns a plain-English status summary", async () => {
    const rootDir = await createTempProject("ged-status-");
    await initializeGedProject(rootDir);

    const status = await readGedStatus(rootDir);
    const rendered = renderPlainStatus(status);

    expect(rendered).toContain("Phase: Understand");
    expect(rendered).toContain("Active task: Run onboarding clarification");
    expect(rendered).toContain("Next step:");
  });

  test("workOnGedProject completes the next task when verification passes", async () => {
    const rootDir = await createTempProject("ged-work-pass-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build the first slice.",
      desiredOutcome: "Build the first slice.",
      constraints: [],
      userSignals: [],
    });

    const engine: WorkEngine = {
      async runTask(task) {
        return {
          summary: `Completed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: true,
            checksRun: ["npm test"],
            failureSummary: [],
            retryRecommended: false,
          },
        };
      },
    };

    const result = await workOnGedProject(rootDir, engine);
    const paths = await activeGedPaths(rootDir);
    const tasks = await readFile(paths.tasksPath, "utf8");

    expect(result.kind).toBe("completed");
    expect(result.message).toContain("Verification passed: npm test");
    expect(tasks).toContain(
      "| T01 | Lock the exact user requirements | - | done |",
    );
  });

  test("workOnGedProject records retryable failures before recovery", async () => {
    const rootDir = await createTempProject("ged-work-retry-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build the first slice.",
      desiredOutcome: "Build the first slice.",
      constraints: [],
      userSignals: [],
    });

    const engine: WorkEngine = {
      async runTask(task) {
        return {
          summary: `Failed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: false,
            checksRun: ["npm test"],
            failureSummary: ["Unit test failed"],
            retryRecommended: true,
          },
        };
      },
    };

    const result = await workOnGedProject(rootDir, engine);
    const history = await readFile(
      path.join(rootDir, ".ged", "tasks", "T01.history.json"),
      "utf8",
    );

    expect(result.kind).toBe("blocked");
    expect(result.message).toContain("queued for retry");
    expect(result.message).toContain("Verification failed: npm test");
    expect(history).toContain("Unit test failed");
  });

  test("workOnGedProject blocks the task after the retry limit and writes recovery notes", async () => {
    const rootDir = await createTempProject("ged-work-blocked-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build the first slice.",
      desiredOutcome: "Build the first slice.",
      constraints: [],
      userSignals: [],
    });

    let runCalls = 0;
    const engine: WorkEngine = {
      async runTask(task) {
        runCalls += 1;
        return {
          summary: `Failed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: false,
            checksRun: ["npm test"],
            failureSummary: [`Attempt failure ${runCalls}`],
            retryRecommended: true,
          },
        };
      },
    };

    const firstResult = await workOnGedProject(rootDir, engine);
    const secondResult = await workOnGedProject(rootDir, engine);
    const paths = await activeGedPaths(rootDir);
    const tasks = await readFile(paths.tasksPath, "utf8");
    const recovery = await readFile(
      path.join(rootDir, ".ged", "tasks", "T01-RECOVERY.md"),
      "utf8",
    );

    expect(firstResult.kind).toBe("blocked");
    expect(secondResult.kind).toBe("blocked");
    expect(secondResult.message).toContain(
      "remains blocked after 2 implementation attempts",
    );
    expect(tasks).toContain(
      "| T01 | Lock the exact user requirements | - | blocked |",
    );
    expect(recovery).toContain("Attempt failure 1");
  });

  test("workOnGedProject surfaces recovery options when repeated attempts fail", async () => {
    const rootDir = await createTempProject("ged-work-recovery-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build the first slice.",
      desiredOutcome: "Build the first slice.",
      constraints: [],
      userSignals: [],
    });

    let runCalls = 0;
    const engine: WorkEngine = {
      async runTask(task) {
        runCalls += 1;
        return {
          summary: `Failed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: false,
            checksRun: ["npm test"],
            failureSummary: [`Attempt failure ${runCalls}`],
            retryRecommended: true,
          },
        };
      },
    };

    await workOnGedProject(rootDir, engine);
    const result = await workOnGedProject(rootDir, engine);
    const state = await readGedStatus(rootDir);

    expect(result.kind).toBe("blocked");
    expect(result.message).toContain("remains blocked");
    expect(result.recoveryOptions).toBeDefined();
    expect(result.recoveryOptions?.length).toBeGreaterThan(0);
    expect(state.currentPhase).toBe("check");
    expect(state.recoveryOptions).toBeDefined();
    expect(state.recoveryOptions?.length).toBeGreaterThan(0);

    const rendered = renderPlainStatus(state);
    expect(rendered).toContain("Recovery options:");
  });

  test("gatherPlanningContext collects decisions, session notes, and completed tasks", async () => {
    const rootDir = await createTempProject("ged-plan-ctx-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build the first slice.",
      desiredOutcome: "Build the first slice.",
      constraints: [],
      userSignals: [],
    });

    await syncGedProject(rootDir, {
      summary: "Completed initial setup",
      decisions: ["Use React for the frontend"],
      nextHandoffNotes: ["Ready for implementation"],
    });

    const ctx = await gatherPlanningContext(rootDir);
    expect(ctx.existingDecisions).toContain("Use React for the frontend");
    expect(ctx.sessionNotes).toContain("Completed initial setup");
    expect(ctx.priorScope.length).toBeGreaterThan(0);
  });

  test("planGedProject incorporates prior decisions into the spec", async () => {
    const rootDir = await createTempProject("ged-plan-enrich-");
    await initializeGedProject(rootDir);
    await syncGedProject(rootDir, {
      summary: "Decided on the architecture",
      decisions: ["Use server components"],
    });

    await planGedProject(rootDir, {
      summary: "Build a feature.",
      desiredOutcome: "Working feature",
      constraints: [],
      userSignals: [],
    });

    const paths = await activeGedPaths(rootDir);
    const spec = await readFile(paths.specPath, "utf8");
    expect(spec).toContain("Use server components");
  });

  test("planGedProject archives unrelated prior tasks and resets carried task state", async () => {
    const rootDir = await createTempProject("ged-plan-unrelated-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build auth flow",
      desiredOutcome: "Auth flow",
      constraints: [],
      userSignals: [],
    });

    const engine: WorkEngine = {
      async runTask(task) {
        return {
          summary: `Completed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: true,
            checksRun: ["npm test"],
            failureSummary: [],
            retryRecommended: false,
          },
        };
      },
    };

    await workOnGedProject(rootDir, engine);
    await planGedProject(rootDir, {
      summary: "Fix payment webhook retries",
      desiredOutcome: "Webhook reliability",
      constraints: [],
      userSignals: [],
    });

    const paths = await activeGedPaths(rootDir);
    const spec = await readFile(paths.specPath, "utf8");
    const tasks = await readFile(paths.tasksPath, "utf8");
    const sessionSummary = await readFile(paths.sessionSummaryPath, "utf8");
    const plans = await readPlanIndex(rootDir);

    expect(spec).toContain("Webhook reliability");
    expect(spec).not.toContain("Build auth flow");
    expect(tasks).toContain(
      "| T01 | Lock the exact user requirements | - | todo |",
    );
    expect(sessionSummary).toContain("## Archived task summaries");
    expect(sessionSummary).toContain("Auth flow");
    expect(sessionSummary).toContain(
      "T01 (done): Lock the exact user requirements",
    );
    expect(plans.some((plan) => plan.status === "discarded")).toBe(true);
  });

  test("planGedProject keeps carried task state for related follow-up requests", async () => {
    const rootDir = await createTempProject("ged-plan-related-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build auth flow",
      desiredOutcome: "Auth flow",
      constraints: [],
      userSignals: [],
    });

    const engine: WorkEngine = {
      async runTask(task) {
        return {
          summary: `Completed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: true,
            checksRun: ["npm test"],
            failureSummary: [],
            retryRecommended: false,
          },
        };
      },
    };

    await workOnGedProject(rootDir, engine);
    await planGedProject(rootDir, {
      summary: "Improve auth error handling",
      desiredOutcome: "Auth error handling",
      constraints: [],
      userSignals: [],
    });

    const paths = await activeGedPaths(rootDir);
    const tasks = await readFile(paths.tasksPath, "utf8");
    const sessionSummary = await readFile(paths.sessionSummaryPath, "utf8");

    expect(tasks).toContain(
      "| T01 | Lock the exact user requirements | - | done |",
    );
    expect(sessionSummary).not.toContain("## Archived task summaries");
  });

  test("applyInstallResults moves failed skills to deferred", async () => {
    const rootDir = await createTempProject("ged-skill-recovery-");
    await initializeGedProject(rootDir);

    const recovery = await applyInstallResults(rootDir, [
      { name: "find-skills", success: false, error: "network timeout" },
    ]);

    expect(recovery.deferred).toContain("find-skills");
    const registry = await readSkillRegistry(rootDir);
    expect(registry.deferred.some((s) => s.name === "find-skills")).toBe(true);
    expect(registry.deferred[0].reason).toContain("network timeout");
    expect(registry.installed.some((s) => s.name === "find-skills")).toBe(
      false,
    );
  });

  test("ensureTaskSkillDependencies installs bundled skills project-scope", async () => {
    const rootDir = await createTempProject("ged-skill-deps-");
    await initializeGedProject(rootDir);
    const paths = await activeGedPaths(rootDir);

    const result = await ensureTaskSkillDependencies(rootDir, {
      id: "T01",
      title: "Lock requirements",
      objective: "Refine the implementation-ready spec.",
      contextFiles: [relativeGedPath(rootDir, paths.specPath)],
      skills: ["ged-planning"],
      doneCriteria: ["Requirements are explicit."],
      status: "todo",
      dependsOn: [],
    });

    const skillFile = await readFile(
      path.join(projectSkillsDir(rootDir), "ged-planning", "SKILL.md"),
      "utf8",
    );

    expect(result.task.skills).toContain("ged-planning");
    expect(result.installed).toContain("ged-planning");
    expect(skillFile).toContain("ged-planning");
  });

  test("ensureTaskSkillDependencies creates a project skill when no skill matches", async () => {
    const rootDir = await createTempProject("ged-skill-create-");
    await initializeGedProject(rootDir);

    const result = await ensureTaskSkillDependencies(rootDir, {
      id: "T77",
      title: "Invent niche protocol adapter",
      objective: "Implement a custom adapter for an internal protocol.",
      contextFiles: [],
      skills: ["totally-missing-project-skill"],
      doneCriteria: ["Adapter is documented."],
      status: "todo",
      dependsOn: [],
    });

    expect(result.created.length).toBe(1);
    const createdName = result.created[0];
    const createdSkill = await readFile(
      path.join(projectSkillsDir(rootDir), createdName, "SKILL.md"),
      "utf8",
    );
    expect(result.task.skills).toContain(createdName);
    expect(createdSkill).toContain("Project-specific skill");
  });

  test("cleanupUnusedProjectSkills removes project skills with no active task refs", async () => {
    const rootDir = await createTempProject("ged-skill-cleanup-");
    await initializeGedProject(rootDir);

    const ensured = await ensureTaskSkillDependencies(rootDir, {
      id: "T99",
      title: "Invent niche protocol adapter",
      objective: "Implement a custom adapter for an internal protocol.",
      contextFiles: [],
      skills: [],
      doneCriteria: ["Adapter is documented."],
      status: "todo",
      dependsOn: [],
    });

    const removed = await cleanupUnusedProjectSkills(rootDir, []);

    expect(removed).toContain(ensured.task.skills[0]);
  });

  test("modified files are preserved in recovery notes after repeated failures", async () => {
    const rootDir = await createTempProject("ged-work-modfiles-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build the first slice.",
      desiredOutcome: "Build the first slice.",
      constraints: [],
      userSignals: [],
    });

    let runCalls = 0;
    const engine: WorkEngine = {
      async runTask(task) {
        runCalls += 1;
        return {
          summary: `Failed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: false,
            checksRun: ["npm test"],
            failureSummary: [`Attempt failure ${runCalls}`],
            retryRecommended: true,
          },
          modifiedFiles: ["src/feature.ts"],
        };
      },
    };

    await workOnGedProject(rootDir, engine);
    await workOnGedProject(rootDir, engine);
    const recovery = await readFile(
      path.join(rootDir, ".ged", "tasks", "T01-RECOVERY.md"),
      "utf8",
    );
    expect(recovery).toContain("src/feature.ts");
  });

  test("renderCompactStatus produces a widget-friendly status array", async () => {
    const rootDir = await createTempProject("ged-compact-");
    await initializeGedProject(rootDir);
    const state = await readGedStatus(rootDir);
    const lines = renderCompactStatus(state);

    expect(lines[0]).toContain("GedPi Brain");
    expect(lines.some((l) => l.includes("Focus:"))).toBe(true);
    expect(lines.some((l) => l.includes("Next:"))).toBe(true);
  });

  test("renderCompactStatus falls back gracefully for unknown phases", () => {
    const lines = renderCompactStatus({
      currentPhase: "weird-phase" as never,
      activeTask: "Await user feedback",
      statusSummary: "Waiting for clarification.",
      blockers: [],
      nextStep: "Answer the open questions.",
    });

    expect(lines[0]).toBe("GedPi Brain");
  });

  test("renderCompactStatus shows working only when not awaiting user input", () => {
    const lines = renderCompactStatus({
      currentPhase: "build",
      activeTask: "Implement the next slice",
      statusSummary: "Implementing the requested change.",
      blockers: [],
      nextStep: "Run the planned verification checks.",
    });

    expect(lines[0]).toContain("[Working]");
  });

  test("loadSkillTriggers and matchSkillsForTask match execution triggers", async () => {
    const skillsDir = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "skills",
    );
    const triggers = await loadSkillTriggers(skillsDir);
    expect(triggers.length).toBeGreaterThan(0);

    const matched = matchSkillsForTask(
      {
        id: "T01",
        title: "Implement the feature",
        objective: "Execute the implementation",
        contextFiles: [],
        skills: [],
        doneCriteria: [],
        status: "todo",
        dependsOn: [],
      },
      triggers,
    );
    expect(matched.some((s) => s.name === "ged-execution")).toBe(true);
  });

  test("loadSkillTriggers captures all trigger keywords from skill descriptions", async () => {
    const skillsDir = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "skills",
    );
    const triggers = await loadSkillTriggers(skillsDir);
    const verification = triggers.find((t) => t.name === "ged-verification");
    expect(verification).toBeDefined();
    expect(verification?.triggers).toContain("verify");
    expect(verification?.triggers).toContain("test");
    expect(verification?.triggers).toContain("check");
    expect(verification?.triggers).toContain("did it work");
  });

  test("buildBranchName and buildCommitMessage format git artifacts", () => {
    const branch = buildBranchName("T01");
    expect(branch).toBe("ged/t01");

    const message = buildCommitMessage({
      id: "T01",
      title: "Add auth flow",
      objective: "Implement authentication",
      contextFiles: [],
      skills: [],
      doneCriteria: ["Auth works"],
      status: "done",
      dependsOn: [],
    });
    expect(message).toContain("feat(T01): Add auth flow");
    expect(message).toContain("Auth works");
  });

  test("generatePrBody creates a structured PR description", () => {
    const body = generatePrBody(
      {
        id: "T01",
        title: "Add auth",
        objective: "Implement auth",
        contextFiles: [],
        skills: [],
        doneCriteria: ["Works", "Tests pass"],
        status: "done",
        dependsOn: [],
      },
      "All checks passed",
    );
    expect(body).toContain("Implements T01");
    expect(body).toContain("- [x] Works");
    expect(body).toContain("All checks passed");
  });

  test("prepareCommitPlan reads the last completed task", async () => {
    const rootDir = await createTempProject("ged-commit-plan-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build a feature.",
      desiredOutcome: "Working feature",
      constraints: [],
      userSignals: [],
    });

    const engine: WorkEngine = {
      async runTask(task) {
        return {
          summary: `Completed ${task.id}`,
          verification: {
            taskId: task.id,
            passed: true,
            checksRun: ["npm test"],
            failureSummary: [],
            retryRecommended: false,
          },
        };
      },
    };

    await workOnGedProject(rootDir, engine);
    const plan = await prepareCommitPlan(rootDir);

    expect(plan).not.toBeNull();
    expect(plan?.taskId).toBe("T01");
    expect(plan?.branch).toBe("ged/t01");
    expect(plan?.message).toContain("T01");
  });

  test("userSignals are incorporated into spec scope", async () => {
    const rootDir = await createTempProject("ged-plan-signals-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Build auth.",
      desiredOutcome: "Auth system",
      constraints: [],
      userSignals: ["Primary users: developers"],
    });

    const paths = await activeGedPaths(rootDir);
    const spec = await readFile(paths.specPath, "utf8");
    expect(spec).toContain("Primary users: developers");
  });

  test("detectPreset infers workflow from branch name and brief", () => {
    expect(detectPreset("fix/login-loop", "")).toBe("bugfix");
    expect(detectPreset("", "refactor the auth module")).toBe("refactor");
    expect(detectPreset("feat/oauth", "")).toBe("feature");
    expect(detectPreset("", "spike on new API")).toBe("spike");
    expect(detectPreset("", "security audit of payment module")).toBe(
      "security-audit",
    );
    expect(detectPreset("main", "")).toBeNull();
  });

  test("planGedProject respects bugfix preset by limiting tasks", async () => {
    const rootDir = await createTempProject("ged-plan-preset-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "Fix the login redirect loop",
      desiredOutcome: "Login works",
      constraints: [],
      userSignals: [],
      preset: "bugfix",
    });

    const paths = await activeGedPaths(rootDir);
    const spec = await readFile(paths.specPath, "utf8");
    const tasks = await readFile(paths.tasksPath, "utf8");

    expect(spec).toContain("bugfix");
    expect(spec).toContain("root cause");
    const taskRows = tasks.split("\n").filter((line) => line.startsWith("| T"));
    expect(taskRows.length).toBeLessThanOrEqual(2);
  });

  test("readConfig parses a written CONFIG.md correctly", async () => {
    const rootDir = await createTempProject("ged-config-");
    await initializeGedProject(rootDir);

    await writeConfig(rootDir, {
      models: {
        brain: "openai/gpt-5.4",
      },
      cleanupCompletedPlans: true,
    });

    const config = await readConfig(rootDir);
    expect(config.models.brain).toBe("openai/gpt-5.4");
    expect(config.cleanupCompletedPlans).toBe(true);
  });

  test("runDoctor reports healthy on an initialized project", async () => {
    const rootDir = await createTempProject("ged-doctor-");
    await initializeGedProject(rootDir);
    await writeFile(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { typescript: "1" } }),
      "utf8",
    );
    await writeFile(path.join(rootDir, "tsconfig.json"), "{}", "utf8");

    const report = await runDoctor(rootDir);
    expect(report.overall).toBe("green");
    expect(
      report.checks.some((c) => c.name === "ged-init" && c.level === "green"),
    ).toBe(true);

    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("[OK] green");
  });

  test("runDoctor reports red when .ged/ is missing", async () => {
    const rootDir = await createTempProject("ged-doctor-missing-");
    const report = await runDoctor(rootDir);
    expect(report.overall).toBe("red");
    expect(
      report.checks.some((c) => c.name === "ged-init" && c.level === "red"),
    ).toBe(true);
  });

  test("createPlan writes a plan file and updates the index", async () => {
    const rootDir = await createTempProject("ged-plans-");
    await initializeGedProject(rootDir);

    const entry = await createPlan(rootDir, "Add auth", "Implement auth flow", [
      "Setup JWT",
      "Add login endpoint",
    ]);

    expect(entry.status).toBe("active");
    expect(entry.title).toBe("Add auth");

    const index = await readPlanIndex(rootDir);
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(entry.id);

    const planFile = await readFile(
      path.join(rootDir, ".ged", "plans", `${entry.id}.md`),
      "utf8",
    );
    expect(planFile).toContain("# Add auth");
    expect(planFile).toContain("Setup JWT");
    expect(planFile).toContain("Add login endpoint");
  });

  test("updatePlanStatus marks a plan as completed", async () => {
    const rootDir = await createTempProject("ged-plans-status-");
    await initializeGedProject(rootDir);

    const entry = await createPlan(rootDir, "Fix bug", "Fix the crash", []);
    const updated = await updatePlanStatus(rootDir, entry.id, "completed");

    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeDefined();

    const index = await readPlanIndex(rootDir);
    expect(index[0].status).toBe("completed");
  });

  test("cleanupCompletedPlans removes completed plan files", async () => {
    const rootDir = await createTempProject("ged-plans-cleanup-");
    await initializeGedProject(rootDir);

    const entry = await createPlan(rootDir, "Old plan", "Done", []);
    await updatePlanStatus(rootDir, entry.id, "completed");

    const removed = await cleanupCompletedPlans(rootDir);
    expect(removed).toContain(entry.id);

    // Index still has the entry, but the file is gone
    const index = await readPlanIndex(rootDir);
    expect(index).toHaveLength(1);
    expect(index[0].status).toBe("completed");

    await expect(
      readFile(path.join(rootDir, ".ged", "plans", `${entry.id}.md`), "utf8"),
    ).rejects.toThrow();
  });

  test("appendProgress and readProgress track progress entries", async () => {
    const rootDir = await createTempProject("ged-progress-");
    await initializeGedProject(rootDir);

    await appendProgress(rootDir, "Started work on auth");
    await appendProgress(rootDir, "Completed login endpoint");

    const progress = await readProgress(rootDir);
    expect(progress).toContain("Started work on auth");
    expect(progress).toContain("Completed login endpoint");
  });

  test("renderPlanIndex groups by status", async () => {
    const rendered = renderPlanIndex([
      {
        id: "plan-1",
        title: "Active plan",
        status: "active",
        createdAt: "2026-01-01",
      },
      {
        id: "plan-2",
        title: "Done plan",
        status: "completed",
        createdAt: "2026-01-01",
        completedAt: "2026-01-02",
      },
    ]);

    expect(rendered).toContain("Active:");
    expect(rendered).toContain("Active plan");
    expect(rendered).toContain("Completed:");
    expect(rendered).toContain("Done plan");
  });

  test("planGedProject creates a plan entry and logs progress", async () => {
    const rootDir = await createTempProject("ged-plan-creates-plan-");
    await initializeGedProject(rootDir);

    await planGedProject(rootDir, {
      summary: "Build a widget",
      desiredOutcome: "A working widget",
      constraints: [],
      userSignals: [],
    });

    const index = await readPlanIndex(rootDir);
    expect(index.length).toBeGreaterThanOrEqual(1);
    expect(index[0].status).toBe("active");

    const progress = await readProgress(rootDir);
    expect(progress).toContain("Created plan");
  });

  test("config round-trips cleanupCompletedPlans setting", async () => {
    const rootDir = await createTempProject("ged-config-cleanup-");
    await initializeGedProject(rootDir);

    const config = await readConfig(rootDir);
    expect(config.cleanupCompletedPlans).toBe(false);

    await writeConfig(rootDir, { ...config, cleanupCompletedPlans: true });
    const reloaded = await readConfig(rootDir);
    expect(reloaded.cleanupCompletedPlans).toBe(true);
  });

  test("estimateTokens uses char-based approximation", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("hello world!")).toBe(3);
  });

  test("budget tracks consumed and remaining tokens", () => {
    let budget = createBudget(100);
    expect(budget.remainingTokens).toBe(100);

    budget = consumeBudget(budget, "a".repeat(200));
    expect(budget.usedTokens).toBe(50);
    expect(budget.remainingTokens).toBe(50);

    expect(fitsInBudget(budget, "a".repeat(200))).toBe(true);
    expect(fitsInBudget(budget, "a".repeat(204))).toBe(false);
  });

  test("getPhaseFiles returns different files per phase", () => {
    const buildFiles = getPhaseFiles("build");
    const planFiles = getPhaseFiles("plan");

    expect(buildFiles).toContain(".ged/work/<work-id>/TESTS.md");
    expect(planFiles).toContain(".ged/DECISIONS.md");
    expect(planFiles).not.toContain(".ged/PROGRESS.md");
    expect(buildFiles).toContain(".ged/PROGRESS.md");
  });

  test("gatherPhaseContext reads files within token budget", async () => {
    const rootDir = await createTempProject("ged-context-phase-");
    await initializeGedProject(rootDir);

    const blocks = await gatherPhaseContext(rootDir, "build", 10000);
    const paths = await activeGedPaths(rootDir);
    expect(blocks.length).toBeGreaterThan(0);
    expect(
      blocks.some((b) => b.file === relativeGedPath(rootDir, paths.specPath)),
    ).toBe(true);

    const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(10000);
  });

  test("gatherPhaseContext respects tight budget", async () => {
    const rootDir = await createTempProject("ged-context-tight-");
    await initializeGedProject(rootDir);

    // Very tight budget — may not fit all files
    const blocks = await gatherPhaseContext(rootDir, "escalate", 10);
    const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(10);
  });

  test("gatherTaskContext includes task-relevant files", async () => {
    const rootDir = await createTempProject("ged-context-task-");
    await initializeGedProject(rootDir);

    const task = {
      id: "T01",
      title: "Test task",
      objective: "Do something",
      contextFiles: [".ged/PROJECT.md"],
      skills: [],
      doneCriteria: [],
      status: "todo" as const,
      dependsOn: [],
    };

    const blocks = await gatherTaskContext(rootDir, task, 10000);
    const paths = await activeGedPaths(rootDir);
    expect(
      blocks.some((b) => b.file === relativeGedPath(rootDir, paths.specPath)),
    ).toBe(true);
    expect(blocks.some((b) => b.file === ".ged/PROJECT.md")).toBe(true);
  });

  test("renderContextSummary shows file names and token counts", () => {
    const summary = renderContextSummary([
      { file: "SPEC.md", content: "x".repeat(40), tokens: 10 },
      { file: "TESTS.md", content: "y".repeat(80), tokens: 20 },
    ]);
    expect(summary).toContain("30 tokens");
    expect(summary).toContain("2 files");
    expect(summary).toContain("SPEC.md (10t)");
  });

  // --- detectStuck tests ---

  test("detectStuck returns not detected when no tasks exist", async () => {
    const rootDir = await createTempProject("ged-stuck-none-");
    const result = await detectStuck(rootDir);
    expect(result.detected).toBe(false);
  });

  test("detectStuck returns not detected with fewer than 3 failures", async () => {
    const rootDir = await createTempProject("ged-stuck-few-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "test",
      desiredOutcome: "test",
      constraints: [],
      userSignals: [],
    });

    const taskDir = path.join(rootDir, ".ged", "tasks");
    await mkdir(taskDir, { recursive: true });
    const history = [
      { verification: { passed: false, failureSummary: ["err1"] } },
      { verification: { passed: false, failureSummary: ["err2"] } },
    ];
    await writeFile(
      path.join(taskDir, "T01.history.json"),
      JSON.stringify(history),
      "utf8",
    );

    const result = await detectStuck(rootDir);
    expect(result.detected).toBe(false);
  });

  test("detectStuck detects 3+ identical failures", async () => {
    const rootDir = await createTempProject("ged-stuck-same-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "test",
      desiredOutcome: "test",
      constraints: [],
      userSignals: [],
    });

    const taskDir = path.join(rootDir, ".ged", "tasks");
    await mkdir(taskDir, { recursive: true });
    const history = [
      { verification: { passed: false, failureSummary: ["type error"] } },
      { verification: { passed: false, failureSummary: ["type error"] } },
      { verification: { passed: false, failureSummary: ["type error"] } },
    ];
    await writeFile(
      path.join(taskDir, "T01.history.json"),
      JSON.stringify(history),
      "utf8",
    );

    const result = await detectStuck(rootDir);
    expect(result.detected).toBe(true);
    expect(result.reason).toContain("same error");
    expect(result.taskId).toBe("T01");
  });

  test("detectStuck detects 3+ different failures", async () => {
    const rootDir = await createTempProject("ged-stuck-diff-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "test",
      desiredOutcome: "test",
      constraints: [],
      userSignals: [],
    });

    const taskDir = path.join(rootDir, ".ged", "tasks");
    await mkdir(taskDir, { recursive: true });
    const history = [
      { verification: { passed: false, failureSummary: ["err1"] } },
      { verification: { passed: false, failureSummary: ["err2"] } },
      { verification: { passed: false, failureSummary: ["err3"] } },
    ];
    await writeFile(
      path.join(taskDir, "T01.history.json"),
      JSON.stringify(history),
      "utf8",
    );

    const result = await detectStuck(rootDir);
    expect(result.detected).toBe(true);
    expect(result.reason).toContain("3 failures");
    expect(result.taskId).toBe("T01");
  });

  test("detectStuck returns not detected with no history file", async () => {
    const rootDir = await createTempProject("ged-stuck-nohist-");
    await initializeGedProject(rootDir);
    await planGedProject(rootDir, {
      summary: "test",
      desiredOutcome: "test",
      constraints: [],
      userSignals: [],
    });

    const result = await detectStuck(rootDir);
    expect(result.detected).toBe(false);
    expect(result.reason).toBe("No stuck signals.");
  });

  // --- tasks.ts unit tests ---

  test("readTasks parses markdown task table", async () => {
    const rootDir = await createTempProject("ged-tasks-parse-");
    const tasksPath = path.join(rootDir, "tasks.md");
    await writeFile(
      tasksPath,
      `# Tasks

## Task slices

| ID | Title | Depends On | Status | Done Criteria |
| --- | --- | --- | --- | --- |
| T01 | First task | - | todo | Passes tests |
| T02 | Second task | T01 | todo | Compiles |
`,
      "utf8",
    );

    const tasks = await readTasks(tasksPath);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("T01");
    expect(tasks[0].dependsOn).toEqual([]);
    expect(tasks[1].dependsOn).toEqual(["T01"]);
  });

  test("readTasks skips malformed rows", async () => {
    const rootDir = await createTempProject("ged-tasks-bad-");
    const tasksPath = path.join(rootDir, "tasks.md");
    await writeFile(
      tasksPath,
      `# Tasks

## Task slices

| ID | Title | Depends On | Status | Done Criteria |
| --- | --- | --- | --- | --- |
| T01 | Good row | - | todo | OK |
| Too few columns |
| T03 | Another good | - | done | Done |
`,
      "utf8",
    );

    const tasks = await readTasks(tasksPath);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("T01");
    expect(tasks[1].id).toBe("T03");
  });

  test("findNextExecutableTask respects dependencies", () => {
    const tasks = [
      {
        id: "T01",
        title: "First",
        objective: "First",
        contextFiles: [],
        skills: [],
        doneCriteria: [],
        status: "todo" as const,
        dependsOn: [],
      },
      {
        id: "T02",
        title: "Second",
        objective: "Second",
        contextFiles: [],
        skills: [],
        doneCriteria: [],
        status: "todo" as const,
        dependsOn: ["T01"],
      },
    ];

    // T01 is executable, T02 is blocked
    expect(findNextExecutableTask(tasks)?.id).toBe("T01");

    // After T01 is done, T02 becomes executable
    const updated = updateTaskStatus(tasks, "T01", "done");
    expect(findNextExecutableTask(updated)?.id).toBe("T02");
  });

  test("findNextExecutableTask returns null when all done", () => {
    const tasks = [
      {
        id: "T01",
        title: "Done task",
        objective: "Done",
        contextFiles: [],
        skills: [],
        doneCriteria: [],
        status: "done" as const,
        dependsOn: [],
      },
    ];

    expect(findNextExecutableTask(tasks)).toBeNull();
  });

  test("findNextExecutableTask skips blocked dependencies", () => {
    const tasks = [
      {
        id: "T01",
        title: "Blocked",
        objective: "Blocked",
        contextFiles: [],
        skills: [],
        doneCriteria: [],
        status: "blocked" as const,
        dependsOn: [],
      },
      {
        id: "T02",
        title: "Depends on blocked",
        objective: "Waiting",
        contextFiles: [],
        skills: [],
        doneCriteria: [],
        status: "todo" as const,
        dependsOn: ["T01"],
      },
    ];

    // T01 is blocked (not todo), T02 depends on T01 which isn't done
    expect(findNextExecutableTask(tasks)).toBeNull();
  });

  test("updateTaskStatus returns new array without mutating", () => {
    const tasks = [
      {
        id: "T01",
        title: "Task",
        objective: "Task",
        contextFiles: [],
        skills: [],
        doneCriteria: [],
        status: "todo" as const,
        dependsOn: [],
      },
    ];

    const updated = updateTaskStatus(tasks, "T01", "done");
    expect(updated[0].status).toBe("done");
    expect(tasks[0].status).toBe("todo"); // original unchanged
  });

  test("renderTaskTable round-trips through readTasks", async () => {
    const tasks = [
      {
        id: "T01",
        title: "Build feature",
        objective: "Build feature",
        contextFiles: [],
        skills: ["ged-planning"],
        doneCriteria: ["Passes tests", "Compiles"],
        status: "todo" as const,
        dependsOn: [],
      },
    ];

    const rootDir = await createTempProject("ged-tasks-roundtrip-");
    const tasksPath = path.join(rootDir, "tasks.md");
    await writeFile(tasksPath, renderTaskTable(tasks), "utf8");

    const parsed = await readTasks(tasksPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("T01");
    expect(parsed[0].doneCriteria).toEqual(["Passes tests", "Compiles"]);
    expect(parsed[0].skills).toEqual(["ged-planning"]);
  });

  test("renderTaskTable round-trips titles with pipe characters", async () => {
    const tasks = [
      {
        id: "T01",
        title: "Build auth | login flow",
        objective: "Build auth | login flow",
        contextFiles: [],
        skills: [],
        doneCriteria: ["Passes tests"],
        status: "todo" as const,
        dependsOn: [],
      },
    ];

    const rootDir = await createTempProject("ged-tasks-pipe-title-");
    const tasksPath = path.join(rootDir, "tasks.md");
    await writeFile(tasksPath, renderTaskTable(tasks), "utf8");

    const content = await readFile(tasksPath, "utf8");
    expect(content).toContain("Build auth \\| login flow");

    const parsed = await readTasks(tasksPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Build auth | login flow");
  });

  test("renderTaskTable round-trips done criteria with pipe characters", async () => {
    const tasks = [
      {
        id: "T01",
        title: "Build feature",
        objective: "Build feature",
        contextFiles: [],
        skills: [],
        doneCriteria: ["CLI shows a | separator", "Compiles"],
        status: "todo" as const,
        dependsOn: [],
      },
    ];

    const rootDir = await createTempProject("ged-tasks-pipe-criteria-");
    const tasksPath = path.join(rootDir, "tasks.md");
    await writeFile(tasksPath, renderTaskTable(tasks), "utf8");

    const parsed = await readTasks(tasksPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].doneCriteria).toEqual([
      "CLI shows a | separator",
      "Compiles",
    ]);
  });

  test("renderTasksMarkdown escapes pipe characters in planned tasks", () => {
    const content = renderTasksMarkdown([
      {
        id: "T01",
        title: "Build auth | login flow",
        objective: "Build auth | login flow",
        contextFiles: [],
        skills: [],
        doneCriteria: ["CLI shows a | separator", "Compiles"],
        status: "todo",
        dependsOn: [],
      },
    ]);

    expect(content).toContain("Build auth \\| login flow");
    expect(content).toContain("CLI shows a \\| separator; Compiles");
  });

  test("prepareCommitPlan parses escaped pipes from completed task rows", async () => {
    const rootDir = await createTempProject("ged-commit-plan-pipes-");
    await initializeGedProject(rootDir);
    const paths = await activeGedPaths(rootDir);
    await writeFile(
      paths.tasksPath,
      `# Tasks

## Task slices

| ID | Title | Depends On | Status | Done Criteria |
| --- | --- | --- | --- | --- |
| T01 | Fix auth \\| login flow | - | done | CLI shows a \\| separator; Tests pass |
`,
      "utf8",
    );
    await mkdir(path.join(rootDir, ".ged", "tasks"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".ged", "tasks", "T01.history.json"),
      JSON.stringify([{ modifiedFiles: ["src/auth.ts"] }]),
      "utf8",
    );

    const plan = await prepareCommitPlan(rootDir);

    expect(plan).not.toBeNull();
    expect(plan?.taskId).toBe("T01");
    expect(plan?.message).toContain("Fix auth | login flow");
    expect(plan?.message).toContain("CLI shows a | separator; Tests pass");
    expect(plan?.files).toEqual(["src/auth.ts"]);
  });

  test("initializeGedProject includes diagnostics in result", async () => {
    const rootDir = await createTempProject("ged-init-diag-");
    const result = await initializeGedProject(rootDir);

    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics.overall).toBeDefined();
    expect(result.diagnostics.checks.length).toBeGreaterThan(0);
  });

  // --- config edge case tests ---

  test("readConfig returns defaults for missing CONFIG.md", async () => {
    const rootDir = await createTempProject("ged-config-missing-");
    const config = await readConfig(rootDir);
    expect(config.models.brain).toBe("anthropic/claude-opus-4-6");
    expect(config.cleanupCompletedPlans).toBe(false);
  });

  test("readConfig handles CONFIG.md with extra whitespace", async () => {
    const rootDir = await createTempProject("ged-config-ws-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".ged", "CONFIG.md"),
      `# GedPi Configuration

## Models

| Agent | Model |
|-------|-------|
| brain | openai/gpt-5.4 |

## Memory

Delete completed plan files: true
`,
      "utf8",
    );

    const config = await readConfig(rootDir);
    expect(config.models.brain).toBe("openai/gpt-5.4");
    expect(config.cleanupCompletedPlans).toBe(true);
  });

  test("readConfig handles CONFIG.md missing Memory section", async () => {
    const rootDir = await createTempProject("ged-config-nomem-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".ged", "CONFIG.md"),
      `# GedPi Configuration

## Models

| Agent | Model |
|-------|-------|
| brain | anthropic/claude-opus-4-6 |
`,
      "utf8",
    );

    const config = await readConfig(rootDir);
    // Missing Memory section → uses default
    expect(config.cleanupCompletedPlans).toBe(false);
  });

  test("readConfig handles empty model values gracefully", async () => {
    const rootDir = await createTempProject("ged-config-empty-");
    await mkdir(path.join(rootDir, ".ged"), { recursive: true });
    await writeFile(
      path.join(rootDir, ".ged", "CONFIG.md"),
      `# GedPi Configuration

## Models

| Agent | Model |
|-------|-------|
| brain |  |
`,
      "utf8",
    );

    const config = await readConfig(rootDir);
    expect(config.models.brain).toBe("anthropic/claude-opus-4-6");
  });
});
