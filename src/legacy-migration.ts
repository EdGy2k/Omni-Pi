import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { publishFileExclusive } from "./atomic.js";
import { GED_DIR } from "./contracts.js";
import {
  gedPathsForWorkId,
  generateWorkId,
  isGeneratedWorkId,
  type WorkItemMeta,
} from "./ged-paths.js";
import {
  GovernanceStoreError,
  initializeGovernanceState,
  readGovernanceState,
  regenerateGovernanceProjection,
  renderGovernanceProjection,
} from "./governance-store.js";
import { withProcessQueue } from "./serial-queue.js";
import {
  DEFAULT_WORK_NOTES,
  DEFAULT_WORK_SPEC,
  DEFAULT_WORK_TASKS,
  DEFAULT_WORK_TESTS,
} from "./templates.js";

const MIGRATION_SCHEMA_VERSION = 1;
const MIGRATION_NAME = "legacy-checkpoints-v1";
const CLASSIFICATIONS = [
  "supported-active-v2",
  "supported-inactive-v2",
  "supported-active-v3",
  "supported-inactive-v3",
  "corrupt-json",
  "invalid-shape",
  "unsupported-newer",
  "unsupported-older",
] as const;

type LegacyClassification = (typeof CLASSIFICATIONS)[number];
type MigrationPhase =
  | "plan"
  | "backup-file"
  | "backup-complete"
  | "import-started"
  | "target-files"
  | "governance"
  | "import-complete"
  | "complete";

interface LegacyCandidate {
  id: string;
  checkpointPath: string;
  logicalWorkId: string;
  classification: LegacyClassification;
  schemaVersion: number | null;
  sourcePaths: string[];
}

interface MigrationManifestEntry {
  sourcePath: string;
  backupPath: string;
  sha256: string;
  size: number;
  candidateIds: string[];
}

interface ImportDecision {
  outcome: "import" | "no-import";
  reason: string;
  candidateId: string | null;
}

export interface LegacyMigrationPlan {
  schemaVersion: 1;
  migrationId: string;
  createdAt: string;
  backupId: string;
  candidates: LegacyCandidate[];
  manifest: MigrationManifestEntry[];
  importDecision: ImportDecision;
  targetWorkId: string | null;
  evidenceId: string | null;
}

interface PhaseMarker {
  schemaVersion: 1;
  migrationId: string;
  phase: "backup-complete" | "import-started" | "import-complete" | "complete";
  recordedAt: string;
  outcome?: "imported" | "no-import";
  targetWorkId?: string | null;
}

export interface LegacyMigrationResult {
  status: "not-needed" | "completed";
  outcome?: "imported" | "no-import";
  migrationId?: string;
  backupId?: string;
  targetWorkId?: string | null;
  reason?: string;
}

export interface LegacyMigrationOptions {
  now?: () => Date;
  createMigrationId?: () => string;
  afterPhase?: (phase: MigrationPhase, detail?: string) => void | Promise<void>;
}

export class LegacyMigrationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsafe-layout"
      | "invalid-journal"
      | "source-drift"
      | "artifact-conflict"
      | "integrity-failure",
  ) {
    super(message);
    this.name = "LegacyMigrationError";
  }
}

export function legacyMigrationPaths(rootDir: string) {
  const migrationDir = path.join(
    path.resolve(rootDir),
    GED_DIR,
    "runtime",
    "migrations",
    MIGRATION_NAME,
  );
  return {
    migrationDir,
    planPath: path.join(migrationDir, "PLAN.json"),
    backupCompletePath: path.join(migrationDir, "10-backup-complete.json"),
    importStartedPath: path.join(migrationDir, "20-import-started.json"),
    importCompletePath: path.join(migrationDir, "30-import-complete.json"),
    completePath: path.join(migrationDir, "40-complete.json"),
  };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function canonicalDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRelative(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    return false;
  return (
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== ".." &&
    !value.startsWith("../")
  );
}

function repoRelative(rootDir: string, absolutePath: string): string {
  const relative = path
    .relative(path.resolve(rootDir), path.resolve(absolutePath))
    .split(path.sep)
    .join("/");
  if (!safeRelative(relative)) {
    throw new LegacyMigrationError(
      `Legacy migration path escapes the repository: ${absolutePath}`,
      "unsafe-layout",
    );
  }
  return relative;
}

function resolveRelative(rootDir: string, relativePath: string): string {
  if (!safeRelative(relativePath)) {
    throw new LegacyMigrationError(
      `Migration journal contains an unsafe path: ${JSON.stringify(relativePath)}.`,
      "invalid-journal",
    );
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new LegacyMigrationError(
      `Migration journal path escapes the repository: ${relativePath}.`,
      "invalid-journal",
    );
  }
  return target;
}

async function assertSafeDirectoryChain(
  rootDir: string,
  targetDirectory: string,
): Promise<void> {
  const root = path.resolve(rootDir);
  const relative = path.relative(root, path.resolve(targetDirectory));
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new LegacyMigrationError(
      "Migration storage path escapes the repository.",
      "unsafe-layout",
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory()) {
        throw new LegacyMigrationError(
          `Migration refuses unsafe directory component ${repoRelative(root, current)}.`,
          "unsafe-layout",
        );
      }
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
  }
}

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readRegularFile(
  rootDir: string,
  absolutePath: string,
): Promise<Buffer | null> {
  await assertSafeDirectoryChain(rootDir, path.dirname(absolutePath));
  let initialInfo: Stats;
  try {
    initialInfo = await lstat(absolutePath);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  if (!initialInfo.isFile()) {
    throw new LegacyMigrationError(
      `Legacy migration refuses symlink or special file ${repoRelative(rootDir, absolutePath)}.`,
      "unsafe-layout",
    );
  }
  let handle: FileHandle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isEnoent(error)) return null;
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      throw new LegacyMigrationError(
        `Legacy migration refuses symlink ${repoRelative(rootDir, absolutePath)}.`,
        "unsafe-layout",
      );
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new LegacyMigrationError(
        `Legacy migration refuses symlink or special file ${repoRelative(rootDir, absolutePath)}.`,
        "unsafe-layout",
      );
    }
    await assertSafeDirectoryChain(rootDir, path.dirname(absolutePath));
    const currentInfo = await lstat(absolutePath).catch(() => null);
    if (
      !currentInfo?.isFile() ||
      currentInfo.dev !== info.dev ||
      currentInfo.ino !== info.ino
    ) {
      throw new LegacyMigrationError(
        `Legacy migration file changed identity during a safe read: ${repoRelative(rootDir, absolutePath)}.`,
        "unsafe-layout",
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function classifyCheckpoint(content: Buffer): {
  classification: LegacyClassification;
  schemaVersion: number | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    return { classification: "corrupt-json", schemaVersion: null };
  }
  if (!isObject(value) || !Number.isSafeInteger(value.schemaVersion)) {
    return { classification: "unsupported-older", schemaVersion: null };
  }
  const schemaVersion = value.schemaVersion as number;
  if (schemaVersion < 2)
    return { classification: "unsupported-older", schemaVersion };
  if (schemaVersion > 3)
    return { classification: "unsupported-newer", schemaVersion };

  const lifecycleStatus = value.lifecycleStatus ?? "active";
  const planCheckpoints = value.planCheckpoints;
  const taskCheckpoints = value.taskCheckpoints;
  const structurallyValidCollections =
    isObject(planCheckpoints) &&
    Object.values(planCheckpoints).every(isObject) &&
    isObject(taskCheckpoints) &&
    Object.entries(taskCheckpoints).every(
      ([taskId, records]) =>
        nonBlank(taskId) &&
        isObject(records) &&
        Object.values(records).every(isObject),
    ) &&
    (value.workerRuns === undefined ||
      (Array.isArray(value.workerRuns) && value.workerRuns.every(isObject)));
  const validEnvelope =
    (value.classification === "trivial" ||
      value.classification === "non-trivial") &&
    nonBlank(value.classificationReason) &&
    structurallyValidCollections &&
    (lifecycleStatus === "active" ||
      lifecycleStatus === "verified" ||
      lifecycleStatus === "closed");
  if (!validEnvelope) return { classification: "invalid-shape", schemaVersion };
  if (schemaVersion === 2) {
    return {
      classification:
        lifecycleStatus === "active"
          ? "supported-active-v2"
          : "supported-inactive-v2",
      schemaVersion,
    };
  }
  if (value.lifecycleStatus === undefined) {
    return { classification: "invalid-shape", schemaVersion };
  }
  return {
    classification:
      lifecycleStatus === "active"
        ? "supported-active-v3"
        : "supported-inactive-v3",
    schemaVersion,
  };
}

function candidateId(checkpointPath: string): string {
  return `legacy-${sha256(checkpointPath).slice(0, 20)}`;
}

function candidateLayout(checkpointPath: string): {
  runtimePrefix: string;
  workPrefix: string;
  directRoot: boolean;
} | null {
  const segments = checkpointPath.split("/");
  if (
    segments.length === 3 &&
    segments[0] === GED_DIR &&
    segments[1] === "runtime" &&
    segments[2] === "checkpoints.json"
  ) {
    return {
      runtimePrefix: `${GED_DIR}/runtime`,
      workPrefix: `${GED_DIR}/work/root`,
      directRoot: true,
    };
  }
  if (
    segments.length === 4 &&
    segments[0] === GED_DIR &&
    segments[1] === "runtime" &&
    segments[3] === "checkpoints.json" &&
    nonBlank(segments[2]) &&
    segments[2] !== "migrations"
  ) {
    return {
      runtimePrefix: `${GED_DIR}/runtime/${segments[2]}`,
      workPrefix: `${GED_DIR}/work/${segments[2]}`,
      directRoot: false,
    };
  }
  return null;
}

async function discoverLegacy(
  rootDir: string,
): Promise<{ candidates: LegacyCandidate[]; files: Map<string, Buffer> }> {
  const runtimeRoot = path.join(rootDir, GED_DIR, "runtime");
  const candidates: LegacyCandidate[] = [];
  const files = new Map<string, Buffer>();

  const collect = async (absolutePath: string): Promise<Buffer | null> => {
    const content = await readRegularFile(rootDir, absolutePath);
    if (content) files.set(repoRelative(rootDir, absolutePath), content);
    return content;
  };

  const collectDirectory = async (
    directory: string,
    recursive: boolean,
    sourcePaths: Set<string>,
  ): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile()) {
        if (await collect(entryPath)) {
          sourcePaths.add(repoRelative(rootDir, entryPath));
        }
      } else if (entry.isDirectory() && recursive) {
        await collectDirectory(entryPath, true, sourcePaths);
      } else if (!entry.isDirectory()) {
        throw new LegacyMigrationError(
          `Legacy migration refuses symlink or special file ${repoRelative(rootDir, entryPath)}.`,
          "unsafe-layout",
        );
      }
    }
  };

  const addCandidate = async (
    checkpointPath: string,
    runtimeDir: string,
    workSlug: string,
  ): Promise<void> => {
    const checkpoint = await collect(checkpointPath);
    if (!checkpoint) return;
    const sourcePaths = new Set<string>([
      repoRelative(rootDir, checkpointPath),
    ]);
    await collectDirectory(runtimeDir, runtimeDir !== runtimeRoot, sourcePaths);

    const workDir = path.join(rootDir, GED_DIR, "work", workSlug);
    let workInfo: Stats | undefined;
    try {
      workInfo = await lstat(workDir);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    if (workInfo && !workInfo.isDirectory()) {
      throw new LegacyMigrationError(
        `Legacy migration refuses unsafe work path ${repoRelative(rootDir, workDir)}.`,
        "unsafe-layout",
      );
    }
    await collectDirectory(workDir, true, sourcePaths);

    let logicalWorkId = workSlug;
    const meta = files.get(
      repoRelative(rootDir, path.join(workDir, "META.json")),
    );
    if (meta) {
      try {
        const parsed: unknown = JSON.parse(meta.toString("utf8"));
        if (isObject(parsed) && nonBlank(parsed.workId)) {
          logicalWorkId = parsed.workId;
        }
      } catch {
        // META is archival context only. Checkpoint classification determines
        // import eligibility; malformed metadata never becomes authority.
      }
    }
    const relativeCheckpoint = repoRelative(rootDir, checkpointPath);
    candidates.push({
      id: candidateId(relativeCheckpoint),
      checkpointPath: relativeCheckpoint,
      logicalWorkId,
      ...classifyCheckpoint(checkpoint),
      sourcePaths: [...sourcePaths].sort(),
    });
  };

  const directCheckpoint = path.join(runtimeRoot, "checkpoints.json");
  await addCandidate(directCheckpoint, runtimeRoot, "root");

  const isCurrentGeneratedRuntime = async (name: string): Promise<boolean> => {
    if (!isGeneratedWorkId(name)) return false;
    const metaRaw = await readRegularFile(
      rootDir,
      path.join(rootDir, GED_DIR, "work", name, "META.json"),
    );
    if (!metaRaw) return false;
    try {
      const meta: unknown = JSON.parse(metaRaw.toString("utf8"));
      return (
        isObject(meta) &&
        meta.schemaVersion === 1 &&
        meta.workId === name &&
        nonBlank(meta.summary) &&
        canonicalDate(meta.createdAt)
      );
    } catch {
      return false;
    }
  };

  let entries: Dirent[];
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return { candidates: [], files };
    throw error;
  }
  const currentGeneratedDirectories = new Set<string>();
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (await isCurrentGeneratedRuntime(entry.name)) {
      currentGeneratedDirectories.add(entry.name);
      continue;
    }
    if (entry.name === "migrations") {
      continue;
    }
    if (entry.name === "checkpoints.json" && entry.isFile()) continue;
    if (entry.isSymbolicLink()) {
      throw new LegacyMigrationError(
        `Legacy migration refuses symlink ${repoRelative(rootDir, path.join(runtimeRoot, entry.name))}.`,
        "unsafe-layout",
      );
    }
    if (!entry.isDirectory()) continue;
    await addCandidate(
      path.join(runtimeRoot, entry.name, "checkpoints.json"),
      path.join(runtimeRoot, entry.name),
      entry.name,
    );
  }
  const directCandidate = candidates.find(
    (candidate) =>
      candidate.checkpointPath === `${GED_DIR}/runtime/checkpoints.json`,
  );
  if (directCandidate) {
    const directSources = new Set(directCandidate.sourcePaths);
    const branchRuntimeDirectories = new Set(
      candidates
        .map((candidate) => candidateLayout(candidate.checkpointPath))
        .filter((layout) => layout && !layout.directRoot)
        .map((layout) => layout?.runtimePrefix.split("/").at(-1)),
    );
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === "migrations" ||
        entry.name === "active-work" ||
        currentGeneratedDirectories.has(entry.name) ||
        branchRuntimeDirectories.has(entry.name)
      ) {
        continue;
      }
      await collectDirectory(
        path.join(runtimeRoot, entry.name),
        true,
        directSources,
      );
    }
    directCandidate.sourcePaths = [...directSources].sort();
  }
  return {
    candidates: candidates.sort((left, right) =>
      left.checkpointPath.localeCompare(right.checkpointPath),
    ),
    files,
  };
}

function chooseImport(candidates: LegacyCandidate[]): ImportDecision {
  const logicalIds = candidates.map((candidate) => candidate.logicalWorkId);
  if (new Set(logicalIds).size !== logicalIds.length) {
    return {
      outcome: "no-import",
      reason: "Duplicate legacy logical work IDs make task identity ambiguous.",
      candidateId: null,
    };
  }
  const active = candidates.filter((candidate) =>
    candidate.classification.startsWith("supported-active-"),
  );
  const conclusivelyKnown = candidates.every((candidate) =>
    candidate.classification.startsWith("supported-"),
  );
  if (!conclusivelyKnown) {
    return {
      outcome: "no-import",
      reason:
        "At least one legacy candidate is corrupt, invalid, or uses an unsupported schema.",
      candidateId: null,
    };
  }
  if (active.length !== 1) {
    return {
      outcome: "no-import",
      reason:
        active.length === 0
          ? "No clearly active legacy candidate exists."
          : "Multiple active legacy candidates make task selection ambiguous.",
      candidateId: null,
    };
  }
  return {
    outcome: "import",
    reason:
      "Exactly one legacy candidate is active and every other candidate is conclusively inactive.",
    candidateId: active[0].id,
  };
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/gu, "");
}

function sourceCandidatesFor(
  candidates: LegacyCandidate[],
): Map<string, string[]> {
  const sourceCandidates = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const sourcePath of candidate.sourcePaths) {
      sourceCandidates.set(sourcePath, [
        ...(sourceCandidates.get(sourcePath) ?? []),
        candidate.id,
      ]);
    }
  }
  return sourceCandidates;
}

function buildPlan(
  rootDir: string,
  candidates: LegacyCandidate[],
  files: Map<string, Buffer>,
  options: LegacyMigrationOptions,
): LegacyMigrationPlan {
  const now = options.now?.() ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new LegacyMigrationError(
      "Legacy migration timestamp is invalid.",
      "invalid-journal",
    );
  }
  const migrationId = options.createMigrationId?.() ?? randomUUID();
  if (!nonBlank(migrationId) || migrationId.length > 128) {
    throw new LegacyMigrationError(
      "Legacy migration ID is invalid.",
      "invalid-journal",
    );
  }
  const backupId = `${compactTimestamp(now)}-${sha256(migrationId).slice(0, 16)}`;
  const importDecision = chooseImport(candidates);
  const selected = candidates.find(
    (candidate) => candidate.id === importDecision.candidateId,
  );
  const summary = selected
    ? `Legacy checkpoint import from ${selected.checkpointPath}`
    : "Legacy checkpoint import";
  const targetWorkId = selected
    ? generateWorkId(summary, {
        now: now.getTime(),
        entropy: sha256(`${migrationId}:${selected.id}`).slice(0, 32),
      })
    : null;
  const sourceCandidates = sourceCandidatesFor(candidates);
  const migrationDir = legacyMigrationPaths(rootDir).migrationDir;
  const manifest = [...sourceCandidates]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourcePath, candidateIds]) => {
      const content = files.get(sourcePath);
      if (!content) {
        throw new LegacyMigrationError(
          `Legacy source disappeared while planning: ${sourcePath}.`,
          "source-drift",
        );
      }
      return {
        sourcePath,
        backupPath: repoRelative(
          rootDir,
          path.join(migrationDir, "backups", backupId, "source", sourcePath),
        ),
        sha256: sha256(content),
        size: content.byteLength,
        candidateIds: [...new Set(candidateIds)].sort(),
      };
    });
  return {
    schemaVersion: 1,
    migrationId,
    createdAt: now.toISOString(),
    backupId,
    candidates,
    manifest,
    importDecision,
    targetWorkId,
    evidenceId: selected
      ? `legacy-migration-${sha256(`${migrationId}:${selected.id}`).slice(0, 24)}`
      : null,
  };
}

function parsePlan(rootDir: string, raw: Buffer): LegacyMigrationPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new LegacyMigrationError(
      "Legacy migration PLAN.json is malformed.",
      "invalid-journal",
    );
  }
  if (
    !isObject(value) ||
    !onlyKeys(value, [
      "schemaVersion",
      "migrationId",
      "createdAt",
      "backupId",
      "candidates",
      "manifest",
      "importDecision",
      "targetWorkId",
      "evidenceId",
    ]) ||
    value.schemaVersion !== MIGRATION_SCHEMA_VERSION ||
    !nonBlank(value.migrationId) ||
    !canonicalDate(value.createdAt) ||
    !nonBlank(value.backupId) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.manifest) ||
    !isObject(value.importDecision)
  ) {
    throw new LegacyMigrationError(
      "Legacy migration PLAN.json has an invalid or unsupported shape.",
      "invalid-journal",
    );
  }
  const candidatesValid = value.candidates.every(
    (candidate) =>
      isObject(candidate) &&
      onlyKeys(candidate, [
        "id",
        "checkpointPath",
        "logicalWorkId",
        "classification",
        "schemaVersion",
        "sourcePaths",
      ]) &&
      nonBlank(candidate.id) &&
      safeRelative(candidate.checkpointPath) &&
      nonBlank(candidate.logicalWorkId) &&
      typeof candidate.classification === "string" &&
      CLASSIFICATIONS.includes(
        candidate.classification as LegacyClassification,
      ) &&
      (candidate.schemaVersion === null ||
        Number.isSafeInteger(candidate.schemaVersion)) &&
      Array.isArray(candidate.sourcePaths) &&
      candidate.sourcePaths.every(safeRelative),
  );
  const manifestValid = value.manifest.every(
    (entry) =>
      isObject(entry) &&
      onlyKeys(entry, [
        "sourcePath",
        "backupPath",
        "sha256",
        "size",
        "candidateIds",
      ]) &&
      safeRelative(entry.sourcePath) &&
      safeRelative(entry.backupPath) &&
      typeof entry.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(entry.sha256) &&
      Number.isSafeInteger(entry.size) &&
      (entry.size as number) >= 0 &&
      Array.isArray(entry.candidateIds) &&
      entry.candidateIds.every(nonBlank),
  );
  const decision = value.importDecision;
  const decisionValid =
    onlyKeys(decision, ["outcome", "reason", "candidateId"]) &&
    (decision.outcome === "import" || decision.outcome === "no-import") &&
    nonBlank(decision.reason) &&
    (decision.candidateId === null || nonBlank(decision.candidateId));
  if (
    !candidatesValid ||
    !manifestValid ||
    !decisionValid ||
    (value.targetWorkId !== null &&
      (typeof value.targetWorkId !== "string" ||
        !isGeneratedWorkId(value.targetWorkId))) ||
    (value.evidenceId !== null && !nonBlank(value.evidenceId)) ||
    (decision.outcome === "import" &&
      (decision.candidateId === null ||
        value.targetWorkId === null ||
        value.evidenceId === null)) ||
    (decision.outcome === "no-import" &&
      (decision.candidateId !== null ||
        value.targetWorkId !== null ||
        value.evidenceId !== null))
  ) {
    throw new LegacyMigrationError(
      "Legacy migration PLAN.json has inconsistent records.",
      "invalid-journal",
    );
  }
  const plan = value as unknown as LegacyMigrationPlan;
  const expectedBackupId = `${compactTimestamp(new Date(plan.createdAt))}-${sha256(plan.migrationId).slice(0, 16)}`;
  const candidateIds = plan.candidates.map((candidate) => candidate.id);
  const checkpointPaths = plan.candidates.map(
    (candidate) => candidate.checkpointPath,
  );
  const sourcePaths = plan.manifest.map((entry) => entry.sourcePath);
  const backupPaths = plan.manifest.map((entry) => entry.backupPath);
  const candidateIdSet = new Set(candidateIds);
  const manifestBySource = new Map(
    plan.manifest.map((entry) => [entry.sourcePath, entry]),
  );
  const derivedDecision = chooseImport(plan.candidates);
  const selected = plan.candidates.find(
    (candidate) => candidate.id === derivedDecision.candidateId,
  );
  const expectedTarget = selected
    ? generateWorkId(
        `Legacy checkpoint import from ${selected.checkpointPath}`,
        {
          now: new Date(plan.createdAt).getTime(),
          entropy: sha256(`${plan.migrationId}:${selected.id}`).slice(0, 32),
        },
      )
    : null;
  const expectedEvidence = selected
    ? `legacy-migration-${sha256(`${plan.migrationId}:${selected.id}`).slice(0, 24)}`
    : null;
  const migrationDir = legacyMigrationPaths(rootDir).migrationDir;
  const semanticValid =
    plan.candidates.length > 0 &&
    plan.backupId === expectedBackupId &&
    new Set(candidateIds).size === candidateIds.length &&
    new Set(checkpointPaths).size === checkpointPaths.length &&
    new Set(sourcePaths).size === sourcePaths.length &&
    new Set(backupPaths).size === backupPaths.length &&
    JSON.stringify(plan.importDecision) === JSON.stringify(derivedDecision) &&
    plan.targetWorkId === expectedTarget &&
    plan.evidenceId === expectedEvidence &&
    plan.candidates.every((candidate) => {
      const layout = candidateLayout(candidate.checkpointPath);
      return (
        layout !== null &&
        candidate.id === candidateId(candidate.checkpointPath) &&
        new Set(candidate.sourcePaths).size === candidate.sourcePaths.length &&
        candidate.sourcePaths.includes(candidate.checkpointPath) &&
        candidate.sourcePaths.every(
          (sourcePath) =>
            sourcePath.startsWith(`${layout.workPrefix}/`) ||
            (layout.directRoot
              ? sourcePath.startsWith(`${layout.runtimePrefix}/`) &&
                !sourcePath.startsWith(`${layout.runtimePrefix}/migrations/`) &&
                !sourcePath.startsWith(`${layout.runtimePrefix}/active-work/`)
              : sourcePath.startsWith(`${layout.runtimePrefix}/`)),
        ) &&
        candidate.sourcePaths.every((sourcePath) => {
          const manifest = manifestBySource.get(sourcePath);
          return manifest?.candidateIds.includes(candidate.id) === true;
        })
      );
    }) &&
    plan.manifest.every(
      (entry) =>
        entry.backupPath ===
          repoRelative(
            rootDir,
            path.join(
              migrationDir,
              "backups",
              plan.backupId,
              "source",
              entry.sourcePath,
            ),
          ) &&
        new Set(entry.candidateIds).size === entry.candidateIds.length &&
        entry.candidateIds.length > 0 &&
        entry.candidateIds.every((id) => candidateIdSet.has(id)) &&
        entry.candidateIds.every(
          (id) =>
            plan.candidates
              .find((candidate) => candidate.id === id)
              ?.sourcePaths.includes(entry.sourcePath) === true,
        ),
    );
  if (!semanticValid) {
    throw new LegacyMigrationError(
      "Legacy migration PLAN.json violates its canonical identity or manifest invariants.",
      "invalid-journal",
    );
  }
  return plan;
}

function markerFor(
  plan: LegacyMigrationPlan,
  phase: PhaseMarker["phase"],
  extra: Partial<Pick<PhaseMarker, "outcome" | "targetWorkId">> = {},
): PhaseMarker {
  return {
    schemaVersion: 1,
    migrationId: plan.migrationId,
    phase,
    recordedAt: plan.createdAt,
    ...extra,
  };
}

function parseMarker(
  raw: Buffer,
  plan: LegacyMigrationPlan,
  phase: PhaseMarker["phase"],
): PhaseMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new LegacyMigrationError(
      `Legacy migration ${phase} marker is malformed.`,
      "invalid-journal",
    );
  }
  if (
    !isObject(value) ||
    !onlyKeys(value, [
      "schemaVersion",
      "migrationId",
      "phase",
      "recordedAt",
      "outcome",
      "targetWorkId",
    ]) ||
    value.schemaVersion !== 1 ||
    value.migrationId !== plan.migrationId ||
    value.phase !== phase ||
    value.recordedAt !== plan.createdAt ||
    !(
      value.outcome === undefined ||
      value.outcome === "imported" ||
      value.outcome === "no-import"
    ) ||
    !(
      value.targetWorkId === undefined ||
      value.targetWorkId === null ||
      (typeof value.targetWorkId === "string" &&
        isGeneratedWorkId(value.targetWorkId))
    )
  ) {
    throw new LegacyMigrationError(
      `Legacy migration ${phase} marker has an invalid shape.`,
      "invalid-journal",
    );
  }
  const marker = value as unknown as PhaseMarker;
  const phaseFieldsValid =
    phase === "import-complete"
      ? marker.outcome !== undefined &&
        marker.targetWorkId === plan.targetWorkId
      : phase === "import-started"
        ? marker.outcome === undefined &&
          marker.targetWorkId === plan.targetWorkId
        : marker.outcome === undefined && marker.targetWorkId === undefined;
  if (!phaseFieldsValid) {
    throw new LegacyMigrationError(
      `Legacy migration ${phase} marker contains fields for a different phase.`,
      "invalid-journal",
    );
  }
  return marker;
}

async function readMarker(
  rootDir: string,
  filePath: string,
  plan: LegacyMigrationPlan,
  phase: PhaseMarker["phase"],
): Promise<PhaseMarker | null> {
  const raw = await readRegularFile(rootDir, filePath);
  return raw ? parseMarker(raw, plan, phase) : null;
}

async function publishJson(filePath: string, value: unknown): Promise<boolean> {
  return publishFileExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function publishExact(
  rootDir: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  await assertSafeDirectoryChain(rootDir, path.dirname(filePath));
  if (await publishFileExclusive(filePath, content)) return;
  const existing = await readRegularFile(rootDir, filePath);
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (!existing?.equals(expected)) {
    throw new LegacyMigrationError(
      `Migration artifact already exists with different content: ${filePath}.`,
      "artifact-conflict",
    );
  }
}

async function publishMarker(
  rootDir: string,
  filePath: string,
  marker: PhaseMarker,
  plan: LegacyMigrationPlan,
): Promise<void> {
  await publishJson(filePath, marker);
  const persisted = await readMarker(rootDir, filePath, plan, marker.phase);
  if (JSON.stringify(persisted) !== JSON.stringify(marker)) {
    throw new LegacyMigrationError(
      `Migration phase ${marker.phase} conflicts with the immutable journal.`,
      "artifact-conflict",
    );
  }
}

async function verifyBackup(
  rootDir: string,
  plan: LegacyMigrationPlan,
): Promise<void> {
  for (const entry of plan.manifest) {
    const backup = await readRegularFile(
      rootDir,
      resolveRelative(rootDir, entry.backupPath),
    );
    if (
      !backup ||
      backup.byteLength !== entry.size ||
      sha256(backup) !== entry.sha256
    ) {
      throw new LegacyMigrationError(
        `Legacy backup is missing or changed: ${entry.backupPath}.`,
        "integrity-failure",
      );
    }
  }
  const manifestBySource = new Map(
    plan.manifest.map((entry) => [entry.sourcePath, entry]),
  );
  for (const candidate of plan.candidates) {
    const checkpointEntry = manifestBySource.get(candidate.checkpointPath);
    if (!checkpointEntry) {
      throw new LegacyMigrationError(
        `Legacy checkpoint is absent from the backup manifest: ${candidate.checkpointPath}.`,
        "integrity-failure",
      );
    }
    const checkpointBackup = await readRegularFile(
      rootDir,
      resolveRelative(rootDir, checkpointEntry.backupPath),
    );
    if (!checkpointBackup) {
      throw new LegacyMigrationError(
        `Legacy checkpoint backup is missing: ${candidate.checkpointPath}.`,
        "integrity-failure",
      );
    }
    const classification = classifyCheckpoint(checkpointBackup);
    if (
      classification.classification !== candidate.classification ||
      classification.schemaVersion !== candidate.schemaVersion
    ) {
      throw new LegacyMigrationError(
        `Legacy checkpoint classification does not match PLAN.json: ${candidate.checkpointPath}.`,
        "integrity-failure",
      );
    }
    const layout = candidateLayout(candidate.checkpointPath);
    if (!layout) {
      throw new LegacyMigrationError(
        "Legacy candidate layout became invalid during backup verification.",
        "integrity-failure",
      );
    }
    const metaSource = `${layout.workPrefix}/META.json`;
    const metaEntry = manifestBySource.get(metaSource);
    let expectedLogicalWorkId = layout.workPrefix.split("/").at(-1) ?? "root";
    if (metaEntry) {
      const metaBackup = await readRegularFile(
        rootDir,
        resolveRelative(rootDir, metaEntry.backupPath),
      );
      if (metaBackup) {
        try {
          const meta: unknown = JSON.parse(metaBackup.toString("utf8"));
          if (isObject(meta) && nonBlank(meta.workId)) {
            expectedLogicalWorkId = meta.workId;
          }
        } catch {
          // Malformed legacy META remains archival and resolves to its path ID.
        }
      }
    }
    if (candidate.logicalWorkId !== expectedLogicalWorkId) {
      throw new LegacyMigrationError(
        `Legacy logical work identity does not match its backup: ${candidate.checkpointPath}.`,
        "integrity-failure",
      );
    }
  }
}

async function backUpSources(
  rootDir: string,
  plan: LegacyMigrationPlan,
  options: LegacyMigrationOptions,
): Promise<void> {
  for (const entry of plan.manifest) {
    const sourcePath = resolveRelative(rootDir, entry.sourcePath);
    const source = await readRegularFile(rootDir, sourcePath);
    if (
      !source ||
      source.byteLength !== entry.size ||
      sha256(source) !== entry.sha256
    ) {
      throw new LegacyMigrationError(
        `Legacy source changed after migration planning: ${entry.sourcePath}.`,
        "source-drift",
      );
    }
    await publishExact(
      rootDir,
      resolveRelative(rootDir, entry.backupPath),
      source,
    );
    await options.afterPhase?.("backup-file", entry.sourcePath);
  }
}

async function verifyCurrentLegacyInventory(
  rootDir: string,
  plan: LegacyMigrationPlan,
): Promise<void> {
  const current = await discoverLegacy(rootDir);
  if (JSON.stringify(current.candidates) !== JSON.stringify(plan.candidates)) {
    throw new LegacyMigrationError(
      "Legacy candidate inventory changed after migration planning.",
      "source-drift",
    );
  }
  const references = sourceCandidatesFor(current.candidates);
  if (
    current.files.size !== plan.manifest.length ||
    plan.manifest.some((entry) => {
      const content = current.files.get(entry.sourcePath);
      return (
        !content ||
        content.byteLength !== entry.size ||
        sha256(content) !== entry.sha256 ||
        JSON.stringify([...(references.get(entry.sourcePath) ?? [])].sort()) !==
          JSON.stringify(entry.candidateIds)
      );
    })
  ) {
    throw new LegacyMigrationError(
      "Legacy source inventory changed after migration planning.",
      "source-drift",
    );
  }
}

function importedMeta(plan: LegacyMigrationPlan): WorkItemMeta {
  const candidate = plan.candidates.find(
    (entry) => entry.id === plan.importDecision.candidateId,
  );
  if (!candidate || !plan.targetWorkId) {
    throw new LegacyMigrationError(
      "Migration import decision has no matching candidate.",
      "invalid-journal",
    );
  }
  return {
    schemaVersion: 1,
    workId: plan.targetWorkId,
    summary: `Legacy checkpoint import from ${candidate.checkpointPath}`,
    createdAt: plan.createdAt,
    branch: null,
    baseHead: null,
    origin: {
      kind: "legacy-import",
      migrationId: plan.migrationId,
      candidateId: candidate.id,
      selectable: false,
    },
  };
}

async function assertNoPointerTargets(
  rootDir: string,
  workId: string,
): Promise<void> {
  const pointerDir = path.join(rootDir, GED_DIR, "runtime", "active-work");
  let entries: Dirent[];
  try {
    entries = await readdir(pointerDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new LegacyMigrationError(
        "Active-work pointer directory contains an unsafe entry.",
        "integrity-failure",
      );
    }
    let pointer: unknown;
    try {
      const pointerRaw = await readRegularFile(
        rootDir,
        path.join(pointerDir, entry.name),
      );
      if (!pointerRaw) throw new Error("Pointer disappeared");
      pointer = JSON.parse(pointerRaw.toString("utf8"));
    } catch {
      throw new LegacyMigrationError(
        "Active-work pointer is malformed during migration verification.",
        "integrity-failure",
      );
    }
    if (isObject(pointer) && pointer.workId === workId) {
      throw new LegacyMigrationError(
        `Imported legacy work ${workId} is referenced by an active pointer.`,
        "integrity-failure",
      );
    }
  }
}

async function verifyImportedTarget(
  rootDir: string,
  plan: LegacyMigrationPlan,
): Promise<void> {
  if (!plan.targetWorkId || !plan.evidenceId) {
    throw new LegacyMigrationError(
      "Import target identity is missing from the migration plan.",
      "invalid-journal",
    );
  }
  const paths = gedPathsForWorkId(rootDir, plan.targetWorkId);
  const expectedMeta = `${JSON.stringify(importedMeta(plan), null, 2)}\n`;
  const expectedWorkFiles = new Map([
    [paths.specPath, DEFAULT_WORK_SPEC],
    [paths.tasksPath, DEFAULT_WORK_TASKS],
    [paths.testsPath, DEFAULT_WORK_TESTS],
    [paths.notesPath, DEFAULT_WORK_NOTES],
    [paths.metaPath, expectedMeta],
  ]);
  for (const [filePath, expected] of expectedWorkFiles) {
    if (
      (await readRegularFile(rootDir, filePath))?.toString("utf8") !== expected
    ) {
      throw new LegacyMigrationError(
        `Imported legacy work artifact is missing or changed: ${repoRelative(rootDir, filePath)}.`,
        "integrity-failure",
      );
    }
  }
  if (await readRegularFile(rootDir, paths.checkpointsPath)) {
    throw new LegacyMigrationError(
      "Imported legacy work must not contain an authorizing legacy checkpoint.",
      "integrity-failure",
    );
  }
  if (!(await readRegularFile(rootDir, paths.governancePath))) {
    throw new LegacyMigrationError(
      "Imported governance state is missing.",
      "integrity-failure",
    );
  }
  const state = await readGovernanceState(rootDir, plan.targetWorkId).catch(
    (error) => {
      throw new LegacyMigrationError(
        `Imported governance state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "integrity-failure",
      );
    },
  );
  const candidate = plan.candidates.find(
    (entry) => entry.id === plan.importDecision.candidateId,
  );
  const expectedSummary = candidate
    ? `Legacy checkpoints from ${candidate.checkpointPath} were preserved in backup ${plan.backupId} but were not trusted as authorization.`
    : "";
  if (
    state.revision !== 0 ||
    state.summary !== importedMeta(plan).summary ||
    state.createdAt !== plan.createdAt ||
    state.updatedAt !== plan.createdAt ||
    state.currentSlice !== null ||
    state.lifecycle !== "paused" ||
    state.decision.mode !== "planned-change" ||
    state.decision.reasonCode !== "decision-needed" ||
    state.decision.reason !==
      "Legacy checkpoint state requires human review and cannot authorize current work." ||
    state.decision.requiresDecision !== true ||
    state.approvals.length !== 0 ||
    state.evidence.length !== 1 ||
    state.evidence[0]?.id !== plan.evidenceId ||
    state.evidence[0]?.kind !== "migration-required" ||
    state.evidence[0]?.source !== "runtime" ||
    state.evidence[0]?.producerId !== undefined ||
    state.evidence[0]?.recordedAt !== plan.createdAt ||
    state.evidence[0]?.summary !== expectedSummary ||
    state.evidence[0]?.outcome !== "failed" ||
    state.repository.branch !== null ||
    state.repository.baseHead !== null
  ) {
    throw new LegacyMigrationError(
      "Imported governance state is not the planned paused migration record.",
      "integrity-failure",
    );
  }
  if (
    (await readRegularFile(rootDir, paths.statePath))?.toString("utf8") !==
    renderGovernanceProjection(state)
  ) {
    throw new LegacyMigrationError(
      "Imported governance projection is missing or changed.",
      "integrity-failure",
    );
  }
  await assertNoPointerTargets(rootDir, plan.targetWorkId);
}

async function createImportedTarget(
  rootDir: string,
  plan: LegacyMigrationPlan,
  options: LegacyMigrationOptions,
): Promise<void> {
  if (!plan.targetWorkId || !plan.evidenceId) {
    throw new LegacyMigrationError(
      "Import target identity is missing from the migration plan.",
      "invalid-journal",
    );
  }
  const paths = gedPathsForWorkId(rootDir, plan.targetWorkId);
  await Promise.all([
    assertSafeDirectoryChain(rootDir, path.dirname(paths.workDir)),
    assertSafeDirectoryChain(rootDir, path.dirname(paths.runtimeDir)),
  ]);
  await Promise.all([
    mkdir(paths.workDir, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
  ]);
  await Promise.all([
    assertSafeDirectoryChain(rootDir, paths.workDir),
    assertSafeDirectoryChain(rootDir, paths.runtimeDir),
  ]);
  await Promise.all([
    publishExact(rootDir, paths.specPath, DEFAULT_WORK_SPEC),
    publishExact(rootDir, paths.tasksPath, DEFAULT_WORK_TASKS),
    publishExact(rootDir, paths.testsPath, DEFAULT_WORK_TESTS),
    publishExact(rootDir, paths.notesPath, DEFAULT_WORK_NOTES),
  ]);
  await publishExact(
    rootDir,
    paths.metaPath,
    `${JSON.stringify(importedMeta(plan), null, 2)}\n`,
  );
  await options.afterPhase?.("target-files");

  const candidate = plan.candidates.find(
    (entry) => entry.id === plan.importDecision.candidateId,
  );
  if (!candidate) {
    throw new LegacyMigrationError(
      "Import candidate is absent from the migration plan.",
      "invalid-journal",
    );
  }
  const governanceBefore = await readRegularFile(rootDir, paths.governancePath);
  const projectionBefore = await readRegularFile(rootDir, paths.statePath);
  if (!governanceBefore && projectionBefore) {
    throw new LegacyMigrationError(
      "Migration target projection exists without authoritative governance state.",
      "artifact-conflict",
    );
  }
  try {
    await initializeGovernanceState(
      rootDir,
      plan.targetWorkId,
      {
        decision: {
          mode: "planned-change",
          reasonCode: "decision-needed",
          reason:
            "Legacy checkpoint state requires human review and cannot authorize current work.",
          requiresDecision: true,
        },
        executionProfile: "solo",
        lifecycle: "paused",
        evidence: [
          {
            id: plan.evidenceId,
            kind: "migration-required",
            source: "runtime",
            recordedAt: plan.createdAt,
            summary: `Legacy checkpoints from ${candidate.checkpointPath} were preserved in backup ${plan.backupId} but were not trusted as authorization.`,
            outcome: "failed",
          },
        ],
      },
      new Date(plan.createdAt),
    );
  } catch (error) {
    if (
      !(error instanceof GovernanceStoreError) ||
      error.code !== "already-exists"
    ) {
      throw error;
    }
    const existingState = await readGovernanceState(rootDir, plan.targetWorkId);
    const expectedProjection = renderGovernanceProjection(existingState);
    const existingProjection = await readRegularFile(rootDir, paths.statePath);
    if (existingProjection) {
      if (existingProjection.toString("utf8") !== expectedProjection) {
        throw new LegacyMigrationError(
          "Migration target projection conflicts with authoritative governance state.",
          "artifact-conflict",
        );
      }
    } else {
      await regenerateGovernanceProjection(rootDir, plan.targetWorkId);
    }
  }
  await options.afterPhase?.("governance");
  await verifyImportedTarget(rootDir, plan);
}

async function verifyJournalPrefix(
  rootDir: string,
  plan: LegacyMigrationPlan,
): Promise<{
  backup: PhaseMarker | null;
  started: PhaseMarker | null;
  imported: PhaseMarker | null;
  complete: PhaseMarker | null;
}> {
  const paths = legacyMigrationPaths(rootDir);
  const backup = await readMarker(
    rootDir,
    paths.backupCompletePath,
    plan,
    "backup-complete",
  );
  const started = await readMarker(
    rootDir,
    paths.importStartedPath,
    plan,
    "import-started",
  );
  const imported = await readMarker(
    rootDir,
    paths.importCompletePath,
    plan,
    "import-complete",
  );
  const complete = await readMarker(
    rootDir,
    paths.completePath,
    plan,
    "complete",
  );
  if (
    (started && !backup) ||
    (imported && !backup) ||
    (imported && plan.importDecision.outcome === "import" && !started) ||
    (complete && !imported) ||
    (plan.importDecision.outcome === "no-import" && started)
  ) {
    throw new LegacyMigrationError(
      "Legacy migration journal has a skipped or contradictory phase.",
      "invalid-journal",
    );
  }
  const expectedOutcome =
    plan.importDecision.outcome === "import" ? "imported" : "no-import";
  if (
    imported &&
    (imported.outcome !== expectedOutcome ||
      imported.targetWorkId !== plan.targetWorkId)
  ) {
    throw new LegacyMigrationError(
      "Legacy migration completion marker contradicts PLAN.json.",
      "invalid-journal",
    );
  }
  return { backup, started, imported, complete };
}

async function resumeMigration(
  rootDir: string,
  plan: LegacyMigrationPlan,
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationResult> {
  const paths = legacyMigrationPaths(rootDir);
  await verifyCurrentLegacyInventory(rootDir, plan);
  let phases = await verifyJournalPrefix(rootDir, plan);
  if (phases.complete) {
    await verifyBackup(rootDir, plan);
    if (plan.importDecision.outcome === "import") {
      await verifyImportedTarget(rootDir, plan);
    }
    return {
      status: "completed",
      outcome:
        plan.importDecision.outcome === "import" ? "imported" : "no-import",
      migrationId: plan.migrationId,
      backupId: plan.backupId,
      targetWorkId: plan.targetWorkId,
      reason: plan.importDecision.reason,
    };
  }

  if (!phases.backup) {
    await backUpSources(rootDir, plan, options);
    await verifyBackup(rootDir, plan);
    await publishMarker(
      rootDir,
      paths.backupCompletePath,
      markerFor(plan, "backup-complete"),
      plan,
    );
    await options.afterPhase?.("backup-complete");
    phases = await verifyJournalPrefix(rootDir, plan);
  } else {
    await verifyBackup(rootDir, plan);
  }

  if (plan.importDecision.outcome === "import") {
    if (!phases.started) {
      await publishMarker(
        rootDir,
        paths.importStartedPath,
        markerFor(plan, "import-started", {
          targetWorkId: plan.targetWorkId,
        }),
        plan,
      );
      await options.afterPhase?.("import-started");
    }
    if (!phases.imported) {
      await createImportedTarget(rootDir, plan, options);
    } else {
      await verifyImportedTarget(rootDir, plan);
    }
  }

  phases = await verifyJournalPrefix(rootDir, plan);
  if (!phases.imported) {
    const outcome =
      plan.importDecision.outcome === "import" ? "imported" : "no-import";
    await publishMarker(
      rootDir,
      paths.importCompletePath,
      markerFor(plan, "import-complete", {
        outcome,
        targetWorkId: plan.targetWorkId,
      }),
      plan,
    );
    await options.afterPhase?.("import-complete");
  }
  await publishMarker(
    rootDir,
    paths.completePath,
    markerFor(plan, "complete"),
    plan,
  );
  await options.afterPhase?.("complete");
  return {
    status: "completed",
    outcome:
      plan.importDecision.outcome === "import" ? "imported" : "no-import",
    migrationId: plan.migrationId,
    backupId: plan.backupId,
    targetWorkId: plan.targetWorkId,
    reason: plan.importDecision.reason,
  };
}

export async function ensureLegacyCheckpointMigration(
  rootDir: string,
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const root = path.resolve(rootDir);
  const paths = legacyMigrationPaths(root);
  return withProcessQueue(paths.planPath, async () => {
    await Promise.all([
      assertSafeDirectoryChain(root, paths.migrationDir),
      assertSafeDirectoryChain(root, path.join(root, GED_DIR, "work")),
    ]);
    let planRaw = await readRegularFile(root, paths.planPath);
    let plan: LegacyMigrationPlan;
    if (planRaw) {
      plan = parsePlan(root, planRaw);
    } else {
      const discovery = await discoverLegacy(root);
      if (discovery.candidates.length === 0) return { status: "not-needed" };
      const proposed = buildPlan(
        root,
        discovery.candidates,
        discovery.files,
        options,
      );
      const created = await publishJson(paths.planPath, proposed);
      planRaw = await readRegularFile(root, paths.planPath);
      if (!planRaw) {
        throw new LegacyMigrationError(
          "Published migration plan disappeared.",
          "integrity-failure",
        );
      }
      plan = parsePlan(root, planRaw);
      if (created && JSON.stringify(plan) !== JSON.stringify(proposed)) {
        throw new LegacyMigrationError(
          "Published migration plan does not match its source proposal.",
          "artifact-conflict",
        );
      }
      await options.afterPhase?.("plan");
    }
    return resumeMigration(root, plan, options);
  });
}
