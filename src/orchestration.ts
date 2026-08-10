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
      ? "enabled"
      : "disabled — main-agent fallback checkpoint required";
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
    return "ged-plan-reviewer is disabled; perform plan critique yourself and record a fallback/skipped checkpoint with a reason.";
  }
  if (settings.critiqueMode === "off") {
    return "Critique mode is off; skip ged-plan-reviewer unless the user explicitly requests an extra plan critique.";
  }
  if (settings.critiqueMode === "always") {
    return "Critique mode is always; run ged-plan-reviewer for every non-trivial accepted plan before implementation.";
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
  if (!settings.enabled) {
    return "";
  }

  return `## Subagent orchestration (mandatory for non-trivial work)

Main-agent ownership invariant: you are the user-facing decision owner, scope owner, final .ged artifact owner, verification adjudicator, and committer. Subagents can gather context, draft plans, critique, verify, and — only when explicitly enabled — implement bounded worker slices. Subagents do not own product decisions, final acceptance, commits, pushes, or PR decisions.

### Current orchestration settings

Intercom bridge: ${settings.intercomBridge ? "enabled" : "disabled"}
Critique mode: ${settings.critiqueMode}
Roles:
${roleSettingsSummary(settings)}

### Task classification (FIRST STEP for every new request)

Before any planning or implementation, classify the incoming request:

- **TRIVIAL**: Questions, documentation-only changes, README edits, config tweaks, single-line formatting fixes, and comment-only edits. After classification, execute directly and skip the subagent workflow entirely.
- **NON-TRIVIAL**: Feature implementation, bug fixes, refactoring, multi-file source changes, architectural work, or anything requiring design/planning. Mandatory subagent checkpoints apply below.

Write your classification and reason to .ged/runtime/<work-id>/checkpoints.json using:
\`\`\`json
{"schemaVersion": 3, "lifecycleStatus": "active", "classification": "trivial|non-trivial", "classificationReason": "...", "planCheckpoints": {}, "taskCheckpoints": {}}
\`\`\`

### Hard enforcement (structural guards)

All source file edits and git commits are **structurally guarded**:

1. **Classification is required** — If \`.ged/runtime/<work-id>/checkpoints.json\` does not exist, **all source file edits and commits are blocked**. You must classify the task and write the state file before editing any source code.
2. **Trivial classification** allows immediate edits and commits — no subagent dispatches needed.
3. **Non-trivial classification** requires an explicit clarification sufficiency decision (\`grill-me: needed\` or \`grill-me: skipped; reason: ...\`), \`ged-explorer\` skill-fit reconnaissance before planning when enabled, \`ged-planner\` plan drafting when enabled before edits, main-agent acceptance of the final .ged plan recorded as \`planAcceptance\`, and \`ged-verifier\` before \`git commit\` or \`git commit --amend\` when enabled. Disabled roles become main-agent responsibilities and must be recorded with a skipped/fallback reason. Do not end the turn after only narrating that you will inspect, plan, or apply changes; immediately make the next required tool call in the same response.
4. **Planner clarification refusals block continuation** — If \`ged-planner\` asks for grill-me/clarification or records \`outcome: "refused-needs-clarification"\`, you must run a main-agent grill-me session in chat, update the plan, repeat any required user plan-review approval, and re-dispatch \`ged-planner\`. Do not dismiss the planner's clarification request as unnecessary.
5. **Verifier blockers stop commits** — If a verifier checkpoint records \`blocksCommit: true\`, commits are blocked until findings are resolved and adjudicated. After adjudicating, update \`.ged/runtime/<work-id>/checkpoints.json\` to set \`blocksCommit: false\` on the verifier checkpoint. Source file edits automatically invalidate verifier checkpoints, so you must re-run the verifier after fixing code.
6. **Auto-escalation** — If you classify as trivial but touch more than one source file, the system auto-escalates to non-trivial. You must then dispatch ged-planner before continuing.

These guards are implemented in the tool-call interception layer — they cannot be bypassed by instruction alone. The only way to commit without verification is to set \`agents.allowCheckpointBypass: true\` in Ged settings and include \`[skip-checkpoint]\` in the commit command.

### Mandatory checkpoints for non-trivial work

When subagents are enabled and the task is non-trivial, use mandatory intelligence checkpoints:

0. **clarification** — Before drafting a non-trivial plan, perform a main-agent sufficiency check and make it visible. Start the clarification response with exactly one of: \`grill-me: needed\` or \`grill-me: skipped; reason: <why sufficient>\`. If needed, use \`grill-me\` in chat when any goal, user/audience, scope, constraint, risk, relevant context, or success criterion is unclear: one concise question at a time with a recommended answer/default. Use \`grill-with-docs\` instead when terminology, glossary, domain-model, CONTEXT.md, or ADR decisions should be captured. If skipped, synthesize the clarification evidence from the request instead of asking unnecessary questions. Record the clarification in \`.ged/runtime/<work-id>/checkpoints.json\`: completed clarification uses \`status: "completed"\` with evidence; skipped/sufficient clarification uses \`status: "skipped"\`, \`sufficiency: "sufficient-from-request"\`, and a non-empty \`skipReason\`.

1. **ged-explorer skill-fit reconnaissance + discovery** — After clarification and before source inspection/planning, use the current pi-subagents workflow API: \`subagent({ workflowScript: "return runs.run('explore', {agent:'ged-explorer', task:'<clarified task brief>'})", async: false })\`. Use stable lane keys and \`runs.all\` inside \`workflowScript\` for disjoint parallel reconnaissance. Include the clarified task brief and ask it to inventory bundled/project/user skills, evaluate relevance, search the ecosystem with \`npx skills find\` only when there is a real coverage gap, and report recommended skills/gaps without installing or creating anything. Also ask it to perform evidence-backed codebase discovery when relevant code context is needed. If the role is disabled, do this work yourself and record a role-disabled fallback reason.

2. **main-agent skill decisions** — After receiving the explorer's skill-fit findings, decide what to do: accept recommended bundled/project/user skills, install external skills through the project-skill mechanism if warranted, or create narrow project-local skills with \`skill-creator\` when no adequate external skill exists and the gap is reusable. These are mutating actions that only you perform. Never install global/user skills automatically.

3. **ged-planner authors the plan draft** — Pass clarified requirements, users/audience, scope, constraints, and explorer findings through a stable \`workflowScript\` lane using \`runs.run('plan', {agent:'ged-planner', task:'draft SPEC/TASKS/TESTS...'})\` with \`async: false\`. The planner drafts; you review, accept/edit/reject, and write the final .ged/work/<work-id>/SPEC.md, TASKS.md, and TESTS.md files. After acceptance, record \`planAcceptance\` with the accepted plan paths in .ged/runtime/<work-id>/checkpoints.json. Source edits are not safe until you have accepted/written the final plan and recorded planAcceptance. If the planner asks for grill-me/clarification or returns \`outcome: "refused-needs-clarification"\`, run grill-me in the main chat, update the brief, and re-dispatch ged-planner.

4. **plan review / critique** — After you accept and write the planner draft, honor the Plan Review Preference on the written plan files. ${critiqueInstruction(settings)} You adjudicate reviewer findings.

5. **ged-worker (optional)** — ${workerInstruction(settings)} Treat plan-reviewer worker-safety findings as a strong signal to keep the slice in the main agent. Workers may edit assigned implementation files but must not commit, push, rebase, merge, or make product/scope decisions. Worker completion never substitutes for verification or main-agent acceptance.

6. **ged-verifier** — Use a stable \`workflowScript\` lane with \`runs.run('verify', {agent:'ged-verifier', task:'review diff and verification evidence...', outputSchema:{type:'object', additionalProperties:false, required:['outcome','findings'], properties:{outcome:{type:'string', enum:['clean','findings']}, findings:{type:'array', items:{type:'object'}}}}})\` and \`async: false\` for clean-context review before committing meaningful implementation changes when enabled. Only \`clean\` with an empty findings array satisfies the checkpoint. The verifier reviews your diff and tests with minimal prior assumptions. You adjudicate each finding (accept, reject, needs-user), fix accepted issues directly by default as the main agent, and rerun verification. Do not re-invoke worker for verifier fixes unless the fix is a rare new isolated mechanical slice with a clear verification path. If disabled, perform and record main-agent fallback verification.

Use the \`subagent\` tool's current \`workflowScript\` API for execution. Compose single, sequential, parallel, and async work with stable-key \`runs.run\`/\`runs.all\` calls inside the script. Mandatory explorer/planner/verifier examples use \`async: false\` so their terminal result is available before a guarded continuation. If intentionally launched asynchronously, call \`subagent_wait\` and wait for terminal \`details.completions\`. Wait details do not carry verifier structured output, so verifier runs stay foreground. GedPi records checkpoints from successful foreground \`subagent\` results, \`subagent_wait\` completions, and compatibility \`subagent:async-complete\` events. Do not mark checkpoints complete on launch alone, and do not treat verifier process success as semantic success.

### Clean-context review flow (before every meaningful commit)

1. Run all planned checks from .ged/work/<work-id>/TESTS.md
2. Dispatch ged-verifier for clean-context review of the diff and tests when enabled, or perform explicit main-agent fallback verification when disabled
3. Adjudicate each finding: accept (fix before commit), reject (record reason), or needs-user (ask)
4. Fix accepted issues and rerun verification
5. Update the verifier checkpoint in \`.ged/runtime/<work-id>/checkpoints.json\` to set \`blocksCommit: false\`
6. Commit — the verifier guard will allow it through

### Subagent communication

GedPi uses pi-subagents for subagent lifecycle, chaining, parallel runs, and async completion. ${intercomInstruction(settings)} Do not use intercom for routine completion handoffs; normal results should return through pi-subagents.

Planner may draft plan text, but you own final .ged planning files. Optional workers may edit implementation slices only when enabled; you still own final acceptance, conflict resolution, verification adjudication, commits, pushes, and PR decisions.`;
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
