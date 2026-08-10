import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type ActiveWorkPointer,
  clearActiveWorkSession,
  continueGedWork,
  ensureActiveGedWork,
  isActiveWorkBoundToRequest,
  openGedWork,
  relativeGedPath,
  setActiveWorkSession,
  type WorkRequestIdentity,
} from "./ged-paths.js";
import { governanceMutationBlockReason } from "./governance-store.js";
import { ensureLegacyCheckpointMigration } from "./legacy-migration.js";
import { isGitCommitCommand } from "./orchestration.js";

interface ActiveRequest extends WorkRequestIdentity {
  cwd: string;
  workId?: string;
}

export interface GedWorkRuntimeOptions {
  createRequestId?: () => string;
}

interface GedWorkToolDetails {
  operation: "open" | "continue";
  workId: string;
  workPath: string;
}

function workTransitionPrompt(pointer: ActiveWorkPointer): string {
  const priorWork =
    pointer.operation === "bootstrap"
      ? "There is no prior generated work item selected for continuation."
      : `The prior session selection is ${pointer.workId}; it is not authorized for this request until explicitly continued.`;
  return `## Current-request work selection

${priorWork}

Before any repository write, edit, or commit in this request, call \`ged_work\` in a separate tool batch:
- \`action: "open"\` with a concise \`summary\` when this is a new user request;
- \`action: "continue"\` with the exact \`workId\` only when the user is continuing that work.

Read-only work does not need a work selection. Never continue prior work merely because it is visible. A new request cannot reuse an earlier request's selection.`;
}

function bindingBlockReason(): string {
  return "GedPi work guard: this agent request is not bound to an explicitly opened or continued work item. Call ged_work in a separate tool batch before writing, editing, or committing.";
}

export function registerGedWorkRuntime(
  api: ExtensionAPI,
  options: GedWorkRuntimeOptions = {},
): void {
  const createRequestId = options.createRequestId ?? randomUUID;
  let activeRequest: ActiveRequest | undefined;

  api.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    setActiveWorkSession(ctx.cwd, sessionId);
    activeRequest = undefined;
    await ensureLegacyCheckpointMigration(ctx.cwd);
    await ensureActiveGedWork(ctx.cwd, sessionId);
  });

  api.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    activeRequest = undefined;
    clearActiveWorkSession(ctx.cwd, sessionId);
  });

  api.on("before_agent_start", async (event, ctx) => {
    activeRequest = undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    setActiveWorkSession(ctx.cwd, sessionId);
    await ensureLegacyCheckpointMigration(ctx.cwd);
    const pointer = await ensureActiveGedWork(ctx.cwd, sessionId);
    activeRequest = {
      cwd: ctx.cwd,
      sessionId,
      requestId: createRequestId(),
    };
    return {
      systemPrompt: `${event.systemPrompt}\n\n${workTransitionPrompt(pointer)}`,
    };
  });

  api.on("agent_settled", async () => {
    activeRequest = undefined;
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
      const governanceReason = await governanceMutationBlockReason(
        ctx.cwd,
        activeRequest.workId,
      );
      if (governanceReason) {
        return { block: true, reason: `GedPi work guard: ${governanceReason}` };
      }
    } catch (error) {
      return {
        block: true,
        reason: `${bindingBlockReason()} Pointer error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  api.registerTool({
    name: "ged_work",
    label: "Ged work",
    description:
      "Explicitly open a new Ged work item or continue an existing generated work item for the current agent request. Run this in its own tool batch before write/edit/commit tools. Output is capped at a short work ID and path.",
    promptSnippet:
      "Open or continue the current Ged work item before repository mutation",
    promptGuidelines: [
      "Use ged_work in a separate tool batch before write, edit, or commit whenever the current user request intends repository mutation.",
      "Do not use ged_work for read-only requests, and never continue prior work without confirming the request is a continuation.",
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
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
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
      const opened =
        params.action === "open"
          ? await openGedWork(ctx.cwd, identity, params.summary ?? "")
          : await continueGedWork(ctx.cwd, identity, params.workId ?? "");
      activeRequest.workId = opened.workId;
      const details: GedWorkToolDetails = {
        operation: params.action,
        workId: opened.workId,
        workPath: relativeGedPath(ctx.cwd, opened.paths.workDir),
      };
      return {
        content: [
          {
            type: "text",
            text: `${params.action === "open" ? "Opened" : "Continued"} Ged work ${opened.workId} at ${details.workPath}. This request is now bound to that work item.`,
          },
        ],
        details,
      };
    },
  });
}
