import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  activeGedPaths,
  activeWorkPointerPath,
  continueGedWork,
  ensureActiveGedWork,
  generateWorkId,
  isActiveWorkBoundToRequest,
  openGedWork,
  readActiveWorkPointer,
  readWorkItemMeta,
  WorkSelectionError,
} from "../src/ged-paths.js";

const execFileAsync = promisify(execFile);

async function tempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

const request = (sessionId: string, requestId: string) => ({
  sessionId,
  requestId,
});

describe("generated work IDs", () => {
  it("uses a readable slug, sortable time, and supplied collision entropy", () => {
    const earlier = generateWorkId("Fix auth callback", {
      now: Date.UTC(2026, 7, 10, 4, 0, 0, 1),
      entropy: "00000000000000000000000000000001",
    });
    const later = generateWorkId("Fix auth callback", {
      now: Date.UTC(2026, 7, 10, 4, 0, 0, 2),
      entropy: "00000000000000000000000000000002",
    });

    expect(earlier).toMatch(/^fix-auth-callback-\d{17}-[a-f0-9]{32}$/u);
    expect(earlier < later).toBe(true);
  });

  it("does not let slug normalization collisions become identity collisions", () => {
    const options = { now: 1_786_334_400_000 };
    const slash = generateWorkId("feat/a", {
      ...options,
      entropy: "00000000000000000000000000000001",
    });
    const dash = generateWorkId("feat-a", {
      ...options,
      entropy: "00000000000000000000000000000002",
    });

    expect(slash).not.toBe(dash);
  });
});

describe("active Ged work selection", () => {
  it("creates an unbound generated bootstrap without selecting legacy root", async () => {
    const rootDir = await tempProject("ged-path-bootstrap-");
    await mkdir(path.join(rootDir, ".ged", "work", "root"), {
      recursive: true,
    });
    await writeFile(
      path.join(rootDir, ".ged", "work", "root", "META.json"),
      '{"workId":"root","schema":1}\n',
    );

    const pointer = await ensureActiveGedWork(rootDir, "session-a");

    expect(pointer.operation).toBe("bootstrap");
    expect(pointer.requestId).toBeNull();
    expect(pointer.workId).not.toBe("root");
    expect((await activeGedPaths(rootDir, "session-a")).workId).toBe(
      pointer.workId,
    );
  });

  it("isolates two tasks opened on the same branch", async () => {
    const rootDir = await tempProject("ged-path-isolation-");
    const first = await openGedWork(
      rootDir,
      request("session-a", "request-1"),
      "Fix first issue",
    );
    await writeFile(first.paths.specPath, "first\n");
    const second = await openGedWork(
      rootDir,
      request("session-a", "request-2"),
      "Fix second issue",
    );
    await writeFile(second.paths.specPath, "second\n");

    expect(first.workId).not.toBe(second.workId);
    expect(await readFile(first.paths.specPath, "utf8")).toBe("first\n");
    expect(await readFile(second.paths.specPath, "utf8")).toBe("second\n");
    expect((await activeGedPaths(rootDir, "session-a")).workId).toBe(
      second.workId,
    );
  });

  it("keeps independent session pointers", async () => {
    const rootDir = await tempProject("ged-path-sessions-");
    const first = await openGedWork(
      rootDir,
      request("session-a", "request-a"),
      "Session A task",
    );
    const second = await openGedWork(
      rootDir,
      request("session-b", "request-b"),
      "Session B task",
    );

    expect((await activeGedPaths(rootDir, "session-a")).workId).toBe(
      first.workId,
    );
    expect((await activeGedPaths(rootDir, "session-b")).workId).toBe(
      second.workId,
    );
    expect(activeWorkPointerPath(rootDir, "session-a")).not.toBe(
      activeWorkPointerPath(rootDir, "session-b"),
    );
  });

  it("survives a branch rename because branch is metadata only", async () => {
    const rootDir = await tempProject("ged-path-rename-");
    await execFileAsync("git", ["init", "-b", "before"], { cwd: rootDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: rootDir,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: rootDir,
    });
    await writeFile(path.join(rootDir, "README.md"), "test\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: rootDir });
    await execFileAsync("git", ["commit", "-m", "initial"], {
      cwd: rootDir,
    });

    const opened = await openGedWork(
      rootDir,
      request("session-a", "request-a"),
      "Rename-safe task",
    );
    await execFileAsync("git", ["branch", "-m", "after"], { cwd: rootDir });

    expect((await activeGedPaths(rootDir, "session-a")).workId).toBe(
      opened.workId,
    );
    expect((await readWorkItemMeta(rootDir, opened.workId)).branch).toBe(
      "before",
    );
  });

  it("does not collide across detached and non-Git work", async () => {
    const gitRoot = await tempProject("ged-path-detached-");
    await execFileAsync("git", ["init"], { cwd: gitRoot });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: gitRoot,
    });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: gitRoot,
    });
    await writeFile(path.join(gitRoot, "README.md"), "test\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: gitRoot });
    await execFileAsync("git", ["commit", "-m", "initial"], {
      cwd: gitRoot,
    });
    await execFileAsync("git", ["checkout", "--detach", "HEAD"], {
      cwd: gitRoot,
    });
    const nonGitRoot = await tempProject("ged-path-nongit-");

    const detached = await openGedWork(
      gitRoot,
      request("session-a", "request-a"),
      "Same task",
    );
    const nonGit = await openGedWork(
      nonGitRoot,
      request("session-a", "request-a"),
      "Same task",
    );

    expect(detached.workId).not.toBe(nonGit.workId);
    expect(
      (await readWorkItemMeta(gitRoot, detached.workId)).branch,
    ).toBeNull();
    expect(
      (await readWorkItemMeta(nonGitRoot, nonGit.workId)).branch,
    ).toBeNull();
  });

  it("requires the exact current request binding", async () => {
    const rootDir = await tempProject("ged-path-binding-");
    const firstRequest = request("session-a", "request-1");
    const secondRequest = request("session-a", "request-2");
    const opened = await openGedWork(rootDir, firstRequest, "Bound task");

    await expect(
      isActiveWorkBoundToRequest(rootDir, firstRequest),
    ).resolves.toBe(true);
    await expect(
      isActiveWorkBoundToRequest(rootDir, secondRequest),
    ).resolves.toBe(false);

    await continueGedWork(rootDir, secondRequest, opened.workId);
    await expect(
      isActiveWorkBoundToRequest(rootDir, secondRequest),
    ).resolves.toBe(true);
    await expect(
      isActiveWorkBoundToRequest(rootDir, firstRequest),
    ).resolves.toBe(false);
  });

  it("fails closed when selected work metadata disappears", async () => {
    const rootDir = await tempProject("ged-path-deleted-");
    const identity = request("session-a", "request-1");
    const opened = await openGedWork(rootDir, identity, "Deleted task");
    await rm(opened.paths.metaPath);

    await expect(
      isActiveWorkBoundToRequest(rootDir, identity, opened.workId),
    ).rejects.toBeInstanceOf(WorkSelectionError);
    await expect(activeGedPaths(rootDir, "session-a")).rejects.toBeInstanceOf(
      WorkSelectionError,
    );
  });

  it("reserves distinct directories for concurrent opens", async () => {
    const rootDir = await tempProject("ged-path-concurrent-");
    const opened = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        openGedWork(
          rootDir,
          request("session-a", `request-${index}`),
          "Concurrent task",
        ),
      ),
    );

    expect(new Set(opened.map((entry) => entry.workId))).toHaveLength(8);
    await Promise.all(
      opened.map((entry) =>
        expect(readWorkItemMeta(rootDir, entry.workId)).resolves.toBeDefined(),
      ),
    );
  });

  it("fails closed for corrupt, unknown, or traversal pointers", async () => {
    const rootDir = await tempProject("ged-path-invalid-");
    const pointerPath = activeWorkPointerPath(rootDir, "session-a");
    await mkdir(path.dirname(pointerPath), { recursive: true });

    for (const raw of [
      "not-json",
      JSON.stringify({ schemaVersion: 99 }),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-a",
        workId: "../../escape",
        operation: "continue",
        selectedAt: new Date().toISOString(),
        requestId: "request-a",
      }),
    ]) {
      await writeFile(pointerPath, raw);
      await expect(activeGedPaths(rootDir, "session-a")).rejects.toBeInstanceOf(
        WorkSelectionError,
      );
    }
  });

  it("does not replace the pointer when continue target is missing", async () => {
    const rootDir = await tempProject("ged-path-missing-");
    const opened = await openGedWork(
      rootDir,
      request("session-a", "request-1"),
      "Existing task",
    );

    await expect(
      continueGedWork(
        rootDir,
        request("session-a", "request-2"),
        generateWorkId("Missing task"),
      ),
    ).rejects.toBeInstanceOf(WorkSelectionError);
    expect((await readActiveWorkPointer(rootDir, "session-a"))?.workId).toBe(
      opened.workId,
    );
  });
});
