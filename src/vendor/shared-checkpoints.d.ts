/**
 * Shared checkpoint state types and validation for GedOC and GedPi.
 */

export type TaskClassification = "trivial" | "non-trivial";
export type CheckpointAgent =
  | "ged-explorer"
  | "ged-planner"
  | "ged-plan-reviewer"
  | "ged-verifier"
  | "ged-worker";
export type PlanCheckpointAgent =
  | "ged-explorer"
  | "ged-planner"
  | "ged-plan-reviewer";
export type TaskCheckpointAgent =
  | "ged-explorer"
  | "ged-verifier"
  | "ged-worker";
export type CheckpointSource = "auto" | "manual" | "fallback";
export type CheckpointStatus = "completed" | "skipped" | "blocked" | "failed";
export type CheckpointLifecycleStatus = "active" | "verified" | "closed";
export type PlannerOutcome = "planned" | "refused-needs-clarification";
export type SubagentSourceMode = "foreground" | "async" | "fallback";

export interface CheckpointRecord {
  agent: CheckpointAgent;
  timestamp: string;
  status: CheckpointStatus;
  source?: CheckpointSource;
  skipReason?: string;
  outcome?: PlannerOutcome;
  findingCount?: number;
  blocksCommit?: boolean;
  verifierOutcome?: "clean";
  acceptanceStatus?: string;
  runId?: string;
  taskId?: string;
  sliceId?: string;
  artifactPath?: string;
  artifactPaths?: Record<string, unknown>;
  diffPath?: string;
  sessionPath?: string;
  worktreePath?: string;
  worktree?: boolean;
  sourceMode?: SubagentSourceMode;
}

export interface PlanAcceptanceRecord {
  status: "accepted";
  source: "manual" | "fallback";
  timestamp: string;
  planPaths: string[];
  summary?: string;
  skipReason?: string;
}

export interface WorkerRunRecord {
  agent: "ged-worker";
  timestamp: string;
  status: CheckpointStatus;
  source?: CheckpointSource;
  runId?: string;
  taskId?: string;
  sliceId?: string;
  artifactPath?: string;
  artifactPaths?: Record<string, unknown>;
  diffPath?: string;
  sessionPath?: string;
  worktreePath?: string;
  worktree?: boolean;
  sourceMode?: SubagentSourceMode;
}

export interface ClarificationEvidence {
  goal: string;
  users: string;
  scope: string;
  constraints: string;
}

export interface ClarificationRecord {
  status: "completed" | "skipped";
  source: "manual";
  timestamp: string;
  evidence?: ClarificationEvidence;
  sufficiency?: "sufficient-from-request";
  skipReason?: string;
}

export interface CheckpointState {
  schemaVersion: number;
  lifecycleStatus: CheckpointLifecycleStatus;
  classification: TaskClassification;
  classificationReason: string;
  clarification?: ClarificationRecord;
  planAcceptance?: PlanAcceptanceRecord;
  planCheckpoints: Partial<Record<PlanCheckpointAgent, CheckpointRecord>>;
  taskCheckpoints: Record<
    string,
    Partial<Record<TaskCheckpointAgent, CheckpointRecord>>
  >;
  workerRuns?: WorkerRunRecord[];
}

export interface CheckpointValidation {
  valid: boolean;
  missing: string[];
  warning?: string;
}

export interface SchemaVersionCheck {
  ok: boolean;
  version: number | null;
  error: string | null;
}

export function initCheckpointState(
  classification: TaskClassification,
  classificationReason: string,
): CheckpointState;
export function checkSchemaVersion(raw: unknown): SchemaVersionCheck;
export function parseCheckpointState(raw: unknown): CheckpointState | null;
export function validatePlannerCheckpoint(
  state: CheckpointState | null,
): CheckpointValidation;
export function validateVerifierCheckpoint(
  state: CheckpointState | null,
  taskId: string,
): CheckpointValidation;
export function validateAllVerifierCheckpoints(
  state: CheckpointState | null,
): CheckpointValidation;
export function validateCommitCheckpoints(
  state: CheckpointState | null,
): CheckpointValidation;
export function hasExplorerClearedInspection(
  state: CheckpointState | null,
): boolean;
export function isSafePreExplorerRead(filePath: string): boolean;
export function recordCheckpoint(
  state: CheckpointState,
  record: CheckpointRecord,
  taskId?: string,
): CheckpointState;
export function recordAutoCheckpoint(
  state: CheckpointState,
  record: CheckpointRecord,
  taskId?: string,
): CheckpointState;
export function recordPlanAcceptance(
  state: CheckpointState,
  record: PlanAcceptanceRecord,
): CheckpointState;
export function recordWorkerRun(
  state: CheckpointState,
  run: Partial<WorkerRunRecord> & {
    timestamp: string;
    status: CheckpointStatus;
  },
): CheckpointState;
export function consumePlannerCheckpoint(
  state: CheckpointState,
): CheckpointState;
export function isCheckpointClosed(state: CheckpointState | null): boolean;
export function markCheckpointVerified(state: CheckpointState): CheckpointState;
export function closeCheckpointState(state: CheckpointState): CheckpointState;
export function invalidateVerifierCheckpoints(
  state: CheckpointState,
): CheckpointState;
export function isGitCommitCommand(command: string): boolean;
export function hasSkipCheckpointMarker(command: string): boolean;
export function shouldAutoEscalate(
  currentClassification: TaskClassification,
  touchedFilePaths: string[],
): boolean;
