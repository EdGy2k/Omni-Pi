import { describe, expect, test } from "vitest";

import {
  AUTO_COMMIT_DEFAULT,
  AUTO_COMMIT_ID,
  buildAutoCommitWorkflowPrompt,
  buildPlanReviewWorkflowPrompt,
  normalizeAutoCommitVerifiedWork,
  normalizeReviewPlanBeforePlannerHandoff,
  PREFERENCE_DEFINITIONS,
  REVIEW_PLAN_DEFAULT,
  REVIEW_PLAN_ID,
} from "../src/commit-settings.js";

describe("commit settings", () => {
  test("normalizes plan-review preference", () => {
    expect(normalizeReviewPlanBeforePlannerHandoff("off")).toBe("off");
    expect(normalizeReviewPlanBeforePlannerHandoff("chat")).toBe("chat");
    expect(normalizeReviewPlanBeforePlannerHandoff("plannotator")).toBe(
      "plannotator",
    );
    expect(normalizeReviewPlanBeforePlannerHandoff("on")).toBe("chat");
    expect(normalizeReviewPlanBeforePlannerHandoff("ask")).toBe("plannotator");
    expect(normalizeReviewPlanBeforePlannerHandoff(undefined)).toBe(
      "plannotator",
    );
    expect(normalizeReviewPlanBeforePlannerHandoff("invalid")).toBe(
      "plannotator",
    );
  });

  test("normalizes auto-commit preference", () => {
    expect(normalizeAutoCommitVerifiedWork("off")).toBe("off");
    expect(normalizeAutoCommitVerifiedWork("ask")).toBe("ask");
    expect(normalizeAutoCommitVerifiedWork("on")).toBe("on");
    expect(normalizeAutoCommitVerifiedWork(undefined)).toBe("ask");
    expect(normalizeAutoCommitVerifiedWork("invalid")).toBe("ask");
  });

  test("exports preference definitions for UI rendering", () => {
    expect(PREFERENCE_DEFINITIONS).toEqual([
      expect.objectContaining({
        id: AUTO_COMMIT_ID,
        label: "Commit after verification",
        defaultValue: AUTO_COMMIT_DEFAULT,
        values: ["off", "ask", "on"],
      }),
      expect.objectContaining({
        id: REVIEW_PLAN_ID,
        label: "Accepted plan review",
        defaultValue: REVIEW_PLAN_DEFAULT,
        values: ["off", "chat", "plannotator"],
      }),
    ]);
  });

  test("re-exports constants", () => {
    expect(AUTO_COMMIT_ID).toBe("autoCommitVerifiedWork");
    expect(REVIEW_PLAN_ID).toBe("reviewPlanBeforePlannerHandoff");
    expect(AUTO_COMMIT_DEFAULT).toBe("ask");
    expect(REVIEW_PLAN_DEFAULT).toBe("plannotator");
  });

  test("builds prompt instructions for each preference", () => {
    expect(buildAutoCommitWorkflowPrompt("off")).toContain(
      "do not commit unless the user explicitly asks",
    );
    expect(buildAutoCommitWorkflowPrompt("ask")).toContain(
      "ask the user whether to commit",
    );
    expect(buildAutoCommitWorkflowPrompt("on")).toContain(
      "create a conventional git commit without asking",
    );
    expect(buildPlanReviewWorkflowPrompt("off")).toContain(
      "continue without separate human approval",
    );
    expect(buildPlanReviewWorkflowPrompt("chat")).toContain(
      "show them to the user in chat",
    );
    expect(buildPlanReviewWorkflowPrompt("chat")).not.toContain(
      "before planner handoff",
    );
    expect(buildPlanReviewWorkflowPrompt("plannotator")).toContain(
      "gedpi_plan_review",
    );
    expect(buildPlanReviewWorkflowPrompt("plannotator")).toContain(
      "visual review surface",
    );
    expect(buildPlanReviewWorkflowPrompt("plannotator")).toContain(
      "fall back to chat approval",
    );
    expect(buildPlanReviewWorkflowPrompt("plannotator")).toContain(
      "accepted plan evidence",
    );
  });
});
