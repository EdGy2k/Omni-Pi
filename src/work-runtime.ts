import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  captureRepositorySnapshot,
  changedPathsBetween,
  fingerprintFileSet,
  type RepositorySnapshot,
  snapshotsEqual,
} from "./content-fingerprint.js";
import {
  type ActiveWorkPointer,
  bindGedWork,
  clearActiveWorkSession,
  continueGedWork,
  ensureActiveGedWork,
  gedPathsForWorkId,
  isActiveWorkBoundToRequest,
  type OpenedGedWork,
  openGedWork,
  relativeGedPath,
  setActiveWorkSession,
  type WorkRequestIdentity,
} from "./ged-paths.js";
import {
  type ExecutionProfile,
  type GovernanceEvidence,
  type GovernanceWorkState,
  type Risk,
  resolveGovernance,
} from "./governance.js";
import {
  appendGovernanceEvidence,
  beginGovernanceCommit,
  beginGovernanceMutation,
  clearGovernanceCommit,
  clearGovernanceMutation,
  completeGovernanceCommit,
  completeGovernanceMutation,
  governanceMutationBlockReason,
  initializeGovernanceState,
  readGovernanceState,
  recordSatisfiedGovernanceEvidence,
  transitionGovernanceLifecycle,
} from "./governance-store.js";
import { ensureLegacyCheckpointMigration } from "./legacy-migration.js";
import { isGitCommitCommand } from "./orchestration.js";
import { staffingDispatchInspection } from "./staffing.js";
import {
  acquireCheckoutWriterLease,
  activateCheckoutWriterLease,
  releaseCheckoutWriterLease,
  terminalCheckoutWriterLease,
} from "./writer-lease.js";

interface ActiveRequest extends WorkRequestIdentity {
  cwd: string;
  workId?: string;
}

interface PendingMutation {
  requestKey: string;
  workId: string;
  pendingId: string;
  summary: string;
  before: RepositorySnapshot;
}

interface PendingCommit {
  requestKey: string;
  workId: string;
  pendingId: string;
  before: RepositorySnapshot;
  expectedTree: string;
  verifiedSnapshotDigest: string;
}

interface PendingWriterLaunch {
  requestKey: string;
  cwd: string;
  sessionId: string;
  mutationKey: string;
  leaseId: string;
}

interface ActiveWriterRun extends PendingWriterLaunch {
  runId: string;
}

export interface GedWorkRuntimeOptions {
  createRequestId?: () => string;
  captureSnapshot?: (cwd: string) => Promise<RepositorySnapshot>;
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

interface VerificationCheckParams {
  command: string;
  args: string[];
}

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_OUTPUT = 8_000;

function workTransitionPrompt(pointer: ActiveWorkPointer): string {
  const priorWork =
    pointer.operation === "bootstrap"
      ? "There is no prior generated work item selected for continuation."
      : `The prior session selection is ${pointer.workId}; it is not authorized for this request until explicitly continued.`;
  return `## Current-request work selection

${priorWork}

Before repository mutation, call ged_work in a separate tool batch. Open new work with a concise summary plus structured ambiguity, risk, minimum mode, and direct-change evidence. Continue only the exact work ID when the user is continuing that task.

Read-only work needs no selection and must not mutate. Planned-change work may write bound .ged planning artifacts before acceptance; source mutation requires ged_governance accept-plan and unchanged accepted bytes. Stage only observed work-scope paths, then call record-verification with argv-based checks before committing the exact verified snapshot. Use ged_lifecycle with an exact work ID to pause, resume, complete, abandon, or supersede work; commits never change lifecycle. Run each transition in its own tool batch.`;
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

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "view_image",
  "web_search",
  "fetch_content",
  "get_search_content",
  "gedpi_plan_review",
]);
const GOVERNANCE_TOOLS = new Set([
  "ged_work",
  "ged_governance",
  "ged_lifecycle",
]);

function isAuditedReadOnlyBash(command: string): boolean {
  const normalized = command.replace(/\\\n/gu, " ").trim();
  if (
    !normalized ||
    /[;&|`<>\n]/u.test(normalized) ||
    normalized.includes("$(") ||
    /(?:^|\s)(?:--output(?:=|\s)|-o(?:\s|$))/u.test(normalized)
  ) {
    return false;
  }
  return /^(?:pwd|ls|rg|grep|cat|head|tail|wc|stat|file)(?:\s|$)/u.test(
    normalized,
  );
}

function latestEvidence(
  state: GovernanceWorkState,
  kind: GovernanceEvidence["kind"],
): GovernanceEvidence | null {
  for (let index = state.evidence.length - 1; index >= 0; index -= 1) {
    const entry = state.evidence[index];
    if (entry?.kind === kind) return entry;
  }
  return null;
}

function observedScopePaths(state: GovernanceWorkState): string[] {
  const paths = state.evidence.flatMap((entry) =>
    entry.kind === "implementation" &&
    entry.binding?.type === "mutation-content"
      ? entry.binding.changedPaths
      : entry.kind === "milestone" && entry.binding?.type === "commit-milestone"
        ? ["@HEAD"]
        : [],
  );
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

async function planBindingBlockReason(
  rootDir: string,
  state: GovernanceWorkState,
): Promise<string | null> {
  if (state.decision.mode !== "planned-change") return null;
  const plan = latestEvidence(state, "plan");
  if (plan?.outcome !== "satisfied" || plan.binding?.type !== "plan-content") {
    return `Ged work ${state.workId} has no content-bound accepted plan.`;
  }
  const paths = gedPathsForWorkId(rootDir, state.workId);
  const current = await fingerprintFileSet(rootDir, [
    paths.specPath,
    paths.tasksPath,
    paths.testsPath,
  ]);
  if (
    current.digest !== plan.binding.digest ||
    JSON.stringify(current.paths) !== JSON.stringify(plan.binding.paths)
  ) {
    return `Ged work ${state.workId} plan bytes changed after acceptance; accept the current plan again.`;
  }
  return null;
}

function verifiedContent(state: GovernanceWorkState) {
  const verification = latestEvidence(state, "verification");
  return verification?.outcome === "satisfied" &&
    verification.binding?.type === "verification-content"
    ? verification.binding
    : null;
}

function commitCommandBlockReason(command: string): string | null {
  if (/[;&|`<>\n$*?[\]{}\\]/u.test(command)) {
    return "GedPi commit guard: compound commit commands are not allowed.";
  }
  if (
    /\bgit(?:\s+-[^\s]+)*\s+commit\b[^\n]*(?:\s-[^-\s]*a[^\s]*|\s--all\b)/u.test(
      command,
    )
  ) {
    return "GedPi commit guard: commit commands may not stage content with -a/--all.";
  }
  return null;
}

function isPotentialGitCommit(command: string): boolean {
  return (
    isGitCommitCommand(command) ||
    /(?:^|[\s/])git(?:\.exe|\.cmd)?[^\n]*\bcommit\b/iu.test(command)
  );
}

async function runVerificationCheck(
  cwd: string,
  check: VerificationCheckParams,
) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(check.command, check.args, {
      cwd,
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      command: check.command,
      args: check.args,
      exitCode: 0,
      stdout: String(stdout).slice(-MAX_EVIDENCE_OUTPUT),
      stderr: String(stderr).slice(-MAX_EVIDENCE_OUTPUT),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const failure = error as Error & {
      code?: string | number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      command: check.command,
      args: check.args,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: String(failure.stdout ?? "").slice(-MAX_EVIDENCE_OUTPUT),
      stderr: String(failure.stderr ?? failure.message).slice(
        -MAX_EVIDENCE_OUTPUT,
      ),
      durationMs: Date.now() - startedAt,
    };
  }
}

export function registerGedWorkRuntime(
  api: ExtensionAPI,
  options: GedWorkRuntimeOptions = {},
): void {
  const createRequestId = options.createRequestId ?? randomUUID;
  const captureSnapshot = options.captureSnapshot ?? captureRepositorySnapshot;
  const activeRequests = new Map<string, ActiveRequest>();
  const pendingMutations = new Map<string, PendingMutation>();
  const pendingCommits = new Map<string, PendingCommit>();
  const pendingWriterLaunches = new Map<string, PendingWriterLaunch>();
  const activeWriterRuns = new Map<string, ActiveWriterRun>();

  const requestState = (cwd: string, sessionId: string) => {
    const key = activeRequestKey(cwd, sessionId);
    return { key, request: activeRequests.get(key) };
  };

  const clearPendingFor = (requestKey: string) => {
    for (const [toolCallId, pending] of pendingMutations) {
      if (pending.requestKey === requestKey)
        pendingMutations.delete(toolCallId);
    }
    for (const [toolCallId, pending] of pendingCommits) {
      if (pending.requestKey === requestKey) pendingCommits.delete(toolCallId);
    }
    for (const [toolCallId, pending] of pendingWriterLaunches) {
      if (pending.requestKey === requestKey)
        pendingWriterLaunches.delete(toolCallId);
    }
  };

  const reconcilePendingCommit = async (cwd: string, workId: string) => {
    const state = await readGovernanceState(cwd, workId);
    for (const pending of state.pendingCommits ?? []) {
      const snapshot = await captureSnapshot(cwd);
      if (snapshot.head === pending.beforeHead) {
        await clearGovernanceCommit(cwd, workId, pending.id);
        continue;
      }
      if (
        snapshot.head &&
        snapshot.headTree === pending.expectedTree &&
        snapshot.stagedPaths.length === 0 &&
        snapshot.unstagedDigest === pending.unstagedDigest &&
        snapshot.untrackedDigest === pending.untrackedDigest &&
        (state.pendingMutations?.length ?? 0) === 0
      ) {
        await completeGovernanceCommit(cwd, workId, pending.id, {
          id: `milestone-${randomUUID()}`,
          kind: "milestone",
          source: "runtime",
          recordedAt: new Date().toISOString(),
          summary: `Recovered commit advancement from ${pending.beforeHead ?? "unborn"} to ${snapshot.head}.`,
          outcome: "observed",
          binding: {
            type: "commit-milestone",
            beforeHead: pending.beforeHead,
            afterHead: snapshot.head,
            committedTree: pending.expectedTree,
            verifiedSnapshotDigest: pending.verifiedSnapshotDigest,
          },
        });
        continue;
      }
      throw new Error(
        `Ged work ${workId} has an unproven commit whose resulting tree does not match verified staged content.`,
      );
    }
  };

  const reconcileTerminalWriterLease = async (cwd: string): Promise<void> => {
    const lease = await terminalCheckoutWriterLease(cwd);
    if (!lease) return;
    if (
      [...activeWriterRuns.values()].some((entry) => entry.leaseId === lease.id)
    ) {
      return;
    }
    const state = await readGovernanceState(cwd, lease.workId);
    const hasPending = (state.pendingMutations ?? []).some(
      (entry) => entry.id === lease.pendingMutationId,
    );
    if (hasPending) {
      const after = await captureSnapshot(cwd);
      if (snapshotsEqual(lease.beforeSnapshot, after)) {
        await clearGovernanceMutation(
          cwd,
          lease.workId,
          lease.pendingMutationId,
        );
      } else {
        await completeGovernanceMutation(
          cwd,
          lease.workId,
          lease.pendingMutationId,
          {
            id: `implementation-${randomUUID()}`,
            kind: "implementation",
            source: "runtime",
            recordedAt: new Date().toISOString(),
            summary: `Reconciled changed content after terminal async writer ${lease.runId ?? lease.id}.`,
            outcome: "observed",
            binding: {
              type: "mutation-content",
              beforeDigest: lease.beforeSnapshot.digest,
              afterDigest: after.digest,
              changedPaths: changedPathsBetween(lease.beforeSnapshot, after),
            },
          },
        );
      }
    }
    for (const [key, pending] of pendingMutations) {
      if (pending.pendingId === lease.pendingMutationId) {
        pendingMutations.delete(key);
      }
    }
    await releaseCheckoutWriterLease(cwd, lease.id);
  };

  const finalizeActiveWriter = async (payload: unknown): Promise<void> => {
    if (!payload || typeof payload !== "object") return;
    const record = payload as Record<string, unknown>;
    const runId =
      typeof record.runId === "string"
        ? record.runId
        : typeof record.id === "string"
          ? record.id
          : undefined;
    if (!runId) return;
    const writer = activeWriterRuns.get(runId);
    if (!writer) {
      if (typeof record.cwd === "string") {
        await reconcileTerminalWriterLease(record.cwd);
      }
      return;
    }
    const pending = pendingMutations.get(writer.mutationKey);
    if (!pending) {
      await releaseCheckoutWriterLease(writer.cwd, writer.leaseId);
      activeWriterRuns.delete(runId);
      return;
    }
    const after = await captureSnapshot(writer.cwd);
    if (snapshotsEqual(pending.before, after)) {
      await clearGovernanceMutation(
        writer.cwd,
        pending.workId,
        pending.pendingId,
      );
    } else {
      const failed =
        record.success === false ||
        record.state === "failed" ||
        record.state === "stopped";
      await completeGovernanceMutation(
        writer.cwd,
        pending.workId,
        pending.pendingId,
        {
          id: `implementation-${randomUUID()}`,
          kind: "implementation",
          source: "runtime",
          recordedAt: new Date().toISOString(),
          summary: `${failed ? "Observed changed content after failed" : "Observed changed content after"} async writer ${runId}.`,
          outcome: "observed",
          binding: {
            type: "mutation-content",
            beforeDigest: pending.before.digest,
            afterDigest: after.digest,
            changedPaths: changedPathsBetween(pending.before, after),
          },
        },
      );
    }
    pendingMutations.delete(writer.mutationKey);
    await releaseCheckoutWriterLease(writer.cwd, writer.leaseId);
    activeWriterRuns.delete(runId);
  };

  api.events?.on("subagent:async-started", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const record = payload as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.asyncDir !== "string" ||
      !path.isAbsolute(record.asyncDir) ||
      typeof record.cwd !== "string" ||
      typeof record.sessionId !== "string"
    ) {
      return;
    }
    const launching = [...pendingWriterLaunches.values()].find(
      (entry) =>
        entry.cwd === record.cwd && entry.sessionId === record.sessionId,
    );
    if (!launching) return;
    return activateCheckoutWriterLease(
      launching.cwd,
      launching.leaseId,
      record.id,
      record.asyncDir,
    ).catch((error) => {
      console.error(
        `GedPi could not activate async-started writer lease: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  api.events?.on("subagent:async-complete", (payload) => {
    return finalizeActiveWriter(payload).catch((error) => {
      console.error(
        `GedPi could not finalize async writer evidence: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  api.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const key = activeRequestKey(ctx.cwd, sessionId);
    setActiveWorkSession(ctx.cwd, sessionId);
    activeRequests.delete(key);
    await ensureLegacyCheckpointMigration(ctx.cwd);
    await reconcileTerminalWriterLease(ctx.cwd);
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
    const staffing = staffingDispatchInspection(
      event.toolName,
      event.input as Record<string, unknown>,
    );
    if (staffing.reason) return { block: true, reason: staffing.reason };
    if (
      staffing.writesCurrentCheckout &&
      ([...pendingWriterLaunches.values()].some(
        (entry) => entry.cwd === ctx.cwd,
      ) ||
        [...activeWriterRuns.values()].some((entry) => entry.cwd === ctx.cwd))
    ) {
      return {
        block: true,
        reason:
          "Ged staffing guard blocks another writer while a current-checkout writer launch or run is active. Wait for completion or use managed worktree isolation.",
      };
    }
    const bashCommand =
      event.toolName === "bash" &&
      event.input &&
      typeof event.input === "object" &&
      typeof (event.input as { command?: unknown }).command === "string"
        ? (event.input as { command: string }).command
        : null;
    if (
      GOVERNANCE_TOOLS.has(event.toolName) ||
      READ_ONLY_TOOLS.has(event.toolName) ||
      (bashCommand !== null && isAuditedReadOnlyBash(bashCommand))
    ) {
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const { key, request: activeRequest } = requestState(ctx.cwd, sessionId);
    if (!activeRequest?.workId) {
      return { block: true, reason: bindingBlockReason() };
    }
    try {
      if (staffing.writesCurrentCheckout) {
        await reconcileTerminalWriterLease(ctx.cwd);
      }
      if (
        !(await isActiveWorkBoundToRequest(
          ctx.cwd,
          { sessionId, requestId: activeRequest.requestId },
          activeRequest.workId,
        ))
      ) {
        return { block: true, reason: bindingBlockReason() };
      }
      const isFileMutation =
        event.toolName === "write" || event.toolName === "edit";
      const filePath = isFileMutation
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
      const isCommit =
        bashCommand !== null && isPotentialGitCommit(bashCommand);
      const action = isCommit
        ? "commit"
        : gedPathKind === "metadata"
          ? "metadata-mutation"
          : "source-mutation";
      const state = await readGovernanceState(ctx.cwd, activeRequest.workId);
      if (!state.contentBaseline) {
        return {
          block: true,
          reason: `GedPi work guard: Ged work ${activeRequest.workId} predates content-bound governance. Open new work before mutation.`,
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
      if (action !== "metadata-mutation") {
        const planReason = await planBindingBlockReason(ctx.cwd, state);
        if (planReason) {
          return { block: true, reason: `GedPi work guard: ${planReason}` };
        }
      }

      const lookupKey = pendingMutationKey(
        key,
        activeRequest.requestId,
        event.toolCallId,
      );
      if (isCommit) {
        const commandReason = commitCommandBlockReason(bashCommand);
        if (commandReason) return { block: true, reason: commandReason };
        const verification = verifiedContent(state);
        if (!verification) {
          return {
            block: true,
            reason:
              "GedPi commit guard: latest verification is not content-bound.",
          };
        }
        const current = await captureSnapshot(ctx.cwd);
        if (!snapshotsEqual(current, verification.snapshot)) {
          return {
            block: true,
            reason:
              "GedPi commit guard: repository content differs from the verified snapshot.",
          };
        }
        const scope = new Set(verification.scopePaths);
        const unrelated = current.stagedPaths.filter(
          (entry) => !scope.has(entry),
        );
        if (unrelated.length > 0) {
          return {
            block: true,
            reason: `GedPi commit guard: unrelated staged paths are outside work scope: ${unrelated.join(", ")}`,
          };
        }
        if (
          current.stagedPaths.length === 0 &&
          !/\bgit(?:\s+-[^\s]+)*\s+commit\b[^\n]*\s--amend\b/u.test(bashCommand)
        ) {
          return {
            block: true,
            reason: "GedPi commit guard: no verified work paths are staged.",
          };
        }
        if (!current.indexTree) {
          return {
            block: true,
            reason:
              "GedPi commit guard: unable to derive the verified index tree.",
          };
        }
        const pendingId = `commit-${randomUUID()}`;
        await beginGovernanceCommit(ctx.cwd, activeRequest.workId, {
          id: pendingId,
          requestId: activeRequest.requestId,
          toolCallId: event.toolCallId,
          beforeHead: current.head,
          expectedTree: current.indexTree,
          unstagedDigest: current.unstagedDigest,
          untrackedDigest: current.untrackedDigest,
          verifiedSnapshotDigest: verification.snapshot.digest,
          startedAt: new Date().toISOString(),
        });
        pendingCommits.set(lookupKey, {
          requestKey: key,
          workId: activeRequest.workId,
          pendingId,
          before: current,
          expectedTree: current.indexTree,
          verifiedSnapshotDigest: verification.snapshot.digest,
        });
        return;
      }

      if (pendingMutations.has(lookupKey)) {
        return {
          block: true,
          reason:
            "GedPi governance guard: this tool call ID already has a pending mutation.",
        };
      }
      const before = await captureSnapshot(ctx.cwd);
      const pendingId = `mutation-${randomUUID()}`;
      const writerLease = staffing.writesCurrentCheckout
        ? await acquireCheckoutWriterLease(ctx.cwd, {
            sessionId,
            requestId: activeRequest.requestId,
            toolCallId: event.toolCallId,
            workId: activeRequest.workId,
            pendingMutationId: pendingId,
            beforeSnapshot: before,
          })
        : undefined;
      try {
        await beginGovernanceMutation(
          ctx.cwd,
          activeRequest.workId,
          {
            id: pendingId,
            requestId: activeRequest.requestId,
            toolCallId: event.toolCallId,
            target: filePath || `${event.toolName} repository capability`,
            startedAt: new Date().toISOString(),
          },
          action === "metadata-mutation"
            ? "metadata-mutation"
            : "source-mutation",
        );
      } catch (error) {
        if (writerLease) {
          await releaseCheckoutWriterLease(ctx.cwd, writerLease.id);
        }
        throw error;
      }
      pendingMutations.set(lookupKey, {
        requestKey: key,
        workId: activeRequest.workId,
        pendingId,
        summary: `${event.toolName} ${filePath || "repository capability"}`,
        before,
      });
      if (staffing.writesCurrentCheckout) {
        pendingWriterLaunches.set(lookupKey, {
          requestKey: key,
          cwd: ctx.cwd,
          sessionId,
          mutationKey: lookupKey,
          leaseId: writerLease?.id as string,
        });
      }
    } catch (error) {
      return {
        block: true,
        reason: `GedPi governance guard failed closed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  api.on("tool_result", async (event, ctx) => {
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
    const writerLaunch = pendingWriterLaunches.get(pendingKey);
    if (writerLaunch) {
      pendingWriterLaunches.delete(pendingKey);
      const details =
        event.details && typeof event.details === "object"
          ? (event.details as Record<string, unknown>)
          : {};
      const runId =
        typeof details.asyncId === "string"
          ? details.asyncId
          : typeof details.runId === "string" && details.mode === "async"
            ? details.runId
            : undefined;
      if (!event.isError && runId) {
        activeWriterRuns.set(runId, { ...writerLaunch, runId });
        const asyncDir =
          typeof details.asyncDir === "string" ? details.asyncDir : undefined;
        if (!asyncDir || !path.isAbsolute(asyncDir)) {
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: "GedPi writer lease remained fail-closed because the async launch did not return an absolute asyncDir.",
              },
            ],
            isError: true,
          };
        }
        try {
          await activateCheckoutWriterLease(
            writerLaunch.cwd,
            writerLaunch.leaseId,
            runId,
            asyncDir,
          );
        } catch (error) {
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: `GedPi could not persist the active writer lease: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
        return;
      }
      await releaseCheckoutWriterLease(writerLaunch.cwd, writerLaunch.leaseId);
    }

    const commit = pendingCommits.get(pendingKey);
    if (commit) {
      try {
        const after = await captureSnapshot(ctx.cwd);
        const currentState = await readGovernanceState(ctx.cwd, commit.workId);
        if (
          after.head &&
          commit.before.head !== after.head &&
          after.headTree === commit.expectedTree &&
          after.stagedPaths.length === 0 &&
          after.unstagedDigest === commit.before.unstagedDigest &&
          after.untrackedDigest === commit.before.untrackedDigest &&
          (currentState.pendingMutations?.length ?? 0) === 0
        ) {
          await completeGovernanceCommit(
            ctx.cwd,
            commit.workId,
            commit.pendingId,
            {
              id: `milestone-${randomUUID()}`,
              kind: "milestone",
              source: "runtime",
              recordedAt: new Date().toISOString(),
              summary: `Commit advanced HEAD from ${commit.before.head ?? "unborn"} to ${after.head}.`,
              outcome: "observed",
              binding: {
                type: "commit-milestone",
                beforeHead: commit.before.head,
                afterHead: after.head,
                committedTree: commit.expectedTree,
                verifiedSnapshotDigest: commit.verifiedSnapshotDigest,
              },
            },
          );
          pendingCommits.delete(pendingKey);
          return;
        }
        if (after.head === commit.before.head) {
          await clearGovernanceCommit(ctx.cwd, commit.workId, commit.pendingId);
          pendingCommits.delete(pendingKey);
        } else {
          pendingCommits.delete(pendingKey);
        }
        if (!event.isError) {
          return {
            content: [
              ...event.content,
              {
                type: "text" as const,
                text: "GedPi did not record a commit milestone because HEAD did not advance cleanly.",
              },
            ],
            isError: true,
          };
        }
        return;
      } catch (error) {
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `GedPi commit evidence failed closed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    const pending = pendingMutations.get(pendingKey);
    if (!pending) return;
    try {
      const after = await captureSnapshot(ctx.cwd);
      if (snapshotsEqual(pending.before, after)) {
        await clearGovernanceMutation(
          ctx.cwd,
          pending.workId,
          pending.pendingId,
        );
      } else {
        await completeGovernanceMutation(
          ctx.cwd,
          pending.workId,
          pending.pendingId,
          {
            id: `implementation-${randomUUID()}`,
            kind: "implementation",
            source: "runtime",
            recordedAt: new Date().toISOString(),
            summary: `${event.isError ? "Observed changed content after failed" : "Observed changed content after"} ${pending.summary}`,
            outcome: "observed",
            binding: {
              type: "mutation-content",
              beforeDigest: pending.before.digest,
              afterDigest: after.digest,
              changedPaths: changedPathsBetween(pending.before, after),
            },
          },
        );
      }
      pendingMutations.delete(pendingKey);
    } catch (error) {
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `GedPi could not persist content-bound mutation evidence: ${error instanceof Error ? error.message : String(error)}`,
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
        const contentBaseline = await captureSnapshot(ctx.cwd);
        state = await initializeGovernanceState(ctx.cwd, opened.workId, {
          decision: governance.decision,
          executionProfile: governance.executionProfile,
          contentBaseline,
        });
        opened = await bindGedWork(ctx.cwd, identity, opened.workId, "open");
      } else {
        const workId = params.workId ?? "";
        await reconcilePendingCommit(ctx.cwd, workId);
        const governanceReason = await governanceMutationBlockReason(
          ctx.cwd,
          workId,
          "metadata-mutation",
        );
        if (governanceReason) throw new Error(governanceReason);
        state = await readGovernanceState(ctx.cwd, workId);
        if (!state.contentBaseline) {
          throw new Error(
            `Ged work ${workId} predates content-bound governance and cannot continue. Open new work.`,
          );
        }
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
      "Record content-bound accepted-plan evidence or execute and bind verification commands for the exact work in this request. Run in its own tool batch.",
    promptSnippet: "Record accepted governance evidence for current work",
    promptGuidelines: [
      "Use accept-plan only after the coordinator accepts the final planned artifacts.",
      "For record-verification, provide argv-based checks for the runtime to execute; process or subagent prose alone is never verification.",
      "Evidence producers may be main-agent or optional assistants; staffing never changes the contract.",
    ],
    parameters: Type.Object(
      {
        action: StringEnum(["accept-plan", "record-verification"] as const),
        summary: Type.String({ minLength: 1, maxLength: 500 }),
        checks: Type.Optional(
          Type.Array(
            Type.Object(
              {
                command: Type.String({ minLength: 1, maxLength: 200 }),
                args: Type.Array(Type.String({ maxLength: 1_000 }), {
                  maxItems: 100,
                }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 20 },
          ),
        ),
        residualRisks: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
            maxItems: 20,
          }),
        ),
        review: Type.Optional(
          Type.Object(
            {
              outcome: StringEnum(["clean", "findings"] as const),
              findings: Type.Array(
                Type.String({ minLength: 1, maxLength: 1_000 }),
                { maxItems: 100 },
              ),
            },
            { additionalProperties: false },
          ),
        ),
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
      let state: GovernanceWorkState;
      if (params.action === "accept-plan") {
        const paths = gedPathsForWorkId(ctx.cwd, activeRequest.workId);
        const binding = await fingerprintFileSet(ctx.cwd, [
          paths.specPath,
          paths.tasksPath,
          paths.testsPath,
        ]);
        state = await recordSatisfiedGovernanceEvidence(
          ctx.cwd,
          activeRequest.workId,
          {
            id: evidenceId,
            kind: "plan",
            source: "agent",
            producerId: "coordinator",
            recordedAt: new Date().toISOString(),
            summary: params.summary,
            outcome: "satisfied",
            binding: { type: "plan-content", ...binding },
          },
        );
      } else {
        const checks = params.checks ?? [];
        if (checks.length === 0) {
          throw new Error(
            "record-verification requires at least one argv-based check.",
          );
        }
        let current = await readGovernanceState(ctx.cwd, activeRequest.workId);
        const planReason = await planBindingBlockReason(ctx.cwd, current);
        if (planReason) throw new Error(planReason);
        const before = await captureSnapshot(ctx.cwd);
        const pendingId = `verification-${randomUUID()}`;
        await beginGovernanceMutation(
          ctx.cwd,
          activeRequest.workId,
          {
            id: pendingId,
            requestId: activeRequest.requestId,
            toolCallId: _toolCallId,
            target: "runtime verification commands",
            startedAt: new Date().toISOString(),
          },
          "source-mutation",
        );
        const commandResults = [];
        for (const check of checks) {
          commandResults.push(await runVerificationCheck(ctx.cwd, check));
        }
        const snapshot = await captureSnapshot(ctx.cwd);
        if (snapshotsEqual(before, snapshot)) {
          await clearGovernanceMutation(
            ctx.cwd,
            activeRequest.workId,
            pendingId,
          );
        } else {
          await completeGovernanceMutation(
            ctx.cwd,
            activeRequest.workId,
            pendingId,
            {
              id: `implementation-${randomUUID()}`,
              kind: "implementation",
              source: "runtime",
              recordedAt: new Date().toISOString(),
              summary: "Verification commands changed repository content.",
              outcome: "observed",
              binding: {
                type: "mutation-content",
                beforeDigest: before.digest,
                afterDigest: snapshot.digest,
                changedPaths: changedPathsBetween(before, snapshot),
              },
            },
          );
        }
        current = await readGovernanceState(ctx.cwd, activeRequest.workId);
        const scopePaths = observedScopePaths(current);
        const baseline = current.contentBaseline;
        if (!baseline) {
          throw new Error("Content baseline is missing after verification.");
        }
        const unscoped = changedPathsBetween(baseline, snapshot).filter(
          (entry) => !scopePaths.includes(entry),
        );
        const failed = commandResults.some((entry) => entry.exitCode !== 0);
        const reviewBlocked =
          params.review?.outcome === "findings" ||
          (params.review?.findings.length ?? 0) > 0;
        const binding = {
          type: "verification-content" as const,
          snapshot,
          scopePaths,
          commands: commandResults,
          environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
          },
          ...(params.review ? { review: params.review } : {}),
          residualRisks: params.residualRisks ?? [],
        };
        if (failed || reviewBlocked || unscoped.length > 0) {
          await appendGovernanceEvidence(ctx.cwd, activeRequest.workId, {
            id: evidenceId,
            kind: "verification",
            source: "runtime",
            producerId: "coordinator",
            recordedAt: new Date().toISOString(),
            summary: failed
              ? "One or more verification commands failed."
              : reviewBlocked
                ? "Independent review reported unresolved findings."
                : `Verification found unscoped changed paths: ${unscoped.join(", ")}`,
            outcome: "failed",
            binding,
          });
          throw new Error(
            failed
              ? "Verification commands failed; evidence is non-authorizing."
              : reviewBlocked
                ? "Independent review findings are non-authorizing."
                : `Verification found unscoped changed paths: ${unscoped.join(", ")}`,
          );
        }
        const refreshedPlanReason = await planBindingBlockReason(
          ctx.cwd,
          current,
        );
        if (refreshedPlanReason) throw new Error(refreshedPlanReason);
        state = await recordSatisfiedGovernanceEvidence(
          ctx.cwd,
          activeRequest.workId,
          {
            id: evidenceId,
            kind: "verification",
            source: "runtime",
            producerId: "coordinator",
            recordedAt: new Date().toISOString(),
            summary: params.summary,
            outcome: "satisfied",
            binding,
          },
        );
      }
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
      await reconcilePendingCommit(ctx.cwd, params.workId);
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
      if (params.action === "complete") {
        const planReason = await planBindingBlockReason(ctx.cwd, before);
        if (planReason) throw new Error(planReason);
        const verification = verifiedContent(before);
        if (!verification) {
          throw new Error(
            `Ged work ${params.workId} cannot complete without content-bound verification.`,
          );
        }
        if (
          !snapshotsEqual(await captureSnapshot(ctx.cwd), verification.snapshot)
        ) {
          throw new Error(
            `Ged work ${params.workId} cannot complete because repository content differs from verification.`,
          );
        }
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
