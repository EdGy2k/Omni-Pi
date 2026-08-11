import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { publishFileExclusive, writeFileAtomic } from "./atomic.js";
import { GED_DIR } from "./contracts.js";
import { isGeneratedWorkId, relativeGedPath } from "./ged-paths.js";
import {
  assertSafeRepositoryReadPath,
  assertSafeRepositoryWritePath,
} from "./path-safety.js";

const MIGRATION_SCHEMA_VERSION = 1;
const MIGRATION_ID = "durable-memory-v3";
const STATE_PATH = path.join(GED_DIR, "MEMORY-MIGRATION.json");
const MIGRATION_RUNTIME = path.join(
  GED_DIR,
  "runtime",
  "migrations",
  MIGRATION_ID,
);
const JOURNAL_PATH = path.join(MIGRATION_RUNTIME, "JOURNAL.json");

export interface DurableMemoryMigrationEntry {
  sourcePath: string;
  action:
    | "removed-placeholder"
    | "migrated-context"
    | "migrated-decisions"
    | "migrated-task-artifact"
    | "retained-substantive";
  sha256?: string;
  backupPath?: string;
  destinationPath?: string;
  reason?: string;
}

export interface DurableMemoryMigrationState {
  schemaVersion: 1;
  migrationId: typeof MIGRATION_ID;
  status: "complete";
  completedAt: string;
  entries: DurableMemoryMigrationEntry[];
}

export interface DurableMemoryMigrationResult {
  status: "not-needed" | "completed" | "already-complete";
  state?: DurableMemoryMigrationState;
}

export interface DurableMemoryMigrationOptions {
  beforeSourceCommit?: (sourcePath: string) => void | Promise<void>;
  afterSourceCommit?: (sourcePath: string) => void | Promise<void>;
}

interface DurableMemoryMigrationJournal {
  schemaVersion: 1;
  migrationId: typeof MIGRATION_ID;
  entries: DurableMemoryMigrationEntry[];
}

type RecordMigrationEntry = (
  entry: DurableMemoryMigrationEntry,
) => Promise<void>;

const LEGACY_PLACEHOLDERS = new Map<string, string>([
  [
    ".ged/CONTEXT-MAP.md",
    `# Context Map\n\nGed memory is current-state oriented. Durable root files describe the project as it is now; active work and runtime state are scoped by immutable work-item IDs rather than branches.\n\n## Durable root memory\n\n- \`.ged/PROJECT.md\` — product goal, users, constraints, success criteria, repo signals.\n- \`.ged/ARCHITECTURE.md\` — current component boundaries and system shape.\n- \`.ged/PATTERNS.md\` — conventions and implementation patterns.\n- \`.ged/GLOSSARY.md\` — project/domain vocabulary.\n- \`.ged/DECISIONS.md\` — durable decisions and rationale.\n- \`.ged/STANDARDS.md\` — imported repo-wide agent standards.\n- \`.ged/SKILLS.md\` — durable skill guidance.\n\n## Active work memory\n\n- \`.ged/work/<work-id>/SPEC.md\`\n- \`.ged/work/<work-id>/TASKS.md\`\n- \`.ged/work/<work-id>/TESTS.md\`\n- \`.ged/work/<work-id>/NOTES.md\`\n- \`.ged/work/<work-id>/META.json\`\n\n## Runtime memory\n\n- \`.ged/runtime/active-work/<session-key>.json\` (ignored session selection)\n- \`.ged/runtime/<work-id>/governance.json\` (authoritative structured state)\n- \`.ged/runtime/<work-id>/STATE.md\`\n- \`.ged/runtime/<work-id>/SESSION-SUMMARY.md\`\n`,
  ],
  [
    ".ged/PROJECT.md",
    `# Project\n\n## Goal\n\nDescribe what this project should achieve.\n\n## Users\n\n- Primary users:\n- Secondary users:\n\n## Constraints\n\n- Technical constraints:\n- Product constraints:\n\n## Success Criteria\n\n- What does success look like?\n`,
  ],
  [
    ".ged/ARCHITECTURE.md",
    "# Architecture\n\nDescribe current system components, boundaries, and data flow.\n",
  ],
  [
    ".ged/PATTERNS.md",
    "# Patterns\n\nRecord implementation conventions and recurring workflow patterns.\n",
  ],
  [".ged/GLOSSARY.md", "# Glossary\n\nRecord domain terms and definitions.\n"],
  [
    ".ged/IDEAS.md",
    "# Ideas\n\n## Active ideas\n\n-\n\n## Future ideas\n\n-\n\n## Parking lot\n\n-\n",
  ],
  [
    ".ged/DECISIONS.md",
    "# Decisions\n\nRecord important choices here as the project evolves.\n\n## Entries\n\n- Date: YYYY-MM-DD\n  - Decision:\n  - Why:\n  - Impact:\n",
  ],
  [
    ".ged/STANDARDS.md",
    "# Imported Standards\n\nThese standards were imported from other harness-specific instruction files and approved for Ged use.\n\nNo imported standards have been accepted yet.\n",
  ],
  [
    ".ged/SKILLS.md",
    "# Skills\n\n## Installed\n\n- None yet\n\n## Recommended\n\n- None yet\n\n## Deferred\n\n- None yet\n\n## Rejected\n\n- None yet\n\n## Usage Notes\n\n- Record why a skill was installed, recommended, or skipped.\n",
  ],
  [".ged/PROGRESS.md", "# Progress\n\nOngoing log of project progress.\n\n"],
  [
    ".ged/plans/INDEX.md",
    "# Plan Index\n\n| ID | Title | Status | Created | Completed |\n| --- | --- | --- | --- | --- |\n",
  ],
  [
    ".ged/project-skills/README.md",
    "# Project Skills\n\nStore project-scoped skills that Ged auto-installs or creates for active tasks here.\n",
  ],
  [
    ".ged/research/README.md",
    "# Research\n\nStore external research summaries and package notes here.\n",
  ],
  [
    ".ged/specs/README.md",
    "# Specs\n\nStore durable detailed specs here when they remain useful after active work completes.\n",
  ],
  [
    ".ged/tasks/README.md",
    "# Task Artifacts\n\nStore per-task briefs, outputs, and failure histories here when they should outlive runtime summaries.\n",
  ],
  [".ged/SKILLS-STATE.json", '{\n  "managed": []\n}\n'],
  [
    ".pi/agents/ged-brain.md",
    `---\nname: ged-brain\ndescription: GedPi brain for user-facing clarifying, planning, and implementation\nmodel: anthropic/claude-opus-4-6\ntools: read, grep, find, ls, bash\nskill: ged-planning, ged-execution, ged-verification\n---\n\nYou are GedPi's only user-facing agent.\n\nClarify with grill-me until the requested behavior, constraints, and success criteria are concrete enough to implement safely.\nWrite durable project context into .ged/PROJECT.md and active work context into .ged/work/<work-id>/SPEC.md.\nBreak the work into bounded slices in .ged/work/<work-id>/TASKS.md before editing code.\nRun the planned checks, record outcomes in .ged/runtime/<work-id>/STATE.md and .ged/runtime/<work-id>/SESSION-SUMMARY.md, and tighten the plan if a slice fails.\n`,
  ],
]);

function digest(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOptionalBuffer(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

const MIGRATION_ACTIONS = new Set<DurableMemoryMigrationEntry["action"]>([
  "removed-placeholder",
  "migrated-context",
  "migrated-decisions",
  "migrated-task-artifact",
  "retained-substantive",
]);

function isSafeMigrationPath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).some((segment) => segment === "..")
  );
}

function parseMigrationEntry(value: unknown): DurableMemoryMigrationEntry {
  if (!value || typeof value !== "object") {
    throw new Error("Ged durable-memory migration entry is invalid.");
  }
  const entry = value as Partial<DurableMemoryMigrationEntry>;
  if (
    typeof entry.sourcePath !== "string" ||
    !isSafeMigrationPath(entry.sourcePath) ||
    typeof entry.action !== "string" ||
    !MIGRATION_ACTIONS.has(
      entry.action as DurableMemoryMigrationEntry["action"],
    ) ||
    (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(entry.sha256)) ||
    (entry.backupPath !== undefined &&
      (typeof entry.backupPath !== "string" ||
        !isSafeMigrationPath(entry.backupPath))) ||
    (entry.destinationPath !== undefined &&
      (typeof entry.destinationPath !== "string" ||
        !isSafeMigrationPath(entry.destinationPath))) ||
    (entry.reason !== undefined &&
      (typeof entry.reason !== "string" || !entry.reason.trim()))
  ) {
    throw new Error("Ged durable-memory migration entry is invalid.");
  }
  if (
    entry.action === "removed-placeholder" &&
    (entry.sha256 !== undefined ||
      entry.backupPath !== undefined ||
      entry.destinationPath !== undefined)
  ) {
    throw new Error("Ged placeholder migration entry is invalid.");
  }
  if (
    entry.action !== "removed-placeholder" &&
    (entry.sha256 === undefined || entry.backupPath === undefined)
  ) {
    throw new Error("Ged substantive migration entry lacks backup evidence.");
  }
  if (
    entry.action.startsWith("migrated-") &&
    entry.destinationPath === undefined
  ) {
    throw new Error("Ged migrated entry lacks a destination.");
  }
  if (entry.action === "retained-substantive" && !entry.reason) {
    throw new Error("Ged retained migration entry lacks a reason.");
  }
  return entry as DurableMemoryMigrationEntry;
}

async function readCompletedState(
  rootDir: string,
): Promise<DurableMemoryMigrationState | null> {
  const raw = await readOptionalBuffer(path.join(rootDir, STATE_PATH));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Ged durable-memory migration state is malformed.");
  }
  const value = parsed as Partial<DurableMemoryMigrationState>;
  if (
    value.schemaVersion !== MIGRATION_SCHEMA_VERSION ||
    value.migrationId !== MIGRATION_ID ||
    value.status !== "complete" ||
    typeof value.completedAt !== "string" ||
    Number.isNaN(Date.parse(value.completedAt)) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Ged durable-memory migration state is unsupported.");
  }
  return {
    ...(value as DurableMemoryMigrationState),
    entries: value.entries.map(parseMigrationEntry),
  };
}

async function readMigrationJournal(
  rootDir: string,
): Promise<DurableMemoryMigrationJournal> {
  const content = await readOptionalBuffer(path.join(rootDir, JOURNAL_PATH));
  if (!content) {
    return { schemaVersion: 1, migrationId: MIGRATION_ID, entries: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Ged durable-memory migration journal is malformed.");
  }
  const journal = parsed as Partial<DurableMemoryMigrationJournal>;
  if (
    journal.schemaVersion !== 1 ||
    journal.migrationId !== MIGRATION_ID ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error("Ged durable-memory migration journal is unsupported.");
  }
  return {
    ...(journal as DurableMemoryMigrationJournal),
    entries: journal.entries.map(parseMigrationEntry),
  };
}

function migrationEntryKey(entry: DurableMemoryMigrationEntry): string {
  return JSON.stringify([
    entry.sourcePath,
    entry.action,
    entry.sha256 ?? null,
    entry.backupPath ?? null,
    entry.destinationPath ?? null,
    entry.reason ?? null,
  ]);
}

async function backupSource(
  rootDir: string,
  sourcePath: string,
  content: Buffer,
): Promise<{ sha256: string; backupPath: string }> {
  const sha256 = digest(content);
  const backupPath = path.join(MIGRATION_RUNTIME, "backups", sourcePath);
  const absoluteBackup = path.join(rootDir, backupPath);
  await assertSafeRepositoryWritePath(rootDir, absoluteBackup);
  const created = await publishFileExclusive(absoluteBackup, content);
  if (!created) {
    const existing = await readFile(absoluteBackup);
    if (digest(existing) !== sha256) {
      throw new Error(`Durable-memory backup conflict for ${sourcePath}.`);
    }
  }
  return { sha256, backupPath };
}

function migrationMarker(kind: string, sha256: string): string {
  return `ged-memory-v3:${kind}:${sha256}`;
}

async function requireUnchangedSource(
  rootDir: string,
  sourcePath: string,
  expectedSha256: string,
  options: DurableMemoryMigrationOptions,
): Promise<void> {
  await options.beforeSourceCommit?.(sourcePath);
  const current = await readOptionalBuffer(path.join(rootDir, sourcePath));
  if (!current || digest(current) !== expectedSha256) {
    throw new Error(
      `Legacy source changed during durable-memory migration: ${sourcePath}`,
    );
  }
}

async function appendCanonicalContent(
  rootDir: string,
  destination: string,
  heading: string,
  source: string,
  kind: string,
  sha256: string,
): Promise<void> {
  const marker = migrationMarker(kind, sha256);
  await assertSafeRepositoryWritePath(rootDir, destination);
  const existing =
    (await readOptionalBuffer(destination))?.toString("utf8") ?? "";
  if (existing.includes(marker)) return;
  const section = `<!-- ${marker}:begin -->\n## ${heading}\n\n${source}${source.endsWith("\n") ? "" : "\n"}<!-- ${marker}:end -->\n`;
  const prefix = existing.trimEnd();
  await writeFileAtomic(
    destination,
    `${prefix ? `${prefix}\n\n` : "# Project Context\n\n"}${section}`,
  );
}

async function migrateGlossary(
  rootDir: string,
  content: Buffer,
  options: DurableMemoryMigrationOptions,
  recordEntry: RecordMigrationEntry,
): Promise<DurableMemoryMigrationEntry> {
  const sourcePath = ".ged/GLOSSARY.md";
  const backup = await backupSource(rootDir, sourcePath, content);
  await requireUnchangedSource(rootDir, sourcePath, backup.sha256, options);
  const destinationPath = "CONTEXT.md";
  await appendCanonicalContent(
    rootDir,
    path.join(rootDir, destinationPath),
    "Migrated Ged glossary",
    content.toString("utf8"),
    "context",
    backup.sha256,
  );
  const entry: DurableMemoryMigrationEntry = {
    sourcePath,
    action: "migrated-context",
    ...backup,
    destinationPath,
  };
  await recordEntry(entry);
  await writeFileAtomic(
    path.join(rootDir, sourcePath),
    `# Glossary moved\n\nCanonical project and domain vocabulary now lives in [../CONTEXT.md](../CONTEXT.md).\n\nMigration content hash: ${backup.sha256}\n`,
  );
  await options.afterSourceCommit?.(sourcePath);
  return entry;
}

async function migrateDecisions(
  rootDir: string,
  content: Buffer,
  options: DurableMemoryMigrationOptions,
  recordEntry: RecordMigrationEntry,
): Promise<DurableMemoryMigrationEntry> {
  const sourcePath = ".ged/DECISIONS.md";
  const backup = await backupSource(rootDir, sourcePath, content);
  await requireUnchangedSource(rootDir, sourcePath, backup.sha256, options);
  const destinationPath = `docs/adr/0000-migrated-ged-decisions-${backup.sha256.slice(0, 12)}.md`;
  const marker = migrationMarker("decisions", backup.sha256);
  const destination = path.join(rootDir, destinationPath);
  await assertSafeRepositoryWritePath(rootDir, destination);
  const existing = await readOptionalBuffer(destination);
  if (existing && !existing.toString("utf8").includes(marker)) {
    throw new Error(`ADR destination conflict at ${destinationPath}.`);
  }
  if (!existing) {
    await writeFileAtomic(
      destination,
      `# ADR 0000: Migrated Ged decisions\n\nStatus: migrated\n\n<!-- ${marker}:begin -->\n${content.toString("utf8")}${content.toString("utf8").endsWith("\n") ? "" : "\n"}<!-- ${marker}:end -->\n`,
    );
  }
  const entry: DurableMemoryMigrationEntry = {
    sourcePath,
    action: "migrated-decisions",
    ...backup,
    destinationPath,
  };
  await recordEntry(entry);
  await writeFileAtomic(
    path.join(rootDir, sourcePath),
    `# Decisions moved\n\nCanonical durable decisions now live in [../${destinationPath}](../${destinationPath}).\n\nMigration content hash: ${backup.sha256}\n`,
  );
  await options.afterSourceCommit?.(sourcePath);
  return entry;
}

function legacyTaskDescriptor(
  fileName: string,
): { taskId: string; artifact: string } | null {
  const descriptor = (taskId: string, artifact: string) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(taskId)
      ? { taskId, artifact }
      : null;
  const brief = fileName.match(/^([A-Za-z0-9._-]+)-BRIEF\.md$/u);
  if (brief) return descriptor(brief[1], "BRIEF.md");
  const history = fileName.match(/^([A-Za-z0-9._-]+)\.history\.json$/u);
  if (history) return descriptor(history[1], "HISTORY.json");
  const recovery = fileName.match(/^([A-Za-z0-9._-]+)-RECOVERY\.md$/u);
  if (recovery) return descriptor(recovery[1], "RECOVERY.md");
  return null;
}

async function uniqueLegacyTaskDestination(
  rootDir: string,
  fileName: string,
): Promise<string | null> {
  const descriptor = legacyTaskDescriptor(fileName);
  if (!descriptor) return null;
  let workIds: string[];
  try {
    workIds = (
      await readdir(path.join(rootDir, GED_DIR, "work"), {
        withFileTypes: true,
      })
    )
      .filter((entry) => entry.isDirectory() && isGeneratedWorkId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }

  const owners: string[] = [];
  for (const workId of workIds) {
    const workDir = path.join(rootDir, GED_DIR, "work", workId);
    const tasks = await readOptionalBuffer(path.join(workDir, "TASKS.md"));
    if (!tasks) continue;
    const ownsTask = tasks
      .toString("utf8")
      .split("\n")
      .some((line) => line.split("|")[1]?.trim() === descriptor.taskId);
    if (ownsTask) owners.push(workDir);
  }
  return owners.length === 1
    ? path.join(owners[0], "tasks", descriptor.taskId, descriptor.artifact)
    : null;
}

async function migrateLegacyTasks(
  rootDir: string,
  options: DurableMemoryMigrationOptions,
  recordEntry: RecordMigrationEntry,
): Promise<DurableMemoryMigrationEntry[]> {
  const legacyDir = path.join(rootDir, GED_DIR, "tasks");
  await assertSafeRepositoryReadPath(rootDir, legacyDir);
  let files: string[];
  try {
    files = (await readdir(legacyDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== "README.md")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const entries: DurableMemoryMigrationEntry[] = [];
  for (const file of files) {
    const source = path.join(legacyDir, file);
    await assertSafeRepositoryReadPath(rootDir, source);
    const sourcePath = relativeGedPath(rootDir, source);
    const content = await readFile(source);
    const backup = await backupSource(rootDir, sourcePath, content);
    const destination = await uniqueLegacyTaskDestination(rootDir, file);
    if (!destination) {
      const entry: DurableMemoryMigrationEntry = {
        sourcePath,
        action: "retained-substantive",
        ...backup,
        reason:
          "Legacy task artifact has no unambiguous active work destination.",
      };
      await recordEntry(entry);
      entries.push(entry);
      continue;
    }
    await requireUnchangedSource(rootDir, sourcePath, backup.sha256, options);
    await assertSafeRepositoryWritePath(rootDir, destination);
    const created = await publishFileExclusive(destination, content);
    if (!created && digest(await readFile(destination)) !== backup.sha256) {
      const entry: DurableMemoryMigrationEntry = {
        sourcePath,
        action: "retained-substantive",
        ...backup,
        reason: "Work-scoped task destination contains different bytes.",
      };
      await recordEntry(entry);
      entries.push(entry);
      continue;
    }
    const latest = await readOptionalBuffer(source);
    if (!latest || digest(latest) !== backup.sha256) {
      const entry: DurableMemoryMigrationEntry = {
        sourcePath,
        action: "retained-substantive",
        ...backup,
        destinationPath: relativeGedPath(rootDir, destination),
        reason:
          "Legacy task source changed after copy; preserved for manual reconciliation.",
      };
      await recordEntry(entry);
      entries.push(entry);
      continue;
    }
    const entry: DurableMemoryMigrationEntry = {
      sourcePath,
      action: "migrated-task-artifact",
      ...backup,
      destinationPath: relativeGedPath(rootDir, destination),
    };
    await recordEntry(entry);
    await rm(source);
    await options.afterSourceCommit?.(sourcePath);
    entries.push(entry);
  }
  return entries;
}

async function walkRegularFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRegularFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

const AMBIGUOUS_LEGACY_PATHS = [
  ".ged/CONFIG.md",
  ".ged/CONTEXT-MAP.md",
  ".ged/ARCHITECTURE.md",
  ".ged/PATTERNS.md",
  ".ged/IDEAS.md",
  ".ged/PROGRESS.md",
  ".ged/SKILLS.md",
] as const;

async function hasActionableLegacyMemory(rootDir: string): Promise<boolean> {
  for (const [sourcePath, placeholder] of LEGACY_PLACEHOLDERS) {
    const absoluteSource = path.join(rootDir, sourcePath);
    await assertSafeRepositoryReadPath(rootDir, absoluteSource);
    const content = await readOptionalBuffer(absoluteSource);
    if (content?.toString("utf8") === placeholder) return true;
  }
  for (const [sourcePath, pointerHeading] of [
    [".ged/GLOSSARY.md", "# Glossary moved"],
    [".ged/DECISIONS.md", "# Decisions moved"],
  ] as const) {
    const absoluteSource = path.join(rootDir, sourcePath);
    await assertSafeRepositoryReadPath(rootDir, absoluteSource);
    const content = await readOptionalBuffer(absoluteSource);
    if (content && !content.toString("utf8").startsWith(pointerHeading)) {
      return true;
    }
  }
  for (const directory of [
    "tasks",
    "project-skills",
    "plans",
    "research",
    "specs",
  ] as const) {
    const absoluteDirectory = path.join(rootDir, GED_DIR, directory);
    await assertSafeRepositoryReadPath(rootDir, absoluteDirectory);
    if (
      (await walkRegularFiles(absoluteDirectory)).some(
        (file) => path.basename(file) !== "README.md",
      )
    ) {
      return true;
    }
  }
  return false;
}

interface MigrationLockOwner {
  schemaVersion: 1;
  pid: number;
  token: string;
  startedAt: string;
}

function parseLockOwner(raw: string): MigrationLockOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Ged durable-memory migration lock is malformed.");
  }
  const owner = parsed as Partial<MigrationLockOwner>;
  if (
    owner.schemaVersion !== 1 ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(owner.token) ||
    typeof owner.startedAt !== "string" ||
    Number.isNaN(Date.parse(owner.startedAt))
  ) {
    throw new Error("Ged durable-memory migration lock is invalid.");
  }
  return owner as MigrationLockOwner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

async function releaseMigrationLock(
  lockPath: string,
  token: string,
): Promise<void> {
  const raw = await readOptionalBuffer(lockPath);
  if (!raw) return;
  if (parseLockOwner(raw.toString("utf8")).token === token) {
    await unlink(lockPath);
  }
}

interface MigrationLockCandidate {
  path: string;
  owner: MigrationLockOwner;
  mtimeNs: bigint;
  inode: bigint;
}

async function readMigrationLockCandidates(
  locksDir: string,
): Promise<MigrationLockCandidate[]> {
  const names = (await readdir(locksDir))
    .filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name))
    .sort();
  const candidates: MigrationLockCandidate[] = [];
  for (const name of names) {
    const lockPath = path.join(locksDir, name);
    const raw = await readOptionalBuffer(lockPath);
    if (!raw) continue;
    const owner = parseLockOwner(raw.toString("utf8"));
    if (`${owner.token}.json` !== name) {
      throw new Error("Ged durable-memory migration lock token is invalid.");
    }
    const metadata = await stat(lockPath, { bigint: true }).catch(() => null);
    if (!metadata) continue;
    candidates.push({
      path: lockPath,
      owner,
      mtimeNs: metadata.mtimeNs,
      inode: metadata.ino,
    });
  }
  return candidates;
}

function compareMigrationLocks(
  left: MigrationLockCandidate,
  right: MigrationLockCandidate,
): number {
  if (left.mtimeNs !== right.mtimeNs) {
    return left.mtimeNs < right.mtimeNs ? -1 : 1;
  }
  if (left.inode !== right.inode) return left.inode < right.inode ? -1 : 1;
  return left.owner.token.localeCompare(right.owner.token);
}

export async function migrateDurableMemory(
  rootDir: string,
  options: DurableMemoryMigrationOptions = {},
): Promise<DurableMemoryMigrationResult> {
  const completed = await readCompletedState(rootDir);
  if (completed) return { status: "already-complete", state: completed };

  const gedRoot = path.join(rootDir, GED_DIR);
  const version = await readOptionalBuffer(path.join(gedRoot, "VERSION"));
  if (!version) {
    return { status: "not-needed" };
  }
  const parsedVersion = Number.parseInt(version.toString("utf8").trim(), 10);
  if (
    Number.isFinite(parsedVersion) &&
    parsedVersion >= 3 &&
    !(await hasActionableLegacyMemory(rootDir))
  ) {
    return { status: "not-needed" };
  }

  const locksDir = path.join(rootDir, MIGRATION_RUNTIME, "LOCKS");
  await assertSafeRepositoryWritePath(rootDir, locksDir);
  await mkdir(locksDir, { recursive: true });
  const lockOwner: MigrationLockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const lockPath = path.join(locksDir, `${lockOwner.token}.json`);
  await assertSafeRepositoryWritePath(rootDir, lockPath);
  if (
    !(await publishFileExclusive(
      lockPath,
      `${JSON.stringify(lockOwner, null, 2)}\n`,
    ))
  ) {
    throw new Error("Ged durable-memory migration lock token collided.");
  }
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const converged = await readCompletedState(rootDir);
      if (converged) {
        return { status: "already-complete", state: converged };
      }
      const candidates = await readMigrationLockCandidates(locksDir);
      for (const candidate of candidates) {
        if (processIsAlive(candidate.owner.pid)) continue;
        const stalePath = path.join(
          path.dirname(locksDir),
          `STALE-${candidate.owner.token}.json`,
        );
        try {
          await rename(candidate.path, stalePath);
        } catch {
          // Another recovering process already moved this token-specific lock.
        }
      }
      const live = (await readMigrationLockCandidates(locksDir))
        .filter((candidate) => processIsAlive(candidate.owner.pid))
        .sort(compareMigrationLocks);
      if (live[0]?.owner.token === lockOwner.token) {
        acquired = true;
        break;
      }
      await delay(25);
    }
    if (!acquired) {
      throw new Error(
        "Ged durable-memory migration is already running or needs manual recovery.",
      );
    }

    const journal = await readMigrationJournal(rootDir);
    const entries = [...journal.entries];
    const recordEntry: RecordMigrationEntry = async (entry) => {
      const key = migrationEntryKey(entry);
      if (!entries.some((existing) => migrationEntryKey(existing) === key)) {
        entries.push(entry);
      }
      const nextJournal: DurableMemoryMigrationJournal = {
        schemaVersion: 1,
        migrationId: MIGRATION_ID,
        entries,
      };
      const journalPath = path.join(rootDir, JOURNAL_PATH);
      await assertSafeRepositoryWritePath(rootDir, journalPath);
      await writeFileAtomic(
        journalPath,
        `${JSON.stringify(nextJournal, null, 2)}\n`,
      );
    };
    for (const [sourcePath, placeholder] of LEGACY_PLACEHOLDERS) {
      const absolute = path.join(rootDir, sourcePath);
      await assertSafeRepositoryReadPath(rootDir, absolute);
      const content = await readOptionalBuffer(absolute);
      if (!content || content.toString("utf8") !== placeholder) continue;
      await options.beforeSourceCommit?.(sourcePath);
      if (
        (await readOptionalBuffer(absolute))?.toString("utf8") !== placeholder
      ) {
        throw new Error(
          `Legacy placeholder changed during durable-memory migration: ${sourcePath}`,
        );
      }
      const entry: DurableMemoryMigrationEntry = {
        sourcePath,
        action: "removed-placeholder",
      };
      await recordEntry(entry);
      await rm(absolute);
      await options.afterSourceCommit?.(sourcePath);
    }

    const glossaryPath = path.join(rootDir, GED_DIR, "GLOSSARY.md");
    await assertSafeRepositoryReadPath(rootDir, glossaryPath);
    const glossary = await readOptionalBuffer(glossaryPath);
    if (glossary && !glossary.toString("utf8").startsWith("# Glossary moved")) {
      await migrateGlossary(rootDir, glossary, options, recordEntry);
    }
    const decisionsPath = path.join(rootDir, GED_DIR, "DECISIONS.md");
    await assertSafeRepositoryReadPath(rootDir, decisionsPath);
    const decisions = await readOptionalBuffer(decisionsPath);
    if (
      decisions &&
      !decisions.toString("utf8").startsWith("# Decisions moved")
    ) {
      await migrateDecisions(rootDir, decisions, options, recordEntry);
    }

    await migrateLegacyTasks(rootDir, options, recordEntry);

    for (const sourcePath of AMBIGUOUS_LEGACY_PATHS) {
      const absoluteSource = path.join(rootDir, sourcePath);
      await assertSafeRepositoryReadPath(rootDir, absoluteSource);
      const content = await readOptionalBuffer(absoluteSource);
      if (!content) continue;
      const backup = await backupSource(rootDir, sourcePath, content);
      await recordEntry({
        sourcePath,
        action: "retained-substantive",
        ...backup,
        reason: "No unambiguous canonical destination; preserved in place.",
      });
    }

    const legacySkills = path.join(rootDir, GED_DIR, "project-skills");
    const legacySkillFiles = await walkRegularFiles(legacySkills);
    for (const skillFile of legacySkillFiles) {
      await assertSafeRepositoryReadPath(rootDir, skillFile);
      const sourcePath = relativeGedPath(rootDir, skillFile);
      const content = await readFile(skillFile);
      const backup = await backupSource(rootDir, sourcePath, content);
      await recordEntry({
        sourcePath,
        action: "retained-substantive",
        ...backup,
        reason:
          "Legacy task-generated or edited skills lack unchanged provenance; quarantined from native .agents/skills discovery until explicitly promoted.",
      });
    }

    for (const legacyDir of ["plans", "research", "specs"] as const) {
      const files = await walkRegularFiles(
        path.join(rootDir, GED_DIR, legacyDir),
      );
      for (const file of files) {
        await assertSafeRepositoryReadPath(rootDir, file);
        const sourcePath = relativeGedPath(rootDir, file);
        if (
          entries.some(
            (entry) =>
              entry.sourcePath === sourcePath &&
              entry.action === "removed-placeholder",
          )
        ) {
          continue;
        }
        const content = await readFile(file);
        const backup = await backupSource(rootDir, sourcePath, content);
        await recordEntry({
          sourcePath,
          action: "retained-substantive",
          ...backup,
          reason:
            "Legacy global artifact has no unambiguous canonical work destination.",
        });
      }
    }

    const state: DurableMemoryMigrationState = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      migrationId: MIGRATION_ID,
      status: "complete",
      completedAt: new Date().toISOString(),
      entries,
    };
    await assertSafeRepositoryWritePath(
      rootDir,
      path.join(rootDir, STATE_PATH),
    );
    await writeFileAtomic(
      path.join(rootDir, STATE_PATH),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    return { status: "completed", state };
  } finally {
    await releaseMigrationLock(lockPath, lockOwner.token);
  }
}
