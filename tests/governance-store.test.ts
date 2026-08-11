import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openGedWork } from "../src/ged-paths.js";
import {
  type GovernanceEvidence,
  resolveGovernance,
} from "../src/governance.js";
import {
  appendGovernanceEvidence,
  beginGovernanceMutation,
  clearGovernanceMutation,
  compareAndSwapGovernanceState,
  GovernanceStoreError,
  governanceActionBlockReason,
  governanceMutationBlockReason,
  initializeGovernanceState,
  readGovernanceState,
  recordGovernanceImplementation,
  recordSatisfiedGovernanceEvidence,
  regenerateGovernanceProjection,
  renderGovernanceProjection,
  transitionGovernanceLifecycle,
} from "../src/governance-store.js";

async function setup() {
  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), "ged-governance-store-"),
  );
  const opened = await openGedWork(
    rootDir,
    { sessionId: "session-a", requestId: "request-a" },
    "Implement governance state",
  );
  const decision = resolveGovernance({
    intent: { mutation: "requested", minimumMode: "planned-change" },
    ambiguity: "sufficient",
    risk: "normal",
    change: {
      clearScope: true,
      bounded: true,
      reversible: true,
      deterministicCheck: true,
    },
  });
  return { rootDir, opened, decision };
}

function evidence(id: string): GovernanceEvidence {
  return {
    id,
    kind: "verification",
    source: "agent",
    producerId: "coordinator",
    recordedAt: "2026-08-10T05:00:00.000Z",
    summary: `Evidence ${id}`,
    outcome: "observed",
  };
}

describe("governance state store", () => {
  it("initializes revision zero for the exact generated work item", async () => {
    const { rootDir, opened, decision } = await setup();
    const state = await initializeGovernanceState(
      rootDir,
      opened.workId,
      { decision, executionProfile: "coordinated", currentSlice: "slice-3" },
      new Date("2026-08-10T05:00:00.000Z"),
    );

    expect(state).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      workId: opened.workId,
      summary: "Implement governance state",
      currentSlice: "slice-3",
      executionProfile: "coordinated",
      lifecycle: "active",
      approvals: [],
      evidence: [],
    });
    expect(state.repository.repositoryId).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readGovernanceState(rootDir, opened.workId)).toEqual(state);
  });

  it("accepts current CAS and rejects stale or identity-changing updates", async () => {
    const { rootDir, opened, decision } = await setup();
    const initial = await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "solo",
    });
    const updated = await compareAndSwapGovernanceState(
      rootDir,
      opened.workId,
      initial.revision,
      (state) => ({ ...state, currentSlice: "T01" }),
    );
    expect(updated.revision).toBe(1);
    expect(updated.currentSlice).toBe("T01");

    await expect(
      compareAndSwapGovernanceState(
        rootDir,
        opened.workId,
        0,
        (state) => state,
      ),
    ).rejects.toMatchObject({ code: "stale-revision" });
    await expect(
      compareAndSwapGovernanceState(rootDir, opened.workId, 1, (state) => ({
        ...state,
        workId: "changed",
      })),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      compareAndSwapGovernanceState(rootDir, opened.workId, 1, (state) => ({
        ...state,
        repository: { ...state.repository, worktreeId: "changed" },
      })),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      compareAndSwapGovernanceState(rootDir, opened.workId, 1, (state) => ({
        ...state,
        lifecycle: "paused",
      })),
    ).rejects.toMatchObject({ code: "invalid-state" });
    expect((await readGovernanceState(rootDir, opened.workId)).revision).toBe(
      1,
    );
  });

  it("serializes concurrent evidence appends without losing records", async () => {
    const { rootDir, opened, decision } = await setup();
    await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "assisted",
    });

    await Promise.all([
      appendGovernanceEvidence(rootDir, opened.workId, evidence("verify-a")),
      appendGovernanceEvidence(rootDir, opened.workId, evidence("verify-b")),
    ]);
    const state = await readGovernanceState(rootDir, opened.workId);
    expect(state.revision).toBe(2);
    expect(state.evidence.map((entry) => entry.id)).toEqual([
      "verify-a",
      "verify-b",
    ]);
    await expect(
      appendGovernanceEvidence(rootDir, opened.workId, evidence("verify-a")),
    ).rejects.toMatchObject({ code: "duplicate-evidence" });
  });

  it("fails closed for malformed and unknown structured state", async () => {
    const { rootDir, opened } = await setup();
    for (const raw of [
      "not-json",
      '{"schemaVersion":99}',
      JSON.stringify({ schemaVersion: 1, unexpected: true }),
    ]) {
      await writeFile(opened.paths.governancePath, raw);
      await expect(
        readGovernanceState(rootDir, opened.workId),
      ).rejects.toBeInstanceOf(GovernanceStoreError);
    }
  });

  it("rejects state whose embedded identity targets another work item", async () => {
    const { rootDir, opened, decision } = await setup();
    const state = await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "solo",
    });
    const other = await openGedWork(
      rootDir,
      { sessionId: "session-a", requestId: "request-b" },
      "Other work",
    );
    await writeFile(
      opened.paths.governancePath,
      JSON.stringify({ ...state, workId: other.workId }),
    );

    await expect(
      readGovernanceState(rootDir, opened.workId),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await expect(
      readGovernanceState(rootDir, other.workId),
    ).rejects.toMatchObject({ code: "missing" });
  });

  it("serializes public projection regeneration with state mutation", async () => {
    const { rootDir, opened, decision } = await setup();
    await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "solo",
    });

    await Promise.all([
      compareAndSwapGovernanceState(rootDir, opened.workId, 0, (state) => ({
        ...state,
        currentSlice: "latest",
      })),
      regenerateGovernanceProjection(rootDir, opened.workId),
    ]);
    const latest = await readGovernanceState(rootDir, opened.workId);
    expect(await readFile(opened.paths.statePath, "utf8")).toBe(
      renderGovernanceProjection(latest),
    );
    expect(latest.revision).toBe(1);
  });

  it("regenerates a deterministic projection after interruption", async () => {
    const { rootDir, opened, decision } = await setup();
    const state = await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "high-stakes",
      currentSlice: "migration",
    });
    const expected = renderGovernanceProjection(state);
    await expect(
      readFile(opened.paths.statePath, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(await regenerateGovernanceProjection(rootDir, opened.workId)).toBe(
      expected,
    );
    expect(await readFile(opened.paths.statePath, "utf8")).toBe(expected);
  });

  it("enforces mode, plan, and verification freshness by append order", async () => {
    const { rootDir, opened, decision } = await setup();
    let state = await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "coordinated",
    });
    expect(governanceActionBlockReason(state, "metadata-mutation")).toBeNull();
    expect(governanceActionBlockReason(state, "source-mutation")).toContain(
      "without satisfied plan evidence",
    );

    state = await recordSatisfiedGovernanceEvidence(rootDir, opened.workId, {
      id: "plan-newer-array-order",
      kind: "plan",
      source: "agent",
      recordedAt: "2026-08-10T04:00:00.000Z",
      summary: "Accepted plan",
      outcome: "satisfied",
    });
    expect(governanceActionBlockReason(state, "source-mutation")).toBeNull();
    state = await recordSatisfiedGovernanceEvidence(rootDir, opened.workId, {
      id: "verify-before-implementation",
      kind: "verification",
      source: "agent",
      recordedAt: "2026-08-10T03:00:00.000Z",
      summary: "Checks passed despite older wall clock",
      outcome: "satisfied",
    });
    expect(governanceActionBlockReason(state, "commit")).toBeNull();

    state = await recordGovernanceImplementation(rootDir, opened.workId, {
      id: "implementation-after-verify",
      kind: "implementation",
      source: "runtime",
      recordedAt: "2026-08-10T02:00:00.000Z",
      summary: "Successful write",
      outcome: "observed",
    });
    expect(governanceActionBlockReason(state, "commit")).toContain(
      "no satisfied verification evidence newer",
    );
    state = await recordSatisfiedGovernanceEvidence(rootDir, opened.workId, {
      id: "verify-after-implementation",
      kind: "verification",
      source: "agent",
      recordedAt: "2026-08-10T01:00:00.000Z",
      summary: "Fresh verification by append order",
      outcome: "satisfied",
    });
    expect(governanceActionBlockReason(state, "commit")).toBeNull();

    state = await appendGovernanceEvidence(rootDir, opened.workId, {
      id: "later-failed-verification",
      kind: "verification",
      source: "runtime",
      recordedAt: "2026-08-10T09:00:00.000Z",
      summary: "Later verification failed",
      outcome: "failed",
    });
    expect(governanceActionBlockReason(state, "commit")).toContain(
      "no satisfied verification evidence newer",
    );
    state = await appendGovernanceEvidence(rootDir, opened.workId, {
      id: "later-failed-plan",
      kind: "plan",
      source: "runtime",
      recordedAt: "2026-08-10T10:00:00.000Z",
      summary: "Later plan review failed",
      outcome: "failed",
    });
    expect(governanceActionBlockReason(state, "source-mutation")).toContain(
      "without satisfied plan evidence",
    );
  });

  it("fails closed for missing, read-only, unresolved, and non-active state", async () => {
    const { rootDir, opened } = await setup();
    await expect(
      governanceMutationBlockReason(rootDir, opened.workId),
    ).resolves.toContain("no authoritative governance state");

    const readOnly = resolveGovernance({
      intent: { mutation: "none" },
      ambiguity: "sufficient",
      risk: "low",
    });
    let state = await initializeGovernanceState(rootDir, opened.workId, {
      decision: readOnly,
      executionProfile: "solo",
    });
    expect(governanceActionBlockReason(state, "metadata-mutation")).toContain(
      "read-only",
    );
    state = { ...state, lifecycle: "paused" };
    expect(governanceActionBlockReason(state, "metadata-mutation")).toContain(
      "lifecycle paused",
    );
    state = {
      ...state,
      lifecycle: "active",
      decision: resolveGovernance({
        intent: { mutation: "requested", minimumMode: "planned-change" },
        ambiguity: "decision-needed",
        risk: "normal",
        change: {
          clearScope: true,
          bounded: true,
          reversible: true,
          deterministicCheck: true,
        },
      }),
    };
    expect(governanceActionBlockReason(state, "metadata-mutation")).toContain(
      "user-owned decision",
    );
  });

  it("records pause, resume, and verified completion as explicit history", async () => {
    const { rootDir, opened, decision } = await setup();
    let state = await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "solo",
    });
    await expect(
      transitionGovernanceLifecycle(rootDir, opened.workId, {
        action: "complete",
        expectedLifecycle: "active",
        reason: "Implementation is done",
      }),
    ).rejects.toMatchObject({ code: "governance-blocked" });

    state = await recordSatisfiedGovernanceEvidence(rootDir, opened.workId, {
      id: "accepted-plan",
      kind: "plan",
      source: "agent",
      recordedAt: "2026-08-11T10:00:00.000Z",
      summary: "Plan accepted",
      outcome: "satisfied",
    });
    state = await recordSatisfiedGovernanceEvidence(rootDir, opened.workId, {
      id: "current-verification",
      kind: "verification",
      source: "agent",
      recordedAt: "2026-08-11T10:01:00.000Z",
      summary: "Checks passed",
      outcome: "satisfied",
    });
    state = await transitionGovernanceLifecycle(
      rootDir,
      opened.workId,
      {
        action: "pause",
        expectedLifecycle: "active",
        reason: "Waiting for the next session",
      },
      new Date("2026-08-11T10:02:00.000Z"),
    );
    expect(state).toMatchObject({ lifecycle: "paused", revision: 3 });
    await regenerateGovernanceProjection(rootDir, opened.workId);
    expect(await readFile(opened.paths.statePath, "utf8")).toContain(
      `Resume exact work ID ${opened.workId}`,
    );
    state = await transitionGovernanceLifecycle(
      rootDir,
      opened.workId,
      {
        action: "resume",
        expectedLifecycle: "paused",
        reason: "Continuing the approved work",
      },
      new Date("2026-08-11T10:03:00.000Z"),
    );
    expect(state).toMatchObject({ lifecycle: "active", revision: 4 });
    state = await transitionGovernanceLifecycle(
      rootDir,
      opened.workId,
      {
        action: "complete",
        expectedLifecycle: "active",
        reason: "All accepted work is verified",
      },
      new Date("2026-08-11T10:04:00.000Z"),
    );
    expect(state).toMatchObject({ lifecycle: "completed", revision: 5 });
    expect(state.lifecycleTransitions).toEqual([
      expect.objectContaining({
        from: "active",
        to: "paused",
        reason: "Waiting for the next session",
      }),
      expect.objectContaining({ from: "paused", to: "active" }),
      expect.objectContaining({ from: "active", to: "completed" }),
    ]);
    expect(governanceActionBlockReason(state, "source-mutation")).toContain(
      "lifecycle completed",
    );
    await expect(
      transitionGovernanceLifecycle(rootDir, opened.workId, {
        action: "resume",
        expectedLifecycle: "completed",
        reason: "Terminal work must not reopen",
      }),
    ).rejects.toMatchObject({ code: "governance-blocked" });
    await regenerateGovernanceProjection(rootDir, opened.workId);
    const projection = await readFile(opened.paths.statePath, "utf8");
    expect(projection).toContain("Current Phase: Closed");
    expect(projection).toContain("Active Task: None");
    expect(projection).toContain("Lifecycle transitions: 3");
    expect(projection).toContain(
      "No further lifecycle transition or repository mutation is authorized.",
    );
  });

  it("makes abandoned and superseded work terminal", async () => {
    for (const [action, lifecycle] of [
      ["abandon", "abandoned"],
      ["supersede", "superseded"],
    ] as const) {
      const { rootDir, opened, decision } = await setup();
      const state = await initializeGovernanceState(rootDir, opened.workId, {
        decision,
        executionProfile: "solo",
      });
      const terminal = await transitionGovernanceLifecycle(
        rootDir,
        opened.workId,
        {
          action,
          expectedLifecycle: "active",
          reason: `${action} by explicit coordinator decision`,
        },
      );
      expect(terminal.lifecycle).toBe(lifecycle);
      expect(terminal.revision).toBe(state.revision + 1);
      await expect(
        transitionGovernanceLifecycle(rootDir, opened.workId, {
          action: "pause",
          expectedLifecycle: lifecycle,
          reason: "Terminal work cannot transition",
        }),
      ).rejects.toMatchObject({ code: "governance-blocked" });
    }
  });

  it("allows paused work to become explicitly terminal", async () => {
    for (const [action, lifecycle] of [
      ["complete", "completed"],
      ["abandon", "abandoned"],
      ["supersede", "superseded"],
    ] as const) {
      const { rootDir, opened, decision } = await setup();
      await initializeGovernanceState(rootDir, opened.workId, {
        decision,
        executionProfile: "solo",
      });
      if (action === "complete") {
        await recordSatisfiedGovernanceEvidence(rootDir, opened.workId, {
          id: "paused-terminal-plan",
          kind: "plan",
          source: "agent",
          recordedAt: "2026-08-11T10:10:00.000Z",
          summary: "Plan accepted",
          outcome: "satisfied",
        });
        await recordSatisfiedGovernanceEvidence(rootDir, opened.workId, {
          id: "paused-terminal-verification",
          kind: "verification",
          source: "agent",
          recordedAt: "2026-08-11T10:11:00.000Z",
          summary: "Checks passed",
          outcome: "satisfied",
        });
      }
      await transitionGovernanceLifecycle(rootDir, opened.workId, {
        action: "pause",
        expectedLifecycle: "active",
        reason: "Pause before terminal decision",
      });
      const terminal = await transitionGovernanceLifecycle(
        rootDir,
        opened.workId,
        {
          action,
          expectedLifecycle: "paused",
          reason: `${action} paused work explicitly`,
        },
      );
      expect(terminal.lifecycle).toBe(lifecycle);
      expect(terminal.lifecycleTransitions?.at(-1)).toMatchObject({
        from: "paused",
        to: lifecycle,
      });
    }
  });

  it("serializes competing lifecycle transitions and rejects pending mutations", async () => {
    const { rootDir, opened, decision } = await setup();
    await initializeGovernanceState(rootDir, opened.workId, {
      decision,
      executionProfile: "solo",
    });
    await transitionGovernanceLifecycle(rootDir, opened.workId, {
      action: "pause",
      expectedLifecycle: "active",
      reason: "Prepare competing paused transitions",
    });
    const competing = await Promise.allSettled([
      transitionGovernanceLifecycle(rootDir, opened.workId, {
        action: "resume",
        expectedLifecycle: "paused",
        reason: "Resume concurrently",
      }),
      transitionGovernanceLifecycle(rootDir, opened.workId, {
        action: "abandon",
        expectedLifecycle: "paused",
        reason: "Abandon concurrently",
      }),
    ]);
    expect(
      competing.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      competing.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const terminalOrPaused = await readGovernanceState(rootDir, opened.workId);
    expect(terminalOrPaused.revision).toBe(2);
    expect(terminalOrPaused.lifecycleTransitions).toHaveLength(2);

    const pendingSetup = await setup();
    await initializeGovernanceState(
      pendingSetup.rootDir,
      pendingSetup.opened.workId,
      { decision: pendingSetup.decision, executionProfile: "solo" },
    );
    await recordSatisfiedGovernanceEvidence(
      pendingSetup.rootDir,
      pendingSetup.opened.workId,
      {
        id: "pending-plan",
        kind: "plan",
        source: "agent",
        recordedAt: "2026-08-11T11:00:00.000Z",
        summary: "Plan accepted",
        outcome: "satisfied",
      },
    );
    await beginGovernanceMutation(
      pendingSetup.rootDir,
      pendingSetup.opened.workId,
      {
        id: "pending-write",
        requestId: "request-a",
        toolCallId: "write-a",
        target: "src/a.ts",
        startedAt: "2026-08-11T11:01:00.000Z",
      },
    );
    await expect(
      transitionGovernanceLifecycle(
        pendingSetup.rootDir,
        pendingSetup.opened.workId,
        {
          action: "pause",
          expectedLifecycle: "active",
          reason: "Unsafe while write is pending",
        },
      ),
    ).rejects.toMatchObject({ code: "governance-blocked" });
    await clearGovernanceMutation(
      pendingSetup.rootDir,
      pendingSetup.opened.workId,
      "pending-write",
    );
  });
});
