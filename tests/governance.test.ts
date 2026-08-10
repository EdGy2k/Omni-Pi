import { describe, expect, it } from "vitest";
import {
  AMBIGUITIES,
  type ChangeGovernanceInput,
  type DirectChangeEvidence,
  EXECUTION_PROFILES,
  type GovernanceInput,
  RISKS,
  resolveGovernance,
  WORK_LIFECYCLES,
  WORK_MODES,
  type WorkMode,
} from "../src/governance.js";

const DIRECT_CHANGE: DirectChangeEvidence = {
  clearScope: true,
  bounded: true,
  reversible: true,
  deterministicCheck: true,
} as const;

const requestedChange = (
  overrides: Partial<DirectChangeEvidence> = {},
): ChangeGovernanceInput => ({
  intent: { mutation: "requested", minimumMode: "direct-change" },
  ambiguity: "sufficient",
  risk: "normal",
  change: { ...DIRECT_CHANGE, ...overrides },
});

interface Scenario {
  name: string;
  input: GovernanceInput;
  mode: WorkMode;
  requiresDecision: boolean;
  reasonCode: string;
}

const scenarios: Scenario[] = [
  {
    name: "explanation",
    input: {
      intent: { mutation: "none" },
      ambiguity: "sufficient",
      risk: "low",
    },
    mode: "read-only",
    requiresDecision: false,
    reasonCode: "no-mutation-intent",
  },
  {
    name: "broad architecture audit",
    input: {
      intent: { mutation: "none" },
      ambiguity: "decision-needed",
      risk: "high",
      coordinatorEscalation: {
        reason: "The subsystem is security-sensitive.",
      },
    },
    mode: "read-only",
    requiresDecision: false,
    reasonCode: "no-mutation-intent",
  },
  {
    name: "one-file bug",
    input: { ...requestedChange(), risk: "low" },
    mode: "direct-change",
    requiresDecision: false,
    reasonCode: "direct-change-eligible",
  },
  {
    name: "two-file mechanical fix",
    input: requestedChange(),
    mode: "direct-change",
    requiresDecision: false,
    reasonCode: "direct-change-eligible",
  },
  {
    name: "authentication configuration",
    input: { ...requestedChange(), risk: "high" },
    mode: "planned-change",
    requiresDecision: false,
    reasonCode: "high-risk",
  },
  {
    name: "data migration",
    input: {
      ...requestedChange({ reversible: false }),
      risk: "high",
    },
    mode: "planned-change",
    requiresDecision: false,
    reasonCode: "high-risk",
  },
  {
    name: "ambiguous UI behavior",
    input: {
      ...requestedChange({ clearScope: false }),
      ambiguity: "decision-needed",
    },
    mode: "planned-change",
    requiresDecision: true,
    reasonCode: "decision-needed",
  },
  {
    name: "release operation",
    input: {
      ...requestedChange({ reversible: false }),
      risk: "high",
    },
    mode: "planned-change",
    requiresDecision: false,
    reasonCode: "high-risk",
  },
];

describe("governance vocabulary", () => {
  it("exports the canonical policy inventories", () => {
    expect(WORK_MODES).toEqual([
      "read-only",
      "direct-change",
      "planned-change",
    ]);
    expect(AMBIGUITIES).toEqual(["sufficient", "decision-needed"]);
    expect(RISKS).toEqual(["low", "normal", "high"]);
    expect(WORK_LIFECYCLES).toEqual([
      "active",
      "paused",
      "completed",
      "abandoned",
      "superseded",
    ]);
    expect(EXECUTION_PROFILES).toEqual([
      "solo",
      "assisted",
      "coordinated",
      "high-stakes",
    ]);
  });
});

describe("resolveGovernance", () => {
  for (const scenario of scenarios) {
    it(`resolves ${scenario.name}`, () => {
      const decision = resolveGovernance(scenario.input);

      expect(decision.mode).toBe(scenario.mode);
      expect(decision.requiresDecision).toBe(scenario.requiresDecision);
      expect(decision.reasonCode).toBe(scenario.reasonCode);
      expect(decision.reason.length).toBeGreaterThan(0);
    });
  }

  it("does not downgrade a user-requested plan", () => {
    expect(
      resolveGovernance({
        ...requestedChange(),
        intent: {
          mutation: "requested" as const,
          minimumMode: "planned-change" as const,
        },
      }),
    ).toMatchObject({
      mode: "planned-change",
      requiresDecision: false,
      reasonCode: "user-requested-plan",
    });
  });

  it("allows the coordinator to escalate but not downgrade", () => {
    const decision = resolveGovernance({
      ...requestedChange(),
      coordinatorEscalation: {
        reason: "The touched subsystem has poor regression coverage.",
      },
    });

    expect(decision).toMatchObject({
      mode: "planned-change",
      requiresDecision: false,
      reasonCode: "coordinator-escalation",
    });
    expect(decision.reason).toContain("poor regression coverage");
  });

  it.each([
    ["unbounded", { bounded: false }],
    ["irreversible", { reversible: false }],
    ["non-deterministic", { deterministicCheck: false }],
    ["unclear scope", { clearScope: false }],
  ] as const)("requires planning for %s work", (_name, overrides) => {
    expect(resolveGovernance(requestedChange(overrides))).toMatchObject({
      mode: "planned-change",
      requiresDecision: false,
      reasonCode: "direct-change-ineligible",
    });
  });

  it("blocks ambiguous mutation even when mechanical predicates pass", () => {
    expect(
      resolveGovernance({
        ...requestedChange(),
        ambiguity: "decision-needed",
      }),
    ).toMatchObject({
      mode: "planned-change",
      requiresDecision: true,
      reasonCode: "decision-needed",
    });
  });
});
