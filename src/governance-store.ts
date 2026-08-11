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
  type GovernancePendingMutation,
  type GovernanceWorkState,
  WORK_LIFECYCLES,
  WORK_MODES,
  type WorkLifecycle,
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
      | "duplicate-evidence"
      | "governance-blocked",
  ) {
    super(message);
    this.name = "GovernanceStoreError";
  }
}

export type GovernanceGuardAction =
  | "metadata-mutation"
  | "source-mutation"
  | "commit";

export interface InitializeGovernanceStateInput {
  decision: GovernanceDecision;
  executionProfile: ExecutionProfile;
  currentSlice?: string | null;
  lifecycle?: WorkLifecycle;
  evidence?: GovernanceEvidence[];
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

function validPendingMutation(
  value: unknown,
): value is GovernancePendingMutation {
  if (!isObject(value)) return false;
  return (
    hasOnlyKeys(value, [
      "id",
      "requestId",
      "toolCallId",
      "target",
      "startedAt",
    ]) &&
    nonBlank(value.id) &&
    nonBlank(value.requestId) &&
    nonBlank(value.toolCallId) &&
    nonBlank(value.target) &&
    validDate(value.startedAt)
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
  const pendingMutations = value.pendingMutations;
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
      "pendingMutations",
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
    !(
      pendingMutations === undefined ||
      (Array.isArray(pendingMutations) &&
        pendingMutations.every(validPendingMutation))
    ) ||
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
  const pendingIds = (pendingMutations ?? []).map(
    (entry) => (entry as GovernancePendingMutation).id,
  );
  if (
    new Set(evidenceIds).size !== evidenceIds.length ||
    new Set(approvalIds).size !== approvalIds.length ||
    new Set(pendingIds).size !== pendingIds.length
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

function latestEvidence(
  state: GovernanceWorkState,
  kind: GovernanceEvidence["kind"],
): { entry: GovernanceEvidence; index: number } | null {
  for (let index = state.evidence.length - 1; index >= 0; index -= 1) {
    const entry = state.evidence[index];
    if (entry?.kind === kind) return { entry, index };
  }
  return null;
}

export function governanceActionBlockReason(
  state: GovernanceWorkState,
  action: GovernanceGuardAction,
): string | null {
  if (state.lifecycle !== "active") {
    return `Ged work ${state.workId} has lifecycle ${state.lifecycle}; only active work can authorize mutation.`;
  }
  if (
    state.evidence.some(
      (entry) =>
        entry.kind === "migration-required" && entry.outcome === "failed",
    )
  ) {
    return `Ged work ${state.workId} requires legacy migration review and cannot authorize mutation.`;
  }
  if (state.decision.mode === "read-only") {
    return `Ged work ${state.workId} is read-only and cannot authorize mutation.`;
  }
  if (state.decision.requiresDecision) {
    return `Ged work ${state.workId} still requires a user-owned decision before mutation.`;
  }
  const latestPlan = latestEvidence(state, "plan");
  const planSatisfied = latestPlan?.entry.outcome === "satisfied";
  if (
    state.decision.mode === "planned-change" &&
    action !== "metadata-mutation" &&
    !planSatisfied
  ) {
    return `Ged work ${state.workId} is planned-change work without satisfied plan evidence.`;
  }
  if (action === "commit") {
    if ((state.pendingMutations?.length ?? 0) > 0) {
      return `Ged work ${state.workId} has a source mutation pending durable completion evidence.`;
    }
    let latestImplementation = -1;
    state.evidence.forEach((entry, index) => {
      if (entry.kind === "implementation") latestImplementation = index;
    });
    const verification = latestEvidence(state, "verification");
    if (
      !verification ||
      verification.index <= latestImplementation ||
      verification.entry.outcome !== "satisfied"
    ) {
      return `Ged work ${state.workId} has no satisfied verification evidence newer than its latest implementation evidence.`;
    }
  }
  return null;
}

/** Returns a fail-closed denial from authoritative state. */
export async function governanceMutationBlockReason(
  rootDir: string,
  workId: string,
  action: GovernanceGuardAction = "source-mutation",
): Promise<string | null> {
  try {
    return governanceActionBlockReason(
      await readGovernanceState(rootDir, workId),
      action,
    );
  } catch (error) {
    if (error instanceof GovernanceStoreError && error.code === "missing") {
      return `Ged work ${workId} has no authoritative governance state.`;
    }
    throw error;
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
- Pending mutations: ${state.pendingMutations?.length ?? 0}
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
      evidence: input.evidence ?? [],
      pendingMutations: [],
      lifecycle: input.lifecycle ?? "active",
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

async function appendEvidenceWithPolicy(
  rootDir: string,
  workId: string,
  record: GovernanceEvidence,
  policy: (current: GovernanceWorkState) => string | null,
  now = new Date(),
): Promise<GovernanceWorkState> {
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () => {
    const current = await readGovernanceState(rootDir, workId);
    const blocked = policy(current);
    if (blocked) {
      throw new GovernanceStoreError(blocked, "governance-blocked");
    }
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

export async function beginGovernanceMutation(
  rootDir: string,
  workId: string,
  pending: GovernancePendingMutation,
  now = new Date(),
): Promise<GovernanceWorkState> {
  if (!validPendingMutation(pending)) {
    throw new GovernanceStoreError(
      "Pending mutation has an invalid shape.",
      "invalid-state",
    );
  }
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () => {
    const current = await readGovernanceState(rootDir, workId);
    const blocked = governanceActionBlockReason(current, "source-mutation");
    if (blocked) {
      throw new GovernanceStoreError(blocked, "governance-blocked");
    }
    if (
      (current.pendingMutations ?? []).some(
        (entry) =>
          entry.id === pending.id ||
          (entry.requestId === pending.requestId &&
            entry.toolCallId === pending.toolCallId),
      )
    ) {
      throw new GovernanceStoreError(
        `Pending mutation ${pending.id} already exists.`,
        "invalid-state",
      );
    }
    const next = validateState({
      ...current,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
      pendingMutations: [...(current.pendingMutations ?? []), pending],
    });
    await writeStructuredState(rootDir, workId, next);
    await writeProjectionFromState(rootDir, next);
    return next;
  });
}

export async function completeGovernanceMutation(
  rootDir: string,
  workId: string,
  pendingId: string,
  record: GovernanceEvidence,
  now = new Date(),
): Promise<GovernanceWorkState> {
  if (
    !nonBlank(pendingId) ||
    record.kind !== "implementation" ||
    record.outcome !== "observed" ||
    !validEvidence(record)
  ) {
    throw new GovernanceStoreError(
      "Mutation completion requires a pending ID and observed implementation evidence.",
      "invalid-state",
    );
  }
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () => {
    const current = await readGovernanceState(rootDir, workId);
    if (
      !(current.pendingMutations ?? []).some((entry) => entry.id === pendingId)
    ) {
      throw new GovernanceStoreError(
        `Pending mutation ${pendingId} does not exist.`,
        "invalid-state",
      );
    }
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
      pendingMutations: (current.pendingMutations ?? []).filter(
        (entry) => entry.id !== pendingId,
      ),
      evidence: [...current.evidence, record],
    });
    await writeStructuredState(rootDir, workId, next);
    await writeProjectionFromState(rootDir, next);
    return next;
  });
}

export async function clearGovernanceMutation(
  rootDir: string,
  workId: string,
  pendingId: string,
  now = new Date(),
): Promise<GovernanceWorkState> {
  const paths = gedPathsForWorkId(rootDir, workId);
  return withProcessQueue(paths.governancePath, async () => {
    const current = await readGovernanceState(rootDir, workId);
    if (
      !(current.pendingMutations ?? []).some((entry) => entry.id === pendingId)
    ) {
      throw new GovernanceStoreError(
        `Pending mutation ${pendingId} does not exist.`,
        "invalid-state",
      );
    }
    const next = validateState({
      ...current,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
      pendingMutations: (current.pendingMutations ?? []).filter(
        (entry) => entry.id !== pendingId,
      ),
    });
    await writeStructuredState(rootDir, workId, next);
    await writeProjectionFromState(rootDir, next);
    return next;
  });
}

export async function recordGovernanceImplementation(
  rootDir: string,
  workId: string,
  record: GovernanceEvidence,
  now = new Date(),
): Promise<GovernanceWorkState> {
  if (record.kind !== "implementation" || record.outcome !== "observed") {
    throw new GovernanceStoreError(
      "Implementation transitions require observed implementation evidence.",
      "invalid-state",
    );
  }
  return appendEvidenceWithPolicy(
    rootDir,
    workId,
    record,
    (current) => governanceActionBlockReason(current, "source-mutation"),
    now,
  );
}

export async function recordSatisfiedGovernanceEvidence(
  rootDir: string,
  workId: string,
  record: GovernanceEvidence,
  now = new Date(),
): Promise<GovernanceWorkState> {
  if (
    (record.kind !== "plan" && record.kind !== "verification") ||
    record.outcome !== "satisfied"
  ) {
    throw new GovernanceStoreError(
      "Governance milestones require satisfied plan or verification evidence.",
      "invalid-state",
    );
  }
  return appendEvidenceWithPolicy(
    rootDir,
    workId,
    record,
    (current) => {
      const base = governanceActionBlockReason(current, "metadata-mutation");
      if (base) return base;
      if (
        record.kind === "plan" &&
        current.decision.mode !== "planned-change"
      ) {
        return "Plan evidence is only valid for planned-change work.";
      }
      if (
        record.kind === "verification" &&
        current.decision.mode === "planned-change" &&
        latestEvidence(current, "plan")?.entry.outcome !== "satisfied"
      ) {
        return "Planned-change verification requires satisfied plan evidence first.";
      }
      return null;
    },
    now,
  );
}
