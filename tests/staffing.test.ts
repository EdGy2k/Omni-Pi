import { describe, expect, test } from "vitest";

import {
  GED_AGENT_CAPABILITIES,
  recommendExecutionProfile,
  workflowStaffingBlockReason,
} from "../src/staffing.js";

describe("adaptive staffing", () => {
  test.each([
    ["small fix", "none", "narrow", "routine", "standard", "solo"],
    ["broad review", "none", "broad", "routine", "standard", "assisted"],
    [
      "parallel subsystem recon",
      "disjoint",
      "broad",
      "routine",
      "standard",
      "coordinated",
    ],
    [
      "disjoint implementation",
      "disjoint",
      "narrow",
      "difficult",
      "high",
      "coordinated",
    ],
    [
      "coupled migration",
      "bounded",
      "broad",
      "difficult",
      "standard",
      "assisted",
    ],
    [
      "high-stakes security",
      "none",
      "broad",
      "high-stakes",
      "high",
      "high-stakes",
    ],
    ["low budget", "disjoint", "broad", "routine", "low", "solo"],
  ] as const)("%s recommends %s", (_label, decomposability, contextSpread, difficulty, budget, expected) => {
    expect(
      recommendExecutionProfile({
        decomposability,
        contextSpread,
        difficulty,
        budget,
      }).profile,
    ).toBe(expected);
  });

  test("keeps capability and model-independent execution traits explicit", () => {
    expect(GED_AGENT_CAPABILITIES.scout).toMatchObject({
      readOnly: true,
      writer: false,
      mayFanout: false,
      defaultContext: "fresh",
    });
    expect(GED_AGENT_CAPABILITIES.worker).toMatchObject({
      writer: true,
      mayFanout: false,
      defaultContext: "fork",
      requiresManagedIsolationWhenParallel: true,
    });
    expect(GED_AGENT_CAPABILITIES["smart-worker"]).toMatchObject({
      writer: true,
      mayFanout: true,
      maxParallel: 1,
    });
  });

  test("allows parallel readers and one current-checkout writer", () => {
    expect(
      workflowStaffingBlockReason(`
        return runs.all([
          { key: "api", agent: "ged-explorer", task: "Inspect API" },
          { key: "tests", agent: "ged-verifier", task: "Inspect tests" }
        ]);
      `),
    ).toBeNull();
    expect(
      workflowStaffingBlockReason(`
        return runs.all([
          { key: "write", agent: "ged-worker", task: "Implement" },
          { key: "review", agent: "ged-verifier", task: "Review" }
        ]);
      `),
    ).toBeNull();
  });

  test("blocks unisolated parallel writers and permits managed worktrees", () => {
    const script = `
      return runs.all([
        { key: "a", agent: "ged-worker", task: "Implement A" },
        { key: "b", agent: "ged-smart-worker", task: "Implement B" }
      ]);
    `;
    expect(workflowStaffingBlockReason(script)).toContain(
      "blocks parallel writers",
    );
    expect(workflowStaffingBlockReason(script, { worktree: true })).toBeNull();
    expect(
      workflowStaffingBlockReason(`
        return runs.all([
          { key: "a", agent: "ged-worker", task: "A", worktree: true },
          { key: "b", agent: "ged-worker", task: "B", worktree: true }
        ]);
      `),
    ).toBeNull();
  });

  test("fails closed for dynamic possibly-writing parallel lanes", () => {
    expect(
      workflowStaffingBlockReason(
        "return runs.all(targets.map(target => ({ key: target.id, agent: target.agent, task: target.task })));",
      ),
    ).toContain("dynamic parallel lanes");
    expect(
      workflowStaffingBlockReason(
        "return runs.all(targets.map(target => ({ key: target.id, agent: target.agent, task: target.task })));",
        { worktree: true },
      ),
    ).toBeNull();
  });

  test("blocks aliased workflow launch APIs", () => {
    expect(
      workflowStaffingBlockReason(`
        const all = runs.all;
        return all([
          { key: "a", agent: "ged-worker", task: "A" },
          { key: "b", agent: "ged-worker", task: "B" }
        ]);
      `),
    ).toContain("aliased workflow launch functions");
    expect(
      workflowStaffingBlockReason(`
        const { all } = runs;
        return all([]);
      `),
    ).toContain("aliased or destructured runs APIs");
    expect(
      workflowStaffingBlockReason(`
        const first = runs.run("a", { agent: "ged-worker", task: "A" });
        const second = runs.run("b", { agent: "ged-worker", task: "B" });
        return Promise.all([first, second]);
      `),
    ).toContain("directly awaited or returned");
    expect(
      workflowStaffingBlockReason(
        'return runs["r" + "un"]("a", { agent: "ged-worker", task: "A" });',
      ),
    ).toContain("dynamically computed runs API properties");
  });

  test("rejects duplicate or spread lane fields that can change isolation", () => {
    expect(
      workflowStaffingBlockReason(`
        return runs.all([
          { key: "a", agent: "ged-worker", task: "A", worktree: true, worktree: false },
          { key: "b", agent: "ged-worker", task: "B", worktree: true }
        ]);
      `),
    ).toContain("blocks parallel writers");
    expect(
      workflowStaffingBlockReason(
        `return runs.all([
          { key: "a", agent: "ged-worker", task: "A", worktree: true },
          { ...lane, key: "b" }
        ]);`,
        { worktree: true },
      ),
    ).toContain("blocks parallel writers");
  });

  test("blocks helper-composed current-checkout writer concurrency", () => {
    expect(
      workflowStaffingBlockReason(`
        async function a() {
          return await runs.run("a", { agent: "ged-worker", task: "A" });
        }
        async function b() {
          return await runs.run("b", { agent: "ged-worker", task: "B" });
        }
        return Promise.all([a(), b()]);
      `),
    ).toContain("hidden behind user-defined workflow functions");
  });
});
