import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  readEffectiveGedAgentsSettings,
  syncGedSubagentRuntimeConfig,
} from "../../src/agent-settings.js";
import {
  buildPassiveGedPromptSuffix,
  buildWorkflowPromptSuffix,
  ensureGedReady,
} from "../../src/brain.js";
import { createGedCommands } from "../../src/commands.js";
import { renderHeader } from "../../src/header.js";
import {
  closeCheckpointState,
  consumePlannerCheckpoint,
  detectSubagentDispatch,
  hasExplorerClearedInspection,
  hasSkipCheckpointMarker,
  invalidateVerifierCheckpoints,
  isCheckpointClosed,
  isGitCommitCommand,
  isSafePreExplorerRead,
  markCheckpointVerified,
  plannerGuardMessage,
  readCheckpointState,
  readCheckpointStateOrMigrationError,
  recordAutoCheckpoint,
  shouldAutoEscalate,
  validateCommitCheckpoints,
  validatePlannerCheckpoint,
  verifierGuardMessage,
  writeCheckpointState,
} from "../../src/orchestration.js";
import {
  registerGedMessageRenderer,
  registerPiCommands,
} from "../../src/pi.js";
import { registerPlanReviewTool } from "../../src/plan-review.js";
import { ensureBundledPromptTemplates } from "../../src/prompt-template-sync.js";
import {
  buildRepoMapPromptSuffix,
  registerRepoMapTracking,
  warmRepoMap,
} from "../../src/repo-map-runtime.js";
import {
  refreshRtkStatusIndicator,
  registerRtkBashRouting,
} from "../../src/rtk.js";
import { ensurePiSettings, formatGedStatus } from "../../src/theme.js";
import { registerUpdater } from "../../src/updater.js";
import type { CheckpointAgent } from "../../src/vendor/shared-checkpoints.js";
import { registerGedWorkRuntime } from "../../src/work-runtime.js";
import { buildOnboardingInterviewKickoff } from "../../src/workflow.js";
import { registerGhostlightUi } from "./ghostlight-ui.js";

// ─── Session-level touched-files tracking ──────────────────────────
const touchedSourceFiles = new Set<string>();
let activeCwd: string | undefined;

type GedSubagentCompletion = {
  name: string;
  status: "completed" | "failed";
  metadata?: Record<string, unknown>;
};

async function recordGedSubagentCheckpoint(
  cwd: string,
  subagentName: string,
  status: "completed" | "failed" = "completed",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  let state = await readCheckpointState(cwd);
  if (!state) {
    state = {
      schemaVersion: 3,
      lifecycleStatus: "active",
      classification: "non-trivial",
      classificationReason: "Subagent dispatched — auto-classified",
      planCheckpoints: {},
      taskCheckpoints: {},
    };
  }
  const isTaskAgent =
    subagentName === "ged-verifier" || subagentName === "ged-worker";
  const recorded = recordAutoCheckpoint(
    state,
    {
      agent: subagentName as CheckpointAgent,
      timestamp: new Date().toISOString(),
      status,
      ...metadata,
      // Verifiers start with blocksCommit: false until they report findings.
      // The agent adjudicates findings and the verifier re-runs with findings.
      blocksCommit: subagentName === "ged-verifier" ? undefined : undefined,
    },
    isTaskAgent ? "auto" : undefined,
  );
  const next =
    subagentName === "ged-verifier" && status === "completed"
      ? markCheckpointVerified(recorded)
      : recorded;
  await writeCheckpointState(cwd, next);
}

async function recordGedSubagentCompletions(
  cwd: string,
  completions: GedSubagentCompletion[],
): Promise<void> {
  const seen = new Set<string>();
  for (const completion of completions) {
    if (completion.name !== "ged-worker") {
      if (seen.has(completion.name)) continue;
      seen.add(completion.name);
    }
    await recordGedSubagentCheckpoint(
      cwd,
      completion.name,
      completion.status,
      completion.metadata,
    );
  }
}

function subagentCompletionRecords(
  raw: unknown,
  sourceMode: "foreground" | "async",
): GedSubagentCompletion[] {
  const result = raw as {
    agent?: unknown;
    success?: unknown;
    status?: unknown;
    state?: unknown;
    exitCode?: unknown;
    error?: unknown;
    detached?: unknown;
    interrupted?: unknown;
    timedOut?: unknown;
    stopped?: unknown;
    turnBudgetExceeded?: unknown;
    structuredOutputFailed?: unknown;
    structuredOutput?: unknown;
    acceptance?: { status?: unknown };
    progress?: { status?: unknown };
    runId?: unknown;
    asyncId?: unknown;
    results?: Array<{
      agent?: unknown;
      success?: unknown;
      status?: unknown;
      state?: unknown;
      exitCode?: unknown;
      error?: unknown;
      detached?: unknown;
      interrupted?: unknown;
      timedOut?: unknown;
      stopped?: unknown;
      turnBudgetExceeded?: unknown;
      structuredOutputFailed?: unknown;
      structuredOutput?: unknown;
      acceptance?: { status?: unknown };
      progress?: { status?: unknown };
      runId?: unknown;
      taskId?: unknown;
      sliceId?: unknown;
      artifactPath?: unknown;
      artifactPaths?: unknown;
      diffPath?: unknown;
      sessionPath?: unknown;
      sessionFile?: unknown;
      worktreePath?: unknown;
      worktree?: unknown;
    }>;
  };
  const completions: GedSubagentCompletion[] = [];
  if (isSuccessfulSubagentResult(result) && typeof result.agent === "string") {
    const detected = detectSubagentDispatch("subagent", {
      agent: result.agent,
    });
    if (detected) {
      const metadata = completionMetadata(
        detected,
        result as Record<string, unknown>,
        result as Record<string, unknown>,
        sourceMode,
      );
      if (metadata !== null) {
        completions.push({
          name: detected,
          status: "completed",
          metadata,
        });
      }
    }
  }
  if (Array.isArray(result.results)) {
    for (const child of result.results) {
      if (
        !isSuccessfulSubagentResult(child) ||
        typeof child.agent !== "string"
      ) {
        continue;
      }
      const detected = detectSubagentDispatch("subagent", {
        agent: child.agent,
      });
      if (detected) {
        const metadata = completionMetadata(
          detected,
          child as Record<string, unknown>,
          result as Record<string, unknown>,
          sourceMode,
        );
        if (metadata === null) continue;
        completions.push({
          name: detected,
          status: "completed",
          metadata,
        });
      }
    }
  }
  return completions;
}

function cleanVerifierMetadata(
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const structuredOutput = result.structuredOutput;
  if (
    !structuredOutput ||
    typeof structuredOutput !== "object" ||
    Array.isArray(structuredOutput)
  ) {
    return null;
  }
  const output = structuredOutput as Record<string, unknown>;
  if (
    output.outcome !== "clean" ||
    !Array.isArray(output.findings) ||
    output.findings.length > 0
  ) {
    return null;
  }
  const acceptance = result.acceptance;
  const acceptanceStatus =
    acceptance && typeof acceptance === "object" && !Array.isArray(acceptance)
      ? (acceptance as Record<string, unknown>).status
      : undefined;
  return {
    verifierOutcome: "clean",
    findingCount: 0,
    ...(typeof acceptanceStatus === "string" ? { acceptanceStatus } : {}),
  };
}

function completionMetadata(
  agent: string,
  result: Record<string, unknown>,
  parent: Record<string, unknown>,
  sourceMode: "foreground" | "async",
): Record<string, unknown> | undefined | null {
  if (agent === "ged-verifier") {
    const verifier = cleanVerifierMetadata(result);
    return verifier ? { ...verifier, sourceMode } : null;
  }
  return workerMetadata(result, parent, sourceMode);
}

function stringField(
  primary: Record<string, unknown>,
  secondary: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = primary[key] ?? secondary[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function workerMetadata(
  result: Record<string, unknown>,
  parent: Record<string, unknown>,
  sourceMode: "foreground" | "async",
): Record<string, unknown> | undefined {
  const detected = detectSubagentDispatch("subagent", {
    agent: result.agent,
  });
  if (detected !== "ged-worker") return undefined;
  const artifactPaths =
    result.artifactPaths &&
    typeof result.artifactPaths === "object" &&
    !Array.isArray(result.artifactPaths)
      ? (result.artifactPaths as Record<string, unknown>)
      : undefined;
  const metadata: Record<string, unknown> = { sourceMode };
  const runId = stringField(result, parent, ["runId", "asyncId"]);
  if (runId) metadata.runId = runId;
  const taskId = stringField(result, parent, ["taskId"]);
  if (taskId) metadata.taskId = taskId;
  const sliceId = stringField(result, parent, ["sliceId"]);
  if (sliceId) metadata.sliceId = sliceId;
  const artifactPath = stringField(result, parent, ["artifactPath"]);
  const canonicalArtifactPath =
    typeof artifactPaths?.outputPath === "string"
      ? artifactPaths.outputPath
      : artifactPath;
  if (canonicalArtifactPath) metadata.artifactPath = canonicalArtifactPath;
  if (artifactPaths) metadata.artifactPaths = artifactPaths;
  const diffPath =
    stringField(result, parent, ["diffPath"]) ??
    (typeof artifactPaths?.diffPath === "string"
      ? artifactPaths.diffPath
      : undefined);
  if (diffPath) metadata.diffPath = diffPath;
  const sessionPath = stringField(result, parent, [
    "sessionPath",
    "sessionFile",
  ]);
  if (sessionPath) metadata.sessionPath = sessionPath;
  const worktreePath = stringField(result, parent, ["worktreePath"]);
  if (worktreePath) metadata.worktreePath = worktreePath;
  const worktree = result.worktree ?? parent.worktree;
  if (typeof worktree === "boolean") metadata.worktree = worktree;
  return metadata;
}

function isGedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  return normalized.startsWith(".ged/") || normalized.includes("/.ged/");
}

function isSafePreExplorerBashCommand(command: string): boolean {
  const normalized = command.replace(/\\\n/gu, " ").trim();
  if (!normalized) return false;
  if (/[;&|`]/u.test(normalized) || normalized.includes("$(")) return false;
  if (/^(?:bash|sh|zsh|fish)\s+(?:-[^\s]*\s+)*-?c\b/u.test(normalized)) {
    return false;
  }
  return /^git(?:\.(?:exe|cmd))?\s+(?:--no-pager\s+)?(?:status|branch|log|diff)(?:\s|$)/u.test(
    normalized,
  );
}

function isSuccessfulSubagentResult(result: {
  success?: unknown;
  status?: unknown;
  state?: unknown;
  exitCode?: unknown;
  error?: unknown;
  detached?: unknown;
  interrupted?: unknown;
  timedOut?: unknown;
  stopped?: unknown;
  turnBudgetExceeded?: unknown;
  structuredOutputFailed?: unknown;
  structuredOutput?: unknown;
  acceptance?: { status?: unknown };
  progress?: { status?: unknown };
}): boolean {
  if (
    result.detached === true ||
    result.interrupted === true ||
    result.timedOut === true ||
    result.stopped === true ||
    result.turnBudgetExceeded === true ||
    result.structuredOutputFailed === true ||
    result.acceptance?.status === "rejected" ||
    result.acceptance?.status === "pending" ||
    result.acceptance?.status === "claimed" ||
    result.acceptance?.status === "review-required" ||
    (typeof result.error === "string" && result.error.trim().length > 0)
  ) {
    return false;
  }
  if (
    result.progress?.status === "running" ||
    result.progress?.status === "pending" ||
    result.progress?.status === "paused" ||
    result.progress?.status === "detached"
  ) {
    return false;
  }
  if (
    result.status === "failed" ||
    result.status === "paused" ||
    result.status === "detached" ||
    result.status === "running" ||
    result.status === "pending"
  ) {
    return false;
  }
  if (
    result.state === "failed" ||
    result.state === "paused" ||
    result.state === "detached" ||
    result.state === "running" ||
    result.state === "pending"
  ) {
    return false;
  }
  if (typeof result.success === "boolean") return result.success;
  if (typeof result.exitCode === "number") return result.exitCode === 0;
  if (result.status === "completed") return true;
  if (result.state === "complete" || result.state === "completed") return true;
  return false;
}

function subagentForegroundCompletionRecords(
  details: unknown,
): GedSubagentCompletion[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return [];
  }
  const record = details as Record<string, unknown>;
  if (typeof record.asyncId === "string") return [];
  if (!Array.isArray(record.results)) return [];
  const completions: GedSubagentCompletion[] = [];
  for (const child of record.results) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const result = child as {
      agent?: unknown;
      success?: unknown;
      status?: unknown;
      state?: unknown;
      exitCode?: unknown;
      error?: unknown;
      detached?: unknown;
      interrupted?: unknown;
      timedOut?: unknown;
      stopped?: unknown;
      turnBudgetExceeded?: unknown;
      structuredOutputFailed?: unknown;
      structuredOutput?: unknown;
      acceptance?: { status?: unknown };
      progress?: { status?: unknown };
      runId?: unknown;
      taskId?: unknown;
      sliceId?: unknown;
      artifactPath?: unknown;
      artifactPaths?: unknown;
      diffPath?: unknown;
      sessionPath?: unknown;
      sessionFile?: unknown;
      worktreePath?: unknown;
      worktree?: unknown;
    };
    if (
      !isSuccessfulSubagentResult(result) ||
      typeof result.agent !== "string"
    ) {
      continue;
    }
    const detected = detectSubagentDispatch("subagent", {
      agent: result.agent,
    });
    if (detected) {
      const metadata = completionMetadata(
        detected,
        result as Record<string, unknown>,
        record,
        "foreground",
      );
      if (metadata === null) continue;
      completions.push({
        name: detected,
        status: "completed",
        metadata,
      });
    }
  }
  return completions;
}

export default async function gedCoreExtension(
  api: ExtensionAPI,
): Promise<void> {
  registerGedWorkRuntime(api);

  // Reset touched files on session start
  api.on("session_start", (_event, ctx) => {
    activeCwd = ctx.cwd;
    touchedSourceFiles.clear();
  });

  api.events?.on("subagents:completed", (raw: unknown) => {
    const event = raw as { type?: unknown };
    if (typeof event.type !== "string" || !activeCwd) return;
    const subagentName = detectSubagentDispatch("Agent", {
      subagent_type: event.type,
    });
    if (!subagentName || subagentName === "ged-verifier") return;
    void recordGedSubagentCheckpoint(activeCwd, subagentName).catch(() => {
      // Non-fatal — lifecycle events should not break the subagent runtime.
    });
  });

  api.events?.on("subagent:async-complete", (raw: unknown) => {
    if (!activeCwd) return;
    const completions = subagentCompletionRecords(raw, "async");
    if (completions.length === 0) return;
    void recordGedSubagentCompletions(activeCwd, completions).catch(() => {
      // Non-fatal — lifecycle events should not break the subagent runtime.
    });
  });

  registerGedMessageRenderer(api);
  registerPiCommands(api, createGedCommands());
  registerUpdater(api);
  registerRtkBashRouting(api);
  registerRepoMapTracking(api);
  registerPlanReviewTool(api);
  registerGhostlightUi(api);

  // ─── Session start ──────────────────────────────────────────────

  api.on("session_start", async (_event, ctx) => {
    await ensurePiSettings(ctx.cwd);
    await syncGedSubagentRuntimeConfig(
      ctx.cwd,
      ctx.modelRegistry
        ? {
            modelAvailability: {
              isAvailable(modelId) {
                const slashIndex = modelId.indexOf("/");
                if (slashIndex <= 0 || slashIndex === modelId.length - 1) {
                  return false;
                }
                const provider = modelId.slice(0, slashIndex);
                const id = modelId.slice(slashIndex + 1);
                return Boolean(ctx.modelRegistry.find(provider, id));
              },
            },
          }
        : undefined,
    );
    ensureBundledPromptTemplates(
      fileURLToPath(
        new URL("../../templates/managed-prompts", import.meta.url),
      ),
    );
    if (ctx.mode === "tui") {
      ctx.ui.setTitle("GedPi");
      ctx.ui.setHeader((_tui, theme) => renderHeader(theme));
      ctx.ui.setStatus("gedpi", formatGedStatus());
      await refreshRtkStatusIndicator(ctx);
    }
    void warmRepoMap(ctx.cwd);
  });

  // ─── Before agent start (system prompt injection) ───────────────

  api.on("before_agent_start", async (event, ctx) => {
    const passivePrompt = await buildPassiveGedPromptSuffix(ctx.cwd);
    const repoMapPrompt = await buildRepoMapPromptSuffix(ctx.cwd, {
      prompt: typeof event.prompt === "string" ? event.prompt : "",
    });

    const init = await ensureGedReady(ctx.cwd, {
      ui: "ui" in ctx ? ctx.ui : undefined,
    });
    const workflowPrompt = await buildWorkflowPromptSuffix(ctx.cwd);
    const onboardingKickoff = init.initResult?.onboardingInterviewNeeded
      ? buildOnboardingInterviewKickoff(init.initResult)
      : "";
    const prompt = [
      event.systemPrompt,
      passivePrompt,
      workflowPrompt,
      repoMapPrompt,
      onboardingKickoff,
    ]
      .filter(Boolean)
      .join("\n\n");

    if (init.initResult?.standardsPromptNeeded) {
      api.sendMessage({
        customType: "ged-update",
        content:
          "Ged found external instruction files that can be imported into .ged/STANDARDS.md. Please confirm in chat whether Ged should keep those standards.",
        display: true,
        details: { title: "ged-init" },
      });
    }

    return {
      systemPrompt: prompt,
    };
  });

  // ─── Tool call interception (hard guards) ───────────────────────

  api.on("tool_call", async (event, ctx) => {
    const input =
      event.input && typeof event.input === "object"
        ? (event.input as Record<string, unknown>)
        : {};
    const toolName =
      typeof event.toolName === "string"
        ? event.toolName
        : typeof input.toolName === "string"
          ? input.toolName
          : "";

    // Subagent orchestration is the only thing these guards enforce. When
    // subagents are disabled, the workflow runs solo (see BRAIN_SYSTEM_APPEND_SOLO)
    // and never mentions ged-explorer/ged-planner/ged-verifier or checkpoints —
    // so the guards must stay inert. Otherwise the runtime would block work and
    // demand subagent dispatches that don't exist in solo mode.
    const agentSettings = await readEffectiveGedAgentsSettings(ctx.cwd).catch(
      () => null,
    );
    if (!agentSettings?.enabled) {
      return;
    }

    // --- Explorer-first guard: block source inspection before explorer runs ---
    // Non-trivial work must dispatch ged-explorer before reading source files.
    // Only .md and .ged/ reads are allowed before explorer completes.
    const sourceInspectingTool =
      toolName === "read" ||
      toolName === "grep" ||
      toolName === "find" ||
      (toolName === "bash" &&
        typeof (input as Record<string, unknown>).command === "string" &&
        !isSafePreExplorerBashCommand(
          (input as Record<string, unknown>).command as string,
        ));

    if (sourceInspectingTool) {
      const state = await readCheckpointState(ctx.cwd);
      if (
        state &&
        (state.classification === "non-trivial" || isCheckpointClosed(state))
      ) {
        // Check if explorer has cleared source inspection
        if (!hasExplorerClearedInspection(state)) {
          // Allow .md files and .ged/ paths unconditionally
          const targetPath =
            toolName === "read" || toolName === "grep"
              ? String(
                  (input as Record<string, unknown>).filePath ??
                    (input as Record<string, unknown>).path ??
                    "",
                )
              : "";
          if (!targetPath || !isSafePreExplorerRead(targetPath)) {
            api.sendMessage({
              customType: "ged-checkpoint-blocked",
              content: isCheckpointClosed(state)
                ? "GedPi checkpoint guard: previous task is closed. Classify the current task first before inspecting source files. Only .md and .ged/ files may be read for recovery."
                : "GedPi explorer-first guard: for non-trivial work, source file inspection (read/grep/find) is blocked until ged-explorer has completed its initial reconnaissance. Recovery: dispatch ged-explorer with the subagent tool now, wait for the result, then continue the workflow. Only .md and .ged/ files may be read before explorer runs.",
              display: true,
              details: {
                title: "explorer-first-guard",
                missing: ["ged-explorer (auto-recorded)"],
              },
            });
            return {
              block: true,
              reason: isCheckpointClosed(state)
                ? "GedPi checkpoint guard: classify the current task before inspecting source files."
                : "GedPi explorer-first guard: dispatch ged-explorer with subagent now, wait for the result, then continue before inspecting source files.",
            };
          }
        }
      }
    }
    if (toolName === "write" || toolName === "edit") {
      const filePath = String(
        (input as Record<string, unknown>).filePath ??
          (input as Record<string, unknown>).path ??
          "",
      );
      // Allow .ged/ writes unconditionally
      if (isGedPath(filePath)) {
        return;
      }

      let state = await readCheckpointState(ctx.cwd);

      // Check for legacy schema that needs migration
      if (!state) {
        const { migrationError } = await readCheckpointStateOrMigrationError(
          ctx.cwd,
        );
        if (migrationError) {
          api.sendMessage({
            customType: "ged-checkpoint-blocked",
            content: `GedPi planner guard: ${migrationError}`,
            display: true,
            details: {
              title: "planner-guard",
              missing: ["schema-migration"],
            },
          });
          return {
            block: true,
            reason: `GedPi planner guard: ${migrationError}`,
          };
        }
      }

      // Auto-escalation: if classified as trivial but touching >1 source file,
      // reclassify to non-trivial and persist. This triggers the planner guard
      // on subsequent writes until ged-planner is dispatched. Closed checkpoints
      // must not be mutated; validation below reports the recovery path.
      if (state?.classification === "trivial" && !isCheckpointClosed(state)) {
        touchedSourceFiles.add(filePath);
        if (shouldAutoEscalate(state.classification, [...touchedSourceFiles])) {
          state = {
            ...state,
            classification: "non-trivial",
            classificationReason:
              "Auto-escalated: >1 source file touched in this session",
          };
          await writeCheckpointState(ctx.cwd, state);
        }
      }

      const validation = validatePlannerCheckpoint(state);
      if (!validation.valid) {
        const message = plannerGuardMessage(validation);
        api.sendMessage({
          customType: "ged-checkpoint-blocked",
          content: message,
          display: true,
          details: { title: "planner-guard", missing: validation.missing },
        });
        return { block: true, reason: message };
      }

      // Invalidate verifier checkpoints: any source edit makes prior
      // verifier reviews stale. Forces re-verification before commit.
      if (state) {
        const invalidated = invalidateVerifierCheckpoints(state);
        if (invalidated !== state) {
          await writeCheckpointState(ctx.cwd, invalidated);
        }
      }
    }

    // --- Verifier guard: block git commit ---
    if (toolName === "bash") {
      const command = input.command;
      if (typeof command === "string" && isGitCommitCommand(command)) {
        // Check for bypass marker — only effective if settings allow it
        if (hasSkipCheckpointMarker(command)) {
          const settings = await readEffectiveGedAgentsSettings(ctx.cwd).catch(
            () => null,
          );
          if (settings?.allowCheckpointBypass) {
            return; // Allow through
          }
        }

        const state = await readCheckpointState(ctx.cwd);
        const validation = validateCommitCheckpoints(state);
        if (!validation.valid) {
          api.sendMessage({
            customType: "ged-checkpoint-blocked",
            content: verifierGuardMessage(validation),
            display: true,
            details: { title: "verifier-guard", missing: validation.missing },
          });
          return { block: true, reason: verifierGuardMessage(validation) };
        }

        // Closing happens in the tool_result handler after the bash tool succeeds.
      }
    }
  });

  api.on("tool_result", async (event, ctx) => {
    if (event.toolName === "subagent" && !event.isError) {
      const completions = subagentForegroundCompletionRecords(event.details);
      if (completions.length > 0) {
        await recordGedSubagentCompletions(ctx.cwd, completions);
      }
    }

    if (event.toolName === "subagent_wait" && !event.isError) {
      const details = event.details as { completions?: unknown[] } | undefined;
      for (const completion of details?.completions ?? []) {
        const completions = subagentCompletionRecords(completion, "async");
        if (completions.length > 0) {
          await recordGedSubagentCompletions(ctx.cwd, completions);
        }
      }
    }

    if (event.toolName !== "bash" || event.isError) return;
    const input = event.input as Record<string, unknown>;
    const command = input.command;
    if (typeof command !== "string" || !isGitCommitCommand(command)) return;
    const state = await readCheckpointState(ctx.cwd);
    if (!state) return;
    const validation = validateCommitCheckpoints(state);
    if (!validation.valid) return;
    const consumed =
      state.classification === "non-trivial"
        ? consumePlannerCheckpoint(state)
        : state;
    await writeCheckpointState(ctx.cwd, closeCheckpointState(consumed));
  });

  // ─── Turn end post-hoc checkpoint warning removed ───────────────
  // The commit guard (tool_call handler for git commit) is the real
  // enforcement — it blocks commits before execution. Post-hoc
  // turn_end validation produces false positives because source edits
  // after a valid commit invalidate verifier checkpoints, making past
  // valid commits appear unverified.
}
