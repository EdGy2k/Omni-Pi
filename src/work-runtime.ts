import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type ActiveWorkPointer,
  bindGedWork,
  clearActiveWorkSession,
  continueGedWork,
  ensureActiveGedWork,
  isActiveWorkBoundToRequest,
  type OpenedGedWork,
  openGedWork,
  relativeGedPath,
  setActiveWorkSession,
  type WorkRequestIdentity,
} from "./ged-paths.js";
import {
  type ExecutionProfile,
  type GovernanceWorkState,
  type Risk,
  resolveGovernance,
} from "./governance.js";
import {
  beginGovernanceMutation,
  clearGovernanceMutation,
  completeGovernanceMutation,
  governanceMutationBlockReason,
  initializeGovernanceState,
  readGovernanceState,
  recordSatisfiedGovernanceEvidence,
  transitionGovernanceLifecycle,
} from "./governance-store.js";
import { ensureLegacyCheckpointMigration } from "./legacy-migration.js";
import { isGitCommitCommand } from "./orchestration.js";

interface ActiveRequest extends WorkRequestIdentity {
  cwd: string;
  workId?: string;
}

interface PendingMutation {
  requestKey: string;
  workId: string;
  pendingId: string;
  summary: string;
}

export interface GedWorkRuntimeOptions {
  createRequestId?: () => string;
}

interface GedWorkToolDetails {
  operation: "open" | "continue";
  workId: string;
  workPath: string;
  mode: "direct-change" | "planned-change";
  executionProfile: ExecutionProfile;
}

interface GedGovernanceToolDetails {
  action: "accept-plan" | "record-verification";
  workId: string;
  evidenceId: string;
  revision: number;
}

interface GedLifecycleToolDetails {
  action: "pause" | "resume" | "complete" | "abandon" | "supersede";
  workId: string;
  from: "active" | "paused";
  to: "active" | "paused" | "completed" | "abandoned" | "superseded";
  transitionId: string;
  revision: number;
}

interface OpenGovernanceParams {
  minimumMode?: "direct-change" | "planned-change";
  ambiguity?: "sufficient" | "decision-needed";
  risk?: Risk;
  clearScope?: boolean;
  bounded?: boolean;
  reversible?: boolean;
  deterministicCheck?: boolean;
  escalationReason?: string;
  executionProfile?: ExecutionProfile;
}

function workTransitionPrompt(pointer: ActiveWorkPointer): string {
  const priorWork =
    pointer.operation === "bootstrap"
      ? "There is no prior generated work item selected for continuation."
      : `The prior session selection is ${pointer.workId}; it is not authorized for this request until explicitly continued.`;
  return `## Current-request work selection

${priorWork}

Before repository mutation, call ged_work in a separate tool batch. Open new work with a concise summary plus structured ambiguity, risk, minimum mode, and direct-change evidence. Continue only the exact work ID when the user is continuing that task.

Read-only work needs no selection and must not mutate. Planned-change work may write bound .ged planning artifacts before acceptance; source mutation requires ged_governance accept-plan. After checks pass, record-verification before committing. Use ged_lifecycle with an exact work ID to pause, resume, complete, abandon, or supersede work; commits never change lifecycle. Run each transition in its own tool batch.`;
}

function bindingBlockReason(): string {
  return "GedPi work guard: this agent request is not bound to an explicitly opened or continued work item. Call ged_work in a separate tool batch before writing, editing, or committing.";
}

function activeRequestKey(cwd: string, sessionId: string): string {
  return JSON.stringify([path.resolve(cwd), sessionId]);
}

function pendingMutationKey(
  requestKey: string,
  requestId: string,
  toolCallId: string,
): string {
  return JSON.stringify([requestKey, requestId, toolCallId]);
}

const DURABLE_GED_FILES = new Set([
  "ARCHITECTURE.md",
  "CONFIG.md",
  "CONTEXT-MAP.md",
  "DECISIONS.md",
  "GLOSSARY.md",
  "IDEAS.md",
  "PATTERNS.md",
  "PROGRESS.md",
  "PROJECT.md",
  "SKILLS.md",
  "STANDARDS.md",
]);
const WORK_PLANNING_FILES = new Set([
  "NOTES.md",
  "SPEC.md",
  "TASKS.md",
  "TESTS.md",
]);

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function canonicalMutationTarget(filePath: string): Promise<string> {
  let cursor = path.resolve(filePath);
  const suffix: string[] = [];
  while (true) {
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        try {
          return path.resolve(await realpath(cursor), ...suffix);
        } catch (error) {
          if (isEnoent(error)) {
            throw new Error(
              `Mutation target traverses a dangling symbolic link: ${cursor}`,
            );
          }
          throw error;
        }
      }
      return path.resolve(await realpath(cursor), ...suffix);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function relativeWithin(base: string, target: string): string | null {
  const relative = path.relative(base, target).split(path.sep).join("/");
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

function classifyGedSubpath(
  subpath: string,
  workId: string,
): "metadata" | "protected" {
  if (subpath === "runtime" || subpath.startsWith("runtime/")) {
    return "protected";
  }
  if (subpath === "project-skills" || subpath.startsWith("project-skills/")) {
    return "metadata";
  }
  if (DURABLE_GED_FILES.has(subpath)) return "metadata";
  const activeWorkPrefix = `work/${workId}/`;
  if (subpath.startsWith(activeWorkPrefix)) {
    const workFile = subpath.slice(activeWorkPrefix.length);
    return WORK_PLANNING_FILES.has(workFile) ? "metadata" : "protected";
  }
  return "protected";
}

async function classifyGedPath(
  rootDir: string,
  filePath: string,
  workId: string,
): Promise<"metadata" | "protected" | null> {
  const lexicalTarget = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(rootDir, filePath);
  const lexicalRoot = path.resolve(rootDir);
  const lexicalGedRoot = path.join(lexicalRoot, ".ged");
  const [
    root,
    target,
    gedRoot,
    runtimeRoot,
    workRoot,
    activeWorkRoot,
    skillsRoot,
  ] = await Promise.all([
    realpath(lexicalRoot),
    canonicalMutationTarget(lexicalTarget),
    canonicalMutationTarget(lexicalGedRoot),
    canonicalMutationTarget(path.join(lexicalGedRoot, "runtime")),
    canonicalMutationTarget(path.join(lexicalGedRoot, "work")),
    canonicalMutationTarget(path.join(lexicalGedRoot, "work", workId)),
    canonicalMutationTarget(path.join(lexicalGedRoot, "project-skills")),
  ]);

  const lexicalRelative = relativeWithin(lexicalRoot, lexicalTarget);
  if (lexicalRelative === ".ged" || lexicalRelative?.startsWith(".ged/")) {
    const lexicalKind = classifyGedSubpath(
      lexicalRelative === ".ged" ? "" : lexicalRelative.slice(5),
      workId,
    );
    if (lexicalKind === "protected") return "protected";
  }

  const canonicalGedRelative = relativeWithin(gedRoot, target);
  if (canonicalGedRelative !== null) {
    return classifyGedSubpath(canonicalGedRelative, workId);
  }
  if (relativeWithin(runtimeRoot, target) !== null) return "protected";
  const canonicalWorkRelative = relativeWithin(workRoot, target);
  if (canonicalWorkRelative !== null) {
    return classifyGedSubpath(`work/${canonicalWorkRelative}`, workId);
  }
  const activeWorkRelative = relativeWithin(activeWorkRoot, target);
  if (activeWorkRelative !== null) {
    return WORK_PLANNING_FILES.has(activeWorkRelative)
      ? "metadata"
      : "protected";
  }
  if (relativeWithin(skillsRoot, target) !== null) return "metadata";

  const repositoryRelative = relativeWithin(root, target);
  if (
    repositoryRelative === ".ged" ||
    repositoryRelative?.startsWith(".ged/")
  ) {
    return classifyGedSubpath(
      repositoryRelative === ".ged" ? "" : repositoryRelative.slice(5),
      workId,
    );
  }
  return null;
}

function requireOpenGovernance(params: OpenGovernanceParams) {
  if (
    !params.minimumMode ||
    !params.ambiguity ||
    !params.risk ||
    typeof params.clearScope !== "boolean" ||
    typeof params.bounded !== "boolean" ||
    typeof params.reversible !== "boolean" ||
    typeof params.deterministicCheck !== "boolean"
  ) {
    throw new Error(
      "ged_work open requires minimumMode, ambiguity, risk, clearScope, bounded, reversible, and deterministicCheck.",
    );
  }
  const decision = resolveGovernance({
    intent: { mutation: "requested", minimumMode: params.minimumMode },
    ambiguity: params.ambiguity,
    risk: params.risk,
    change: {
      clearScope: params.clearScope,
      bounded: params.bounded,
      reversible: params.reversible,
      deterministicCheck: params.deterministicCheck,
    },
    ...(params.escalationReason
      ? { coordinatorEscalation: { reason: params.escalationReason } }
      : {}),
  });
  if (decision.requiresDecision) {
    throw new Error(
      "A user-owned decision remains unresolved. Ask the user before opening mutating work.",
    );
  }
  return {
    decision,
    executionProfile: params.executionProfile ?? ("solo" as const),
  };
}

export function registerGedWorkRuntime(
  api: ExtensionAPI,
  options: GedWorkRuntimeOptions = {},
): void {
  const createRequestId = options.createRequestId ?? randomUUID;
  const activeRequests = new Map<string, ActiveRequest>();
  const pendingMutations = new Map<string, PendingMutation>();

  const requestState = (cwd: string, sessionId: string) => {
    const key = activeRequestKey(cwd, sessionId);
    return { key, request: activeRequests.get(key) };
  };

  const clearPendingFor = (requestKey: string) => {
    for (const [toolCallId, pending] of pendingMutations) {
      if (pending.requestKey === requestKey)
        pendingMutations.delete(toolCallId);
    }
  };

  api.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const key = activeRequestKey(ctx.cwd, sessionId);
    setActiveWorkSession(ctx.cwd, sessionId);
    activeRequests.delete(key);
    await ensureLegacyCheckpointMigration(ctx.cwd);
    await ensureActiveGedWork(ctx.cwd, sessionId);
  });

  api.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const key = activeRequestKey(ctx.cwd, sessionId);
    activeRequests.delete(key);
    clearPendingFor(key);
    clearActiveWorkSession(ctx.cwd, sessionId);
  });

  api.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const key = activeRequestKey(ctx.cwd, sessionId);
    setActiveWorkSession(ctx.cwd, sessionId);
    await ensureLegacyCheckpointMigration(ctx.cwd);
    const pointer = await ensureActiveGedWork(ctx.cwd, sessionId);
    activeRequests.set(key, {
      cwd: ctx.cwd,
      sessionId,
      requestId: createRequestId(),
    });
    return {
      systemPrompt: `${event.systemPrompt}\n\n${workTransitionPrompt(pointer)}`,
    };
  });

  api.on("agent_settled", async (_event, ctx) => {
    const key = activeRequestKey(ctx.cwd, ctx.sessionManager.getSessionId());
    activeRequests.delete(key);
  });

  api.on("tool_call", async (event, ctx) => {
    const bashCommand =
      event.toolName === "bash" &&
      event.input &&
      typeof event.input === "object" &&
      typeof (event.input as { command?: unknown }).command === "string"
        ? (event.input as { command: string }).command
        : null;
    const requiresBinding =
      event.toolName === "write" ||
      event.toolName === "edit" ||
      (bashCommand !== null && isGitCommitCommand(bashCommand));
    if (!requiresBinding) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const { key, request: activeRequest } = requestState(ctx.cwd, sessionId);
    if (
      !activeRequest ||
      activeRequest.cwd !== ctx.cwd ||
      activeRequest.sessionId !== sessionId ||
      !activeRequest.workId
    ) {
      return { block: true, reason: bindingBlockReason() };
    }
    try {
      if (
        !(await isActiveWorkBoundToRequest(
          ctx.cwd,
          {
            sessionId,
            requestId: activeRequest.requestId,
          },
          activeRequest.workId,
        ))
      ) {
        return { block: true, reason: bindingBlockReason() };
      }
      const filePath =
        event.toolName === "write" || event.toolName === "edit"
          ? String(
              (event.input as { path?: unknown; filePath?: unknown }).path ??
                (event.input as { filePath?: unknown }).filePath ??
                "",
            )
          : "";
      const gedPathKind = filePath
        ? await classifyGedPath(ctx.cwd, filePath, activeRequest.workId)
        : null;
      if (gedPathKind === "protected") {
        return {
          block: true,
          reason:
            "GedPi governance guard: runtime state, active pointers, migration records, and work metadata are runtime-owned.",
        };
      }
      const action =
        bashCommand !== null
          ? "commit"
          : gedPathKind === "metadata"
            ? "metadata-mutation"
            : "source-mutation";
      if (
        action === "commit" &&
        [...pendingMutations.values()].some(
          (pending) =>
            pending.requestKey === key &&
            pending.workId === activeRequest.workId,
        )
      ) {
        return {
          block: true,
          reason:
            "GedPi governance guard: a source mutation is still pending durable implementation evidence.",
        };
      }
      const governanceReason = await governanceMutationBlockReason(
        ctx.cwd,
        activeRequest.workId,
        action,
      );
      if (governanceReason) {
        return { block: true, reason: `GedPi work guard: ${governanceReason}` };
      }
      if (action === "source-mutation") {
        const lookupKey = pendingMutationKey(
          key,
          activeRequest.requestId,
          event.toolCallId,
        );
        if (pendingMutations.has(lookupKey)) {
          return {
            block: true,
            reason:
              "GedPi governance guard: this tool call ID already has a pending mutation.",
          };
        }
        const pendingId = `mutation-${randomUUID()}`;
        await beginGovernanceMutation(ctx.cwd, activeRequest.workId, {
          id: pendingId,
          requestId: activeRequest.requestId,
          toolCallId: event.toolCallId,
          target: filePath || "repository content",
          startedAt: new Date().toISOString(),
        });
        pendingMutations.set(lookupKey, {
          requestKey: key,
          workId: activeRequest.workId,
          pendingId,
          summary: `${event.toolName} ${filePath || "repository content"}`,
        });
      }
    } catch (error) {
      return {
        block: true,
        reason: `${bindingBlockReason()} Pointer error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  api.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const requestKey = activeRequestKey(
      ctx.cwd,
      ctx.sessionManager.getSessionId(),
    );
    const activeRequest = activeRequests.get(requestKey);
    if (!activeRequest) return;
    const pendingKey = pendingMutationKey(
      requestKey,
      activeRequest.requestId,
      event.toolCallId,
    );
    const pending = pendingMutations.get(pendingKey);
    if (!pending) return;
    if (event.isError) {
      try {
        await clearGovernanceMutation(
          ctx.cwd,
          pending.workId,
          pending.pendingId,
        );
        pendingMutations.delete(pendingKey);
        return;
      } catch (error) {
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `GedPi could not clear durable pending mutation state: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
    try {
      await completeGovernanceMutation(
        ctx.cwd,
        pending.workId,
        pending.pendingId,
        {
          id: `implementation-${randomUUID()}`,
          kind: "implementation",
          source: "runtime",
          recordedAt: new Date().toISOString(),
          summary: `Successful ${pending.summary}`,
          outcome: "observed",
        },
      );
      pendingMutations.delete(pendingKey);
    } catch (error) {
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `GedPi could not persist implementation evidence: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  api.registerTool({
    name: "ged_work",
    label: "Ged work",
    description:
      "Explicitly open governed mutating work or continue an existing governed work item for the current request. Open resolves work mode from structured evidence. Run in its own tool batch.",
    promptSnippet: "Open or continue governed work before repository mutation",
    promptGuidelines: [
      "For open, provide every governance evidence field; file count and staffing are not authority.",
      "Do not use ged_work for read-only requests. Continue only when the user is continuing the exact work item.",
    ],
    parameters: Type.Object(
      {
        action: StringEnum(["open", "continue"] as const),
        summary: Type.Optional(
          Type.String({
            description: "Concise new-work summary; required for open.",
            maxLength: 240,
          }),
        ),
        workId: Type.Optional(
          Type.String({
            description: "Exact generated work ID; required for continue.",
          }),
        ),
        minimumMode: Type.Optional(
          StringEnum(["direct-change", "planned-change"] as const),
        ),
        ambiguity: Type.Optional(
          StringEnum(["sufficient", "decision-needed"] as const),
        ),
        risk: Type.Optional(StringEnum(["low", "normal", "high"] as const)),
        clearScope: Type.Optional(Type.Boolean()),
        bounded: Type.Optional(Type.Boolean()),
        reversible: Type.Optional(Type.Boolean()),
        deterministicCheck: Type.Optional(Type.Boolean()),
        escalationReason: Type.Optional(Type.String({ maxLength: 240 })),
        executionProfile: Type.Optional(
          StringEnum([
            "solo",
            "assisted",
            "coordinated",
            "high-stakes",
          ] as const),
        ),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const { request: activeRequest } = requestState(ctx.cwd, sessionId);
      if (
        !activeRequest ||
        activeRequest.cwd !== ctx.cwd ||
        activeRequest.sessionId !== sessionId
      ) {
        throw new Error(
          "ged_work can only run inside the current agent request.",
        );
      }
      if (activeRequest.workId) {
        throw new Error(
          `This request is already bound to Ged work ${activeRequest.workId}. Start a new agent request to select different work.`,
        );
      }
      const identity = {
        sessionId,
        requestId: activeRequest.requestId,
      };
      let opened: OpenedGedWork;
      let state: GovernanceWorkState;
      if (params.action === "open") {
        const governance = requireOpenGovernance(params);
        opened = await openGedWork(ctx.cwd, identity, params.summary ?? "", {
          bindRequest: false,
        });
        state = await initializeGovernanceState(ctx.cwd, opened.workId, {
          decision: governance.decision,
          executionProfile: governance.executionProfile,
        });
        opened = await bindGedWork(ctx.cwd, identity, opened.workId, "open");
      } else {
        const workId = params.workId ?? "";
        const governanceReason = await governanceMutationBlockReason(
          ctx.cwd,
          workId,
          "metadata-mutation",
        );
        if (governanceReason) throw new Error(governanceReason);
        state = await readGovernanceState(ctx.cwd, workId);
        opened = await continueGedWork(ctx.cwd, identity, workId);
      }
      activeRequest.workId = opened.workId;
      const details: GedWorkToolDetails = {
        operation: params.action,
        workId: opened.workId,
        workPath: relativeGedPath(ctx.cwd, opened.paths.workDir),
        mode: state.decision.mode as "direct-change" | "planned-change",
        executionProfile: state.executionProfile,
      };
      return {
        content: [
          {
            type: "text",
            text: `${params.action === "open" ? "Opened" : "Continued"} ${details.mode} Ged work ${opened.workId} at ${details.workPath}. This request is now bound to that governed work item.`,
          },
        ],
        details,
      };
    },
  });

  api.registerTool({
    name: "ged_governance",
    label: "Ged governance",
    description:
      "Record role-neutral accepted-plan or verification evidence for the exact work bound to this request. Run in its own tool batch.",
    promptSnippet: "Record accepted governance evidence for current work",
    promptGuidelines: [
      "Use accept-plan only after the coordinator accepts the final planned artifacts.",
      "Use record-verification only after the planned checks pass and findings are adjudicated.",
      "Evidence producers may be main-agent or optional assistants; staffing never changes the contract.",
    ],
    parameters: Type.Object(
      {
        action: StringEnum(["accept-plan", "record-verification"] as const),
        summary: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const { request: activeRequest } = requestState(ctx.cwd, sessionId);
      if (
        !activeRequest?.workId ||
        activeRequest.cwd !== ctx.cwd ||
        activeRequest.sessionId !== sessionId ||
        !(await isActiveWorkBoundToRequest(
          ctx.cwd,
          {
            sessionId,
            requestId: activeRequest.requestId,
          },
          activeRequest.workId,
        ))
      ) {
        throw new Error(bindingBlockReason());
      }
      const evidenceId = `${params.action}-${randomUUID()}`;
      const state = await recordSatisfiedGovernanceEvidence(
        ctx.cwd,
        activeRequest.workId,
        {
          id: evidenceId,
          kind: params.action === "accept-plan" ? "plan" : "verification",
          source: "agent",
          producerId: "coordinator",
          recordedAt: new Date().toISOString(),
          summary: params.summary,
          outcome: "satisfied",
        },
      );
      const details: GedGovernanceToolDetails = {
        action: params.action,
        workId: activeRequest.workId,
        evidenceId,
        revision: state.revision,
      };
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${params.action} evidence for Ged work ${activeRequest.workId} at revision ${state.revision}.`,
          },
        ],
        details,
      };
    },
  });

  api.registerTool({
    name: "ged_lifecycle",
    label: "Ged lifecycle",
    description:
      "Explicitly pause, resume, complete, abandon, or supersede one exact governed work item. Commits and staffing never change lifecycle. Run in its own tool batch.",
    promptSnippet: "Transition the exact governed work lifecycle explicitly",
    promptGuidelines: [
      "Use the exact work ID and a concise coordinator-owned reason.",
      "Complete only after current verification. Resume only paused work; terminal work cannot be reopened.",
      "Active work must already be bound to this request with ged_work open or continue.",
    ],
    parameters: Type.Object(
      {
        action: StringEnum([
          "pause",
          "resume",
          "complete",
          "abandon",
          "supersede",
        ] as const),
        workId: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const { request: activeRequest } = requestState(ctx.cwd, sessionId);
      if (!activeRequest) {
        throw new Error(
          "ged_lifecycle can only run inside the current agent request.",
        );
      }
      const before = await readGovernanceState(ctx.cwd, params.workId);
      if (before.lifecycle === "active") {
        if (
          activeRequest.workId !== params.workId ||
          !(await isActiveWorkBoundToRequest(
            ctx.cwd,
            { sessionId, requestId: activeRequest.requestId },
            params.workId,
          ))
        ) {
          throw new Error(
            "Active work lifecycle changes require ged_work open or continue for the exact work ID in this request.",
          );
        }
      } else if (
        activeRequest.workId &&
        activeRequest.workId !== params.workId
      ) {
        throw new Error(
          `This request is already bound to different Ged work ${activeRequest.workId}.`,
        );
      }
      const state = await transitionGovernanceLifecycle(
        ctx.cwd,
        params.workId,
        {
          action: params.action,
          expectedLifecycle: before.lifecycle,
          reason: params.reason,
        },
      );
      const transition = state.lifecycleTransitions?.at(-1);
      if (!transition) {
        throw new Error("Lifecycle transition was not persisted.");
      }
      const details: GedLifecycleToolDetails = {
        action: params.action,
        workId: params.workId,
        from: transition.from as "active" | "paused",
        to: transition.to,
        transitionId: transition.id,
        revision: state.revision,
      };
      return {
        content: [
          {
            type: "text",
            text: `Transitioned Ged work ${params.workId} from ${details.from} to ${details.to} at revision ${details.revision}.`,
          },
        ],
        details,
      };
    },
  });
}
