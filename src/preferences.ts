export interface GedPreferences {
  autoCommitVerifiedWork: "off" | "ask" | "on";
  reviewPlanBeforePlannerHandoff: "off" | "chat" | "plannotator";
}

export const AUTO_COMMIT_DEFAULT: GedPreferences["autoCommitVerifiedWork"] =
  "ask";
export const REVIEW_PLAN_DEFAULT: GedPreferences["reviewPlanBeforePlannerHandoff"] =
  "plannotator";

export const AUTO_COMMIT_ID = "autoCommitVerifiedWork";
export const REVIEW_PLAN_ID = "reviewPlanBeforePlannerHandoff";

export const DEFAULT_PREFERENCES: GedPreferences = {
  autoCommitVerifiedWork: AUTO_COMMIT_DEFAULT,
  reviewPlanBeforePlannerHandoff: REVIEW_PLAN_DEFAULT,
};

export function normalizeAutoCommitVerifiedWork(
  value: unknown,
): GedPreferences["autoCommitVerifiedWork"] {
  return value === "off" || value === "on" || value === "ask"
    ? value
    : AUTO_COMMIT_DEFAULT;
}

export function normalizeReviewPlanBeforePlannerHandoff(
  value: unknown,
): GedPreferences["reviewPlanBeforePlannerHandoff"] {
  if (value === "off" || value === "chat" || value === "plannotator") {
    return value;
  }
  // Backward compatibility: the previous binary "on" setting now maps to
  // explicit chat approval of the accepted/written planner draft.
  if (value === "on") return "chat";
  return REVIEW_PLAN_DEFAULT;
}

export function formatPreferenceValue(id: string, value: string): string {
  if (id === REVIEW_PLAN_ID) {
    const labels: Record<
      GedPreferences["reviewPlanBeforePlannerHandoff"],
      string
    > = {
      off: "No review",
      chat: "Review in chat",
      plannotator: "Review with Plannotator",
    };
    return labels[normalizeReviewPlanBeforePlannerHandoff(value)];
  }

  if (id === AUTO_COMMIT_ID) {
    const labels: Record<GedPreferences["autoCommitVerifiedWork"], string> = {
      off: "Never",
      ask: "Ask first",
      on: "After verification",
    };
    return labels[normalizeAutoCommitVerifiedWork(value)];
  }

  return value;
}

export interface PreferenceDefinition {
  id: string;
  label: string;
  description: string;
  defaultValue: string;
  values: string[];
}

export const PREFERENCE_DEFINITIONS: PreferenceDefinition[] = [
  {
    id: AUTO_COMMIT_ID,
    label: "Commit after verification",
    description:
      "Controls whether GedPi commits verified work: off leaves changes uncommitted, ask prompts first, on commits after successful verification.",
    defaultValue: AUTO_COMMIT_DEFAULT,
    values: ["off", "ask", "on"],
  },
  {
    id: REVIEW_PLAN_ID,
    label: "Accepted plan review",
    description:
      "Choose how GedPi reviews final .ged plan artifacts before accepted-plan evidence: no extra review, chat approval, or exact-byte-bound Plannotator visual approval.",
    defaultValue: REVIEW_PLAN_DEFAULT,
    values: ["off", "chat", "plannotator"],
  },
];
