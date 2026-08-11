export const GED_DIR = ".ged";

export type GedPhase = "understand" | "plan" | "build" | "check" | "escalate";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export type SkillPolicy =
  | "auto-install"
  | "recommend-only"
  | "never-auto-install";

export interface ConversationBrief {
  summary: string;
  desiredOutcome: string;
  constraints: string[];
  userSignals: string[];
  preset?: WorkflowPreset;
}

export interface ImplementationSpec {
  title: string;
  scope: string[];
  architecture: string[];
  taskSlices: TaskBrief[];
  acceptanceCriteria: string[];
}

export interface TaskBrief {
  id: string;
  title: string;
  objective: string;
  contextFiles: string[];
  skills: string[];
  doneCriteria: string[];
  status: TaskStatus;
  dependsOn: string[];
}

export interface VerificationResult {
  taskId: string;
  passed: boolean;
  checksRun: string[];
  failureSummary: string[];
  retryRecommended: boolean;
}

export interface TaskAttemptResult {
  summary: string;
  verification: VerificationResult;
  modifiedFiles?: string[];
}

export interface SkillCandidate {
  name: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  policy: SkillPolicy;
}

export interface GedState {
  currentPhase: GedPhase;
  activeTask: string;
  statusSummary: string;
  blockers: string[];
  nextStep: string;
  recoveryOptions?: string[];
}

export type WorkflowPreset =
  | "bugfix"
  | "feature"
  | "refactor"
  | "spike"
  | "security-audit";

export interface PresetConfig {
  name: WorkflowPreset;
  description: string;
  maxTasks: number;
  skipInterview: boolean;
  requireVerification: boolean;
  executionHint: string;
}

export const WORKFLOW_PRESETS: Record<WorkflowPreset, PresetConfig> = {
  bugfix: {
    name: "bugfix",
    description:
      "Quick fix for a known bug. Minimal planning, regression test required.",
    maxTasks: 2,
    skipInterview: true,
    requireVerification: true,
    executionHint:
      "Focus on the root cause. Write a regression test before fixing.",
  },
  feature: {
    name: "feature",
    description:
      "New feature implementation. Full planning flow with user interview.",
    maxTasks: 8,
    skipInterview: false,
    requireVerification: true,
    executionHint: "Follow the spec. Keep tasks bounded and verifiable.",
  },
  refactor: {
    name: "refactor",
    description: "Code restructuring. Existing tests must stay green.",
    maxTasks: 5,
    skipInterview: true,
    requireVerification: true,
    executionHint:
      "Preserve all existing behavior. Run the full test suite after each change.",
  },
  spike: {
    name: "spike",
    description:
      "Exploratory work. No verification required, no commit artifacts.",
    maxTasks: 1,
    skipInterview: true,
    requireVerification: false,
    executionHint: "Explore freely. Document findings in .ged/research/.",
  },
  "security-audit": {
    name: "security-audit",
    description: "Security review. Read-only analysis, produce a report.",
    maxTasks: 3,
    skipInterview: true,
    requireVerification: false,
    executionHint:
      "Analyze for OWASP Top 10, secrets in code, dependency vulnerabilities. Do not modify source code.",
  },
};

export function detectPreset(
  branchName: string,
  brief: string,
): WorkflowPreset | null {
  const lower = `${branchName} ${brief}`.toLowerCase();
  if (/\b(fix|bug|hotfix)\b/u.test(lower)) return "bugfix";
  if (/\b(refactor|clean\s*up|restructure)\b/u.test(lower)) return "refactor";
  if (/\b(spike|explore|experiment|prototype)\b/u.test(lower)) return "spike";
  if (/\b(security|audit|vulnerability|cve)\b/u.test(lower))
    return "security-audit";
  if (/\b(feat|feature|add|implement|build)\b/u.test(lower)) return "feature";
  return null;
}

export interface GedConfig {
  models: {
    brain: string;
  };
  cleanupCompletedPlans: boolean;
}

export type PlanStatus = "active" | "completed" | "discarded";

export interface PlanEntry {
  id: string;
  title: string;
  status: PlanStatus;
  createdAt: string;
  completedAt?: string;
}
