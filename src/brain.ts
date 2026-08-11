import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  readEffectiveGedAgentsSettings,
  readGedPreferences,
} from "./agent-settings.js";
import {
  buildAutoCommitWorkflowPrompt,
  buildPlanReviewWorkflowPrompt,
} from "./commit-settings.js";
import {
  activeGedPaths,
  currentBranchName,
  relativeGedPath,
} from "./ged-paths.js";
import type { GovernanceWorkState } from "./governance.js";
import { readGovernanceState } from "./governance-store.js";
import { buildOrchestrationPrompt } from "./orchestration.js";
import { ensurePiSettings } from "./theme.js";
import type {
  EnsureCurrentGedResult,
  InitializeGedOptions,
  InitResult,
} from "./workflow.js";
import { ensureGedProjectCurrent } from "./workflow.js";

const PASSIVE_CONTEXT_APPEND = `## Ged Durable Standards

Treat the following .ged files as durable project guidance, preferences, and prior decisions.
`;

const GOVERNANCE_BRAIN_SYSTEM_APPEND = `## GedPi Single-Brain Mode

You are GedPi's only user-facing brain and final decision owner.

Your workflow is mandatory:
1. Understand the user's mutation intent, ambiguity, risk, scope, constraints, and success criteria. Ask one concise question with a recommended default only when a user-owned decision is genuinely unresolved; otherwise summarize naturally and continue.
2. For read-only work, do not open mutating work and do not mutate the repository.
3. For mutation, call ged_work open in its own tool batch with structured minimum mode, ambiguity, risk, and direct-change evidence. Continue existing work only when the user is explicitly continuing that exact work ID.
4. Run the skill-fit checkpoint. Use available skills; search/install/create only for a real reusable capability gap.
5. For planned-change work, write the bounded SPEC/TASKS/TESTS artifacts, adjudicate any critique, then call ged_governance accept-plan before source mutation. Direct-change work skips plan ceremony.
6. Implement one bounded slice at a time. Optional assistants provide capacity or evidence proposals only; staffing never changes governance requirements or final ownership.
7. Run the planned checks, adjudicate findings, update durable project/work notes when substantive, then call ged_governance record-verification in its own tool batch.
8. Commit according to the commit preference. A commit is a milestone and never closes work automatically.

Behavior rules:
- Stay friendly, plain-spoken, direct, and efficient with tokens/context.
- Do not expose internal handoffs or legacy role concepts.
- Do not start mutation while a user-owned decision remains unresolved.
- Treat direct user instructions as requested Ged app/product behavior unless explicitly marked as session-level meta instructions.
- Keep durable project decisions and active work artifacts current, but never treat Markdown as authorization.
- Remain the sole owner of scope, product decisions, acceptance, commits, pushes, and lifecycle transitions.`;

// ─── Branch hygiene nudge ──────────────────────────────────────────────

export const TRUNK_BRANCHES = new Set(["main", "master"]);

export function buildBranchNudge(branchName: string | null): string {
  if (branchName === null) {
    return `## ⚠️ Branch Hygiene

No named Git branch was detected. GedPi work identity remains task-scoped and independent
of Git, but a descriptive feature branch still makes repository history easier to review.
Before making substantial changes, suggest to the user:

    git checkout -b <descriptive-branch-name>`;
  }

  if (!TRUNK_BRANCHES.has(branchName)) return "";

  return `## ⚠️ Branch Hygiene

You are on the \`${branchName}\` branch. GedPi strongly recommends working in a feature branch
so repository history stays reviewable; GedPi work identity remains independent of the
branch name. Before making substantial changes, suggest to the user:

    git checkout -b <descriptive-branch-name>`;
}

function buildBrainSystemAppend(agentsEnabled: boolean): string {
  void agentsEnabled;
  return GOVERNANCE_BRAIN_SYSTEM_APPEND;
}

const PASSIVE_FILES = [
  "PROJECT.md",
  "CONTEXT-MAP.md",
  "ARCHITECTURE.md",
  "PATTERNS.md",
  "GLOSSARY.md",
  "DECISIONS.md",
  "CONFIG.md",
  "SKILLS.md",
  "STANDARDS.md",
] as const;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function renderStateSummary(state: GovernanceWorkState | null): string {
  if (!state) {
    return "No authoritative governance state exists for the selected bootstrap work. Open or continue governed work before mutation.";
  }

  return [
    `Work ID: ${state.workId}`,
    `Mode: ${state.decision.mode}`,
    `Lifecycle: ${state.lifecycle}`,
    `Execution profile: ${state.executionProfile}`,
    `Current slice: ${state.currentSlice ?? "None"}`,
    `Decision: ${state.decision.reason}`,
    `User decision required: ${state.decision.requiresDecision ? "yes" : "no"}`,
    `Evidence records: ${state.evidence.length}`,
    `Revision: ${state.revision}`,
  ].join("\n");
}

function clipSection(value: string | null, maxChars: number): string {
  if (!value) {
    return "- Missing";
  }
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}…`;
}

export interface EnsureGedInitResult {
  status: "initialized" | "migrated" | "existing";
  initResult?: InitResult;
}

export async function ensureGedReady(
  cwd: string,
  options: InitializeGedOptions = {},
): Promise<EnsureGedInitResult> {
  await ensurePiSettings(cwd);
  const result: EnsureCurrentGedResult = await ensureGedProjectCurrent(
    cwd,
    options,
  );
  return result;
}

export async function ensureGedInitializedDetailed(
  cwd: string,
): Promise<EnsureGedInitResult> {
  return ensureGedReady(cwd);
}

export async function ensureGedInitialized(
  cwd: string,
): Promise<"initialized" | "migrated" | "existing"> {
  const result = await ensureGedReady(cwd);
  return result.status;
}

export async function buildPassiveGedPromptSuffix(
  cwd: string,
): Promise<string> {
  const existingFiles = (
    await Promise.all(
      PASSIVE_FILES.map(async (file) => {
        const filePath = path.join(cwd, ".ged", file);
        return (await fileExists(filePath)) ? file : null;
      }),
    )
  ).filter((value): value is (typeof PASSIVE_FILES)[number] => value != null);

  if (existingFiles.length === 0) {
    return "";
  }

  const contents = await Promise.all(
    existingFiles.map((file) => readOptional(path.join(cwd, ".ged", file))),
  );

  const sections = existingFiles.map((file, index) => {
    return `### .ged/${file}\n${clipSection(contents[index], 1400)}`;
  });

  return `${PASSIVE_CONTEXT_APPEND}

## Current Ged Standards

${sections.join("\n\n")}
`;
}

export async function buildWorkflowPromptSuffix(
  cwd: string,
  options: { homeDir?: string } = {},
): Promise<string> {
  const paths = await activeGedPaths(cwd);
  const state = await readGovernanceState(cwd, paths.workId).catch(() => null);
  const [tasks, tests] = await Promise.all([
    readOptional(paths.tasksPath),
    readOptional(paths.testsPath),
  ]);

  const agentSettings = await readEffectiveGedAgentsSettings(
    cwd,
    options,
  ).catch(() => null);
  const agentsEnabled = agentSettings?.enabled ?? false;

  const orchestrationPrompt = buildOrchestrationPrompt(
    agentSettings ?? agentsEnabled,
  );
  const preferences = await readGedPreferences(options.homeDir).catch(
    () => null,
  );
  const commitPreferencePrompt = buildAutoCommitWorkflowPrompt(
    preferences?.autoCommitVerifiedWork ?? "ask",
  );
  const planReviewPreferencePrompt = preferences
    ? buildPlanReviewWorkflowPrompt(preferences.reviewPlanBeforePlannerHandoff)
    : "";

  return [
    buildBrainSystemAppend(agentsEnabled),
    orchestrationPrompt,
    planReviewPreferencePrompt,
    commitPreferencePrompt,
    `## Current Durable Task State

${renderStateSummary(state)}

## Current Ged Workflow Files

### ${relativeGedPath(cwd, paths.tasksPath)}
${clipSection(tasks, 1600)}

### ${relativeGedPath(cwd, paths.testsPath)}
${clipSection(tests, 1200)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function buildBrainSystemPromptSuffix(
  cwd: string,
  options: { homeDir?: string } = {},
): Promise<string> {
  const branch = await currentBranchName(cwd);
  const branchNudge = buildBranchNudge(branch);
  const passive = await buildPassiveGedPromptSuffix(cwd);
  const workflow = await buildWorkflowPromptSuffix(cwd, options);
  return [branchNudge, passive, workflow].filter(Boolean).join("\n\n");
}
