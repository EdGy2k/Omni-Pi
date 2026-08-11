import { readFile } from "node:fs/promises";
import path from "node:path";

import type { TaskBrief } from "./contracts.js";
import { taskArtifactDir } from "./durable-memory.js";
import { activeGedPaths } from "./ged-paths.js";
import { parseTaskRow } from "./tasks.js";

type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

export interface CommitPlan {
  branch: string;
  message: string;
  files: string[];
  taskId: string;
  prBody: string;
}

export function buildBranchName(taskId: string): string {
  return `ged/${taskId.toLowerCase().replace(/[^a-z0-9-]/gu, "-")}`;
}

export function buildCommitMessage(task: TaskBrief): string {
  return `feat(${task.id}): ${task.title}\n\nObjective: ${task.objective}\nDone criteria: ${task.doneCriteria.join("; ") || "None listed"}`;
}

export function generatePrBody(
  task: TaskBrief,
  verificationSummary?: string,
): string {
  const lines = [
    `## Summary`,
    "",
    `Implements ${task.id}: ${task.title}`,
    "",
    `**Objective:** ${task.objective}`,
    "",
    `## Done Criteria`,
    "",
    ...task.doneCriteria.map((c) => `- [x] ${c}`),
    "",
  ];
  if (verificationSummary) {
    lines.push("## Verification", "", verificationSummary, "");
  }
  return lines.join("\n");
}

export async function readLastCompletedTask(
  rootDir: string,
): Promise<{ taskId: string; task: TaskBrief } | null> {
  try {
    const paths = await activeGedPaths(rootDir);
    const tasksContent = await readFile(paths.tasksPath, "utf8");
    const doneRows = tasksContent
      .split("\n")
      .filter((line) => line.startsWith("| T") && line.includes("| done |"));
    if (doneRows.length === 0) return null;

    const lastRow = doneRows[doneRows.length - 1];
    const task = parseTaskRow(lastRow);
    if (task?.status !== "done") return null;
    return { taskId: task.id, task };
  } catch {
    return null;
  }
}

export async function readModifiedFilesFromHistory(
  rootDir: string,
  taskId: string,
): Promise<string[]> {
  try {
    const paths = await activeGedPaths(rootDir);
    const historyPath = path.join(
      taskArtifactDir(rootDir, paths.workId, taskId),
      "HISTORY.json",
    );
    const history = JSON.parse(await readFile(historyPath, "utf8")) as Array<{
      modifiedFiles?: string[];
    }>;
    return [...new Set(history.flatMap((entry) => entry.modifiedFiles ?? []))];
  } catch {
    return [];
  }
}

export async function createBranch(
  exec: ExecFn,
  cwd: string,
  branch: string,
): Promise<boolean> {
  const result = await exec("git", ["checkout", "-b", branch], { cwd });
  return result.code === 0;
}

export async function stageFiles(
  exec: ExecFn,
  cwd: string,
  files: string[],
): Promise<boolean> {
  if (files.length === 0) return false;
  const result = await exec("git", ["add", ...files], { cwd });
  return result.code === 0;
}

export async function commitChanges(
  exec: ExecFn,
  cwd: string,
  message: string,
): Promise<boolean> {
  const result = await exec("git", ["commit", "-m", message], { cwd });
  return result.code === 0;
}

export async function prepareCommitPlan(
  rootDir: string,
): Promise<CommitPlan | null> {
  const completed = await readLastCompletedTask(rootDir);
  if (!completed) return null;

  const files = await readModifiedFilesFromHistory(rootDir, completed.taskId);
  return {
    branch: buildBranchName(completed.taskId),
    message: buildCommitMessage(completed.task),
    files,
    taskId: completed.taskId,
    prBody: generatePrBody(completed.task),
  };
}
