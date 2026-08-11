import path from "node:path";

import { publishFileExclusive } from "./atomic.js";
import { GED_DIR } from "./contracts.js";
import { gedPathsForWorkId, readWorkItemMeta } from "./ged-paths.js";
import {
  DEFAULT_WORK_SPEC,
  DEFAULT_WORK_TASKS,
  DEFAULT_WORK_TESTS,
} from "./templates.js";

export type ArtifactAuthority =
  | "machine-authority"
  | "approved-instructions"
  | "durable-data"
  | "project-configuration"
  | "work-input"
  | "projection"
  | "compatibility";

export interface DurableArtifactContract {
  artifact: string;
  producer: string;
  consumers: string[];
  authority: ArtifactAuthority;
  lifecycle: string;
}

export const DURABLE_ARTIFACT_INVENTORY: DurableArtifactContract[] = [
  {
    artifact: ".ged/VERSION",
    producer: "workflow initialization/migration",
    consumers: ["ensureGedProjectCurrent", "doctor"],
    authority: "machine-authority",
    lifecycle: "required; monotonically upgraded",
  },
  {
    artifact: ".ged/.gitignore",
    producer: "workflow initialization",
    consumers: ["Git"],
    authority: "machine-authority",
    lifecycle: "required ignore rules for runtime-local evidence",
  },
  {
    artifact: ".ged/IMPORT-STATE.json",
    producer: "standards import",
    consumers: ["standards hash verification and renewed approval"],
    authority: "machine-authority",
    lifecycle: "lazy hash-bound import decisions",
  },
  {
    artifact: ".ged/MEMORY-MIGRATION.json",
    producer: "durable-memory v3 migration",
    consumers: ["startup migration convergence", "humans reviewing migration"],
    authority: "machine-authority",
    lifecycle: "one immutable completion record",
  },
  {
    artifact: ".ged/runtime/migrations/durable-memory-v3/*",
    producer: "durable-memory v3 migration",
    consumers: ["migration recovery and byte verification"],
    authority: "machine-authority",
    lifecycle: "ignored backups, journal, and stale-lock evidence",
  },
  {
    artifact: ".ged/runtime/active-work/<session-key>.json",
    producer: "ged work selection runtime",
    consumers: ["ged paths", "governance guards"],
    authority: "machine-authority",
    lifecycle: "ignored, session-scoped selection",
  },
  {
    artifact: ".ged/runtime/<work-id>/governance.json",
    producer: "governance store",
    consumers: ["mutation/commit/lifecycle guards", "brain status"],
    authority: "machine-authority",
    lifecycle: "append-only evidence with monotonic revisions",
  },
  {
    artifact: ".ged/work/<work-id>/META.json",
    producer: "ged work selection runtime",
    consumers: ["governance identity", "work artifact helpers"],
    authority: "machine-authority",
    lifecycle: "immutable for the work item's lifetime",
  },
  {
    artifact: ".ged/PROJECT.md",
    producer: "coordinator via ged_memory create-on-substance tool",
    consumers: ["brain durable-data prompt", "planning context"],
    authority: "durable-data",
    lifecycle: "current project summary, edited in place",
  },
  {
    artifact: ".ged/reports/*.md",
    producer: "coordinator via ged_memory create-on-substance tool",
    consumers: ["humans", "explicit later planning context"],
    authority: "durable-data",
    lifecycle: "lazy substantive read-only reports",
  },
  {
    artifact: "CONTEXT.md",
    producer: "coordinator via ged_memory/domain workflow or v3 migration",
    consumers: ["brain durable-data prompt", "planning context"],
    authority: "durable-data",
    lifecycle: "canonical current domain vocabulary",
  },
  {
    artifact: "docs/adr/*.md",
    producer: "coordinator via ged_memory or v3 migration",
    consumers: ["brain durable-data prompt", "planning context"],
    authority: "durable-data",
    lifecycle: "sparse durable decision records",
  },
  {
    artifact: ".ged/STANDARDS.md",
    producer: "explicit standards import",
    consumers: ["brain approved-instructions prompt"],
    authority: "approved-instructions",
    lifecycle: "rewritten only from explicitly accepted source paths",
  },
  {
    artifact: ".ged/work/<work-id>/DIRECT.md",
    producer: "direct-change work open",
    consumers: ["coordinator", "work handoff"],
    authority: "work-input",
    lifecycle: "one concise scope/check record per direct-change work item",
  },
  {
    artifact: ".ged/work/<work-id>/{SPEC,TASKS,TESTS}.md",
    producer: "planned-change work open/planning",
    consumers: ["plan binding", "coordinator", "workers/verifier"],
    authority: "work-input",
    lifecycle: "created only for planned-change work; content-bound",
  },
  {
    artifact: ".ged/work/<work-id>/tasks/<task-id>/*",
    producer: "work engine",
    consumers: ["retry/recovery", "commit helper", "task context"],
    authority: "work-input",
    lifecycle: "scoped to immutable work and reusable task-local ID",
  },
  {
    artifact: ".ged/runtime/<work-id>/{STATE,SESSION-SUMMARY}.md",
    producer: "explicit ged_memory projection/handoff tool",
    consumers: ["humans and cross-session handoff only"],
    authority: "projection",
    lifecycle: "optional and always regenerable; never parsed as authority",
  },
  {
    artifact: ".agents/skills/<name>/SKILL.md",
    producer: "explicit ged_skill creation",
    consumers: ["Pi native discovery", "Ged hash-checked skill matching"],
    authority: "project-configuration",
    lifecycle: "lazy reusable project knowledge; persists across tasks",
  },
  {
    artifact: ".ged/SKILLS-STATE.json",
    producer: "explicit ged_skill creation",
    consumers: ["project skill lifecycle"],
    authority: "machine-authority",
    lifecycle: "lazy provenance/hash registry; never task-cleaned",
  },
  {
    artifact: ".ged/{GLOSSARY,DECISIONS}.md",
    producer: "v3 compatibility migration only",
    consumers: ["humans following canonical-destination pointer"],
    authority: "compatibility",
    lifecycle: "read-only pointer after migration; never prompt-injected",
  },
];

const SAFE_ARTIFACT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const LEGACY_PROJECT_PLACEHOLDER = `# Project

## Goal

Describe what this project should achieve.

## Users

- Primary users:
- Secondary users:

## Constraints

- Technical constraints:
- Product constraints:

## Success Criteria

- What does success look like?
`;

const NON_SUBSTANTIVE_DOCUMENTS = new Set([
  DEFAULT_WORK_SPEC,
  DEFAULT_WORK_TASKS,
  DEFAULT_WORK_TESTS,
  LEGACY_PROJECT_PLACEHOLDER,
]);

// A helper call represents a deliberate substantive write. It rejects blank
// prose and markdown containing only headings, table scaffolding, or placeholder
// bullets, but otherwise preserves the caller's bytes unchanged.
export function isSubstantiveMarkdown(content: string): boolean {
  if (!content.trim()) return false;
  if (NON_SUBSTANTIVE_DOCUMENTS.has(content)) return false;
  const meaningful = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}(?:\s+.*)?$/u.test(line))
    .filter((line) => !/^\|?(?:\s*:?-{3,}:?\s*\|)+$/u.test(line))
    .filter((line) => !/^[-*+]\s*(?:none yet|tbd|todo)?[.:]?$/iu.test(line))
    .filter((line) => !/^(?:none yet|tbd|todo)[.:]?$/iu.test(line));
  return meaningful.length > 0;
}

async function publishSubstantive(
  filePath: string,
  content: string,
): Promise<boolean> {
  if (!isSubstantiveMarkdown(content)) return false;
  return publishFileExclusive(filePath, content);
}

function requireArtifactId(value: string, label: string): void {
  if (!SAFE_ARTIFACT_ID.test(value)) {
    throw new Error(`${label} must be a safe lowercase artifact identifier.`);
  }
}

export async function createProjectSummary(
  rootDir: string,
  content: string,
): Promise<boolean> {
  return publishSubstantive(path.join(rootDir, GED_DIR, "PROJECT.md"), content);
}

export async function createReadOnlyReport(
  rootDir: string,
  reportId: string,
  content: string,
): Promise<boolean> {
  requireArtifactId(reportId, "reportId");
  return publishSubstantive(
    path.join(rootDir, GED_DIR, "reports", `${reportId}.md`),
    content,
  );
}

export interface DirectChangeRecordInput {
  summary: string;
  decisionReason: string;
  deterministicCheck: boolean;
}

export async function createDirectChangeRecord(
  rootDir: string,
  workId: string,
  input: DirectChangeRecordInput,
): Promise<boolean> {
  const meta = await readWorkItemMeta(rootDir, workId);
  const paths = gedPathsForWorkId(rootDir, workId);
  return publishSubstantive(
    path.join(paths.workDir, "DIRECT.md"),
    `# Direct change\n\n- Work ID: ${meta.workId}\n- Scope: ${input.summary.trim()}\n- Governance: ${input.decisionReason.trim()}\n- Deterministic check available: ${input.deterministicCheck ? "yes" : "no"}\n`,
  );
}

export async function createPlannedWorkArtifacts(
  rootDir: string,
  workId: string,
): Promise<string[]> {
  await readWorkItemMeta(rootDir, workId);
  const paths = gedPathsForWorkId(rootDir, workId);
  const created: string[] = [];
  for (const [filePath, content] of [
    [paths.specPath, DEFAULT_WORK_SPEC],
    [paths.tasksPath, DEFAULT_WORK_TASKS],
    [paths.testsPath, DEFAULT_WORK_TESTS],
  ] as const) {
    if (await publishFileExclusive(filePath, content)) created.push(filePath);
  }
  return created;
}

export async function createRootContext(
  rootDir: string,
  content: string,
): Promise<boolean> {
  return publishSubstantive(path.join(rootDir, "CONTEXT.md"), content);
}

export async function createAdr(
  rootDir: string,
  adrId: string,
  content: string,
): Promise<boolean> {
  requireArtifactId(adrId, "adrId");
  return publishSubstantive(
    path.join(rootDir, "docs", "adr", `${adrId}.md`),
    content,
  );
}

export async function createHandoffProjection(
  rootDir: string,
  workId: string,
  content: string,
): Promise<boolean> {
  await readWorkItemMeta(rootDir, workId);
  return publishSubstantive(
    gedPathsForWorkId(rootDir, workId).sessionSummaryPath,
    content,
  );
}

export function taskArtifactDir(
  rootDir: string,
  workId: string,
  taskId: string,
): string {
  requireArtifactId(taskId.toLowerCase(), "taskId");
  return path.join(gedPathsForWorkId(rootDir, workId).workDir, "tasks", taskId);
}
