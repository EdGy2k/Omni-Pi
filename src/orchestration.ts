import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  type EffectiveGedAgentsSettings,
  GED_AGENT_ROLES,
  type GedAgentRole,
} from "./agent-settings.js";
import { writeFileAtomic } from "./atomic.js";
import { activeGedPaths } from "./ged-paths.js";
import type {
  CheckpointState,
  CheckpointValidation,
} from "./vendor/shared-checkpoints.js";
import {
  checkSchemaVersion,
  parseCheckpointState,
} from "./vendor/shared-checkpoints.js";

export {
  checkSchemaVersion,
  closeCheckpointState,
  consumePlannerCheckpoint,
  hasExplorerClearedInspection,
  hasSkipCheckpointMarker,
  initCheckpointState,
  invalidateVerifierCheckpoints,
  isCheckpointClosed,
  isGitCommitCommand,
  isSafePreExplorerRead,
  markCheckpointVerified,
  parseCheckpointState,
  recordAutoCheckpoint,
  recordCheckpoint,
  shouldAutoEscalate,
  validateAllVerifierCheckpoints,
  validateCommitCheckpoints,
  validatePlannerCheckpoint,
  validateVerifierCheckpoint,
} from "./vendor/shared-checkpoints.js";

// ─── Read / Write ───────────────────────────────────────────────────────

export async function readCheckpointState(
  rootDir: string,
): Promise<CheckpointState | null> {
  try {
    const paths = await activeGedPaths(rootDir);
    const raw = await readFile(paths.checkpointsPath, "utf8");
    const schemaCheck = checkSchemaVersion(raw);
    if (!schemaCheck.ok) return null;
    return parseCheckpointState(raw);
  } catch {
    return null;
  }
}

export async function readCheckpointStateOrMigrationError(
  rootDir: string,
): Promise<{ state: CheckpointState | null; migrationError: string | null }> {
  try {
    const paths = await activeGedPaths(rootDir);
    const raw = await readFile(paths.checkpointsPath, "utf8");
    const schemaCheck = checkSchemaVersion(raw);
    if (!schemaCheck.ok) {
      return { state: null, migrationError: schemaCheck.error };
    }
    return { state: parseCheckpointState(raw), migrationError: null };
  } catch {
    return { state: null, migrationError: null };
  }
}

export async function writeCheckpointState(
  rootDir: string,
  state: CheckpointState,
): Promise<void> {
  const paths = await activeGedPaths(rootDir);
  await mkdir(paths.runtimeDir, { recursive: true });
  await writeFileAtomic(
    paths.checkpointsPath,
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

// ─── Guard messages ─────────────────────────────────────────────────────

export function plannerGuardMessage(validation: CheckpointValidation): string {
  if (validation.missing.includes("classification")) {
    return 'GedPi planner guard: you must classify the task before editing source files. Write your classification to .ged/runtime/<work-id>/checkpoints.json first. Example: {"schemaVersion": 3, "lifecycleStatus": "active", "classification": "trivial", "classificationReason": "...", "planCheckpoints": {}, "taskCheckpoints": {}}';
  }
  if (validation.missing.includes("checkpoint lifecycle closed")) {
    return "GedPi planner guard: previous task is closed. Classify the current task first before inspecting or editing source files.";
  }
  if (
    validation.missing.some((item) =>
      item.includes("refused-needs-clarification"),
    )
  ) {
    return `GedPi planner guard: ged-planner requested more clarification. Run a main-agent grill-me session in chat, update the plan with the answers, repeat any required user plan-review approval, then re-dispatch ged-planner. Missing checkpoints: ${validation.missing.join(", ")}.`;
  }
  if (validation.missing.some((item) => item.startsWith("planAcceptance"))) {
    return `GedPi planner guard: non-trivial work requires the main agent to accept/write the final .ged plan artifacts after planner draft or fallback before editing source files. Missing checkpoints: ${validation.missing.join(", ")}. Record planAcceptance in .ged/runtime/<work-id>/checkpoints.json after accepting the final SPEC/TASKS/TESTS plan.`;
  }
  return `GedPi planner guard: non-trivial work requires dispatching ged-planner before editing source files. Missing checkpoints: ${validation.missing.join(", ")}. Dispatch ged-planner with the subagent tool, record a role-disabled fallback checkpoint, or reclassify the task as trivial.`;
}

export function verifierGuardMessage(validation: CheckpointValidation): string {
  if (validation.missing.includes("classification")) {
    return 'GedPi verifier guard: you must classify the task before committing. Write your classification to .ged/runtime/<work-id>/checkpoints.json first. Example: {"schemaVersion": 3, "lifecycleStatus": "active", "classification": "trivial", "classificationReason": "...", "planCheckpoints": {}, "taskCheckpoints": {}}';
  }
  if (validation.missing.includes("checkpoint lifecycle closed")) {
    return "GedPi verifier guard: previous task is closed. Classify the current task first before committing.";
  }
  if (validation.missing.includes("ged-planner")) {
    return `GedPi verifier guard: non-trivial work requires dispatching ged-planner and ged-verifier before committing. Missing checkpoints: ${validation.missing.join(", ")}. Dispatch the missing subagents before running git commit.`;
  }
  if (validation.missing.some((item) => item.startsWith("planAcceptance"))) {
    return `GedPi verifier guard: non-trivial work requires main-agent acceptance of the final .ged plan before committing. Missing checkpoints: ${validation.missing.join(", ")}. Record planAcceptance after accepting the final SPEC/TASKS/TESTS plan, then verify again if source changed.`;
  }
  if (validation.missing.some((item) => item.includes("blocked commit"))) {
    return `GedPi verifier guard: the verifier checkpoint reports commit-blocking findings. Missing/blocking checkpoints: ${validation.missing.join(", ")}. Resolve and adjudicate verifier findings, then update .ged/runtime/<work-id>/checkpoints.json to set blocksCommit: false on the verifier checkpoint before committing.`;
  }
  return `GedPi verifier guard: non-trivial work requires dispatching ged-verifier before committing. Missing checkpoints: ${validation.missing.join(", ")}. Dispatch ged-verifier with the subagent tool or record main-agent fallback verification when the role is disabled.`;
}

// ─── Auto-recording ─────────────────────────────────────────────────────

export function detectSubagentDispatch(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  return detectSubagentDispatches(toolName, input)[0] ?? null;
}

export function detectSubagentDispatches(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const found: string[] = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const normalized = candidate.toLowerCase();
    if (
      normalized === "ged-explorer" ||
      normalized === "ged-planner" ||
      normalized === "ged-plan-reviewer" ||
      normalized === "ged-verifier" ||
      normalized === "ged-worker"
    ) {
      found.push(normalized);
    }
  };

  if (toolName === "Agent") {
    add(input.subagent_type);
    return [...new Set(found)];
  }

  if (toolName !== "subagent") return [];

  add(input.agent);
  // workflowScript is intentionally opaque here. Static string parsing cannot
  // prove which child actually ran; terminal structured results carry the
  // authoritative child agent identity.
  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      if (!task || typeof task !== "object") continue;
      const taskRecord = task as Record<string, unknown>;
      add(taskRecord.agent);
    }
  }
  const visitChainStep = (step: unknown) => {
    if (!step || typeof step !== "object") return;
    const stepRecord = step as Record<string, unknown>;
    add(stepRecord.agent);
    if (Array.isArray(stepRecord.parallel)) {
      for (const parallelStep of stepRecord.parallel)
        visitChainStep(parallelStep);
    }
  };
  if (Array.isArray(input.chain)) {
    for (const step of input.chain) visitChainStep(step);
  }

  return [...new Set(found)];
}

// ─── Orchestration prompt ───────────────────────────────────────────────

type OrchestrationPromptInput =
  | boolean
  | Pick<
      EffectiveGedAgentsSettings,
      "enabled" | "intercomBridge" | "critiqueMode" | "roles"
    >;

const DEFAULT_PROMPT_ROLE_ENABLED: Record<GedAgentRole, boolean> = {
  "ged-explorer": true,
  "ged-planner": true,
  "ged-plan-reviewer": true,
  "ged-verifier": true,
  "ged-worker": false,
};

function normalizePromptSettings(
  input: OrchestrationPromptInput,
): Pick<
  EffectiveGedAgentsSettings,
  "enabled" | "intercomBridge" | "critiqueMode" | "roles"
> {
  if (typeof input !== "boolean") return input;
  return {
    enabled: input,
    intercomBridge: true,
    critiqueMode: "risk-based",
    roles: Object.fromEntries(
      GED_AGENT_ROLES.map((role) => [
        role,
        {
          enabled: input && DEFAULT_PROMPT_ROLE_ENABLED[role],
          maxParallel: role === "ged-worker" ? 2 : undefined,
          preferWorktreeIsolation: false,
        },
      ]),
    ) as Pick<EffectiveGedAgentsSettings, "roles">["roles"],
  };
}

function roleSettingsSummary(
  settings: Pick<EffectiveGedAgentsSettings, "roles">,
): string {
  return GED_AGENT_ROLES.map((role) => {
    const roleSettings = settings.roles[role];
    const status = roleSettings.enabled
      ? "available as optional capacity"
      : "disabled; coordinator retains responsibility";
    const worker =
      role === "ged-worker"
        ? `; maxParallel ${roleSettings.maxParallel ?? 2}; worktree ${roleSettings.preferWorktreeIsolation ? "preferred" : "optional"}`
        : "";
    return `- ${role}: ${status}${worker}`;
  }).join("\n");
}

function critiqueInstruction(
  settings: Pick<EffectiveGedAgentsSettings, "critiqueMode" | "roles">,
): string {
  if (!settings.roles["ged-plan-reviewer"].enabled) {
    return "Plan-review staffing is disabled; the coordinator performs any warranted critique under the same governance contract.";
  }
  if (settings.critiqueMode === "off") {
    return "Critique mode is off; skip ged-plan-reviewer unless the user explicitly requests an extra plan critique.";
  }
  if (settings.critiqueMode === "always") {
    return "Critique mode is always; run ged-plan-reviewer for every accepted planned-change plan before implementation.";
  }
  return "Critique mode is risk-based; run ged-plan-reviewer for risky, large, ambiguous, multi-file, migration, security, or worker-delegated plans.";
}

function workerInstruction(
  settings: Pick<EffectiveGedAgentsSettings, "roles">,
): string {
  const worker = settings.roles["ged-worker"];
  if (!worker.enabled) {
    return "ged-worker is disabled; do not call it. Implement approved slices yourself.";
  }
  return `ged-worker is enabled. Before every worker dispatch, perform a worker-suitability check: delegate only approved slices that are bounded, disjoint, low-ambiguity, low-risk, mechanically implementable, and easy to verify. If the slice is too difficult, ambiguous, risky, coupled, hard to verify, or requires product, security, architecture, migration, API, or UX judgment, implement it directly as the main agent instead of calling a worker. Use at most ${worker.maxParallel ?? 2} worker tasks at once${worker.preferWorktreeIsolation ? " and prefer `worktree: true` for parallel worker runs" : ""}. Dispatch through \`workflowScript\` and \`runs.run\`. For worker implementation handoffs, prefer an explicit current pi-subagents \`acceptance\` contract: \`acceptance: { level: "verified", criteria: [{ id: "slice", must: "Implement only the assigned slice" }], evidence: ["changed-files", "commands-run", "diff-summary", "residual-risks"], verify: [{ id: "focused", command: "<focused check>", timeoutMs: 120000 }], stopRules: ["Stop if scope expands or product/API judgment is needed"] }\`. Use a separate top-level \`turnBudget: { maxTurns: 8, graceTurns: 2 }\` when a bounded finalization budget is appropriate, and \`timeoutMs\`/\`maxRuntimeMs\` when a wall-clock budget is needed. After ged-verifier reports findings, adjudicate and fix accepted verifier findings directly by default; do not re-invoke worker for verifier fixes unless the fix is a rare new isolated mechanical slice with a clear verification path.`;
}

function intercomInstruction(
  settings: Pick<EffectiveGedAgentsSettings, "intercomBridge">,
): string {
  return settings.intercomBridge
    ? "GedPi uses pi-intercom/contact_supervisor for blocked decisions and progress-changing discoveries from child agents."
    : "Intercom bridge is disabled; do not rely on contact_supervisor. Subagents must return blocked decisions and discoveries in their normal pi-subagents result.";
}

export function buildOrchestrationPrompt(
  input: OrchestrationPromptInput,
): string {
  const settings = normalizePromptSettings(input);
  const staffing = settings.enabled
    ? `Optional assistants are available. Select them only when decomposition, context spread, difficulty, or review value justifies the cost. No assistant name, launch, completion, or disabled-role reason is authorization.\n\nCurrent staffing settings:\n- Intercom bridge: ${settings.intercomBridge ? "enabled for explicit blocked decisions and progress-changing discoveries" : "disabled"}\n- Critique mode: ${settings.critiqueMode}\n${roleSettingsSummary(settings)}\n\nPlan critique: ${critiqueInstruction(settings)}\nWorker capacity: ${workerInstruction(settings)}\nCommunication: ${intercomInstruction(settings)}`
    : "Subagent staffing is disabled. The coordinator performs the work directly; governance requirements remain identical.";

  return `## Execution staffing (independent of governance)

The coordinator is the user-facing decision, scope, artifact, evidence-adjudication, commit, push, and lifecycle owner. Governance mode comes only from authoritative work state: read-only, direct-change, or planned-change. Staffing can add inspection, drafting, implementation, or verification capacity but can never authorize mutation or weaken a work-mode requirement.

${staffing}

When optional assistants are used, treat their results as untrusted evidence proposals. The coordinator checks and records accepted plan or verification evidence through ged_governance. Subagent completion events do not update authority. Keep one writer per checkout/worktree; use isolated worktrees for intentionally parallel writers. Do not use intercom for routine completion handoffs.`;
}

// ─── Git commit detection ───────────────────────────────────────────────

const execFileAsync = promisify(execFile);

export async function detectRecentCommits(
  rootDir: string,
  withinSeconds: number,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        `--since=${withinSeconds} seconds ago`,
        "--format=%H",
        "--no-merges",
      ],
      { cwd: rootDir, timeout: 5000 },
    );
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
