import { formatPreferenceValue } from "./preferences.js";

export type AutoCommitVerifiedWork = "off" | "ask" | "on";
export type ReviewPlanBeforePlannerHandoff = "off" | "chat" | "plannotator";

export {
  AUTO_COMMIT_DEFAULT,
  AUTO_COMMIT_ID,
  DEFAULT_PREFERENCES,
  formatPreferenceValue,
  type GedPreferences,
  normalizeAutoCommitVerifiedWork,
  normalizeReviewPlanBeforePlannerHandoff,
  PREFERENCE_DEFINITIONS,
  type PreferenceDefinition,
  REVIEW_PLAN_DEFAULT,
  REVIEW_PLAN_ID,
} from "./preferences.js";

export function buildAutoCommitWorkflowPrompt(
  preference: AutoCommitVerifiedWork,
): string {
  const instructions = {
    off: "After verification passes, do not commit unless the user explicitly asks. Summarize the verified changes and say they are left uncommitted.",
    ask: "After verification passes, ask the user whether to commit before running git commit.",
    on: "After verification passes, findings are adjudicated, and satisfied verification evidence is recorded for the current work, create a conventional git commit without asking for another confirmation.",
  } satisfies Record<AutoCommitVerifiedWork, string>;

  return `## Commit Preference

Current setting: ${preference}

${instructions[preference]}

Always use the normal git command path so governance guards still apply. Stage only observed work-scope paths before runtime verification; never use commit auto-stage flags or compound commit commands. Never commit before planned checks pass, findings are adjudicated, and current content-bound verification evidence is recorded. A proven HEAD advance is a milestone and never changes work lifecycle; use ged_lifecycle explicitly. Never push unless the user explicitly asks.`;
}

export function buildPlanReviewWorkflowPrompt(
  preference: ReviewPlanBeforePlannerHandoff,
): string {
  const instructions = {
    off: "After the coordinator accepts the final planned-change artifacts, record accepted plan evidence and continue without separate human approval.",
    chat: "After the coordinator accepts the final planned-change artifacts, show them to the user in chat and wait for explicit approval. If changes are requested, revise and re-review them before recording accepted plan evidence.",
    plannotator:
      "After the coordinator accepts the canonical planned-change artifacts in `.ged/work/<work-id>/`, call `gedpi_plan_review` with the plan path (for example `.ged/work/<work-id>/TASKS.md`). Wait for approval, denial with feedback, or timeout. Apply denied feedback and review again. If no visual review surface is available, fall back to chat approval. Record accepted plan evidence only after the selected review policy is satisfied.",
  } satisfies Record<ReviewPlanBeforePlannerHandoff, string>;

  return `## Plan Review Preference

Current setting: ${formatPreferenceValue("reviewPlanBeforePlannerHandoff", preference)} (${preference})

${instructions[preference]}

This preference applies to planned-change work independently of staffing. It does not add plan ceremony to direct-change or read-only work.`;
}
