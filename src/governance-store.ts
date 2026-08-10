import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "./atomic.js";
import {
  gedPathsForWorkId,
  isGeneratedWorkId,
  readWorkItemMeta,
} from "./ged-paths.js";
import {
  EXECUTION_PROFILES,
  type ExecutionProfile,
  type GovernanceDecision,
  type GovernanceEvidence,
  type GovernanceWorkState,
  WORK_LIFECYCLES,
  WORK_MODES,
} from "./governance.js";
import { withProcessQueue } from "./serial-queue.js";

const execFileAsync = promisify(execFile);
const REASON_CODES = new Set([
  "no-mutation-intent",
  "decision-needed",
  "user-requested-plan",
  "high-risk",
  "coordinator-escalation",
  "direct-change-eligible",
  "direct-change-ineligible",
]);
const EVIDENCE_KINDS = new Set([
  "inspection",
  "plan",
  "implementation",
  "verification",
  "approval",
  "migration-required",
]);
const EVIDENCE_SOURCES = new Set(["human", "runtime", "agent"]);
const EVIDENCE_OUTCOMES = new Set(["observed", "satisfied", "failed"]);
const DECISION_MODE_BY_REASON = new Map<string, string>([
  ["no-mutation-intent", "read-only"],
  ["direct-change-eligible", "direct-change"],
  ["decision-needed", "planned-change"],
  ["user-requested-plan", "planned-change"],
  ["high-risk", "planned-change"],
  ["coordinator-escalation", "planned-change"],
  ["direct-change-ineligible", "planned-change"],
]);

export class GovernanceStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing"
      | "already-exists"
      | "invalid-state"
      | "stale-revision"
      | "duplicate-evidence",
  ) {
    super(message);
    this.name = "GovernanceStoreError";
  }
}

export interface InitializeGovernanceStateInput {
  decision: GovernanceDecision;
  executionProfile: ExecutionProfile;
  currentSlice?: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    return false;
  return new Date(value).toISOString() === value;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDecision(value: unknown): value is GovernanceDecision {
  if (!isObject(value)) return false;
  return (
    hasOnlyKeys(value, ["mode", "reasonCode", "reason", "requiresDecision"]) &&
    typeof value.mode === "string" &&
    WORK_MODES.includes(value.mode as (typeof WORK_MODES)[number]) &&
    typeof value.reasonCode === "string" &&
    REASON_CODES.has(value.reasonCode) &&
    DECISION_MODE_BY_REASON.get(value.reasonCode) === value.mode &&
    nonBlank(value.reason) &&
    typeof value.requiresDecision === "boolean"
  );
}

function validEvidence(value: unknown): value is GovernanceEvidence {
  if (!isObject(value)) return false;
  return (
    hasOnlyKeys(value, [
      "id",
      "kind",
      "source",
      "producerId",
      "recordedAt",
      "summary",
      "outcome",
    ]) &&
    nonBlank(value.id) &&
    typeof value.kind === "string" &&
    EVIDENCE_KINDS.has(value.kind) &&
    typeof value.source === "string" &&
    EVIDENCE_SOURCES.has(value.source) &&
    (value.producerId === undefined || nonBlank(value.producerId)) &&
    validDate(value.recordedAt) &&
    nonBlank(value.summary) &&
    typeof value.outcome === "string" &&
    EVIDENCE_OUTCOMES.has(value.outcome)
  );
}

function validApproval(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    hasOnlyKeys(value, ["id", "kind", "status", "recordedAt", "summary"]) &&
    nonBlank(value.id) &&
    (value.kind === "plan" ||
      value.kind === "mutation" ||
      value.kind === "completion") &&
    (value.status === "pending" ||
      value.status === "approved" ||
      value.status === "rejected") &&
    validDate(value.recordedAt) &&
    nonBlank(value.summary)
  );
}

function validateState(value: unknown): GovernanceWorkState {
  if (!isObject(value)) {
    throw new GovernanceStoreError(
      "Governance state must be an object.",
      "invalid-state",
    );
  }
  const repository = value.repository;
  const approvals = value.approvals;
  const evidence = value.evidence;
  if (
    !hasOnlyKeys(value, [
      "schemaVersion",
      "revision",
      "workId",
      "summary",
      "repository",
      "createdAt",
      "updatedAt",
      "currentSlice",
      "decision",
      "executionProfile",
      "approvals",
      "evidence",
      "lifecycle",
    ]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.workId !== "string" ||
    !isGeneratedWorkId(value.workId) ||
    !nonBlank(value.summary) ||
    !isObject(repository) ||
    !hasOnlyKeys(repository, [
      "repositoryId",
      "worktreeId",
      "branch",
      "baseHead",
    ]) ||
    typeof repository.repositoryId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(repository.repositoryId) ||
    typeof repository.worktreeId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(repository.worktreeId) ||
    !(repository.branch === null || typeof repository.branch === "string") ||
    !(
      repository.baseHead === null || typeof repository.baseHead === "string"
    ) ||
    !validDate(value.createdAt) ||
    !validDate(value.updatedAt) ||
    !(value.currentSlice === null || nonBlank(value.currentSlice)) ||
    !validDecision(value.decision) ||
    typeof value.executionProfile !== "string" ||
    !EXECUTION_PROFILES.includes(
      value.executionProfile as (typeof EXECUTION_PROFILES)[number],
    ) ||
    !Array.isArray(approvals) ||
    !approvals.every(validApproval) ||
    !Array.isArray(evidence) ||
    !evidence.every(validEvidence) ||
    typeof value.lifecycle !== "string" ||
    !WORK_LIFECYCLES.includes(
      value.lifecycle as (typeof WORK_LIFECYCLES)[number],
    )
  ) {
    throw new GovernanceStoreError(
      "Governance state has an invalid or unsupported shape.",
      "invalid-state",
    );
  }
  const evidenceIds = evidence.map((entry) => entry.id);
  const approvalIds = approvals.map((entry) => (entry as { id: string }).id);
  if (
    new Set(evidenceIds).size !== evidenceIds.length ||
    new Set(approvalIds).size !== approvalIds.length
  ) {
    throw new GovernanceStoreError(
      "Governance state contains duplicate record IDs.",
      "invalid-state",
    );
  }
  return value as unknown as GovernanceWorkState;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function identityFor(rootDir: string): Promise<{
  repositoryId: string;
  worktreeId: string;
}> {
  const worktree = await realpath(rootDir).catch(() => path.resolve(rootDir));
  let repository = worktree;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        rootDir,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { timeout: 2000 },
    );
    repository = stdout.trim() || worktree;
  } catch {
    // Non-Git work uses the worktree itself as repository identity.
  }
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return { repositoryId: digest(repository), worktreeId: digest(worktree) };
}

export async function readGovernanceState(
  rootDir: string,
  workId: string,
): Promise<GovernanceWorkState> {
  await readWorkItemMeta(rootDir, workId);
  const filePath = gedPathsForWorkId(rootDir, workId).governancePath;
  try {
    const state = validateState(JSON.parse(await readFile(filePath, "utf8")));
    if (state.workId !== workId) {
      throw new GovernanceStoreError(
        `Governance state identity ${state.workId} does not match requested work ${workId}.`,
        "invalid-state",
      );
    }
    return state;
  } catch (error) {
    if (error instanceof GovernanceStoreError) throw error;
    if (isEnoent(error)) {
      throw new GovernanceStoreError(
        `Governance state for ${workId} does not exist.`,
        "missing",
      );
    }
    throw new GovernanceStoreError(
      `Unable to parse governance state: ${error instanceof Error ? error.message : String(error)}`,
      "invalid-state",
    );
  }
}

async function writeStructuredState(
  rootDir: string,
  expectedWorkId: string,
  state: GovernanceWorkState,
): Promise<void> {
  if (state.workId !== expectedWorkId) {
    throw new GovernanceStoreError(
      "Governance state cannot be written outside its selected work item.",
      "invalid-state",
    );
  }
  const paths = gedPathsForWorkId(rootDir, expectedWorkId);
  await writeFileAtomic(
    paths.governancePath,
    `${JSON.stringify(validateState(state), null, 2)}\n`,
  );
}

export function renderGovernanceProjection(state: GovernanceWorkState): string {
  const line = (value: string) => value.replace(/\s+/gu, " ").trim();
  const blockers = state.decision.requiresDecision
    ? "A user-owned decision is required"
    : "None";
  return `# State

Current Phase: ${state.lifecycle === "active" ? "Build" : "Check"}
Active Task: ${line(state.currentSlice ?? state.summary)}
Status Summary: ${state.decision.mode} — ${line(state.decision.reason)}
Blockers: ${blockers}
Next Step: Follow the authoritative governance decision and current slice.

## Governance

- Work ID: ${state.workId}
- Revision: ${state.revision}
- Lifecycle: ${state.lifecycle}
- Execution profile: ${state.executionProfile}
- Evidence records: ${state.evidence.length}
- Approval records: ${state.approvals.length}
`;
}

async function writeProjectionFromState(
  rootDir: string,
  state: GovernanceWorkState,
): Promise<string> {
  const projection = renderGovernanceProjection(state);
  await writeFileAtomic(
    gedPathsForWorkId(rootDir, state.workId).statePath,
    projection,
  );
  return projection;
}

export async function regenerateGovernanceProjection(
  rootDir: string,
  workId: string,
): Promise<string> {
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () =>
    writeProjectionFromState(
      rootDir,
      await readGovernanceState(rootDir, workId),
    ),
  );
}

export async function initializeGovernanceState(
  rootDir: string,
  workId: string,
  input: InitializeGovernanceStateInput,
  now = new Date(),
): Promise<GovernanceWorkState> {
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () => {
    try {
      await readGovernanceState(rootDir, workId);
      throw new GovernanceStoreError(
        `Governance state for ${workId} already exists.`,
        "already-exists",
      );
    } catch (error) {
      if (
        !(error instanceof GovernanceStoreError) ||
        error.code !== "missing"
      ) {
        throw error;
      }
    }
    const meta = await readWorkItemMeta(rootDir, workId);
    const ids = await identityFor(rootDir);
    const timestamp = now.toISOString();
    const state: GovernanceWorkState = validateState({
      schemaVersion: 1,
      revision: 0,
      workId,
      summary: meta.summary,
      repository: { ...ids, branch: meta.branch, baseHead: meta.baseHead },
      createdAt: timestamp,
      updatedAt: timestamp,
      currentSlice: input.currentSlice ?? null,
      decision: input.decision,
      executionProfile: input.executionProfile,
      approvals: [],
      evidence: [],
      lifecycle: "active",
    });
    await writeStructuredState(rootDir, workId, state);
    await writeProjectionFromState(rootDir, state);
    return state;
  });
}

export async function compareAndSwapGovernanceState(
  rootDir: string,
  workId: string,
  expectedRevision: number,
  update: (current: GovernanceWorkState) => GovernanceWorkState,
  now = new Date(),
): Promise<GovernanceWorkState> {
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () => {
    const current = await readGovernanceState(rootDir, workId);
    if (current.revision !== expectedRevision) {
      throw new GovernanceStoreError(
        `Stale governance revision ${expectedRevision}; current revision is ${current.revision}.`,
        "stale-revision",
      );
    }
    const candidate = update(structuredClone(current));
    if (
      candidate.workId !== current.workId ||
      candidate.schemaVersion !== current.schemaVersion ||
      candidate.createdAt !== current.createdAt ||
      candidate.summary !== current.summary ||
      JSON.stringify(candidate.repository) !==
        JSON.stringify(current.repository)
    ) {
      throw new GovernanceStoreError(
        "Governance updates cannot change identity or creation metadata.",
        "invalid-state",
      );
    }
    const next = validateState({
      ...candidate,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    });
    await writeStructuredState(rootDir, workId, next);
    await writeProjectionFromState(rootDir, next);
    return next;
  });
}

export async function appendGovernanceEvidence(
  rootDir: string,
  workId: string,
  record: GovernanceEvidence,
  now = new Date(),
): Promise<GovernanceWorkState> {
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () => {
    const current = await readGovernanceState(rootDir, workId);
    if (current.evidence.some((entry) => entry.id === record.id)) {
      throw new GovernanceStoreError(
        `Evidence ID ${record.id} already exists.`,
        "duplicate-evidence",
      );
    }
    const next = validateState({
      ...current,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
      evidence: [...current.evidence, record],
    });
    await writeStructuredState(rootDir, workId, next);
    await writeProjectionFromState(rootDir, next);
    return next;
  });
}
