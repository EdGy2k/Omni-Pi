export const WORK_MODES = [
  "read-only",
  "direct-change",
  "planned-change",
] as const;

export type WorkMode = (typeof WORK_MODES)[number];

export const AMBIGUITIES = ["sufficient", "decision-needed"] as const;

export type Ambiguity = (typeof AMBIGUITIES)[number];

export const RISKS = ["low", "normal", "high"] as const;

export type Risk = (typeof RISKS)[number];

export const WORK_LIFECYCLES = [
  "active",
  "paused",
  "completed",
  "abandoned",
  "superseded",
] as const;

export type WorkLifecycle = (typeof WORK_LIFECYCLES)[number];

export const EXECUTION_PROFILES = [
  "solo",
  "assisted",
  "coordinated",
  "high-stakes",
] as const;

export type ExecutionProfile = (typeof EXECUTION_PROFILES)[number];

export interface DirectChangeEvidence {
  clearScope: boolean;
  bounded: boolean;
  reversible: boolean;
  deterministicCheck: boolean;
}

export interface NoMutationIntent {
  mutation: "none";
}

export interface RequestedMutationIntent {
  mutation: "requested";
  minimumMode: Exclude<WorkMode, "read-only">;
}

export type UserMutationIntent = NoMutationIntent | RequestedMutationIntent;

interface GovernanceContext {
  ambiguity: Ambiguity;
  risk: Risk;
  coordinatorEscalation?: {
    reason: string;
  };
}

export interface ReadOnlyGovernanceInput extends GovernanceContext {
  intent: NoMutationIntent;
  change?: never;
}

export interface ChangeGovernanceInput extends GovernanceContext {
  intent: RequestedMutationIntent;
  change: DirectChangeEvidence;
}

export type GovernanceInput = ReadOnlyGovernanceInput | ChangeGovernanceInput;

export type GovernanceReasonCode =
  | "no-mutation-intent"
  | "decision-needed"
  | "user-requested-plan"
  | "high-risk"
  | "coordinator-escalation"
  | "direct-change-eligible"
  | "direct-change-ineligible";

export interface GovernanceDecision {
  mode: WorkMode;
  reasonCode: GovernanceReasonCode;
  reason: string;
  requiresDecision: boolean;
}

export type GovernanceEvidenceKind =
  | "inspection"
  | "plan"
  | "implementation"
  | "verification"
  | "approval"
  | "migration-required";

export type GovernanceEvidenceSource = "human" | "runtime" | "agent";

export interface GovernanceEvidence {
  id: string;
  kind: GovernanceEvidenceKind;
  source: GovernanceEvidenceSource;
  producerId?: string;
  recordedAt: string;
  summary: string;
  outcome: "observed" | "satisfied" | "failed";
}

export interface GovernanceApproval {
  id: string;
  kind: "plan" | "mutation" | "completion";
  status: "pending" | "approved" | "rejected";
  recordedAt: string;
  summary: string;
}

export interface GovernanceRepositoryIdentity {
  repositoryId: string;
  worktreeId: string;
  branch: string | null;
  baseHead: string | null;
}

export interface GovernanceWorkState {
  schemaVersion: 1;
  revision: number;
  workId: string;
  summary: string;
  repository: GovernanceRepositoryIdentity;
  createdAt: string;
  updatedAt: string;
  currentSlice: string | null;
  decision: GovernanceDecision;
  executionProfile: ExecutionProfile;
  approvals: GovernanceApproval[];
  evidence: GovernanceEvidence[];
  lifecycle: WorkLifecycle;
}

function isReadOnlyInput(
  input: GovernanceInput,
): input is ReadOnlyGovernanceInput {
  return input.intent.mutation === "none";
}

function decision(
  mode: WorkMode,
  reasonCode: GovernanceReasonCode,
  reason: string,
  requiresDecision = false,
): GovernanceDecision {
  return { mode, reasonCode, reason, requiresDecision };
}

/**
 * Select governance depth from normalized policy evidence.
 *
 * This decision is not mutation authorization. Runtime guards must combine it
 * with active work identity, lifecycle, approvals, and current evidence.
 */
export function resolveGovernance(input: GovernanceInput): GovernanceDecision {
  if (isReadOnlyInput(input)) {
    return decision(
      "read-only",
      "no-mutation-intent",
      "The user did not request repository mutation, so the work remains read-only regardless of breadth or risk.",
    );
  }

  if (input.ambiguity === "decision-needed") {
    return decision(
      "planned-change",
      "decision-needed",
      "A user-owned decision remains unresolved; mutation is blocked until that decision is resolved.",
      true,
    );
  }

  if (input.intent.minimumMode === "planned-change") {
    return decision(
      "planned-change",
      "user-requested-plan",
      "The user requested a planned change, and the coordinator cannot downgrade it.",
    );
  }

  if (input.risk === "high") {
    return decision(
      "planned-change",
      "high-risk",
      "A high-risk dimension requires explicit planning before mutation.",
    );
  }

  if (input.coordinatorEscalation) {
    const escalationReason =
      input.coordinatorEscalation.reason.trim() ||
      "The coordinator identified additional planning risk.";
    return decision(
      "planned-change",
      "coordinator-escalation",
      `The coordinator escalated this change: ${escalationReason}`,
    );
  }

  const { change } = input;
  if (
    change.clearScope &&
    change.bounded &&
    change.reversible &&
    change.deterministicCheck
  ) {
    return decision(
      "direct-change",
      "direct-change-eligible",
      "The change is clear, bounded, reversible, deterministically checkable, and has no high-risk dimension.",
    );
  }

  return decision(
    "planned-change",
    "direct-change-ineligible",
    "Direct-change evidence is incomplete, so explicit planning is required before mutation.",
  );
}
