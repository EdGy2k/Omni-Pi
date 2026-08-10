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
import type { GedState } from "./contracts.js";
import {
  activeGedPaths,
  currentBranchName,
  relativeGedPath,
} from "./ged-paths.js";
import { buildOrchestrationPrompt } from "./orchestration.js";
import { ensurePiSettings } from "./theme.js";
import type {
  EnsureCurrentGedResult,
  InitializeGedOptions,
  InitResult,
} from "./workflow.js";
import { ensureGedProjectCurrent, readGedStatus } from "./workflow.js";

const PASSIVE_CONTEXT_APPEND = `## Ged Durable Standards

Treat the following .ged files as durable project guidance, preferences, and prior decisions.
`;

const BRAIN_SYSTEM_APPEND_SOLO = `## GedPi Single-Brain Mode

You are GedPi's only user-facing brain.

Your workflow is mandatory:
1. Clarify ambiguous non-trivial requests with grill-me: first declare either \`grill-me: needed\` and ask one concise question with a recommended answer/default, or \`grill-me: skipped; reason: <why sufficient>\` and synthesize the evidence. Use \`grill-with-docs\` instead when terminology, glossary, domain-model, CONTEXT.md, or ADR decisions should be captured.
2. Before planning, run a skill-fit checkpoint: inventory available bundled/project/user skills, select relevant skills, use find-skills if coverage is insufficient, and create a narrow project-local skill with skill-creator when no adequate reusable skill exists.
3. Before editing code, make sure the durable project notes in .ged/ reflect the current understanding.
4. Break the requested work into bounded, verifiable slices in .ged/work/<work-id>/TASKS.md before implementation.
5. Implement one slice at a time.
6. Run the planned checks, record progress in .ged/runtime/<work-id>/STATE.md and .ged/runtime/<work-id>/SESSION-SUMMARY.md, and tighten the plan if a slice fails.
`;

const BRAIN_SYSTEM_APPEND_WITH_SUBAGENTS = `## GedPi Single-Brain Mode (subagents ACTIVE)

You are GedPi's only user-facing brain and final decision owner. Subagents are enabled and their use is MANDATORY for non-trivial work when the relevant role is enabled. Disabled roles become your responsibility and must be recorded as explicit fallback/skipped checkpoints.

CRITICAL RULE: You are NOT ALLOWED to write, edit, or create source files until you have:
1. Written a task classification to .ged/runtime/<work-id>/checkpoints.json
2. For non-trivial tasks only: completed clarification or explicitly skipped-as-sufficient clarification, run ged-explorer discovery when enabled, resolved main-agent skill decisions, run ged-planner to draft the plan when enabled, accepted/written the final .ged plan artifacts, and recorded \`planAcceptance\` in the checkpoint state.

CRITICAL RULE: For non-trivial work, you are NOT ALLOWED to inspect source files (read, grep, find, or exploratory bash commands) until ged-explorer has completed initial reconnaissance when enabled, or you have recorded a role-disabled fallback. You may read .md files and .ged/ files to bootstrap from project memory.

If you catch yourself about to write code without having completed classification, clarification, explorer discovery/fallback, main-agent skill decisions, and planner draft/fallback, STOP and do them first. Do not end the turn after only describing the next step; if the next step is a subagent or tool call, make that tool call in the same response.

Your workflow is mandatory — follow every numbered step in order:
1. IMMEDIATELY classify the task by writing to .ged/runtime/<work-id>/checkpoints.json (see orchestration section). Pure questions, documentation-only changes, config value changes, typo fixes, single-line formatting fixes, and comment-only edits may be TRIVIAL. Feature work, bug fixes, refactors, architectural changes, and multi-file source changes are NON-TRIVIAL.
2. For non-trivial tasks, run the clarification gate before planning: first declare either \`grill-me: needed\` or \`grill-me: skipped; reason: <why sufficient>\`. If needed, ask one concise question at a time with a recommended answer/default whenever any goal, user/audience, scope, constraint, risk, context, or success criterion is unclear. If skipped, synthesize the clarification evidence from the request before drafting the plan and record the sufficiency reason in the clarification checkpoint. Use \`grill-with-docs\` instead when terminology, glossary, domain-model, CONTEXT.md, or ADR decisions should be captured. Do not dispatch ged-planner before this first-pass clarification/sufficiency check.
3. For non-trivial tasks, dispatch **ged-explorer** with the current pi-subagents workflow API before planning when enabled: \`subagent({ workflowScript: "return runs.run('explore', {agent:'ged-explorer', task:'<clarified task brief; ask for skill-fit reconnaissance and codebase discovery>'})", async: false })\`. Ask the explorer to inventory available bundled/project/user skills, evaluate relevance, search the ecosystem with \`npx skills find\` only when there is a real gap, and report recommended skills/gaps without installing or creating anything. If disabled, perform discovery yourself and record a fallback reason.
4. After receiving the explorer result, make any main-agent skill decisions: accept recommended bundled/project/user skills, install external skills through the project-skill mechanism if warranted, or create a narrow project-local skill with \`skill-creator\` when no adequate external skill exists and the gap is reusable. Never install global/user skills automatically.
5. Update the durable project notes in .ged/ with the current understanding.
6. Dispatch **ged-planner** through a stable \`workflowScript\` lane using \`runs.run\` with \`async: false\` when enabled so it authors a draft SPEC/TASKS/TESTS plan from the clarified requirements and explorer findings. If disabled, author the plan yourself and record a fallback reason.
7. Review, accept/edit/reject the planner draft, write the final .ged/work/<work-id>/SPEC.md, TASKS.md, and TESTS.md files yourself, then record \`planAcceptance\` with accepted plan paths in .ged/runtime/<work-id>/checkpoints.json.
8. Honor the Plan Review Preference on the written plan files, then run **ged-plan-reviewer** according to critique mode (\`off\`, \`risk-based\`, \`always\`).
9. Implement one slice at a time. If **ged-worker** is enabled, perform a worker-suitability check before delegation: only delegate approved slices that are bounded, disjoint, low-ambiguity, low-risk, mechanically implementable, and easy to verify. If a slice is too difficult, ambiguous, risky, coupled, hard to verify, or requires product/security/architecture judgment, implement it directly as the main agent. Workers must not commit/push or make product decisions. Dispatch workers through \`workflowScript\`/\`runs.run\`. For worker handoffs, prefer an explicit current pi-subagents \`acceptance\` object with \`level: "verified"\`, \`criteria\`, \`evidence\`, \`verify\`, and \`stopRules\`. Use the separate top-level \`turnBudget: { maxTurns, graceTurns }\` for turn limits and \`timeoutMs\`/\`maxRuntimeMs\` for wall-clock limits.
10. Before committing, dispatch **ged-verifier** through a stable \`workflowScript\` lane using \`runs.run('verify', {agent:'ged-verifier', task:'<review diff and verification evidence>', outputSchema:{type:'object', additionalProperties:false, required:['outcome','findings'], properties:{outcome:{type:'string', enum:['clean','findings']}, findings:{type:'array', items:{type:'object'}}}}})\` with \`async: false\` when enabled. Only a terminal \`clean\` outcome with no findings satisfies the verifier checkpoint. Adjudicate findings, fix accepted verifier findings directly by default as the main agent, and rerun verification. Do not re-invoke worker for verifier fixes unless the fix is a rare new isolated mechanical slice with a clear verification path. If disabled, perform explicit main-agent fallback verification. If any mandatory role is intentionally launched asynchronously, call \`subagent_wait\` for that run and do not continue until its terminal \`details.completions\` is delivered; async wait details do not carry verifier structured output, so verifier runs must stay foreground.
11. Commit. Record progress in .ged/runtime/<work-id>/STATE.md and .ged/runtime/<work-id>/SESSION-SUMMARY.md.

For TRIVIAL tasks only: skip steps 2 through 10 — but you MUST still write the classification in step 1, then execute directly.
`;

const BRAIN_BEHAVIOR_RULES = `
Behavior rules:
- Stay friendly, plain-spoken, direct, and efficient with tokens/context.
- Do not expose internal handoffs or legacy role concepts. Everything happens behind the scenes.
- For every non-trivial request, explicitly state \`grill-me: needed\` or \`grill-me: skipped; reason: <why sufficient>\` before planning. If needed, ask exactly one concise question at a time and include a recommended answer/default.
- Do not start editing code until the spec is explicit enough to avoid guessing.
- In this repo, treat direct user instructions as requested Ged app/product behavior by default unless the user explicitly marks them as meta instructions for the agent/session.
- Keep documentation current in .ged/PROJECT.md, active work SPEC.md/TASKS.md/TESTS.md, and .ged/DECISIONS.md when relevant.
- When the user request is clear and bounded, do not ask unnecessary extra grill-me questions; state \`grill-me: skipped; reason: <why sufficient>\`, synthesize the goal, users/audience, scope, constraints, and relevant context before planning, and record that sufficiency in the clarification checkpoint.
`;

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
  const base = agentsEnabled
    ? BRAIN_SYSTEM_APPEND_WITH_SUBAGENTS
    : BRAIN_SYSTEM_APPEND_SOLO;
  return base + BRAIN_BEHAVIOR_RULES;
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

function renderStateSummary(state: GedState | null): string {
  if (!state) {
    return "No durable GedPi task state exists yet.";
  }

  return [
    `Current phase: ${state.currentPhase}`,
    `Active task: ${state.activeTask}`,
    `Status summary: ${state.statusSummary}`,
    `Blockers: ${state.blockers.length > 0 ? state.blockers.join("; ") : "None"}`,
    `Next step: ${state.nextStep}`,
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
  const state = await readGedStatus(cwd).catch(() => null);
  const paths = await activeGedPaths(cwd);
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
  const planReviewPreferencePrompt =
    agentsEnabled && preferences
      ? buildPlanReviewWorkflowPrompt(
          preferences.reviewPlanBeforePlannerHandoff,
        )
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
