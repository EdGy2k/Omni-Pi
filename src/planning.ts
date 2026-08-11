import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ConversationBrief,
  ImplementationSpec,
  PresetConfig,
  TaskBrief,
} from "./contracts.js";
import { WORKFLOW_PRESETS } from "./contracts.js";
import { activeGedPaths } from "./ged-paths.js";
import type { RepoSignals } from "./repo.js";
import { escapeTaskTableCell } from "./tasks.js";

export interface PlanningContext {
  existingDecisions: string[];
  sessionNotes: string[];
  priorTitle: string;
  priorScope: string[];
  completedTaskIds: string[];
  priorTaskSummaries: string[];
}

export async function gatherPlanningContext(
  rootDir: string,
): Promise<PlanningContext> {
  const ctx: PlanningContext = {
    existingDecisions: [],
    sessionNotes: [],
    priorTitle: "",
    priorScope: [],
    completedTaskIds: [],
    priorTaskSummaries: [],
  };

  try {
    const adrDir = path.join(rootDir, "docs", "adr");
    const adrFiles = (await readdir(adrDir))
      .filter((file) => file.endsWith(".md"))
      .sort();
    const decisions = await Promise.all(
      adrFiles.map((file) => readFile(path.join(adrDir, file), "utf8")),
    );
    ctx.existingDecisions = decisions
      .flatMap((decision) => decision.split("\n"))
      .filter((line) => line.trim().startsWith("- Decision:"))
      .map((line) => line.replace(/^.*- Decision:\s*/u, "").trim())
      .filter(Boolean);
  } catch {
    /* no ADR directory yet */
  }

  const paths = await activeGedPaths(rootDir);

  try {
    const session = await readFile(paths.sessionSummaryPath, "utf8");
    const progressMatch = session.match(
      /## Recent progress\n\n([\s\S]*?)(?=\n## |$)/u,
    );
    if (progressMatch) {
      ctx.sessionNotes = progressMatch[1]
        .split("\n")
        .map((line) => line.replace(/^- /u, "").trim())
        .filter((line) => line.length > 0 && line !== "-");
    }
  } catch {
    /* no session summary yet */
  }

  try {
    const spec = await readFile(paths.specPath, "utf8");
    const titleMatch = spec.match(/## Title\n\n([\s\S]*?)(?=\n## |$)/u);
    ctx.priorTitle = titleMatch?.[1]?.trim() ?? "";
    const scopeMatch = spec.match(/## Scope\n\n([\s\S]*?)(?=\n## |$)/u);
    if (scopeMatch) {
      ctx.priorScope = scopeMatch[1]
        .split("\n")
        .map((line) => line.replace(/^- /u, "").trim())
        .filter((line) => line.length > 0);
    }
  } catch {
    /* no spec yet */
  }

  try {
    const tasks = await readFile(paths.tasksPath, "utf8");
    const taskRows = tasks.split("\n").filter((line) => line.startsWith("| T"));
    ctx.completedTaskIds = taskRows
      .filter((line) => line.includes("| done |"))
      .map((line) => line.split("|")[1]?.trim())
      .filter((id): id is string => Boolean(id));
    ctx.priorTaskSummaries = taskRows
      .map((line) => line.split("|").map((part) => part.trim()))
      .map((parts) => {
        const id = parts[1] ?? "";
        const title = parts[2] ?? "";
        const status = parts[4] ?? "";
        return id && title && status ? `${id} (${status}): ${title}` : "";
      })
      .filter(Boolean);
  } catch {
    /* no tasks yet */
  }

  return ctx;
}

function buildBootstrapTasks(repoSignals: RepoSignals): TaskBrief[] {
  const tasks: TaskBrief[] = [
    {
      id: "T01",
      title: "Lock the exact user requirements",
      objective:
        "Refine the requested behavior, constraints, and success criteria into an implementation-ready spec.",
      contextFiles: [
        ".ged/PROJECT.md",
        "CONTEXT.md",
        ".ged/work/<work-id>/SPEC.md",
      ],
      skills: ["ged-planning", "brainstorming"],
      doneCriteria: [
        "The requested behavior is explicit.",
        "Constraints are captured.",
        "Success criteria are explicit.",
      ],
      status: "todo",
      dependsOn: [],
    },
    {
      id: "T02",
      title: "Break the work into the first bounded slice",
      objective:
        "Break the first meaningful delivery slice into bounded tasks with clear verification steps.",
      contextFiles: [
        ".ged/work/<work-id>/SPEC.md",
        ".ged/work/<work-id>/TASKS.md",
        ".ged/work/<work-id>/TESTS.md",
      ],
      skills: ["ged-planning", "brainstorming"],
      doneCriteria: [
        "The first slice is broken into bounded tasks.",
        "Each task has explicit done criteria.",
        "Verification requirements are listed.",
      ],
      status: "todo",
      dependsOn: ["T01"],
    },
  ];

  if (
    repoSignals.tools.includes("playwright") ||
    repoSignals.tools.includes("cypress")
  ) {
    tasks.push({
      id: "T03",
      title: "Document browser verification expectations",
      objective:
        "Document how browser-based checks should be used during future work.",
      contextFiles: [
        ".ged/work/<work-id>/TESTS.md",
        ".ged/work/<work-id>/SPEC.md",
      ],
      skills: ["agent-browser", "ged-verification"],
      doneCriteria: [
        "Browser testing expectations are documented.",
        "The verification plan names the browser toolchain.",
      ],
      status: "todo",
      dependsOn: ["T02"],
    });
  }

  return tasks;
}

const RELATION_OVERLAP_THRESHOLD = 0.34;
const RELATION_SMALL_SET_LIMIT = 3;

const RELATION_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "build",
  "change",
  "create",
  "feature",
  "fix",
  "for",
  "from",
  "implement",
  "improve",
  "make",
  "new",
  "gedpi",
  "gedpi",
  "please",
  "project",
  "repo",
  "request",
  "task",
  "the",
  "this",
  "update",
  "workflow",
  "work",
]);

function tokenizeRelationText(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 3 &&
          !RELATION_STOPWORDS.has(token) &&
          !/^t\d+$/u.test(token),
      ),
  );
}

export function isRequestRelated(
  brief: ConversationBrief,
  planningCtx?: PlanningContext,
): boolean {
  if (!planningCtx) {
    return true;
  }

  const previous = [
    planningCtx.priorTitle,
    ...planningCtx.priorScope,
    ...planningCtx.priorTaskSummaries,
  ]
    .filter(Boolean)
    .join(" ");
  const current = [
    brief.summary,
    brief.desiredOutcome,
    ...brief.constraints,
    ...brief.userSignals,
  ]
    .filter(Boolean)
    .join(" ");

  if (!previous.trim() || !current.trim()) {
    return true;
  }

  const previousTokens = tokenizeRelationText(previous);
  const currentTokens = tokenizeRelationText(current);
  if (previousTokens.size === 0 || currentTokens.size === 0) {
    return true;
  }

  const overlap = [...currentTokens].filter((token) =>
    previousTokens.has(token),
  );
  if (overlap.length === 0) {
    return false;
  }

  // Compare against the smaller token set: short follow-up summaries
  // ("auth bug fix") have very few tokens, so even one match is meaningful
  // there. With more text on either side, demand a real overlap ratio so a
  // single incidental shared word ("users", "config") doesn't keep an
  // unrelated plan alive.
  const smaller = Math.min(previousTokens.size, currentTokens.size);
  if (smaller <= RELATION_SMALL_SET_LIMIT) {
    return true;
  }
  return overlap.length / smaller >= RELATION_OVERLAP_THRESHOLD;
}

export function createInitialSpec(
  brief: ConversationBrief,
  repoSignals: RepoSignals,
  planningCtx?: PlanningContext,
): ImplementationSpec {
  const presetConfig: PresetConfig | undefined = brief.preset
    ? WORKFLOW_PRESETS[brief.preset]
    : undefined;
  const scopeItems = [
    brief.summary,
    ...brief.constraints,
    ...brief.userSignals,
    ...(presetConfig
      ? [`Workflow preset: ${presetConfig.name} — ${presetConfig.description}`]
      : []),
  ].filter(Boolean);

  if (planningCtx?.priorScope.length) {
    for (const item of planningCtx.priorScope) {
      if (!scopeItems.includes(item)) {
        scopeItems.push(item);
      }
    }
  }

  const architecture = [
    "Use task-scoped `.ged/` work state plus substantive PROJECT/CONTEXT/ADR durable memory.",
    "Keep one friendly user-facing brain that clarifies ambiguity first, plans privately, and only then edits code.",
    `Detected repo signals: languages=${repoSignals.languages.join(", ") || "unknown"}; frameworks=${repoSignals.frameworks.join(", ") || "unknown"}; tools=${repoSignals.tools.join(", ") || "unknown"}.`,
  ];

  if (presetConfig) {
    architecture.push(`Implementation hint: ${presetConfig.executionHint}`);
  }

  if (planningCtx?.existingDecisions.length) {
    architecture.push(
      `Prior decisions to honor: ${planningCtx.existingDecisions.join("; ")}`,
    );
  }

  const acceptanceCriteria = [
    "The project direction is captured in `.ged/PROJECT.md` and the active `.ged/work/<work-id>/SPEC.md`.",
    "The next tasks are small, verifiable, and ready for implementation.",
    "The verification plan names the checks needed for the first slice.",
  ];

  if (planningCtx?.sessionNotes.length) {
    acceptanceCriteria.push(
      `Build on recent progress: ${planningCtx.sessionNotes.slice(0, 3).join("; ")}`,
    );
  }

  let tasks = buildBootstrapTasks(repoSignals);
  if (presetConfig && tasks.length > presetConfig.maxTasks) {
    tasks = tasks.slice(0, presetConfig.maxTasks);
  }
  if (planningCtx?.completedTaskIds.length) {
    for (const task of tasks) {
      if (planningCtx.completedTaskIds.includes(task.id)) {
        task.status = "done";
      }
    }
  }

  return {
    title: brief.desiredOutcome || "Initial GedPi plan",
    scope: scopeItems,
    architecture,
    taskSlices: tasks,
    acceptanceCriteria,
  };
}

export function renderSpecMarkdown(spec: ImplementationSpec): string {
  return `# Spec

## Title

${spec.title}

## Scope

${spec.scope.map((item) => `- ${item}`).join("\n")}

## Architecture

${spec.architecture.map((item) => `- ${item}`).join("\n")}

## Acceptance Criteria

${spec.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

## Risks

- To be identified during planning.

## Open Questions

- To be captured during the understand phase.
`;
}

export function renderTasksMarkdown(tasks: TaskBrief[]): string {
  const rows = tasks.map((task) => {
    const dependsOn =
      task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "-";
    const doneCriteria =
      task.doneCriteria.length > 0 ? task.doneCriteria.join("; ") : "-";
    const skills = task.skills.length > 0 ? task.skills.join(", ") : "-";
    return `| ${escapeTaskTableCell(task.id)} | ${escapeTaskTableCell(task.title)} | ${escapeTaskTableCell(dependsOn)} | ${escapeTaskTableCell(task.status)} | ${escapeTaskTableCell(doneCriteria)} | ${escapeTaskTableCell(skills)} |`;
  });

  return `# Tasks

## Task slices

| ID | Title | Depends On | Status | Done Criteria | Skills |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}

export function renderTestsMarkdown(repoSignals: RepoSignals): string {
  const projectChecks = ["npm test"];

  if (repoSignals.tools.includes("playwright")) {
    projectChecks.push("npx playwright test");
  }

  return `# Tests

## Project-wide checks

${projectChecks.map((check) => `- ${check}`).join("\n")}

## Task-specific checks

- Add task-level checks as each slice is planned.

## Retry policy

- Implementation retries before the plan must be tightened: 2

## Recovery rule

- If the same slice fails repeatedly, tighten the plan, clarify the spec, and retry with a narrower implementation slice.
`;
}
