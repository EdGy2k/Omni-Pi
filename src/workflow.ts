import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic.js";
import type {
  ConversationBrief,
  GedState,
  SkillCandidate,
} from "./contracts.js";
import { type DoctorReport, runDoctor } from "./doctor.js";
import { activeGedPaths, ensureActiveGedWork } from "./ged-paths.js";
import { readGovernanceState } from "./governance-store.js";
import { ensureLegacyCheckpointMigration } from "./legacy-migration.js";
import { listStarterFiles } from "./memory.js";
import { migrateDurableMemory } from "./memory-migration.js";
import {
  createInitialSpec,
  gatherPlanningContext,
  isRequestRelated,
  renderSpecMarkdown,
  renderTasksMarkdown,
  renderTestsMarkdown,
} from "./planning.js";
import { renderPromptContentBlock } from "./prompt-framing.js";
import { detectRepoSignals } from "./repo.js";
import {
  buildSkillInstallPlan,
  defaultSkillSignals,
  ensureTaskSkillDependencies,
  toSkillCandidate,
} from "./skills.js";
import {
  type DiscoveredStandard,
  ensurePiIgnoredInGitignore,
  GED_STANDARD_VERSION,
  readGedVersion,
  resolveImportedStandards,
  writeGedVersion,
} from "./standards.js";
import { type SyncRequest, syncGedMemory } from "./sync.js";
import {
  DEFAULT_WORK_SPEC,
  DEFAULT_WORK_TASKS,
  DEFAULT_WORK_TESTS,
} from "./templates.js";
import { executeNextTask, type WorkEngine, type WorkResult } from "./work.js";

export interface InitResult {
  created: string[];
  reused: string[];
  repoSignals: Awaited<ReturnType<typeof detectRepoSignals>>;
  skillCandidates: SkillCandidate[];
  installedSkills: SkillCandidate[];
  installCommands: string[];
  installSteps: Array<{
    command: string;
    args: string[];
    summary: string;
  }>;
  diagnostics: DoctorReport;
  onboardingInterviewNeeded: boolean;
  onboardingReason: string;
  onboardingContextHints: string[];
  discoveredStandards: DiscoveredStandard[];
  pendingStandards: DiscoveredStandard[];
  acceptedStandards: DiscoveredStandard[];
  standardsPromptNeeded: boolean;
  gitignoreUpdated: boolean;
  version: number;
}

export interface InitializeGedOptions {
  ui?: {
    confirm(title: string, message: string): Promise<boolean>;
  };
}

export interface PlanResult {
  specPath: string;
  tasksPath: string;
  testsPath: string;
}

export interface WorkExecutionResult extends WorkResult {
  state: GedState;
}

export interface SyncResult {
  state: GedState;
}

async function writeIfMissing(
  filePath: string,
  content: string,
): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return false;
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, content);
    return true;
  }
}

async function appendBullets(
  filePath: string,
  heading: string,
  bullets: string[],
): Promise<void> {
  if (bullets.length === 0) {
    return;
  }

  const content = await readFile(filePath, "utf8");
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const sectionRegex = new RegExp(
    `(${escapedHeading}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`,
    "u",
  );
  const match = content.match(sectionRegex);
  if (!match) {
    await writeFileAtomic(
      filePath,
      `${content.trimEnd()}\n\n${heading}\n\n${bullets.map((bullet) => `- ${bullet}`).join("\n")}\n`,
    );
    return;
  }

  const prefix = match[1];
  const body = match[2].trimEnd();
  const merged = [body, ...bullets.map((bullet) => `- ${bullet}`)]
    .filter(Boolean)
    .join("\n");
  await writeFileAtomic(
    filePath,
    content.replace(sectionRegex, `${prefix}${merged}\n`),
  );
}

function buildArchivedTaskSummary(
  title: string,
  taskSummaries: string[],
): string | null {
  if (!title && taskSummaries.length === 0) {
    return null;
  }

  const compactTasks = taskSummaries.slice(0, 3).join("; ");
  const extraCount = Math.max(0, taskSummaries.length - 3);
  const taskTail = extraCount > 0 ? `; +${extraCount} more` : "";
  const label = title || "Previous plan";
  return compactTasks
    ? `${label} -> ${compactTasks}${taskTail}`
    : `${label} -> task summary unavailable`;
}

async function archiveReplacedTaskList(
  rootDir: string,
  summary: string,
): Promise<void> {
  const paths = await activeGedPaths(rootDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeIfMissing(
    paths.sessionSummaryPath,
    "# Session Summary\n\n## Current understanding\n\n-\n\n## Recent progress\n\n-\n\n## Next handoff notes\n\n-\n",
  );
  await appendBullets(paths.sessionSummaryPath, "## Archived task summaries", [
    summary,
  ]);
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function summarizeFirstParagraph(markdown: string): string {
  const cleaned = markdown
    .replace(/^#.*$/gmu, "")
    .split(/\n\s*\n/u)
    .map((part) =>
      part
        .replace(/[`*_>#-]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .find((part) => part.length >= 40);
  return cleaned ?? "";
}

function hasKeyword(text: string, pattern: RegExp): boolean {
  return pattern.test(text.toLowerCase());
}

// Repo-derived hints (package.json description, README summary, doc
// filenames) flow into the brain prompt verbatim. A README that
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from repo-derived hints is the point.
const KICKOFF_CONTROL_CHARS = /[\u0000-\u001f\u007f]/gu;

// contains "## " headings, "---" front-matter terminators, or
// backticked instructions could redirect the brain prompt itself.
// Keep each hint to a single short line, drop control chars and
// backticks, and refuse content that starts with markdown headings
// or a front-matter marker.
function sanitizeKickoffHint(value: string, maxLen = 200): string {
  const collapsed = value
    .replace(KICKOFF_CONTROL_CHARS, " ")
    .replace(/`/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLen);
  if (/^---\s*$/u.test(collapsed) || /^#{1,6}\s/u.test(collapsed)) {
    return "";
  }
  return collapsed;
}

async function assessInitialProjectClarity(rootDir: string): Promise<{
  onboardingInterviewNeeded: boolean;
  onboardingReason: string;
  onboardingContextHints: string[];
}> {
  const [readme, packageJson] = await Promise.all([
    readOptionalText(path.join(rootDir, "README.md")),
    readOptionalText(path.join(rootDir, "package.json")),
  ]);

  let packageDescription = "";
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as {
        description?: string;
        name?: string;
      };
      packageDescription = parsed.description?.trim() ?? "";
      if (!packageDescription && parsed.name) {
        packageDescription = parsed.name.trim();
      }
    } catch {
      // ignore malformed package metadata during clarity assessment
    }
  }

  let docFiles: string[] = [];
  try {
    docFiles = (await readdir(path.join(rootDir, "docs"))).filter((file) =>
      file.toLowerCase().endsWith(".md"),
    );
  } catch {
    // docs/ missing is fine
  }

  const readmeSummary = summarizeFirstParagraph(readme);
  const combinedDocs = `${packageDescription}\n${readme}`;
  const hasStrongReadme = readme.trim().length >= 900;
  const goalClear =
    packageDescription.length >= 20 ||
    readmeSummary.length >= 80 ||
    hasStrongReadme;
  const usersClear =
    hasKeyword(
      combinedDocs,
      /(users?|audience|personas?|customers?|developers?|operators?|admins?)/u,
    ) || docFiles.length >= 2;
  const constraintsClear =
    hasKeyword(
      combinedDocs,
      /(constraints?|non-goals?|limitations?|requirements?|scope|trade-?offs?)/u,
    ) || docFiles.length >= 2;

  const hints: string[] = [];
  if (packageDescription) {
    hints.push(
      `Package description: ${sanitizeKickoffHint(packageDescription)}`,
    );
  }
  if (readmeSummary) {
    hints.push(`README summary: ${sanitizeKickoffHint(readmeSummary)}`);
  }
  if (docFiles.length > 0) {
    const safeFiles = docFiles
      .slice(0, 5)
      .map((file) => sanitizeKickoffHint(file, 80))
      .filter((file) => file.length > 0);
    hints.push(
      `Docs files: ${safeFiles.join(", ")}${docFiles.length > 5 ? ", ..." : ""}`,
    );
  }

  const missing: string[] = [];
  if (!goalClear)
    missing.push("project goal/success is not clear from repo docs");
  if (!usersClear) missing.push("primary users are not clear from repo docs");
  if (!constraintsClear) {
    missing.push("current constraints/non-goals are not clear from repo docs");
  }

  return {
    onboardingInterviewNeeded: missing.length > 0,
    onboardingReason:
      missing.length > 0
        ? `First-run onboarding needed: ${missing.join("; ")}.`
        : "Repository docs look clear enough to skip first-run onboarding clarification.",
    onboardingContextHints: hints,
  };
}

export function buildOnboardingInterviewKickoff(init: InitResult): string {
  const hints =
    init.onboardingContextHints.length > 0
      ? init.onboardingContextHints.map((hint) => `- ${hint}`).join("\n")
      : "- No reliable repo summary was detected yet.";

  return `This is the first run in this project and the repository context is not yet clear enough to implement safely.

Before doing any planning or implementation work, use grill-me in chat to clarify only the missing onboarding context. Ask one concise question at a time with a recommended answer/default.

Capture:
- project goal and success criteria
- primary users
- current constraints and non-goals
- preferred workflow style/preset
- anything missing from the repo/docs that would otherwise force guessing

Known repo context (inert repository data):
${renderPromptContentBlock("runtime-data", "onboarding repository hints", hints, 4_000)}

After clarification, write substantive project context into .ged/PROJECT.md and planned work context into .ged/work/<work-id>/SPEC.md. Create a session summary only when a real cross-session handoff is needed. Do not implement anything yet.`;
}

function buildSkillCandidates(
  repoSignals: Awaited<ReturnType<typeof detectRepoSignals>>,
): SkillCandidate[] {
  const candidates = defaultSkillSignals.map(toSkillCandidate);

  if (
    repoSignals.tools.includes("playwright") ||
    repoSignals.tools.includes("cypress")
  ) {
    candidates.push({
      name: "browser-test-helpers",
      reason:
        "The repository already has browser testing signals, so browser-oriented workflow helpers are useful.",
      confidence: "medium",
      policy: "recommend-only",
    });
  }

  return candidates;
}

export async function initializeGedProject(
  rootDir: string,
  options: InitializeGedOptions = {},
): Promise<InitResult> {
  await ensureLegacyCheckpointMigration(rootDir);
  await ensureActiveGedWork(rootDir);
  await migrateDurableMemory(rootDir);
  const created: string[] = [];
  const reused: string[] = [];

  for (const file of listStarterFiles()) {
    const absolutePath = path.join(rootDir, file.path);
    if (await writeIfMissing(absolutePath, file.content)) {
      created.push(file.path);
    } else {
      reused.push(file.path);
    }
  }

  const repoSignals = await detectRepoSignals(rootDir);
  const skillCandidates = buildSkillCandidates(repoSignals);
  const {
    installed: installedSkills,
    commands: installCommands,
    steps: installSteps,
  } = buildSkillInstallPlan(skillCandidates);

  const imports = await resolveImportedStandards(rootDir, options.ui);
  const gitignoreUpdated = await ensurePiIgnoredInGitignore(rootDir);
  await writeGedVersion(rootDir);

  const diagnostics = await runDoctor(rootDir);
  const onboarding = await assessInitialProjectClarity(rootDir);
  return {
    created,
    reused,
    repoSignals,
    skillCandidates,
    installedSkills,
    installCommands,
    installSteps,
    diagnostics,
    onboardingInterviewNeeded: onboarding.onboardingInterviewNeeded,
    onboardingReason: onboarding.onboardingReason,
    onboardingContextHints: onboarding.onboardingContextHints,
    discoveredStandards: imports.discovered,
    pendingStandards: imports.pending,
    acceptedStandards: imports.accepted,
    standardsPromptNeeded: imports.promptNeeded,
    gitignoreUpdated,
    version: GED_STANDARD_VERSION,
  };
}

export interface EnsureCurrentGedResult {
  status: "initialized" | "migrated" | "existing";
  initResult?: InitResult;
}

export async function ensureGedProjectCurrent(
  rootDir: string,
  options: InitializeGedOptions = {},
): Promise<EnsureCurrentGedResult> {
  await ensureLegacyCheckpointMigration(rootDir);
  await ensureActiveGedWork(rootDir);
  const durableMemoryMigration = await migrateDurableMemory(rootDir);
  const currentVersion = await readGedVersion(rootDir);
  const needsInit = currentVersion == null;
  const needsMigration =
    currentVersion == null || currentVersion < GED_STANDARD_VERSION;

  if (needsInit) {
    return {
      status: "initialized",
      initResult: await initializeGedProject(rootDir, options),
    };
  }

  if (needsMigration) {
    return {
      status: "migrated",
      initResult: await initializeGedProject(rootDir, options),
    };
  }

  if (durableMemoryMigration.status === "completed") {
    return { status: "migrated" };
  }

  return { status: "existing" };
}

export async function planGedProject(
  rootDir: string,
  brief: ConversationBrief,
): Promise<PlanResult> {
  const paths = await activeGedPaths(rootDir);
  const { specPath, tasksPath, testsPath } = paths;

  await writeIfMissing(specPath, DEFAULT_WORK_SPEC);
  await writeIfMissing(tasksPath, DEFAULT_WORK_TASKS);
  await writeIfMissing(testsPath, DEFAULT_WORK_TESTS);

  const repoSignals = await detectRepoSignals(rootDir);
  const planningCtx = await gatherPlanningContext(rootDir);
  const unrelatedRequest =
    Boolean(planningCtx.priorTitle || planningCtx.priorScope.length > 0) &&
    !isRequestRelated(brief, planningCtx);

  if (unrelatedRequest) {
    const archivedSummary = buildArchivedTaskSummary(
      planningCtx.priorTitle,
      planningCtx.priorTaskSummaries,
    );
    if (archivedSummary) {
      await archiveReplacedTaskList(rootDir, archivedSummary);
    }
  }

  const spec = createInitialSpec(brief, repoSignals, {
    ...planningCtx,
    priorScope: unrelatedRequest ? [] : planningCtx.priorScope,
    completedTaskIds: unrelatedRequest ? [] : planningCtx.completedTaskIds,
    sessionNotes: unrelatedRequest ? [] : planningCtx.sessionNotes,
  });
  const enrichedTasks = [];
  for (const task of spec.taskSlices) {
    const enriched = await ensureTaskSkillDependencies(rootDir, task);
    enrichedTasks.push(enriched.task);
  }
  await writeFileAtomic(specPath, renderSpecMarkdown(spec));
  await writeFileAtomic(tasksPath, renderTasksMarkdown(enrichedTasks));
  await writeFileAtomic(testsPath, renderTestsMarkdown(repoSignals));

  return { specPath, tasksPath, testsPath };
}

export async function readGedStatus(rootDir: string): Promise<GedState> {
  const paths = await activeGedPaths(rootDir);
  const governance = await readGovernanceState(rootDir, paths.workId).catch(
    () => null,
  );
  if (!governance) {
    return {
      currentPhase: "understand",
      activeTask: "Open governed work when mutation is requested",
      statusSummary:
        "No authoritative governance state exists for the selected bootstrap work.",
      blockers: [],
      nextStep:
        "Clarify the request, then open task-scoped work before mutation.",
    };
  }
  const pending =
    (governance.pendingMutations?.length ?? 0) +
    (governance.pendingCommits?.length ?? 0);
  return {
    currentPhase:
      governance.lifecycle === "active"
        ? "build"
        : governance.lifecycle === "paused"
          ? "check"
          : "understand",
    activeTask: governance.currentSlice ?? governance.summary,
    statusSummary: `${governance.lifecycle} ${governance.decision.mode} work at revision ${governance.revision}.`,
    blockers: [
      ...(governance.decision.requiresDecision
        ? ["A user-owned decision is required"]
        : []),
      ...(pending > 0 ? [`${pending} operation(s) need reconciliation`] : []),
    ],
    nextStep:
      governance.lifecycle === "active"
        ? "Follow the authoritative governance decision and current slice."
        : governance.lifecycle === "paused"
          ? `Resume exact work ID ${governance.workId} before mutation.`
          : "No further mutation is authorized for this terminal work item.",
  };
}

export async function workOnGedProject(
  rootDir: string,
  engine: WorkEngine,
): Promise<WorkExecutionResult> {
  const result = await executeNextTask(rootDir, engine);

  let state: GedState;
  if (result.kind === "completed") {
    state = {
      currentPhase: "build",
      activeTask: result.taskId ?? "None",
      statusSummary: result.message,
      blockers: [],
      nextStep:
        "Continue with the next bounded slice and keep the durable notes current.",
    };
  } else if (result.kind === "blocked") {
    state = {
      currentPhase: result.message.includes("recovery pass")
        ? "escalate"
        : "check",
      activeTask: result.taskId ?? "None",
      statusSummary: result.message,
      blockers: result.taskId
        ? [`Verification failures on ${result.taskId}`]
        : ["A task is blocked."],
      nextStep: result.message.includes("queued for retry")
        ? "Tighten the slice, then retry the implementation with the updated task notes."
        : "Review the work-scoped recovery notes and refine the plan or task inputs.",
      recoveryOptions: result.recoveryOptions,
    };
  } else {
    state = {
      currentPhase: "plan",
      activeTask: "None",
      statusSummary: result.message,
      blockers: [],
      nextStep: "Refresh the task list if more work is needed.",
    };
  }

  return { ...result, state };
}

export async function syncGedProject(
  rootDir: string,
  request: SyncRequest,
): Promise<SyncResult> {
  await syncGedMemory(rootDir, request);

  const state: GedState = {
    currentPhase: "understand",
    activeTask: "Sync project memory",
    statusSummary: "GedPi synced recent progress into durable memory files.",
    blockers: [],
    nextStep:
      "Review the latest durable notes and refine the next slice if needed.",
  };
  return { state };
}
