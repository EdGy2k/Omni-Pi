import { parse } from "acorn";

import type { ExecutionProfile } from "./governance.js";

export const GED_CAPABILITY_IDS = [
  "scout",
  "planner",
  "plan-reviewer",
  "verifier",
  "worker",
  "smart-worker",
] as const;

export type GedCapabilityId = (typeof GED_CAPABILITY_IDS)[number];

export interface GedAgentCapability {
  id: GedCapabilityId;
  agent: string;
  readOnly: boolean;
  writer: boolean;
  mayFanout: boolean;
  defaultContext: "fresh" | "fork";
  maxParallel: number;
  requiresManagedIsolationWhenParallel: boolean;
}

export const GED_AGENT_CAPABILITIES: Record<
  GedCapabilityId,
  GedAgentCapability
> = {
  scout: {
    id: "scout",
    agent: "ged-explorer",
    readOnly: true,
    writer: false,
    mayFanout: false,
    defaultContext: "fresh",
    maxParallel: 4,
    requiresManagedIsolationWhenParallel: false,
  },
  planner: {
    id: "planner",
    agent: "ged-planner",
    readOnly: true,
    writer: false,
    mayFanout: false,
    defaultContext: "fresh",
    maxParallel: 1,
    requiresManagedIsolationWhenParallel: false,
  },
  "plan-reviewer": {
    id: "plan-reviewer",
    agent: "ged-plan-reviewer",
    readOnly: true,
    writer: false,
    mayFanout: false,
    defaultContext: "fresh",
    maxParallel: 2,
    requiresManagedIsolationWhenParallel: false,
  },
  verifier: {
    id: "verifier",
    agent: "ged-verifier",
    readOnly: true,
    writer: false,
    mayFanout: false,
    defaultContext: "fresh",
    maxParallel: 3,
    requiresManagedIsolationWhenParallel: false,
  },
  worker: {
    id: "worker",
    agent: "ged-worker",
    readOnly: false,
    writer: true,
    mayFanout: false,
    defaultContext: "fork",
    maxParallel: 2,
    requiresManagedIsolationWhenParallel: true,
  },
  "smart-worker": {
    id: "smart-worker",
    agent: "ged-smart-worker",
    readOnly: false,
    writer: true,
    mayFanout: true,
    defaultContext: "fork",
    maxParallel: 1,
    requiresManagedIsolationWhenParallel: true,
  },
};

export const GED_AGENT_ALIASES: Readonly<Record<string, GedCapabilityId>> = {
  "ged-explorer": "scout",
  "ged-planner": "planner",
  "ged-plan-reviewer": "plan-reviewer",
  "ged-verifier": "verifier",
  "ged-worker": "worker",
  "ged-smart-worker": "smart-worker",
};

export const STAFFING_DECOMPOSABILITY = [
  "none",
  "bounded",
  "disjoint",
] as const;
export const STAFFING_CONTEXT_SPREAD = ["narrow", "broad"] as const;
export const STAFFING_DIFFICULTY = [
  "routine",
  "difficult",
  "high-stakes",
] as const;
export const STAFFING_BUDGET = ["low", "standard", "high"] as const;

export interface StaffingRecommendationInput {
  decomposability: (typeof STAFFING_DECOMPOSABILITY)[number];
  contextSpread: (typeof STAFFING_CONTEXT_SPREAD)[number];
  difficulty: (typeof STAFFING_DIFFICULTY)[number];
  budget: (typeof STAFFING_BUDGET)[number];
}

export interface StaffingRecommendation {
  profile: ExecutionProfile;
  capabilities: GedCapabilityId[];
  reason: string;
}

export function recommendExecutionProfile(
  input: StaffingRecommendationInput,
): StaffingRecommendation {
  if (input.difficulty === "high-stakes") {
    return {
      profile: "high-stakes",
      capabilities: ["scout", "plan-reviewer", "verifier"],
      reason:
        "High-stakes work warrants independent context gathering and deeper fresh review; the coordinator retains the write path.",
    };
  }
  if (input.budget === "low") {
    return {
      profile: "solo",
      capabilities: [],
      reason:
        "The available staffing budget favors direct coordinator execution.",
    };
  }
  if (input.decomposability === "disjoint") {
    return {
      profile: "coordinated",
      capabilities:
        input.difficulty === "difficult"
          ? ["scout", "smart-worker", "verifier"]
          : ["scout", "worker", "verifier"],
      reason:
        "Disjoint lanes can run as coordinated readers or managed isolated writers.",
    };
  }
  if (
    input.contextSpread === "broad" ||
    input.decomposability === "bounded" ||
    input.difficulty === "difficult"
  ) {
    return {
      profile: "assisted",
      capabilities:
        input.difficulty === "difficult"
          ? ["smart-worker", "verifier"]
          : input.contextSpread === "broad"
            ? ["scout", "verifier"]
            : ["worker", "verifier"],
      reason:
        "One focused assistant or bounded writer adds useful capacity without coordinated fanout.",
    };
  }
  return {
    profile: "solo",
    capabilities: [],
    reason: "The task is narrow, routine, and not usefully decomposable.",
  };
}

type AstNode = { type: string; [key: string]: unknown };

interface LaunchLane {
  possibleWriter: boolean;
  worktree: boolean;
}

function isNode(value: unknown): value is AstNode {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

function staticPropertyName(node: AstNode): string | undefined {
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

function objectProperties(node: AstNode, name: string): AstNode[] {
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    return [];
  }
  const matches: AstNode[] = [];
  for (const candidate of node.properties) {
    if (!isNode(candidate) || candidate.type !== "Property") continue;
    if (!isNode(candidate.key) || staticPropertyName(candidate.key) !== name) {
      continue;
    }
    if (isNode(candidate.value)) matches.push(candidate.value);
  }
  return matches;
}

function objectProperty(node: AstNode, name: string): AstNode | undefined {
  const matches = objectProperties(node, name);
  return matches.length === 1 ? matches[0] : undefined;
}

function staticString(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis)
  ) {
    const quasi = node.quasis[0] as
      | { value?: { cooked?: unknown } }
      | undefined;
    if (typeof quasi?.value?.cooked === "string") {
      return quasi.value.cooked;
    }
  }
  return undefined;
}

function staticBoolean(node: AstNode | undefined): boolean | undefined {
  return node?.type === "Literal" && typeof node.value === "boolean"
    ? node.value
    : undefined;
}

function launchLane(node: AstNode, workflowWorktree: boolean): LaunchLane {
  const hasSpread =
    node.type !== "ObjectExpression" ||
    !Array.isArray(node.properties) ||
    node.properties.some(
      (entry) => isNode(entry) && entry.type === "SpreadElement",
    );
  const agentProperties = objectProperties(node, "agent");
  const worktreeProperties = objectProperties(node, "worktree");
  const agent = staticString(objectProperty(node, "agent"));
  const capability = agent ? GED_AGENT_ALIASES[agent] : undefined;
  return {
    possibleWriter:
      hasSpread ||
      agentProperties.length !== 1 ||
      capability === undefined ||
      GED_AGENT_CAPABILITIES[capability].writer,
    worktree:
      !hasSpread && worktreeProperties.length <= 1
        ? (staticBoolean(objectProperty(node, "worktree")) ?? workflowWorktree)
        : false,
  };
}

function isRunsCall(node: AstNode, method: "run" | "all"): boolean {
  if (node.type !== "CallExpression" || !isNode(node.callee)) return false;
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    isNode(callee.object) &&
    callee.object.type === "Identifier" &&
    callee.object.name === "runs" &&
    isNode(callee.property) &&
    staticPropertyName(callee.property) === method
  );
}

function visitAst(
  node: AstNode,
  visit: (candidate: AstNode, parent?: AstNode) => void,
  parent?: AstNode,
): void {
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (isNode(value)) visitAst(value, visit, node);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visitAst(item, visit, node);
    }
  }
}

export function workflowStaffingBlockReason(
  workflowScript: string,
  options: { worktree?: boolean } = {},
): string | null {
  return inspectWorkflowStaffing(workflowScript, options).reason;
}

export interface WorkflowStaffingInspection {
  reason: string | null;
  writesCurrentCheckout: boolean;
}

export function inspectWorkflowStaffing(
  workflowScript: string,
  options: { worktree?: boolean } = {},
): WorkflowStaffingInspection {
  let root: AstNode;
  try {
    root = parse(`async function __ged_workflow__() {\n${workflowScript}\n}`, {
      ecmaVersion: "latest",
      sourceType: "script",
    }) as unknown as AstNode;
  } catch (error) {
    return {
      reason: `Ged staffing guard could not statically validate workflowScript: ${error instanceof Error ? error.message : String(error)}`,
      writesCurrentCheckout: false,
    };
  }
  let reason: string | null = null;
  let writesCurrentCheckout = false;
  let hasUserDefinedFunction = false;
  visitAst(root, (node, parent) => {
    if (reason) return;
    if (
      (node.type === "CallExpression" || node.type === "NewExpression") &&
      isNode(node.callee) &&
      ((node.callee.type === "Identifier" &&
        (node.callee.name === "eval" || node.callee.name === "Function")) ||
        (node.callee.type === "MemberExpression" &&
          isNode(node.callee.property) &&
          (staticPropertyName(node.callee.property) === "eval" ||
            staticPropertyName(node.callee.property) === "Function" ||
            staticPropertyName(node.callee.property) === "constructor")))
    ) {
      reason =
        "Ged staffing guard blocks dynamic code construction in workflowScript because launch topology cannot be proven.";
      return;
    }
    if (
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      (node.type === "FunctionDeclaration" &&
        (!isNode(node.id) || node.id.name !== "__ged_workflow__"))
    ) {
      hasUserDefinedFunction = true;
    }
    if (
      node.type === "Identifier" &&
      node.name === "runs" &&
      (parent?.type !== "MemberExpression" || parent.object !== node)
    ) {
      reason =
        "Ged staffing guard requires direct public runs.run/runs.all calls; aliased or destructured runs APIs cannot be validated safely.";
      return;
    }
    if (
      node.type === "MemberExpression" &&
      isNode(node.object) &&
      node.object.type === "Identifier" &&
      node.object.name === "runs" &&
      isNode(node.property) &&
      staticPropertyName(node.property) === undefined
    ) {
      reason =
        "Ged staffing guard blocks dynamically computed runs API properties because launch topology cannot be proven.";
      return;
    }
    if (
      node.type === "MemberExpression" &&
      isNode(node.object) &&
      node.object.type === "Identifier" &&
      node.object.name === "runs" &&
      isNode(node.property) &&
      (staticPropertyName(node.property) === "run" ||
        staticPropertyName(node.property) === "all") &&
      (parent?.type !== "CallExpression" || parent.callee !== node)
    ) {
      reason =
        "Ged staffing guard requires direct public runs.run/runs.all calls; aliased workflow launch functions are blocked.";
      return;
    }
    if (
      (isRunsCall(node, "run") || isRunsCall(node, "all")) &&
      (!parent ||
        (parent.type !== "AwaitExpression" &&
          parent.type !== "ReturnStatement"))
    ) {
      reason =
        "Ged staffing guard requires every runs.run/runs.all launch to be directly awaited or returned so writer concurrency remains explicit.";
      return;
    }
    if (isRunsCall(node, "run")) {
      const laneNode = Array.isArray(node.arguments) ? node.arguments[1] : null;
      const lane = isNode(laneNode)
        ? launchLane(laneNode, options.worktree === true)
        : {
            possibleWriter: true,
            worktree: options.worktree === true,
          };
      if (lane.possibleWriter && !lane.worktree) writesCurrentCheckout = true;
    }
    if (!isRunsCall(node, "all")) return;
    const argument = Array.isArray(node.arguments)
      ? node.arguments[0]
      : undefined;
    if (!isNode(argument) || argument.type !== "ArrayExpression") {
      if (options.worktree !== true) {
        reason =
          "Ged staffing guard requires workflow-level worktree: true for dynamic parallel lanes that could contain writers.";
      }
      return;
    }
    const lanes = Array.isArray(argument.elements)
      ? argument.elements.map((entry) =>
          isNode(entry)
            ? launchLane(entry, options.worktree === true)
            : { possibleWriter: true, worktree: options.worktree === true },
        )
      : [];
    const writers = lanes.filter((lane) => lane.possibleWriter);
    if (writers.some((lane) => !lane.worktree)) writesCurrentCheckout = true;
    if (writers.length > 1 && writers.some((lane) => !lane.worktree)) {
      reason =
        "Ged staffing guard blocks parallel writers in the current checkout. Set worktree: true on every writer lane or at workflow level.";
    }
  });
  if (!reason && writesCurrentCheckout && hasUserDefinedFunction) {
    reason =
      "Ged staffing guard blocks current-checkout writer launches hidden behind user-defined workflow functions. Use directly awaited/returned runs.run calls or managed worktree isolation.";
  }
  return { reason, writesCurrentCheckout };
}

export function staffingDispatchBlockReason(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName !== "subagent" || typeof input.workflowScript !== "string") {
    return null;
  }
  return workflowStaffingBlockReason(input.workflowScript, {
    worktree: input.worktree === true,
  });
}

export function staffingDispatchInspection(
  toolName: string,
  input: Record<string, unknown>,
): WorkflowStaffingInspection {
  if (toolName !== "subagent" || typeof input.workflowScript !== "string") {
    return { reason: null, writesCurrentCheckout: false };
  }
  return inspectWorkflowStaffing(input.workflowScript, {
    worktree: input.worktree === true,
  });
}
