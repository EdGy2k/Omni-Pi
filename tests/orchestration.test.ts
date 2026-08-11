import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GED_AGENT_ROLES } from "../src/agent-settings.js";
import { writeFileAtomic } from "../src/atomic.js";
import { buildWorkflowPromptSuffix } from "../src/brain.js";
import { activeGedPaths, ensureActiveGedWork } from "../src/ged-paths.js";
import {
  buildOrchestrationPrompt,
  closeCheckpointState,
  detectRecentCommits,
  detectSubagentDispatch,
  detectSubagentDispatches,
  initCheckpointState,
  invalidateVerifierCheckpoints,
  isGitCommitCommand,
  markCheckpointVerified,
  readCheckpointState,
  recordAutoCheckpoint,
  recordCheckpoint,
  validateCommitCheckpoints,
  validatePlannerCheckpoint,
  validateVerifierCheckpoint,
  writeCheckpointState,
} from "../src/orchestration.js";
import type {
  CheckpointRecord,
  CheckpointState,
} from "../src/vendor/shared-checkpoints.js";

/** Build a valid v2 state with clarification, explorer, and planner (auto). */
function makeValidV2State(
  classification: "trivial" | "non-trivial" = "non-trivial",
): CheckpointState {
  const base = initCheckpointState(classification, "Test setup");
  if (classification === "trivial") return base;

  let state: CheckpointState = {
    ...base,
    clarification: {
      status: "completed",
      source: "manual",
      timestamp: "2026-05-07T10:00:00Z",
      evidence: {
        goal: "Test the checkpoint validation system",
        users: "Engineers working on the GedPi system",
        scope: "Unit tests in the orchestration module",
        constraints: "Must pass CI and be fast",
      },
    },
  };

  state = recordAutoCheckpoint(state, {
    agent: "ged-explorer",
    timestamp: "2026-05-07T10:05:00Z",
    status: "completed",
    findingCount: 5,
  });

  state = recordAutoCheckpoint(state, {
    agent: "ged-planner",
    timestamp: "2026-05-07T10:10:00Z",
    status: "completed",
    findingCount: 3,
  });

  state = {
    ...state,
    planAcceptance: {
      status: "accepted",
      source: "manual",
      timestamp: "2026-05-07T10:12:00Z",
      planPaths: [
        ".ged/work/test/SPEC.md",
        ".ged/work/test/TASKS.md",
        ".ged/work/test/TESTS.md",
      ],
      summary: "Main agent accepted the final plan artifacts.",
    },
  };

  return state;
}

function withPlanAcceptance(state: CheckpointState): CheckpointState {
  const defaultTimestamp = "2026-05-07T10:12:00Z";
  const plannerTimestamp = state.planCheckpoints["ged-planner"]?.timestamp;
  const timestamp =
    plannerTimestamp &&
    !Number.isNaN(Date.parse(plannerTimestamp)) &&
    Date.parse(defaultTimestamp) < Date.parse(plannerTimestamp)
      ? new Date(Date.parse(plannerTimestamp) + 1).toISOString()
      : defaultTimestamp;
  return {
    ...state,
    planAcceptance: {
      status: "accepted",
      source: "manual",
      timestamp,
      planPaths: [
        ".ged/work/test/SPEC.md",
        ".ged/work/test/TASKS.md",
        ".ged/work/test/TESTS.md",
      ],
      summary: "Main agent accepted the final plan artifacts.",
    },
  };
}

describe("checkpoint types", () => {
  it("CheckpointState has expected shape", () => {
    const state: CheckpointState = {
      schemaVersion: 3,
      lifecycleStatus: "active",
      classification: "non-trivial",
      classificationReason: "Feature implementation spanning multiple files",
      planCheckpoints: {},
      taskCheckpoints: {},
    };
    expect(state.classification).toBe("non-trivial");
    expect(state.planCheckpoints).toEqual({});
  });

  it("trivial classification skips checkpoint tracking", () => {
    const state: CheckpointState = {
      schemaVersion: 3,
      lifecycleStatus: "active",
      classification: "trivial",
      classificationReason: "README update",
      planCheckpoints: {},
      taskCheckpoints: {},
    };
    expect(state.classification).toBe("trivial");
  });

  it("CheckpointRecord tracks agent execution", () => {
    const record: CheckpointRecord = {
      agent: "ged-verifier",
      timestamp: "2026-05-04T10:00:00Z",
      status: "completed",
      source: "auto",
      findingCount: 2,
      blocksCommit: false,
    };
    expect(record.agent).toBe("ged-verifier");
    expect(record.status).toBe("completed");
    expect(record.source).toBe("auto");
  });
});

describe("checkpoint state management", () => {
  let tmpDir: string;
  let checkpointPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ged-orch-"));
    await ensureActiveGedWork(tmpDir);
    checkpointPath = (await activeGedPaths(tmpDir)).checkpointsPath;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no checkpoint file exists", async () => {
    const state = await readCheckpointState(tmpDir);
    expect(state).toBeNull();
  });

  it("returns null for malformed checkpoint JSON", async () => {
    await writeFileAtomic(
      checkpointPath,
      '{"schemaVersion":2,"classification":"invalid-value"}',
    );
    const state = await readCheckpointState(tmpDir);
    expect(state).toBeNull();
  });

  it("returns null for legacy v1 schema", async () => {
    await writeFileAtomic(
      checkpointPath,
      JSON.stringify({
        classification: "non-trivial",
        classificationReason: "v1",
        planCheckpoints: {},
        taskCheckpoints: {},
      }),
    );
    const state = await readCheckpointState(tmpDir);
    expect(state).toBeNull();
  });

  it("returns null for non-object checkpoint JSON", async () => {
    await writeFileAtomic(checkpointPath, '"just a string"');
    const state = await readCheckpointState(tmpDir);
    expect(state).toBeNull();
  });

  it("initializes checkpoint state with classification and schemaVersion", () => {
    const state = initCheckpointState("non-trivial", "Multi-file feature");
    expect(state.schemaVersion).toBe(3);
    expect(state.lifecycleStatus).toBe("active");
    expect(state.classification).toBe("non-trivial");
    expect(state.classificationReason).toBe("Multi-file feature");
    expect(state.planCheckpoints).toEqual({});
    expect(state.taskCheckpoints).toEqual({});
  });

  it("round-trips checkpoint state through write and read", async () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    await writeCheckpointState(tmpDir, state);
    const loaded = await readCheckpointState(tmpDir);
    expect(loaded).toEqual(state);
  });

  it("normalizes v2 checkpoints without lifecycle to active v3", async () => {
    await writeFileAtomic(
      checkpointPath,
      `${JSON.stringify({
        schemaVersion: 2,
        classification: "trivial",
        classificationReason: "Legacy checkpoint",
        planCheckpoints: {},
        taskCheckpoints: {},
      })}\n`,
    );
    const loaded = await readCheckpointState(tmpDir);
    expect(loaded?.schemaVersion).toBe(3);
    expect(loaded?.lifecycleStatus).toBe("active");
  });

  it("records a plan checkpoint", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const updated = recordCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-04T10:00:00Z",
      status: "completed",
      findingCount: 3,
    });
    expect(updated.planCheckpoints["ged-planner"]).toEqual({
      agent: "ged-planner",
      timestamp: "2026-05-04T10:00:00Z",
      status: "completed",
      findingCount: 3,
    });
    expect(state.planCheckpoints["ged-planner"]).toBeUndefined();
  });

  it("recordAutoCheckpoint stamps source:auto", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const updated = recordAutoCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-04T10:00:00Z",
      status: "completed",
    });
    expect(updated.planCheckpoints["ged-planner"]?.source).toBe("auto");
  });

  it("recordCheckpoint does NOT stamp source:auto", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const updated = recordCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-04T10:00:00Z",
      status: "completed",
    });
    expect(updated.planCheckpoints["ged-planner"]?.source).toBeUndefined();
  });

  it("records a task checkpoint", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const updated = recordCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-04T11:00:00Z",
        status: "completed",
        findingCount: 0,
        blocksCommit: false,
      },
      "T04",
    );
    expect(updated.taskCheckpoints.T04?.["ged-verifier"]).toEqual({
      agent: "ged-verifier",
      timestamp: "2026-05-04T11:00:00Z",
      status: "completed",
      findingCount: 0,
      blocksCommit: false,
    });
  });

  it("records a skipped checkpoint with reason", () => {
    const state = initCheckpointState("trivial", "README update");
    const updated = recordCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-04T10:00:00Z",
      status: "skipped",
      skipReason: "Task classified as trivial",
    });
    expect(updated.planCheckpoints["ged-planner"]?.status).toBe("skipped");
    expect(updated.planCheckpoints["ged-planner"]?.skipReason).toBe(
      "Task classified as trivial",
    );
  });

  it("recordCheckpoint overwrites existing entries", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const withCompleted = recordAutoCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: "2026-05-04T10:00:00Z",
      status: "completed",
    });
    const withSkipped = recordAutoCheckpoint(withCompleted, {
      agent: "ged-explorer",
      timestamp: "2026-05-04T10:05:00Z",
      status: "skipped",
      skipReason: "redundant",
    });
    // Latest write overwrites — even from completed to skipped
    expect(withSkipped.planCheckpoints["ged-explorer"]?.status).toBe("skipped");
  });
});

describe("checkpoint validation", () => {
  it("closed lifecycle blocks planner and commit validation", () => {
    const state = closeCheckpointState(makeValidV2State("trivial"));
    const planner = validatePlannerCheckpoint(state);
    const commit = validateCommitCheckpoints(state);
    expect(planner.valid).toBe(false);
    expect(planner.missing).toContain("checkpoint lifecycle closed");
    expect(commit.valid).toBe(false);
    expect(commit.missing).toContain("checkpoint lifecycle closed");
  });

  it("verified lifecycle returns to active when verifier checkpoints are invalidated", () => {
    let state = makeValidV2State();
    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T10:20:00Z",
        status: "completed",
        blocksCommit: false,
      },
      "auto",
    );
    const verified = markCheckpointVerified(state);
    expect(verified.lifecycleStatus).toBe("verified");
    const invalidated = invalidateVerifierCheckpoints(verified);
    expect(invalidated.lifecycleStatus).toBe("active");
    expect(
      invalidated.taskCheckpoints.auto?.["ged-verifier"]?.blocksCommit,
    ).toBe(true);
  });

  it("closed lifecycle is not reopened by auto checkpoint recording or invalidation", () => {
    const closed = closeCheckpointState(makeValidV2State());
    const recorded = recordAutoCheckpoint(closed, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:20:00Z",
      status: "completed",
    });
    expect(recorded).toBe(closed);
    expect(invalidateVerifierCheckpoints(closed).lifecycleStatus).toBe(
      "closed",
    );
  });

  it("plan validation passes with valid v2 state", () => {
    const state = makeValidV2State();
    const result = validatePlannerCheckpoint(withPlanAcceptance(state));
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("plan validation fails without clarification", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const result = validatePlannerCheckpoint(state);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("clarification");
  });

  it("plan validation fails without explorer", () => {
    const state = makeValidV2State();
    // Remove explorer
    const { "ged-explorer": _, ...rest } = state.planCheckpoints;
    const noExplorer = { ...state, planCheckpoints: rest };
    const result = validatePlannerCheckpoint(noExplorer);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("ged-explorer (auto-recorded)");
  });

  it("plan validation fails when planner lacks source:auto or fallback", () => {
    const state = makeValidV2State();
    // Replace planner with manual version
    const manualPlanner = recordCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:15:00Z",
      status: "completed",
    });
    const result = validatePlannerCheckpoint(manualPlanner);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain(
      "ged-planner (not auto-recorded or fallback)",
    );
  });

  it("plan validation accepts explicit fallback checkpoints for disabled roles", () => {
    let state = makeValidV2State();
    state = recordCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: "2026-05-07T10:05:00Z",
      status: "skipped",
      source: "fallback",
      skipReason: "ged-explorer disabled; main agent performed discovery",
    });
    state = recordCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "skipped",
      source: "fallback",
      skipReason: "ged-planner disabled; main agent authored the plan",
    });

    const result = validatePlannerCheckpoint(state);
    expect(result.valid).toBe(true);
  });

  it("plan validation rejects fallback checkpoints without a reason", () => {
    const state = recordCheckpoint(makeValidV2State(), {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "skipped",
      source: "fallback",
    });

    const result = validatePlannerCheckpoint(state);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("ged-planner (fallback without reason)");
  });

  it("plan validation fails when planner refused for clarification", () => {
    const state = makeValidV2State();
    const plannerRecord = state.planCheckpoints["ged-planner"];
    expect(plannerRecord).toBeDefined();
    if (!plannerRecord) return;

    const refused: CheckpointState = {
      ...state,
      planCheckpoints: {
        ...state.planCheckpoints,
        "ged-planner": {
          ...plannerRecord,
          outcome: "refused-needs-clarification",
        },
      },
    };

    const result = validatePlannerCheckpoint(refused);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain(
      "ged-planner (outcome: refused-needs-clarification)",
    );
    expect(validateCommitCheckpoints(refused).valid).toBe(false);
  });

  it("plan validation fails without main plan acceptance", () => {
    const state = makeValidV2State();
    const withoutAcceptance = { ...state, planAcceptance: undefined };

    const result = validatePlannerCheckpoint(withoutAcceptance);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("planAcceptance");
  });

  it("plan validation rejects incomplete main plan acceptance", () => {
    const state = {
      ...makeValidV2State(),
      planAcceptance: {
        status: "accepted" as const,
        source: "manual" as const,
        timestamp: "",
        planPaths: [],
      },
    };

    const result = validatePlannerCheckpoint(state);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("planAcceptance.timestamp");
    expect(result.missing).toContain("planAcceptance.planPaths");
  });

  it("plan validation accepts planner fallback plus main plan acceptance", () => {
    const state = recordCheckpoint(makeValidV2State(), {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "skipped",
      source: "fallback",
      skipReason: "ged-planner disabled; main agent authored the plan",
    });

    const result = validatePlannerCheckpoint(withPlanAcceptance(state));

    expect(result.valid).toBe(true);
  });

  it("plan validation rejects acceptance recorded before the planner checkpoint", () => {
    const state: CheckpointState = {
      ...makeValidV2State(),
      planAcceptance: {
        status: "accepted",
        source: "manual",
        timestamp: "2026-05-07T10:09:59Z",
        planPaths: [".ged/work/test/TASKS.md"],
      },
    };

    const result = validatePlannerCheckpoint(state);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("planAcceptance.afterPlanner");
  });

  it("planner rerun requires fresh main plan acceptance", () => {
    const accepted = makeValidV2State();
    const rerun = recordAutoCheckpoint(accepted, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:20:00Z",
      status: "completed",
    });

    const result = validatePlannerCheckpoint(rerun);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("planAcceptance.afterPlanner");
  });

  it("plan validation fails when planner is blocked", () => {
    const base = initCheckpointState("non-trivial", "Feature work");
    let state: CheckpointState = {
      ...base,
      clarification: {
        status: "completed",
        source: "manual",
        timestamp: "2026-05-07T10:00:00Z",
        evidence: {
          goal: "Test",
          users: "Engineers working on GedPi",
          scope: "Unit test suite",
          constraints: "Must pass CI checks",
        },
      },
    };
    state = recordAutoCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: "2026-05-07T10:05:00Z",
      status: "completed",
    });
    state = recordAutoCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "blocked",
    });
    const result = validatePlannerCheckpoint(state);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain(
      "ged-planner (status is blocked, not completed)",
    );
  });

  it("plan validation accepts explorer skipped with reason", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    let withClarification: CheckpointState = {
      ...state,
      clarification: {
        status: "completed",
        source: "manual",
        timestamp: "2026-05-07T10:00:00Z",
        evidence: {
          goal: "Docs update",
          users: "All project contributors",
          scope: "README and documentation files",
          constraints: "No specific constraints",
        },
      },
    };
    withClarification = recordAutoCheckpoint(withClarification, {
      agent: "ged-explorer",
      timestamp: "2026-05-07T10:05:00Z",
      status: "skipped",
      skipReason: "Documentation-only task, no source inspection needed",
    });
    withClarification = recordAutoCheckpoint(withClarification, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "completed",
    });
    const result = validatePlannerCheckpoint(
      withPlanAcceptance(withClarification),
    );
    expect(result.valid).toBe(true);
  });

  it("plan validation fails when explorer skipped without reason", () => {
    // Build state without the pre-existing completed explorer from helper
    const base = initCheckpointState("non-trivial", "Feature work");
    let state: CheckpointState = {
      ...base,
      clarification: {
        status: "completed",
        source: "manual",
        timestamp: "2026-05-07T10:00:00Z",
        evidence: {
          goal: "Test",
          users: "Engineers working on GedPi",
          scope: "Unit test suite",
          constraints: "Must pass CI checks",
        },
      },
    };
    state = recordAutoCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: "2026-05-07T10:05:00Z",
      status: "skipped",
      // No skipReason — invalid
    });
    state = recordAutoCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "completed",
    });
    const result = validatePlannerCheckpoint(withPlanAcceptance(state));
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("ged-explorer (skipped without reason)");
  });

  it("plan validation fails for missing clarification evidence fields", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const bad: CheckpointState = {
      ...state,
      clarification: {
        status: "completed",
        source: "manual",
        timestamp: "2026-05-07T10:00:00Z",
        evidence: {
          goal: "",
          users: "N/A",
          scope: "todo",
          constraints: ".",
        },
      },
    };
    const result = validatePlannerCheckpoint(bad);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("clarification.evidence.goal");
    expect(result.missing).toContain("clarification.evidence.users");
    expect(result.missing).toContain("clarification.evidence.constraints");
  });

  it("plan validation passes when clarification is skipped as sufficient with reason", () => {
    let state: CheckpointState = {
      ...initCheckpointState("non-trivial", "Clear feature request"),
      clarification: {
        status: "skipped",
        source: "manual",
        timestamp: "2026-05-07T10:00:00Z",
        sufficiency: "sufficient-from-request",
        skipReason:
          "The user provided goal, audience, scope, constraints, and success criteria.",
      },
    };
    state = recordAutoCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: "2026-05-07T10:05:00Z",
      status: "completed",
    });
    state = recordAutoCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "completed",
    });

    const result = validatePlannerCheckpoint(withPlanAcceptance(state));

    expect(result.valid).toBe(true);
  });

  it("plan validation fails when skipped clarification lacks sufficiency reason", () => {
    let state: CheckpointState = {
      ...initCheckpointState("non-trivial", "Clear feature request"),
      clarification: {
        status: "skipped",
        source: "manual",
        timestamp: "2026-05-07T10:00:00Z",
      },
    };
    state = recordAutoCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: "2026-05-07T10:05:00Z",
      status: "completed",
    });
    state = recordAutoCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "completed",
    });

    const result = validatePlannerCheckpoint(state);

    expect(result.valid).toBe(false);
    expect(result.missing).toContain("clarification.sufficiency");
    expect(result.missing).toContain("clarification.skipReason");
  });

  it("plan validation passes for trivial classification", () => {
    const state = makeValidV2State("trivial");
    const result = validatePlannerCheckpoint(state);
    expect(result.valid).toBe(true);
  });

  it("verifier validation passes with auto-recorded verifier", () => {
    const state = makeValidV2State();
    const withVerifier = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "completed",
        findingCount: 0,
        blocksCommit: false,
      },
      "T01",
    );
    const result = validateVerifierCheckpoint(withVerifier, "T01");
    expect(result.valid).toBe(true);
  });

  it("verifier validation fails without source:auto or fallback", () => {
    const state = makeValidV2State();
    const withVerifier = recordCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "completed",
        findingCount: 0,
        blocksCommit: false,
      },
      "T01",
    );
    const result = validateVerifierCheckpoint(withVerifier, "T01");
    expect(result.valid).toBe(false);
    expect(result.missing).toContain(
      "ged-verifier (not auto-recorded or fallback)",
    );
  });

  it("verifier validation accepts completed fallback verification", () => {
    const state = makeValidV2State();
    const withVerifier = recordCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "completed",
        source: "fallback",
        skipReason: "ged-verifier disabled; main agent ran the test plan",
        findingCount: 0,
        blocksCommit: false,
      },
      "T01",
    );
    const result = validateVerifierCheckpoint(withVerifier, "T01");
    expect(result.valid).toBe(true);
  });

  it("worker checkpoints append non-authorizing run metadata", () => {
    let state = makeValidV2State();
    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-worker",
        timestamp: "2026-05-07T10:30:00Z",
        status: "completed",
        runId: "run-1",
        sliceId: "T01a",
        artifactPath: ".pi/subagents/run-1/output.md",
        diffPath: ".pi/subagents/run-1/diff.patch",
        sessionPath: ".pi/sessions/run-1.jsonl",
        worktreePath: "/tmp/worktree-1",
        worktree: true,
        sourceMode: "foreground",
      },
      "T01",
    );
    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-worker",
        timestamp: "2026-05-07T10:35:00Z",
        status: "completed",
        runId: "run-2",
        sliceId: "T01b",
        sourceMode: "async",
      },
      "T01",
    );

    expect(state.workerRuns).toHaveLength(2);
    expect(state.workerRuns?.[0]).toMatchObject({
      agent: "ged-worker",
      source: "auto",
      runId: "run-1",
      taskId: "T01",
      sliceId: "T01a",
      worktree: true,
    });
    expect(state.workerRuns?.[1]).toMatchObject({ runId: "run-2" });
    expect(validateVerifierCheckpoint(state, "T01").valid).toBe(false);
    expect(validateCommitCheckpoints(state).valid).toBe(false);
  });

  it("deduplicates worker audit records by run identity", () => {
    let state = makeValidV2State();
    for (const sourceMode of ["async", "foreground"] as const) {
      state = recordAutoCheckpoint(
        state,
        {
          agent: "ged-worker",
          timestamp: "2026-05-07T10:30:00Z",
          status: "completed",
          runId: "same-run",
          sourceMode,
        },
        "T01",
      );
    }

    expect(state.workerRuns).toHaveLength(1);
    expect(state.workerRuns?.[0]).toMatchObject({
      runId: "same-run",
      sourceMode: "async",
    });
  });

  it("worker completion preserves explicit task metadata over checkpoint bucket", () => {
    const state = recordAutoCheckpoint(
      makeValidV2State(),
      {
        agent: "ged-worker",
        timestamp: "2026-05-07T10:30:00Z",
        status: "completed",
        runId: "run-1",
        taskId: "T01",
        sliceId: "T01a",
      },
      "auto",
    );

    expect(state.workerRuns?.[0]).toMatchObject({ taskId: "T01" });
  });

  it("worker completion after verification invalidates the verifier checkpoint", () => {
    let state = makeValidV2State();
    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "completed",
        blocksCommit: false,
      },
      "T01",
    );
    expect(validateCommitCheckpoints(state).valid).toBe(true);

    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-worker",
        timestamp: "2026-05-07T11:05:00Z",
        status: "completed",
        runId: "run-after-verify",
        taskId: "T01",
      },
      "auto",
    );

    const result = validateCommitCheckpoints(state);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("ged-verifier blocked commit (task T01)");
    expect(state.lifecycleStatus).toBe("active");
  });

  it("commit validation fails when verifier missing for non-trivial", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const result = validateVerifierCheckpoint(state, "T04");
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("ged-verifier");
  });

  it("commit validation passes for trivial classification", () => {
    const state = makeValidV2State("trivial");
    const result = validateVerifierCheckpoint(state, "T01");
    expect(result.valid).toBe(true);
  });

  it("verifier validation fails when verifier is skipped", () => {
    const state = makeValidV2State();
    const withSkip = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "skipped",
        skipReason: "Trivial",
      },
      "T01",
    );
    const result = validateVerifierCheckpoint(withSkip, "T01");
    expect(result.valid).toBe(false);
    expect(result.missing).toContain(
      "ged-verifier (status is skipped, not completed)",
    );
  });

  it("validation returns invalid when no checkpoint state", () => {
    const result = validatePlannerCheckpoint(null);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("classification");
    expect(result.warning).toContain("classify the task");
  });

  it("commit validation blocks non-trivial work without planner or verifier", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const result = validateCommitCheckpoints(state);
    expect(result.valid).toBe(false);
    // v2 validation lists clarification + explorer + planner + verifier
    expect(result.missing).toContain("clarification");
  });

  it("commit validation allows valid v2 non-trivial work", () => {
    let state = makeValidV2State();
    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "completed",
        blocksCommit: false,
      },
      "T01",
    );
    const result = validateCommitCheckpoints(state);
    expect(result.valid).toBe(true);
  });

  it("commit validation blocks verifier checkpoints that report blockers", () => {
    let state = makeValidV2State();
    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "completed",
        blocksCommit: true,
      },
      "T01",
    );
    const result = validateCommitCheckpoints(state);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("ged-verifier blocked commit (task T01)");
  });
});

describe("invalidateVerifierCheckpoints", () => {
  it("sets blocksCommit: true on all existing verifier checkpoints", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const state2 = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-04T10:00:00Z",
        status: "completed",
        blocksCommit: false,
        findingCount: 0,
      },
      "T01",
    );
    const state3 = recordAutoCheckpoint(
      state2,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-04T11:00:00Z",
        status: "completed",
        blocksCommit: false,
        findingCount: 0,
      },
      "T02",
    );

    const invalidated = invalidateVerifierCheckpoints(state3);
    expect(
      invalidated.taskCheckpoints.T01?.["ged-verifier"]?.blocksCommit,
    ).toBe(true);
    expect(
      invalidated.taskCheckpoints.T02?.["ged-verifier"]?.blocksCommit,
    ).toBe(true);
  });

  it("leaves non-verifier checkpoints untouched", () => {
    const state = initCheckpointState("non-trivial", "Feature work");
    const withExplorer = recordAutoCheckpoint(
      state,
      {
        agent: "ged-explorer",
        timestamp: "2026-05-04T10:00:00Z",
        status: "completed",
      },
      "T01",
    );

    const invalidated = invalidateVerifierCheckpoints(withExplorer);
    expect(
      invalidated.taskCheckpoints.T01?.["ged-explorer"]?.blocksCommit,
    ).toBeUndefined();
  });

  it("blocks commit after invalidation", () => {
    let state = makeValidV2State();
    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: "2026-05-07T11:00:00Z",
        status: "completed",
        blocksCommit: false,
        findingCount: 0,
      },
      "T01",
    );

    expect(validateCommitCheckpoints(state).valid).toBe(true);

    const invalidated = invalidateVerifierCheckpoints(state);
    const result = validateCommitCheckpoints(invalidated);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("ged-verifier blocked commit (task T01)");
  });
});

describe("subagent dispatch detection", () => {
  it("recognizes legacy Agent and terminal child identities for Ged roles", () => {
    expect(
      detectSubagentDispatch("Agent", { subagent_type: "ged-planner" }),
    ).toBe("ged-planner");
    expect(
      detectSubagentDispatch("Agent", { subagent_type: "GED-VERIFIER" }),
    ).toBe("ged-verifier");
    expect(detectSubagentDispatch("subagent", { agent: "ged-worker" })).toBe(
      "ged-worker",
    );
  });

  it("does not infer child identity by parsing opaque workflowScript", () => {
    expect(
      detectSubagentDispatches("subagent", {
        workflowScript: "return runs.run('dynamic', getRuntimeSelectedChild())",
      }),
    ).toEqual([]);
  });

  it("rejects legacy task/subagent shapes", () => {
    expect(detectSubagentDispatch("Task", { agent: "ged-explorer" })).toBe(
      null,
    );
    expect(
      detectSubagentDispatch("subagent", { subagentType: "ged-planner" }),
    ).toBe(null);
    expect(detectSubagentDispatch("Agent", { agent: "ged-planner" })).toBe(
      null,
    );
  });

  it("ignores unknown roles and tools", () => {
    expect(detectSubagentDispatch("Agent", { subagent_type: "worker" })).toBe(
      null,
    );
    expect(
      detectSubagentDispatch("bash", { subagent_type: "ged-planner" }),
    ).toBe(null);
  });
});

describe("orchestration prompt", () => {
  it("keeps governance unchanged when staffing is disabled", () => {
    const result = buildOrchestrationPrompt(false);
    expect(result).toContain("Execution staffing (independent of governance)");
    expect(result).toContain("Subagent staffing is disabled");
    expect(result).toContain("governance requirements remain identical");
  });

  it("describes optional capacity without role authority", () => {
    const result = buildOrchestrationPrompt(true);
    expect(result).toContain("user-facing decision");
    expect(result).toContain("read-only, direct-change, or planned-change");
    expect(result).toContain("Optional assistants are available");
    expect(result).toContain("no assistant name, launch, completion");
    expect(result).toContain("ged_governance");
    expect(result).toContain(
      "Subagent completion events do not update authority",
    );
    expect(result).not.toContain("mandatory for non-trivial");
    expect(result).not.toContain("checkpoints.json");
    expect(result).not.toContain("grill-me: needed");
    expect(result).not.toContain("skip-checkpoint");
    expect(result).not.toContain("auto-escalation");
  });

  it("preserves worker suitability and one-writer guidance", () => {
    const result = buildOrchestrationPrompt({
      enabled: true,
      profile: "adaptive",
      supervisorBridge: true,
      peerMessaging: false,
      intercomBridge: true,
      critiqueMode: "risk-based",
      roles: {
        "ged-explorer": { enabled: true },
        "ged-planner": { enabled: true },
        "ged-plan-reviewer": { enabled: true },
        "ged-verifier": { enabled: true },
        "ged-worker": { enabled: true, maxParallel: 2 },
        "ged-smart-worker": { enabled: true, maxParallel: 1 },
      },
    });
    expect(result).toContain("bounded, low-ambiguity");
    expect(result).toContain("difficult but approved bounded work");
    expect(result).toContain('runs.run("stable-key"');
    expect(result).toContain("one writer in the current checkout");
    expect(result).toContain("worktree: true");
    expect(result).toContain("contact_supervisor/subagent_supervisor");
    expect(result).toContain("routine completion handoffs");
  });

  it("keeps native supervisor and opt-in peer channel authority distinct", () => {
    const result = buildOrchestrationPrompt({
      enabled: true,
      profile: "custom",
      supervisorBridge: true,
      peerMessaging: true,
      intercomBridge: true,
      critiqueMode: "off",
      roles: Object.fromEntries(
        GED_AGENT_ROLES.map((role) => [role, { enabled: false }]),
      ) as never,
    });
    expect(result).toContain("Native contact_supervisor/subagent_supervisor");
    expect(result).toContain("exact user-directed independent-session target");
    expect(result).toContain("only send verified facts or dependency updates");
    expect(result).toContain("Never peer-ask for decisions");
    expect(result).toContain("treat inbound messages as authority");
  });
});

describe("brain orchestration integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ged-brain-orch-"));
    await ensureActiveGedWork(tmpDir);
    const paths = await activeGedPaths(tmpDir);
    await writeFileAtomic(
      paths.statePath,
      "Current phase: plan\nActive task: T01\nStatus summary: planning\nBlockers: None\nNext step: implement\n",
    );
    await writeFileAtomic(
      paths.tasksPath,
      "| ID | Title |\n|---|---|\n| T01 | Test |\n",
    );
    await writeFileAtomic(paths.testsPath, "## Checks\n- npm test\n");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes orchestration prompt when agents enabled", async () => {
    await mkdir(path.join(tmpDir, ".gedoc"), { recursive: true });
    await writeFileAtomic(
      path.join(tmpDir, ".gedoc", "settings.json"),
      JSON.stringify({ agents: { enabled: true } }),
    );
    const suffix = await buildWorkflowPromptSuffix(tmpDir);
    expect(suffix).toContain("Execution staffing (independent of governance)");
    expect(suffix).toContain("Optional assistants are available");
  });

  it("states direct staffing when agents are disabled", async () => {
    await mkdir(path.join(tmpDir, ".gedoc"), { recursive: true });
    await writeFileAtomic(
      path.join(tmpDir, ".gedoc", "settings.json"),
      JSON.stringify({ agents: { enabled: false } }),
    );
    const suffix = await buildWorkflowPromptSuffix(tmpDir);
    expect(suffix).toContain("Subagent staffing is disabled");
  });

  it("defaults to direct staffing when no settings file exists", async () => {
    const suffix = await buildWorkflowPromptSuffix(tmpDir, {
      homeDir: tmpDir,
    });
    expect(suffix).toContain("Subagent staffing is disabled");
  });
});

describe("commit detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ged-git-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array in non-git directory", async () => {
    const commits = await detectRecentCommits(tmpDir, 60);
    expect(commits).toEqual([]);
  });

  it("detects direct, chained, and nested git commit commands", () => {
    expect(isGitCommitCommand("git commit -m 'x'")).toBe(true);
    expect(isGitCommitCommand("git status; git commit -m 'x'")).toBe(true);
    expect(isGitCommitCommand('bash -lc "git commit -m x"')).toBe(true);
    expect(isGitCommitCommand("sh -c 'git commit -m x'")).toBe(true);
    expect(isGitCommitCommand("bash -l -c 'git commit -m x'")).toBe(true);
    expect(isGitCommitCommand("git status --short")).toBe(false);
  });
});

describe("orchestration integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ged-orch-int-"));
    await ensureActiveGedWork(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full non-trivial v3 workflow: classification → clarification → explorer → planner → verifier → commit", async () => {
    let state = initCheckpointState("non-trivial", "Add user authentication");

    // Step 1: Before clarification, planner validation fails
    const planCheck1 = validatePlannerCheckpoint(state);
    expect(planCheck1.valid).toBe(false);
    expect(planCheck1.missing).toContain("clarification");

    // Step 2: Add clarification
    state = {
      ...state,
      clarification: {
        status: "completed",
        source: "manual",
        timestamp: new Date().toISOString(),
        evidence: {
          goal: "Add authentication",
          users: "End users",
          scope: "Login and registration flow",
          constraints: "Must use OAuth 2.0 providers",
        },
      },
    };

    // Step 3: Auto-record explorer
    state = recordAutoCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: new Date().toISOString(),
      status: "completed",
      findingCount: 5,
    });

    // Step 4: Auto-record planner
    state = recordAutoCheckpoint(state, {
      agent: "ged-planner",
      timestamp: new Date().toISOString(),
      status: "completed",
      findingCount: 3,
    });

    // Step 4b: Main agent accepts/writes final plan artifacts.
    state = withPlanAcceptance(state);
    await writeCheckpointState(tmpDir, state);

    // Now planner validation passes
    expect(validatePlannerCheckpoint(state).valid).toBe(true);

    // Step 5: Verifier required for commit
    const commitCheck1 = validateVerifierCheckpoint(state, "T01");
    expect(commitCheck1.valid).toBe(false);

    state = recordAutoCheckpoint(
      state,
      {
        agent: "ged-verifier",
        timestamp: new Date().toISOString(),
        status: "completed",
        findingCount: 0,
        blocksCommit: false,
      },
      "T01",
    );
    await writeCheckpointState(tmpDir, state);

    // Now commit validation passes
    expect(validateCommitCheckpoints(state).valid).toBe(true);

    const persisted = await readCheckpointState(tmpDir);
    expect(persisted?.schemaVersion).toBe(3);
    expect(persisted?.lifecycleStatus).toBe("active");
    expect(persisted?.classification).toBe("non-trivial");
    expect(persisted?.planCheckpoints["ged-explorer"]?.source).toBe("auto");
    expect(persisted?.planCheckpoints["ged-planner"]?.source).toBe("auto");
    expect(persisted?.taskCheckpoints.T01?.["ged-verifier"]?.source).toBe(
      "auto",
    );
  });

  it("full trivial workflow: init → all validations pass without checkpoints", async () => {
    const state = initCheckpointState("trivial", "Fix typo in README");
    await writeCheckpointState(tmpDir, state);

    expect(validatePlannerCheckpoint(state).valid).toBe(true);
    expect(validateVerifierCheckpoint(state, "T01").valid).toBe(true);
    expect(validateCommitCheckpoints(state).valid).toBe(true);
  });

  it("manual checkpoints without source:auto or fallback are rejected", async () => {
    let state = initCheckpointState("non-trivial", "Feature work");
    state = {
      ...state,
      clarification: {
        status: "completed",
        source: "manual",
        timestamp: "2026-05-07T10:00:00Z",
        evidence: {
          goal: "Test",
          users: "Engineers working on GedPi",
          scope: "Unit test suite",
          constraints: "Must pass CI checks",
        },
      },
    };
    state = recordCheckpoint(state, {
      agent: "ged-explorer",
      timestamp: "2026-05-07T10:05:00Z",
      status: "completed",
    });
    state = recordCheckpoint(state, {
      agent: "ged-planner",
      timestamp: "2026-05-07T10:10:00Z",
      status: "completed",
    });

    // Manual checkpoints without source:auto or source:fallback are rejected.
    const result = validatePlannerCheckpoint(state);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain(
      "ged-explorer (not auto-recorded or fallback)",
    );
    expect(result.missing).toContain(
      "ged-planner (not auto-recorded or fallback)",
    );
  });
});
