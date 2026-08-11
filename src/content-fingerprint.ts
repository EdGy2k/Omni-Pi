import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

export const REPOSITORY_SNAPSHOT_VERSION = 1 as const;
export const LARGE_FILE_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface RepositoryPathFingerprint {
  path: string;
  indexDigest: string | null;
  worktreeDigest: string | null;
}

export interface RepositorySnapshot {
  version: typeof REPOSITORY_SNAPSHOT_VERSION;
  repositoryRoot: string;
  git: boolean;
  head: string | null;
  headTree: string | null;
  indexTree: string | null;
  stagedDigest: string;
  unstagedDigest: string;
  untrackedDigest: string;
  stagedPaths: string[];
  unstagedPaths: string[];
  untrackedPaths: string[];
  paths: RepositoryPathFingerprint[];
  digest: string;
}

export interface FileSetFingerprint {
  digest: string;
  paths: string[];
}

const DIGEST = /^[a-f0-9]{64}$/u;

export function isRepositorySnapshot(
  value: unknown,
): value is RepositorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<RepositorySnapshot>;
  const allowed = [
    "version",
    "repositoryRoot",
    "git",
    "head",
    "headTree",
    "indexTree",
    "stagedDigest",
    "unstagedDigest",
    "untrackedDigest",
    "stagedPaths",
    "unstagedPaths",
    "untrackedPaths",
    "paths",
    "digest",
  ];
  if (
    Object.keys(snapshot).some((key) => !allowed.includes(key)) ||
    snapshot.version !== REPOSITORY_SNAPSHOT_VERSION ||
    typeof snapshot.repositoryRoot !== "string" ||
    !path.isAbsolute(snapshot.repositoryRoot) ||
    typeof snapshot.git !== "boolean" ||
    !(
      snapshot.head === null ||
      (typeof snapshot.head === "string" &&
        /^[a-f0-9]{40,64}$/u.test(snapshot.head))
    ) ||
    !(
      snapshot.headTree === null ||
      (typeof snapshot.headTree === "string" &&
        /^[a-f0-9]{40,64}$/u.test(snapshot.headTree))
    ) ||
    !(
      snapshot.indexTree === null ||
      (typeof snapshot.indexTree === "string" &&
        /^[a-f0-9]{40,64}$/u.test(snapshot.indexTree))
    ) ||
    typeof snapshot.stagedDigest !== "string" ||
    !DIGEST.test(snapshot.stagedDigest) ||
    typeof snapshot.unstagedDigest !== "string" ||
    !DIGEST.test(snapshot.unstagedDigest) ||
    typeof snapshot.untrackedDigest !== "string" ||
    !DIGEST.test(snapshot.untrackedDigest) ||
    typeof snapshot.digest !== "string" ||
    !DIGEST.test(snapshot.digest) ||
    !Array.isArray(snapshot.stagedPaths) ||
    !Array.isArray(snapshot.unstagedPaths) ||
    !Array.isArray(snapshot.untrackedPaths) ||
    !Array.isArray(snapshot.paths)
  )
    return false;
  if (
    !snapshot.stagedPaths.every(
      (entry) => typeof entry === "string" && entry.length > 0,
    ) ||
    !snapshot.unstagedPaths.every(
      (entry) => typeof entry === "string" && entry.length > 0,
    ) ||
    !snapshot.untrackedPaths.every(
      (entry) => typeof entry === "string" && entry.length > 0,
    ) ||
    !snapshot.paths.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return false;
      const record = entry as unknown as Record<string, unknown>;
      return (
        Object.keys(record).every((key) =>
          ["path", "indexDigest", "worktreeDigest"].includes(key),
        ) &&
        typeof record.path === "string" &&
        record.path.length > 0 &&
        (record.indexDigest === null ||
          (typeof record.indexDigest === "string" &&
            DIGEST.test(record.indexDigest))) &&
        (record.worktreeDigest === null ||
          (typeof record.worktreeDigest === "string" &&
            DIGEST.test(record.worktreeDigest)))
      );
    })
  )
    return false;
  const paths = snapshot.paths as RepositoryPathFingerprint[];
  const names = paths.map((entry) => entry.path);
  const sorted = (items: string[]) =>
    [...items].sort((a, b) => a.localeCompare(b));
  const byPath = new Map(paths.map((entry) => [entry.path, entry]));
  if (
    new Set(names).size !== names.length ||
    new Set(snapshot.stagedPaths).size !== snapshot.stagedPaths.length ||
    new Set(snapshot.unstagedPaths).size !== snapshot.unstagedPaths.length ||
    new Set(snapshot.untrackedPaths).size !== snapshot.untrackedPaths.length ||
    JSON.stringify(names) !== JSON.stringify(sorted(names)) ||
    JSON.stringify(snapshot.stagedPaths) !==
      JSON.stringify(sorted(snapshot.stagedPaths)) ||
    JSON.stringify(snapshot.unstagedPaths) !==
      JSON.stringify(sorted(snapshot.unstagedPaths)) ||
    JSON.stringify(snapshot.untrackedPaths) !==
      JSON.stringify(sorted(snapshot.untrackedPaths)) ||
    [
      ...snapshot.stagedPaths,
      ...snapshot.unstagedPaths,
      ...snapshot.untrackedPaths,
    ].some((entry) => !byPath.has(entry))
  )
    return false;
  const untrackedDigest = digestCanonicalRecords(
    snapshot.untrackedPaths.map(
      (entry) =>
        [
          "untracked",
          pathStateDigest(byPath.get(entry) as RepositoryPathFingerprint),
        ] as const,
    ),
  );
  return (
    snapshot.stagedDigest ===
      stagedComponentDigest(
        snapshot.headTree,
        snapshot.indexTree,
        snapshot.stagedPaths,
        byPath,
      ) &&
    snapshot.unstagedDigest ===
      unstagedComponentDigest(
        snapshot.indexTree,
        snapshot.unstagedPaths,
        byPath,
      ) &&
    snapshot.untrackedDigest === untrackedDigest &&
    snapshot.digest ===
      snapshotDigest(
        snapshot.head,
        snapshot.headTree,
        snapshot.indexTree,
        snapshot.stagedDigest,
        snapshot.unstagedDigest,
        snapshot.untrackedDigest,
        paths,
      )
  );
}

interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

function execBuffer(
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
          code:
            error && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0,
        });
      },
    );
  });
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Hashes canonical, length-delimited labeled records. */
export function digestCanonicalRecords(
  records: ReadonlyArray<readonly [label: string, value: Buffer | string]>,
): string {
  const hash = createHash("sha256");
  for (const [label, raw] of records) {
    const labelBytes = Buffer.from(label);
    const value = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(`${labelBytes.length}:`);
    hash.update(labelBytes);
    hash.update(`${value.length}:`);
    hash.update(value);
  }
  return hash.digest("hex");
}

function parseNulPaths(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/gu, "/"));
}

function isRuntimeOwnedPath(relativePath: string): boolean {
  return (
    relativePath === ".git" ||
    relativePath.startsWith(".git/") ||
    relativePath === ".pi" ||
    relativePath.startsWith(".pi/") ||
    relativePath === "node_modules" ||
    relativePath.startsWith("node_modules/") ||
    relativePath === ".ged/runtime" ||
    relativePath.startsWith(".ged/runtime/")
  );
}

async function worktreeDigest(filePath: string): Promise<string | null> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      return digestCanonicalRecords([["symlink", await readlink(filePath)]]);
    }
    if (info.isDirectory()) {
      try {
        await lstat(path.join(filePath, ".git"));
        const nested = await captureRepositorySnapshot(filePath);
        return digestCanonicalRecords([
          ["submodule-snapshot", nested.digest],
          ["submodule-head", nested.head ?? "unborn"],
        ]);
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
    if (!info.isFile()) return null;
    const contentDigest =
      info.size > LARGE_FILE_THRESHOLD_BYTES
        ? await sha256File(filePath)
        : sha256(await readFile(filePath));
    return digestCanonicalRecords([
      ["mode", String(info.mode & 0o777)],
      ["content", contentDigest],
    ]);
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

async function indexDigest(
  repositoryRoot: string,
  relativePath: string,
): Promise<string | null> {
  const result = await execBuffer(
    "git",
    ["ls-files", "--stage", "--", relativePath],
    repositoryRoot,
  );
  if (result.code !== 0 || result.stdout.length === 0) return null;
  const match = result.stdout
    .toString("utf8")
    .match(/^[0-7]{6}\s+([a-f0-9]{40,64})\s/u);
  return match?.[1] ? sha256(`git-blob:${match[1]}`) : null;
}

async function filesystemPaths(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path
        .relative(rootDir, absolute)
        .split(path.sep)
        .join("/");
      if (isRuntimeOwnedPath(relative)) continue;
      if (entry.isDirectory()) await visit(absolute);
      else results.push(relative);
    }
  };
  await visit(rootDir);
  return results;
}

function pathStateDigest(entry: RepositoryPathFingerprint): string {
  return digestCanonicalRecords([
    ["path", entry.path],
    ["index", entry.indexDigest ?? "missing"],
    ["worktree", entry.worktreeDigest ?? "missing"],
  ]);
}

function stagedComponentDigest(
  headTree: string | null,
  indexTree: string | null,
  paths: string[],
  byPath: Map<string, RepositoryPathFingerprint>,
): string {
  return digestCanonicalRecords([
    ["format", "ged-staged-v1"],
    ["head-tree", headTree ?? "unborn"],
    ["index-tree", indexTree ?? "none"],
    ...paths.map(
      (entry) =>
        [
          "path",
          pathStateDigest(byPath.get(entry) as RepositoryPathFingerprint),
        ] as const,
    ),
  ]);
}

function unstagedComponentDigest(
  indexTree: string | null,
  paths: string[],
  byPath: Map<string, RepositoryPathFingerprint>,
): string {
  return digestCanonicalRecords([
    ["format", "ged-unstaged-v1"],
    ["index-tree", indexTree ?? "none"],
    ...paths.map(
      (entry) =>
        [
          "path",
          pathStateDigest(byPath.get(entry) as RepositoryPathFingerprint),
        ] as const,
    ),
  ]);
}

function snapshotDigest(
  head: string | null,
  headTree: string | null,
  indexTree: string | null,
  stagedDigest: string,
  unstagedDigest: string,
  untrackedDigest: string,
  paths: RepositoryPathFingerprint[],
): string {
  return digestCanonicalRecords([
    ["format", "ged-repository-snapshot-v1"],
    ["head", head ?? "unborn"],
    ["head-tree", headTree ?? "unborn"],
    ["index-tree", indexTree ?? "none"],
    ["staged", stagedDigest],
    ["unstaged", unstagedDigest],
    ["untracked", untrackedDigest],
    ...paths.map((entry) => ["path-state", pathStateDigest(entry)] as const),
  ]);
}

async function captureRepositorySnapshotOnce(
  cwd: string,
): Promise<RepositorySnapshot> {
  const resolvedCwd = await realpath(cwd).catch(() => path.resolve(cwd));
  const topLevel = await execBuffer(
    "git",
    ["rev-parse", "--show-toplevel"],
    resolvedCwd,
  );
  if (topLevel.code !== 0) {
    const relativePaths = await filesystemPaths(resolvedCwd);
    const paths = await Promise.all(
      relativePaths.map(async (relativePath) => ({
        path: relativePath,
        indexDigest: null,
        worktreeDigest: await worktreeDigest(
          path.join(resolvedCwd, relativePath),
        ),
      })),
    );
    const byPath = new Map(paths.map((entry) => [entry.path, entry]));
    const stagedDigest = stagedComponentDigest(null, null, [], byPath);
    const unstagedDigest = unstagedComponentDigest(null, [], byPath);
    const untrackedDigest = digestCanonicalRecords(
      paths.map((entry) => ["untracked", pathStateDigest(entry)] as const),
    );
    return {
      version: REPOSITORY_SNAPSHOT_VERSION,
      repositoryRoot: resolvedCwd,
      git: false,
      head: null,
      headTree: null,
      indexTree: null,
      stagedDigest,
      unstagedDigest,
      untrackedDigest,
      stagedPaths: [],
      unstagedPaths: [],
      untrackedPaths: relativePaths,
      paths,
      digest: snapshotDigest(
        null,
        null,
        null,
        stagedDigest,
        unstagedDigest,
        untrackedDigest,
        paths,
      ),
    };
  }

  const repositoryRoot = await realpath(
    topLevel.stdout.toString("utf8").trim(),
  );
  const [
    headResult,
    headTreeResult,
    indexTreeResult,
    staged,
    unstaged,
    stagedNames,
    unstagedNames,
    untracked,
  ] = await Promise.all([
    execBuffer("git", ["rev-parse", "--verify", "HEAD"], repositoryRoot),
    execBuffer("git", ["rev-parse", "--verify", "HEAD^{tree}"], repositoryRoot),
    execBuffer("git", ["write-tree"], repositoryRoot),
    execBuffer(
      "git",
      ["diff", "--cached", "--binary", "--no-ext-diff", "--full-index"],
      repositoryRoot,
    ),
    execBuffer(
      "git",
      ["diff", "--binary", "--no-ext-diff", "--full-index"],
      repositoryRoot,
    ),
    execBuffer(
      "git",
      ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB"],
      repositoryRoot,
    ),
    execBuffer(
      "git",
      ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"],
      repositoryRoot,
    ),
    execBuffer(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      repositoryRoot,
    ),
  ]);
  for (const result of [
    staged,
    unstaged,
    stagedNames,
    unstagedNames,
    untracked,
    indexTreeResult,
  ]) {
    if (result.code !== 0) {
      throw new Error(
        `Unable to fingerprint repository: ${result.stderr.toString("utf8").trim()}`,
      );
    }
  }

  const stagedPaths = parseNulPaths(stagedNames.stdout)
    .filter((entry) => !isRuntimeOwnedPath(entry))
    .sort((left, right) => left.localeCompare(right));
  const unstagedPaths = parseNulPaths(unstagedNames.stdout)
    .filter((entry) => !isRuntimeOwnedPath(entry))
    .sort((left, right) => left.localeCompare(right));
  const changedPaths = [
    ...stagedPaths,
    ...unstagedPaths,
    ...parseNulPaths(untracked.stdout),
  ].filter((entry) => !isRuntimeOwnedPath(entry));
  const orderedPaths = [...new Set(changedPaths)].sort((left, right) =>
    left.localeCompare(right),
  );
  const paths = await Promise.all(
    orderedPaths.map(async (relativePath) => ({
      path: relativePath,
      indexDigest: await indexDigest(repositoryRoot, relativePath),
      worktreeDigest: await worktreeDigest(
        path.join(repositoryRoot, relativePath),
      ),
    })),
  );
  const untrackedPaths = parseNulPaths(untracked.stdout)
    .filter((entry) => !isRuntimeOwnedPath(entry))
    .sort((left, right) => left.localeCompare(right));
  const untrackedPathSet = new Set(untrackedPaths);
  const untrackedDigest = digestCanonicalRecords(
    paths
      .filter((entry) => untrackedPathSet.has(entry.path))
      .map((entry) => ["untracked", pathStateDigest(entry)] as const),
  );
  const head =
    headResult.code === 0 ? headResult.stdout.toString("utf8").trim() : null;
  const headTree =
    headTreeResult.code === 0
      ? headTreeResult.stdout.toString("utf8").trim()
      : null;
  const indexTree = indexTreeResult.stdout.toString("utf8").trim() || null;
  const byPath = new Map(paths.map((entry) => [entry.path, entry]));
  const stagedDigest = stagedComponentDigest(
    headTree,
    indexTree,
    stagedPaths,
    byPath,
  );
  const unstagedDigest = unstagedComponentDigest(
    indexTree,
    unstagedPaths,
    byPath,
  );
  return {
    version: REPOSITORY_SNAPSHOT_VERSION,
    repositoryRoot,
    git: true,
    head,
    headTree,
    indexTree,
    stagedDigest,
    unstagedDigest,
    untrackedDigest,
    stagedPaths: [...new Set(stagedPaths)],
    unstagedPaths: [...new Set(unstagedPaths)],
    untrackedPaths,
    paths,
    digest: snapshotDigest(
      head,
      headTree,
      indexTree,
      stagedDigest,
      unstagedDigest,
      untrackedDigest,
      paths,
    ),
  };
}

export async function captureRepositorySnapshot(
  cwd: string,
): Promise<RepositorySnapshot> {
  let previous = await captureRepositorySnapshotOnce(cwd);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await captureRepositorySnapshotOnce(cwd);
    if (snapshotsEqual(previous, current)) return current;
    previous = current;
  }
  throw new Error(
    "Repository content changed continuously while fingerprinting; retry from a stable state.",
  );
}

export function changedPathsBetween(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): string[] {
  if (before.repositoryRoot !== after.repositoryRoot) {
    throw new Error("Cannot compare snapshots from different worktrees.");
  }
  const beforeByPath = new Map(
    before.paths.map((entry) => [entry.path, pathStateDigest(entry)]),
  );
  const afterByPath = new Map(
    after.paths.map((entry) => [entry.path, pathStateDigest(entry)]),
  );
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
    .filter((entry) => beforeByPath.get(entry) !== afterByPath.get(entry))
    .sort((left, right) => left.localeCompare(right));
  if (before.head !== after.head) paths.unshift("@HEAD");
  return paths;
}

export function snapshotsEqual(
  left: RepositorySnapshot,
  right: RepositorySnapshot,
): boolean {
  return (
    left.digest === right.digest && left.repositoryRoot === right.repositoryRoot
  );
}

export async function fingerprintFileSet(
  rootDir: string,
  filePaths: string[],
): Promise<FileSetFingerprint> {
  const root = await realpath(rootDir).catch(() => path.resolve(rootDir));
  const records: Array<readonly [string, Buffer | string]> = [
    ["format", "ged-file-set-v1"],
  ];
  const relativePaths: string[] = [];
  for (const filePath of [...filePaths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Fingerprint input must be a regular file: ${filePath}`);
    }
    const canonicalFile = await realpath(filePath);
    const relative = path
      .relative(root, canonicalFile)
      .split(path.sep)
      .join("/");
    if (relative === ".." || relative.startsWith("../")) {
      throw new Error(`Fingerprint input escapes the repository: ${filePath}`);
    }
    relativePaths.push(relative);
    records.push(["path", relative], ["content", await readFile(filePath)]);
  }
  return { digest: digestCanonicalRecords(records), paths: relativePaths };
}
