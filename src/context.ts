import { readFile } from "node:fs/promises";
import path from "node:path";

import type { GedPhase, TaskBrief } from "./contracts.js";
import { taskArtifactDir } from "./durable-memory.js";
import { activeGedPaths, relativeGedPath } from "./ged-paths.js";

const CHARS_PER_TOKEN = 4;

export interface TokenBudget {
  maxTokens: number;
  usedTokens: number;
  remainingTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function createBudget(maxTokens: number): TokenBudget {
  return { maxTokens, usedTokens: 0, remainingTokens: maxTokens };
}

export function consumeBudget(budget: TokenBudget, text: string): TokenBudget {
  const tokens = estimateTokens(text);
  const usedTokens = budget.usedTokens + tokens;
  return {
    maxTokens: budget.maxTokens,
    usedTokens,
    remainingTokens: Math.max(0, budget.maxTokens - usedTokens),
  };
}

export function fitsInBudget(budget: TokenBudget, text: string): boolean {
  return estimateTokens(text) <= budget.remainingTokens;
}

const DURABLE_FILES = {
  project: ".ged/PROJECT.md",
  context: "CONTEXT.md",
} as const;

export function getPhaseFiles(phase: GedPhase): string[] {
  switch (phase) {
    case "understand":
      return [
        DURABLE_FILES.project,
        DURABLE_FILES.context,
        ".ged/runtime/<work-id>/SESSION-SUMMARY.md",
      ];
    case "plan":
      return [
        DURABLE_FILES.project,
        ".ged/work/<work-id>/SPEC.md",
        ".ged/work/<work-id>/TASKS.md",
        DURABLE_FILES.context,
        ".ged/runtime/<work-id>/SESSION-SUMMARY.md",
      ];
    case "build":
      return [
        ".ged/work/<work-id>/SPEC.md",
        ".ged/work/<work-id>/TASKS.md",
        ".ged/work/<work-id>/TESTS.md",
      ];
    case "check":
      return [
        ".ged/work/<work-id>/TESTS.md",
        ".ged/work/<work-id>/TASKS.md",
        ".ged/work/<work-id>/SPEC.md",
      ];
    case "escalate":
      return [
        ".ged/work/<work-id>/SPEC.md",
        ".ged/work/<work-id>/TASKS.md",
        ".ged/work/<work-id>/TESTS.md",
        DURABLE_FILES.context,
        ".ged/runtime/<work-id>/SESSION-SUMMARY.md",
      ];
  }
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export interface ContextBlock {
  file: string;
  content: string;
  tokens: number;
}

async function resolveContextPath(
  rootDir: string,
  logicalPath: string,
): Promise<{ file: string; absolutePath: string }> {
  const paths = await activeGedPaths(rootDir);
  const file = logicalPath
    .replace(
      ".ged/work/<work-id>/SPEC.md",
      relativeGedPath(rootDir, paths.specPath),
    )
    .replace(
      ".ged/work/<work-id>/TASKS.md",
      relativeGedPath(rootDir, paths.tasksPath),
    )
    .replace(
      ".ged/work/<work-id>/TESTS.md",
      relativeGedPath(rootDir, paths.testsPath),
    )
    .replace(
      ".ged/runtime/<work-id>/SESSION-SUMMARY.md",
      relativeGedPath(rootDir, paths.sessionSummaryPath),
    );
  return { file, absolutePath: path.join(rootDir, file) };
}

export async function gatherPhaseContext(
  rootDir: string,
  phase: GedPhase,
  maxTokens: number,
): Promise<ContextBlock[]> {
  const files = getPhaseFiles(phase);
  let budget = createBudget(maxTokens);
  const blocks: ContextBlock[] = [];

  for (const logicalFile of files) {
    const { file, absolutePath } = await resolveContextPath(
      rootDir,
      logicalFile,
    );
    const content = await safeReadFile(absolutePath);
    if (!content) continue;
    if (!fitsInBudget(budget, content)) continue;

    budget = consumeBudget(budget, content);
    blocks.push({
      file,
      content,
      tokens: estimateTokens(content),
    });
  }

  return blocks;
}

export async function gatherTaskContext(
  rootDir: string,
  task: TaskBrief,
  maxTokens: number,
): Promise<ContextBlock[]> {
  const paths = await activeGedPaths(rootDir);
  const coreFiles = [paths.specPath, paths.testsPath];
  let budget = createBudget(maxTokens);
  const blocks: ContextBlock[] = [];

  for (const filePath of coreFiles) {
    const content = await safeReadFile(filePath);
    if (!content) continue;
    if (!fitsInBudget(budget, content)) continue;

    budget = consumeBudget(budget, content);
    blocks.push({
      file: relativeGedPath(rootDir, filePath),
      content,
      tokens: estimateTokens(content),
    });
  }

  const briefPath = path.join(
    taskArtifactDir(rootDir, paths.workId, task.id),
    "BRIEF.md",
  );
  const briefContent = await safeReadFile(briefPath);
  if (briefContent && fitsInBudget(budget, briefContent)) {
    budget = consumeBudget(budget, briefContent);
    blocks.push({
      file: relativeGedPath(rootDir, briefPath),
      content: briefContent,
      tokens: estimateTokens(briefContent),
    });
  }

  for (const file of task.contextFiles) {
    const materializedFile = file
      .replace("<work-id>", paths.workId)
      .replace(".ged/SPEC.md", relativeGedPath(rootDir, paths.specPath))
      .replace(".ged/TASKS.md", relativeGedPath(rootDir, paths.tasksPath))
      .replace(".ged/TESTS.md", relativeGedPath(rootDir, paths.testsPath));
    const content = await safeReadFile(path.join(rootDir, materializedFile));
    if (!content) continue;
    if (!fitsInBudget(budget, content)) continue;

    budget = consumeBudget(budget, content);
    blocks.push({
      file: materializedFile,
      content,
      tokens: estimateTokens(content),
    });
  }

  return blocks;
}

export function renderContextBlocks(blocks: ContextBlock[]): string {
  if (blocks.length === 0) return "";

  return blocks
    .map(
      (block) =>
        `--- ${block.file} (${block.tokens} tokens) ---\n${block.content}`,
    )
    .join("\n\n");
}

export function renderContextSummary(blocks: ContextBlock[]): string {
  const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);
  const fileList = blocks.map((b) => `${b.file} (${b.tokens}t)`).join(", ");
  return `Pre-loaded context: ${totalTokens} tokens from ${blocks.length} files: ${fileList}`;
}
