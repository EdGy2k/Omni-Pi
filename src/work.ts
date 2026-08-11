import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic.js";
import {
  gatherTaskContext,
  renderContextBlocks,
  renderContextSummary,
} from "./context.js";
import type { TaskAttemptResult, TaskBrief } from "./contracts.js";
import { taskArtifactDir } from "./durable-memory.js";
import { activeGedPaths, relativeGedPath } from "./ged-paths.js";
import {
  cleanupUnusedProjectSkills,
  ensureTaskSkillDependencies,
  loadAvailableSkills,
} from "./skills.js";
import {
  findNextExecutableTask,
  readTasks,
  updateTask,
  updateTaskStatus,
  writeTasks,
} from "./tasks.js";

export interface WorkEngine {
  runTask: (task: TaskBrief, attempt: number) => Promise<TaskAttemptResult>;
}

export interface WorkResult {
  kind: "completed" | "blocked" | "idle";
  taskId: string | null;
  message: string;
  recoveryOptions?: string[];
}

export interface WorkDispatchResult {
  kind: "ready" | "idle";
  taskId: string | null;
  prompt: string;
  briefPath?: string;
  message: string;
}

const DEFAULT_RETRY_LIMIT = 2;

async function readRetryLimit(testsPath: string): Promise<number> {
  try {
    const content = await readFile(testsPath, "utf8");
    const match = content.match(
      /(?:Implementation retries before the plan must be tightened|Worker retries before expert takeover):\s*(\d+)/u,
    );
    return match ? Number.parseInt(match[1], 10) : DEFAULT_RETRY_LIMIT;
  } catch {
    return DEFAULT_RETRY_LIMIT;
  }
}

async function ensureTaskDir(
  rootDir: string,
  workId: string,
  taskId: string,
): Promise<string> {
  const taskDir = taskArtifactDir(rootDir, workId, taskId);
  await mkdir(taskDir, { recursive: true });
  return taskDir;
}

function historyPath(taskDir: string): string {
  return path.join(taskDir, "HISTORY.json");
}

async function readTaskHistory(taskDir: string): Promise<TaskAttemptResult[]> {
  try {
    return JSON.parse(
      await readFile(historyPath(taskDir), "utf8"),
    ) as TaskAttemptResult[];
  } catch {
    return [];
  }
}

async function writeTaskHistory(
  taskDir: string,
  history: TaskAttemptResult[],
): Promise<void> {
  await writeFileAtomic(historyPath(taskDir), JSON.stringify(history, null, 2));
}

async function writeTaskBrief(taskDir: string, task: TaskBrief): Promise<void> {
  const content = `# ${task.id}: ${task.title}

## Objective

${task.objective}

## Done Criteria

${task.doneCriteria.map((item) => `- ${item}`).join("\n") || "- None yet"}

## Skills

${task.skills.map((item) => `- ${item}`).join("\n") || "- None"}

## Context Files

${task.contextFiles.map((item) => `- ${item}`).join("\n") || "- None"}
`;
  await writeFileAtomic(path.join(taskDir, "BRIEF.md"), content);
}

export async function prepareNextTaskDispatch(
  rootDir: string,
): Promise<WorkDispatchResult> {
  const paths = await activeGedPaths(rootDir);
  const tasksPath = paths.tasksPath;
  const tasks = await readTasks(tasksPath);
  const nextTask = findNextExecutableTask(tasks);

  if (!nextTask) {
    return {
      kind: "idle",
      taskId: null,
      prompt: "",
      message:
        "No executable tasks are available. Refresh the plan or complete dependencies first.",
    };
  }

  const dependencyResult = await ensureTaskSkillDependencies(rootDir, nextTask);
  const preparedTask = dependencyResult.task;
  const taskDir = await ensureTaskDir(rootDir, paths.workId, preparedTask.id);
  await writeTaskBrief(taskDir, preparedTask);
  await writeTasks(
    tasksPath,
    updateTaskStatus(
      updateTask(tasks, preparedTask.id, preparedTask),
      preparedTask.id,
      "in_progress",
    ),
  );

  const briefPath = path.join(taskDir, "BRIEF.md");
  const preReadContext = await gatherTaskContext(rootDir, preparedTask, 4000);
  const availableSkills = await loadAvailableSkills(rootDir);
  const availableNames = new Set(availableSkills.map((skill) => skill.name));
  const missingSkills = preparedTask.skills.filter(
    (name) => !availableNames.has(name),
  );
  const prompt = [
    "You are working inside an GedPi implementation session.",
    "",
    `Task: ${preparedTask.id} - ${preparedTask.title}`,
    `Objective: ${preparedTask.objective}`,
    "",
    "Read these files first:",
    "- .ged/PROJECT.md",
    `- ${relativeGedPath(rootDir, paths.specPath)}`,
    `- ${relativeGedPath(rootDir, paths.testsPath)}`,
    `- ${path.relative(rootDir, briefPath)}`,
    ...preparedTask.contextFiles.map((file) => `- ${file}`),
    "",
    "Then implement the task, explain the change briefly, and run the planned verification steps before finishing.",
    preparedTask.skills.length > 0
      ? `Relevant skills: ${preparedTask.skills.join(", ")}`
      : "Relevant skills: none explicitly listed",
    missingSkills.length > 0
      ? `Unavailable skills were not generated; continue without them unless a reusable capability gap is explicitly approved: ${missingSkills.join(", ")}`
      : "All listed skills are available.",
    ...(preReadContext.length > 0
      ? [
          "",
          renderContextSummary(preReadContext),
          "",
          "Pre-loaded context (already read for you):",
          renderContextBlocks(preReadContext),
        ]
      : []),
  ].join("\n");

  return {
    kind: "ready",
    taskId: preparedTask.id,
    prompt,
    briefPath,
    message: `Prepared ${preparedTask.id} for a focused implementation session.`,
  };
}

async function writeRecoveryBrief(
  taskDir: string,
  task: TaskBrief,
  history: TaskAttemptResult[],
): Promise<void> {
  const failureLogs = history
    .filter((attempt) => !attempt.verification.passed)
    .map((attempt) => attempt.verification.failureSummary.join("; "))
    .filter((log) => log.length > 0);
  const verificationResultsSection = history.length
    ? history
        .flatMap((attempt) =>
          attempt.verification.checksRun.map((command) => ({
            command,
            passed: attempt.verification.passed,
          })),
        )
        .map((r) => `- ${r.command}: ${r.passed ? "passed" : "failed"}`)
        .join("\n")
    : "- None recorded";
  const modifiedFilesSection =
    [...new Set(history.flatMap((attempt) => attempt.modifiedFiles ?? []))]
      .map((f) => `- ${f}`)
      .join("\n") || "- None recorded";

  const content = `# Recovery for ${task.id}

## Prior Attempts

${history.length}

## Failure Logs

${failureLogs.map((item) => `- ${item}`).join("\n") || "- None"}

## Verification Results

${verificationResultsSection}

## Modified Files

${modifiedFilesSection}

## Recovery Objective

Revisit the task inputs, tighten the scope, and retry ${task.id} with a narrower, clearer implementation slice.
`;
  await writeFileAtomic(path.join(taskDir, "RECOVERY.md"), content);
}

function formatVerificationSummary(result: TaskAttemptResult): string {
  const checks =
    result.verification.checksRun.length > 0
      ? result.verification.checksRun.join(", ")
      : "no recorded checks";
  if (result.verification.passed) {
    return `Verification passed: ${checks}.`;
  }
  const failures =
    result.verification.failureSummary.length > 0
      ? result.verification.failureSummary.join("; ")
      : "unknown verification failure";
  return `Verification failed: ${checks}. Reason: ${failures}.`;
}

export async function executeNextTask(
  rootDir: string,
  engine: WorkEngine,
): Promise<WorkResult> {
  const paths = await activeGedPaths(rootDir);
  const tasksPath = paths.tasksPath;
  const testsPath = paths.testsPath;
  const tasks = await readTasks(tasksPath);
  const nextTask = findNextExecutableTask(tasks);

  if (!nextTask) {
    return {
      kind: "idle",
      taskId: null,
      message:
        "No executable tasks are available. Complete dependencies or refresh the plan first.",
    };
  }

  const taskDir = await ensureTaskDir(rootDir, paths.workId, nextTask.id);
  const dependencyResult = await ensureTaskSkillDependencies(rootDir, nextTask);
  const preparedTask = dependencyResult.task;
  const preparedTasks = updateTask(tasks, preparedTask.id, preparedTask);
  await writeTasks(tasksPath, preparedTasks);
  await writeTaskBrief(taskDir, preparedTask);

  const history = await readTaskHistory(taskDir);
  const retryLimit = await readRetryLimit(testsPath);
  const attempt = history.length + 1;
  const implementationResult = await engine.runTask(preparedTask, attempt);
  const implementationHistory = [...history, implementationResult];
  await writeTaskHistory(taskDir, implementationHistory);

  if (implementationResult.verification.passed) {
    const completedTasks = updateTaskStatus(
      preparedTasks,
      preparedTask.id,
      "done",
    );
    await writeTasks(tasksPath, completedTasks);
    await cleanupUnusedProjectSkills(
      rootDir,
      completedTasks.filter((task) => task.status !== "done"),
    );
    return {
      kind: "completed",
      taskId: preparedTask.id,
      message: `Completed ${preparedTask.id} in the implementation pass. ${formatVerificationSummary(implementationResult)}`,
    };
  }

  if (attempt < retryLimit) {
    await writeTasks(
      tasksPath,
      updateTaskStatus(preparedTasks, preparedTask.id, "todo"),
    );
    return {
      kind: "blocked",
      taskId: preparedTask.id,
      message: `Implementation attempt ${attempt} for ${preparedTask.id} failed verification and is queued for retry. ${formatVerificationSummary(implementationResult)}`,
    };
  }

  await writeRecoveryBrief(taskDir, preparedTask, implementationHistory);
  await writeTasks(
    tasksPath,
    updateTaskStatus(preparedTasks, preparedTask.id, "blocked"),
  );
  return {
    kind: "blocked",
    taskId: preparedTask.id,
    message: `Task ${preparedTask.id} remains blocked after ${attempt} implementation attempts. ${formatVerificationSummary(implementationResult)}`,
    recoveryOptions: [
      `Review the recovery notes in ${relativeGedPath(rootDir, path.join(taskDir, "RECOVERY.md"))} and refine the task inputs.`,
      "Restructure the task into smaller slices.",
      "Sync the latest learnings into `.ged/` before attempting a different approach.",
      "Manually inspect and fix the failing checks listed in the active work `TESTS.md`.",
    ],
  };
}
