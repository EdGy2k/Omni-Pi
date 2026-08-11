import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "./atomic.js";
import { GED_DIR } from "./contracts.js";
import { withProcessQueue } from "./serial-queue.js";
import {
  DEFAULT_WORK_NOTES,
  DEFAULT_WORK_SPEC,
  DEFAULT_WORK_TASKS,
  DEFAULT_WORK_TESTS,
} from "./templates.js";

const execFileAsync = promisify(execFile);
const DEFAULT_WORK_SESSION_ID = "ged-default-session";
const GENERATED_WORK_ID = /^[a-z0-9](?:[a-z0-9-]{0,47})-\d{17}-[a-f0-9]{32}$/u;
const SAFE_WORK_PATH_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const ENTROPY = /^[a-f0-9]{32}$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: work summaries are persisted metadata.
const WORK_SUMMARY_CONTROL = /[\u0000-\u001f\u007f]/gu;
const activeSessionByRoot = new Map<string, string>();

export interface ActiveGedPaths {
  workId: string;
  workDir: string;
  runtimeDir: string;
  specPath: string;
  tasksPath: string;
  testsPath: string;
  notesPath: string;
  metaPath: string;
  statePath: string;
  sessionSummaryPath: string;
  checkpointsPath: string;
  governancePath: string;
}

export interface WorkRequestIdentity {
  sessionId: string;
  requestId: string;
}

export interface ActiveWorkPointer {
  schemaVersion: 1;
  sessionId: string;
  workId: string;
  operation: "bootstrap" | "open" | "continue";
  selectedAt: string;
  requestId: string | null;
}

export interface WorkItemMeta {
  schemaVersion: 1;
  workId: string;
  summary: string;
  createdAt: string;
  branch: string | null;
  baseHead: string | null;
  origin?: {
    kind: "legacy-import";
    migrationId: string;
    candidateId: string;
    selectable: false;
  };
}

export interface OpenedGedWork {
  workId: string;
  paths: ActiveGedPaths;
  pointer: ActiveWorkPointer;
  meta: WorkItemMeta;
}

export class WorkSelectionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-identity"
      | "invalid-work-id"
      | "missing-pointer"
      | "invalid-pointer"
      | "missing-work"
      | "invalid-work-meta"
      | "non-selectable-work",
  ) {
    super(message);
    this.name = "WorkSelectionError";
  }
}

function resolvedRoot(rootDir: string): string {
  return path.resolve(rootDir);
}

function selectedSessionId(rootDir: string, sessionId?: string): string {
  return (
    sessionId ??
    activeSessionByRoot.get(resolvedRoot(rootDir)) ??
    DEFAULT_WORK_SESSION_ID
  );
}

function requireIdentityPart(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new WorkSelectionError(
      `${label} must be a non-empty string no longer than 256 characters.`,
      "invalid-identity",
    );
  }
}

function validateRequestIdentity(identity: WorkRequestIdentity): void {
  requireIdentityPart(identity.sessionId, "sessionId");
  requireIdentityPart(identity.requestId, "requestId");
}

function workSlug(summary: string): string {
  return (
    summary
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 48)
      .replace(/-$/u, "") || "work"
  );
}

function sortableTimestamp(now: number): string {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new WorkSelectionError(
      "Work ID timestamp must be a valid epoch millisecond value.",
      "invalid-work-id",
    );
  }
  return date.toISOString().replace(/[-:.TZ]/gu, "");
}

export function generateWorkId(
  summary: string,
  options: { now?: number; entropy?: string } = {},
): string {
  const entropy = options.entropy ?? randomBytes(16).toString("hex");
  if (!ENTROPY.test(entropy)) {
    throw new WorkSelectionError(
      "Work ID entropy must be exactly 32 lowercase hexadecimal characters.",
      "invalid-work-id",
    );
  }
  return `${workSlug(summary)}-${sortableTimestamp(options.now ?? Date.now())}-${entropy}`;
}

export function isGeneratedWorkId(workId: string): boolean {
  return GENERATED_WORK_ID.test(workId);
}

function requireSafeWorkPathSegment(workId: string): void {
  if (!SAFE_WORK_PATH_SEGMENT.test(workId)) {
    throw new WorkSelectionError(
      `Invalid Ged work ID: ${JSON.stringify(workId)}.`,
      "invalid-work-id",
    );
  }
}

function requireGeneratedWorkId(workId: string): void {
  if (!isGeneratedWorkId(workId)) {
    throw new WorkSelectionError(
      `Ged work ID is not a generated task identity: ${JSON.stringify(workId)}.`,
      "invalid-work-id",
    );
  }
}

export function setActiveWorkSession(rootDir: string, sessionId: string): void {
  requireIdentityPart(sessionId, "sessionId");
  activeSessionByRoot.set(resolvedRoot(rootDir), sessionId);
}

export function clearActiveWorkSession(
  rootDir: string,
  sessionId: string,
): void {
  const root = resolvedRoot(rootDir);
  if (activeSessionByRoot.get(root) === sessionId) {
    activeSessionByRoot.delete(root);
  }
}

export function activeWorkPointerPath(
  rootDir: string,
  sessionId?: string,
): string {
  const selectedSession = selectedSessionId(rootDir, sessionId);
  requireIdentityPart(selectedSession, "sessionId");
  const sessionKey = createHash("sha256")
    .update(selectedSession)
    .digest("hex")
    .slice(0, 32);
  return path.join(
    resolvedRoot(rootDir),
    GED_DIR,
    "runtime",
    "active-work",
    `${sessionKey}.json`,
  );
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function parsePointer(
  raw: string,
  expectedSessionId: string,
): ActiveWorkPointer {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkSelectionError(
      "Active Ged work pointer contains malformed JSON.",
      "invalid-pointer",
    );
  }
  if (!value || typeof value !== "object") {
    throw new WorkSelectionError(
      "Active Ged work pointer must be a JSON object.",
      "invalid-pointer",
    );
  }
  const pointer = value as Partial<ActiveWorkPointer>;
  if (
    pointer.schemaVersion !== 1 ||
    pointer.sessionId !== expectedSessionId ||
    typeof pointer.workId !== "string" ||
    !isGeneratedWorkId(pointer.workId) ||
    (pointer.operation !== "bootstrap" &&
      pointer.operation !== "open" &&
      pointer.operation !== "continue") ||
    typeof pointer.selectedAt !== "string" ||
    Number.isNaN(Date.parse(pointer.selectedAt)) ||
    !(pointer.requestId === null || typeof pointer.requestId === "string") ||
    (pointer.operation === "bootstrap" && pointer.requestId !== null) ||
    (pointer.operation !== "bootstrap" &&
      (typeof pointer.requestId !== "string" ||
        pointer.requestId.trim().length === 0))
  ) {
    throw new WorkSelectionError(
      "Active Ged work pointer has an invalid or unsupported shape.",
      "invalid-pointer",
    );
  }
  return pointer as ActiveWorkPointer;
}

export async function readActiveWorkPointer(
  rootDir: string,
  sessionId?: string,
): Promise<ActiveWorkPointer | null> {
  const selectedSession = selectedSessionId(rootDir, sessionId);
  try {
    return parsePointer(
      await readFile(activeWorkPointerPath(rootDir, selectedSession), "utf8"),
      selectedSession,
    );
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof WorkSelectionError) throw error;
    throw new WorkSelectionError(
      `Unable to read active Ged work pointer: ${error instanceof Error ? error.message : String(error)}`,
      "invalid-pointer",
    );
  }
}

export async function currentBranchName(
  rootDir: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootDir, "branch", "--show-current"],
      { timeout: 2000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function currentGitHead(rootDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootDir, "rev-parse", "--verify", "HEAD"],
      { timeout: 2000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function gedPathsForWorkId(
  rootDir: string,
  workId: string,
): ActiveGedPaths {
  requireSafeWorkPathSegment(workId);
  const workDir = path.join(resolvedRoot(rootDir), GED_DIR, "work", workId);
  const runtimeDir = path.join(
    resolvedRoot(rootDir),
    GED_DIR,
    "runtime",
    workId,
  );
  return {
    workId,
    workDir,
    runtimeDir,
    specPath: path.join(workDir, "SPEC.md"),
    tasksPath: path.join(workDir, "TASKS.md"),
    testsPath: path.join(workDir, "TESTS.md"),
    notesPath: path.join(workDir, "NOTES.md"),
    metaPath: path.join(workDir, "META.json"),
    statePath: path.join(runtimeDir, "STATE.md"),
    sessionSummaryPath: path.join(runtimeDir, "SESSION-SUMMARY.md"),
    checkpointsPath: path.join(runtimeDir, "checkpoints.json"),
    governancePath: path.join(runtimeDir, "governance.json"),
  };
}

function parseWorkMeta(raw: string, workId: string): WorkItemMeta {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkSelectionError(
      `Ged work ${workId} has malformed META.json.`,
      "invalid-work-meta",
    );
  }
  if (!value || typeof value !== "object") {
    throw new WorkSelectionError(
      `Ged work ${workId} has invalid META.json.`,
      "invalid-work-meta",
    );
  }
  const meta = value as Partial<WorkItemMeta>;
  const origin = meta.origin;
  if (
    meta.schemaVersion !== 1 ||
    meta.workId !== workId ||
    typeof meta.summary !== "string" ||
    meta.summary.trim().length === 0 ||
    typeof meta.createdAt !== "string" ||
    Number.isNaN(Date.parse(meta.createdAt)) ||
    !(meta.branch === null || typeof meta.branch === "string") ||
    !(meta.baseHead === null || typeof meta.baseHead === "string") ||
    !(
      origin === undefined ||
      (origin !== null &&
        typeof origin === "object" &&
        !Array.isArray(origin) &&
        Object.keys(origin).length === 4 &&
        origin.kind === "legacy-import" &&
        typeof origin.migrationId === "string" &&
        origin.migrationId.trim().length > 0 &&
        typeof origin.candidateId === "string" &&
        origin.candidateId.trim().length > 0 &&
        origin.selectable === false)
    )
  ) {
    throw new WorkSelectionError(
      `Ged work ${workId} has an invalid or unsupported META.json.`,
      "invalid-work-meta",
    );
  }
  return meta as WorkItemMeta;
}

function requireSelectableWork(meta: WorkItemMeta): void {
  if (meta.origin?.kind === "legacy-import" && !meta.origin.selectable) {
    throw new WorkSelectionError(
      `Ged work ${meta.workId} is a paused legacy import and cannot be selected. Open new work after reviewing its migration backup.`,
      "non-selectable-work",
    );
  }
}

export async function readWorkItemMeta(
  rootDir: string,
  workId: string,
): Promise<WorkItemMeta> {
  requireGeneratedWorkId(workId);
  const paths = gedPathsForWorkId(rootDir, workId);
  try {
    return parseWorkMeta(await readFile(paths.metaPath, "utf8"), workId);
  } catch (error) {
    if (error instanceof WorkSelectionError) throw error;
    if (isEnoent(error)) {
      throw new WorkSelectionError(
        `Ged work ${workId} does not exist.`,
        "missing-work",
      );
    }
    throw error;
  }
}

async function createWorkItem(
  rootDir: string,
  summary: string,
): Promise<{ meta: WorkItemMeta; paths: ActiveGedPaths }> {
  const normalizedSummary = summary
    .replace(WORK_SUMMARY_CONTROL, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  if (!normalizedSummary) {
    throw new WorkSelectionError(
      "A non-empty work summary is required.",
      "invalid-identity",
    );
  }
  const root = resolvedRoot(rootDir);
  await mkdir(path.join(root, GED_DIR, "work"), { recursive: true });
  await mkdir(path.join(root, GED_DIR, "runtime"), { recursive: true });
  const [branch, baseHead] = await Promise.all([
    currentBranchName(root),
    currentGitHead(root),
  ]);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const workId = generateWorkId(normalizedSummary);
    const paths = gedPathsForWorkId(root, workId);
    try {
      await mkdir(paths.workDir);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }

    const meta: WorkItemMeta = {
      schemaVersion: 1,
      workId,
      summary: normalizedSummary,
      createdAt: new Date().toISOString(),
      branch,
      baseHead,
    };
    try {
      await mkdir(paths.runtimeDir);
      await Promise.all([
        writeFileAtomic(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`),
        writeFileAtomic(paths.specPath, DEFAULT_WORK_SPEC),
        writeFileAtomic(paths.tasksPath, DEFAULT_WORK_TASKS),
        writeFileAtomic(paths.testsPath, DEFAULT_WORK_TESTS),
        writeFileAtomic(paths.notesPath, DEFAULT_WORK_NOTES),
      ]);
      return { meta, paths };
    } catch (error) {
      await Promise.all([
        rm(paths.workDir, { recursive: true, force: true }),
        rm(paths.runtimeDir, { recursive: true, force: true }),
      ]);
      throw error;
    }
  }
  throw new WorkSelectionError(
    "Unable to reserve a unique Ged work ID after repeated collisions.",
    "invalid-work-id",
  );
}

async function writePointer(
  rootDir: string,
  pointer: ActiveWorkPointer,
): Promise<void> {
  await writeFileAtomic(
    activeWorkPointerPath(rootDir, pointer.sessionId),
    `${JSON.stringify(pointer, null, 2)}\n`,
  );
}

export async function ensureActiveGedWork(
  rootDir: string,
  sessionId?: string,
): Promise<ActiveWorkPointer> {
  const selectedSession = selectedSessionId(rootDir, sessionId);
  requireIdentityPart(selectedSession, "sessionId");
  const pointerPath = activeWorkPointerPath(rootDir, selectedSession);
  return withProcessQueue(pointerPath, async () => {
    const existing = await readActiveWorkPointer(rootDir, selectedSession);
    if (existing) {
      requireSelectableWork(await readWorkItemMeta(rootDir, existing.workId));
      return existing;
    }
    const { meta } = await createWorkItem(rootDir, "Ged bootstrap work");
    const pointer: ActiveWorkPointer = {
      schemaVersion: 1,
      sessionId: selectedSession,
      workId: meta.workId,
      operation: "bootstrap",
      selectedAt: new Date().toISOString(),
      requestId: null,
    };
    await writePointer(rootDir, pointer);
    return pointer;
  });
}

export async function openGedWork(
  rootDir: string,
  identity: WorkRequestIdentity,
  summary: string,
  options: { bindRequest?: boolean } = {},
): Promise<OpenedGedWork> {
  validateRequestIdentity(identity);
  const pointerPath = activeWorkPointerPath(rootDir, identity.sessionId);
  return withProcessQueue(pointerPath, async () => {
    const { meta, paths } = await createWorkItem(rootDir, summary);
    const pointer: ActiveWorkPointer = {
      schemaVersion: 1,
      sessionId: identity.sessionId,
      workId: meta.workId,
      operation: "open",
      selectedAt: new Date().toISOString(),
      requestId: identity.requestId,
    };
    if (options.bindRequest !== false) {
      await writePointer(rootDir, pointer);
    }
    return { workId: meta.workId, paths, pointer, meta };
  });
}

export async function continueGedWork(
  rootDir: string,
  identity: WorkRequestIdentity,
  workId: string,
): Promise<OpenedGedWork> {
  return bindGedWork(rootDir, identity, workId, "continue");
}

export async function bindGedWork(
  rootDir: string,
  identity: WorkRequestIdentity,
  workId: string,
  operation: "open" | "continue",
): Promise<OpenedGedWork> {
  validateRequestIdentity(identity);
  requireGeneratedWorkId(workId);
  const pointerPath = activeWorkPointerPath(rootDir, identity.sessionId);
  return withProcessQueue(pointerPath, async () => {
    const meta = await readWorkItemMeta(rootDir, workId);
    requireSelectableWork(meta);
    const paths = gedPathsForWorkId(rootDir, workId);
    const pointer: ActiveWorkPointer = {
      schemaVersion: 1,
      sessionId: identity.sessionId,
      workId,
      operation,
      selectedAt: new Date().toISOString(),
      requestId: identity.requestId,
    };
    await writePointer(rootDir, pointer);
    return { workId, paths, pointer, meta };
  });
}

export async function isActiveWorkBoundToRequest(
  rootDir: string,
  identity: WorkRequestIdentity,
  expectedWorkId?: string,
): Promise<boolean> {
  validateRequestIdentity(identity);
  const pointer = await readActiveWorkPointer(rootDir, identity.sessionId);
  if (
    !pointer ||
    pointer.operation === "bootstrap" ||
    pointer.requestId !== identity.requestId ||
    (expectedWorkId !== undefined && pointer.workId !== expectedWorkId)
  ) {
    return false;
  }
  requireSelectableWork(await readWorkItemMeta(rootDir, pointer.workId));
  return true;
}

export async function activeGedPaths(
  rootDir: string,
  sessionId?: string,
): Promise<ActiveGedPaths> {
  const selectedSession = selectedSessionId(rootDir, sessionId);
  const pointer = await readActiveWorkPointer(rootDir, selectedSession);
  if (!pointer) {
    throw new WorkSelectionError(
      "No active Ged work pointer exists for this session.",
      "missing-pointer",
    );
  }
  requireSelectableWork(await readWorkItemMeta(rootDir, pointer.workId));
  return gedPathsForWorkId(rootDir, pointer.workId);
}

export function relativeGedPath(rootDir: string, targetPath: string): string {
  return path.relative(rootDir, targetPath).split(path.sep).join("/");
}
