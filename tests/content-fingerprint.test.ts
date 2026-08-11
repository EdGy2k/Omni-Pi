import { execFile } from "node:child_process";
import { mkdtemp, rename, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  captureRepositorySnapshot,
  changedPathsBetween,
  digestCanonicalRecords,
  isRepositorySnapshot,
  LARGE_FILE_THRESHOLD_BYTES,
  snapshotsEqual,
} from "../src/content-fingerprint.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "initial\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("canonical content fingerprints", () => {
  it("uses labeled length delimiters rather than ambiguous concatenation", () => {
    expect(digestCanonicalRecords([["a", "bc"]])).not.toBe(
      digestCanonicalRecords([["ab", "c"]]),
    );
    expect(digestCanonicalRecords([["a", "bc"]])).toBe(
      digestCanonicalRecords([["a", Buffer.from("bc")]]),
    );
  });

  it("is deterministic for clean and reordered repository discovery", async () => {
    const root = await repository("ged-fingerprint-clean-");
    const first = await captureRepositorySnapshot(root);
    const second = await captureRepositorySnapshot(root);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      git: true,
      stagedPaths: [],
      paths: [],
    });
    expect(snapshotsEqual(first, second)).toBe(true);
  });

  it("captures staged, unstaged, binary, untracked, and spaced paths", async () => {
    const root = await repository("ged-fingerprint-mixed-");
    const baseline = await captureRepositorySnapshot(root);
    await writeFile(path.join(root, "README.md"), "unstaged\n");
    await writeFile(path.join(root, "staged file.txt"), "staged\n");
    await git(root, ["add", "staged file.txt"]);
    await writeFile(
      path.join(root, "binary.dat"),
      Buffer.from([0, 1, 2, 0, 255]),
    );

    const snapshot = await captureRepositorySnapshot(root);
    expect(isRepositorySnapshot(snapshot)).toBe(true);
    expect(isRepositorySnapshot({ ...snapshot, digest: "0".repeat(64) })).toBe(
      false,
    );
    expect(snapshot.stagedPaths).toEqual(["staged file.txt"]);
    expect(snapshot.paths.map((entry) => entry.path)).toEqual([
      "binary.dat",
      "README.md",
      "staged file.txt",
    ]);
    expect(changedPathsBetween(baseline, snapshot)).toEqual([
      "binary.dat",
      "README.md",
      "staged file.txt",
    ]);
    expect(snapshot.digest).not.toBe(baseline.digest);
  });

  it("captures rename and deletion state", async () => {
    const root = await repository("ged-fingerprint-rename-");
    await writeFile(path.join(root, "delete.txt"), "delete\n");
    await writeFile(path.join(root, "old.txt"), "rename\n");
    await git(root, ["add", "delete.txt", "old.txt"]);
    await git(root, ["commit", "-m", "fixtures"]);
    const baseline = await captureRepositorySnapshot(root);
    await rename(path.join(root, "old.txt"), path.join(root, "new.txt"));
    await git(root, ["rm", "delete.txt"]);
    await git(root, ["add", "-A"]);

    const snapshot = await captureRepositorySnapshot(root);
    expect(snapshot.stagedPaths).toEqual(
      expect.arrayContaining(["delete.txt", "new.txt"]),
    );
    expect(changedPathsBetween(baseline, snapshot)).toEqual(
      expect.arrayContaining(["delete.txt", "new.txt"]),
    );
  });

  it("treats clean HEAD-only movement as scoped state", async () => {
    const root = await repository("ged-fingerprint-head-");
    const before = await captureRepositorySnapshot(root);
    await git(root, ["commit", "--allow-empty", "-m", "head only"]);
    const after = await captureRepositorySnapshot(root);
    expect(changedPathsBetween(before, after)).toEqual(["@HEAD"]);
  });

  it("streams full content hashes for large untracked files", async () => {
    const root = await repository("ged-fingerprint-large-");
    const filePath = path.join(root, "large.bin");
    await writeFile(filePath, Buffer.alloc(LARGE_FILE_THRESHOLD_BYTES + 1, 7));
    const beforeInfo = await stat(filePath);
    const snapshot = await captureRepositorySnapshot(root);
    expect(snapshot.paths).toEqual([
      expect.objectContaining({
        path: "large.bin",
        indexDigest: null,
        worktreeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    await writeFile(filePath, Buffer.alloc(LARGE_FILE_THRESHOLD_BYTES + 1, 8));
    await utimes(filePath, beforeInfo.atime, beforeInfo.mtime);
    expect((await captureRepositorySnapshot(root)).digest).not.toBe(
      snapshot.digest,
    );
  });

  it("supports linked worktrees and non-Git directories", async () => {
    const root = await repository("ged-fingerprint-worktree-");
    const linked = await mkdtemp(path.join(os.tmpdir(), "ged-linked-parent-"));
    const linkedWorktree = path.join(linked, "worktree");
    await git(root, ["worktree", "add", "-b", "linked", linkedWorktree]);
    const linkedSnapshot = await captureRepositorySnapshot(linkedWorktree);
    expect(linkedSnapshot.git).toBe(true);
    expect(linkedSnapshot.repositoryRoot).toBe(
      await import("node:fs/promises").then(({ realpath }) =>
        realpath(linkedWorktree),
      ),
    );

    const nonGit = await mkdtemp(
      path.join(os.tmpdir(), "ged-fingerprint-nongit-"),
    );
    const before = await captureRepositorySnapshot(nonGit);
    await writeFile(path.join(nonGit, "file.txt"), "content\n");
    const after = await captureRepositorySnapshot(nonGit);
    expect(after.git).toBe(false);
    expect(changedPathsBetween(before, after)).toEqual(["file.txt"]);
  });

  it("fingerprints dirty submodule worktree content", async () => {
    const child = await repository("ged-fingerprint-submodule-child-");
    const root = await repository("ged-fingerprint-submodule-parent-");
    await execFileAsync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", child, "child"],
      { cwd: root },
    );
    await git(root, ["commit", "-am", "add submodule"]);
    await writeFile(path.join(root, "child", "README.md"), "dirty one\n");
    const first = await captureRepositorySnapshot(root);
    await writeFile(path.join(root, "child", "README.md"), "dirty two\n");
    const second = await captureRepositorySnapshot(root);
    expect(first.digest).not.toBe(second.digest);
    expect(changedPathsBetween(first, second)).toEqual(["child"]);
  });
});
